/* Вкладка «Библиотека»: избранные маршруты, треки GPX и ручные отметки пройденных улиц. */
import L from 'leaflet';
import * as Core from '../core/index.js';
import { cssVar, divIcon } from '../map/map.js';
import { $, el, fmtKm, uid, round5, toast, renameable, iconBtn } from './dom.js';

const KIND = { gpx: 'GPX', route: 'маршрут', manual: 'вручную' };
const fmtDate = (t) => new Date(t).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });

export function initLibraryPanel(app) {
  const { map, layers, S, tracks, favorites } = app;
  const lineKm = (lines) => lines.reduce((s, l) => s + Core.polyLength(l), 0);
  const allLines = (except) => tracks.items.filter((t) => t !== except).flatMap((t) => t.lines);

  function fitLines(lines) {
    const pts = lines.flat();
    if (pts.length) map.fitBounds(L.latLngBounds(pts), { padding: [40, 40] });
  }

  const renameIn = (entry, coll) => renameable(entry.name, (v) => { entry.name = v; entry.autoName = false; coll.update(entry); });

  function renderFavorites() {
    const list = $('#favList');
    list.innerHTML = '';
    for (const f of favorites.items.slice().reverse()) {
      list.appendChild(el('div', { class: 'item' },
        el('div', { class: 'grow' },
          renameIn(f, favorites),
          el('div', { class: 'meta' }, fmtKm(f.length) + ' км · ' + Math.round((f.newShare || 0) * 100) + '% новых · ' + fmtDate(f.created))),
        el('div', { class: 'acts' },
          iconBtn('show', 'Показать на карте', () => { app.showLine(f); app.sheet.peek(); }),
          iconBtn('download', 'Скачать GPX', () => app.downloadRoute(f.name, f.coords, f.length, f.loop)),
          iconBtn('remove', 'Удалить ' + f.name, () => { favorites.remove(f.id); render(); app.emit('favorites'); }, true))));
    }
    if (!favorites.items.length) list.appendChild(el('p', { class: 'empty' }, 'Нажмите на звёздочку у варианта маршрута, чтобы сохранить его здесь.'));
  }

  function renderTracks() {
    layers.explored.clearLayers();
    const color = cssVar('map-explored');
    for (const t of tracks.items) {
      for (const ln of t.lines) {
        layers.explored.addLayer(L.polyline(ln, { color, weight: 2.5, opacity: 0.9, lineCap: 'round', lineJoin: 'round', interactive: false }));
      }
    }
    const list = $('#exploredList');
    list.innerHTML = '';
    for (const t of tracks.items.slice().reverse()) {
      const meta = [fmtKm(t.km || 0) + ' км'];
      if (t.newKm !== undefined) meta.push(fmtKm(t.newKm) + ' км новых');
      meta.push(KIND[t.kind] || '');
      list.appendChild(el('div', { class: 'item' },
        el('div', { class: 'grow' }, renameIn(t, tracks), el('div', { class: 'meta' }, meta.join(' · '))),
        el('div', { class: 'acts' },
          iconBtn('show', 'Показать на карте', () => { fitLines(t.lines); app.sheet.peek(); }),
          iconBtn('remove', 'Удалить ' + t.name, () => { tracks.remove(t.id); render(); }, true))));
    }
    if (!tracks.items.length) list.appendChild(el('p', { class: 'empty' }, 'Загрузите GPX своих пробежек или отметьте улицы вручную.'));
  }

  function render() {
    renderFavorites();
    renderTracks();
    app.emit('explored');
  }

  /* Район и заметное место на треке: «Хамовники · Нескучный сад». */
  function placeOn(lines) {
    const parts = [app.districtName(lines.flat()), poiOn(lines)].filter(Boolean);
    return parts.length ? parts.join(' · ') : null;
  }
  /* Заметное место на треке, если рядом уже загружены места из OSM. */
  function poiOn(lines) {
    const g = S.graph;
    if (!g || !g.pois || !g.pois.length) return null;
    const seen = [];
    for (const line of lines) {
      for (const p of Core.resample(line, 40)) {
        const i = Core.poiNear(g, Core.px(p[1]), Core.py(p[0]), 70);
        if (i >= 0 && !seen.includes(g.pois[i])) seen.push(g.pois[i]);
      }
    }
    const poi = Core.notablePlace(seen);
    return poi ? Core.placeName(poi) : null;
  }

  /* Добавляет трек; возвращает запись или null, если в нём нет линий. */
  function addTrack(kind, lines, opts = {}) {
    const clean = lines.map((l) => Core.simplifyDP(l, 4).map(round5)).filter((l) => l.length > 1);
    if (!clean.length) return null;
    const km = lineKm(clean);
    const date = opts.date || Date.now();
    const entry = {
      id: uid(), kind, lines: clean, km, created: Date.now(), date,
      newKm: Core.newDistance(clean, allLines()),
      name: opts.name || Core.trackTitle(date, km, placeOn(clean)), autoName: !opts.name
    };
    tracks.add(entry);
    render();
    app.coverage.ensure(entry).catch(() => {});
    return entry;
  }
  app.addTrack = addTrack;
  app.renderLibrary = render;

  const CAT = { park: 'парк', view: 'смотровая', worship: 'храм', monument: 'памятник', museum: 'музей', sight: 'достопримечательность', history: 'история', heritage: 'наследие' };
  function showSummary(added, failed) {
    const box = $('#importSummary');
    box.innerHTML = '';
    if (!added.length) { box.hidden = true; return; }
    const total = added.reduce((s, t) => s + t.km, 0), fresh = added.reduce((s, t) => s + t.newKm, 0);
    const mkad = el('div', null, el('div', { class: 'big own' }, '…'), el('div', { class: 'muted' }, 'улиц МКАД'));
    const met = el('div', { class: 'met' });
    box.append(
      el('div', { class: 'head' },
        el('span', { class: 'lbl' }, added.length === 1 ? 'Трек загружен' : 'Загружено треков: ' + added.length),
        el('button', { class: 'btn small ghost', type: 'button', onclick: () => { box.hidden = true; } }, 'Скрыть')),
      el('div', { class: 'figs' },
        el('div', null, el('div', { class: 'big' }, fmtKm(total) + ' км'), el('div', { class: 'muted' }, 'всего')),
        el('div', null, el('div', { class: 'big own' }, '+' + fmtKm(fresh) + ' км'), el('div', { class: 'muted' }, 'новых улиц')),
        mkad),
      met,
      el('div', { class: 'files' }, added.map((t) => t.name).join('; ') + (failed ? '. Без трека: ' + failed : '')));
    box.hidden = false;
    app.coverage.summary(added).then((r) => {
      if (!r) { mkad.remove(); return; }
      const pct = r.gainShare * 100;
      mkad.firstChild.textContent = '+' + (pct > 0 && pct < 0.01 ? '<0,01' : pct.toLocaleString('ru-RU', { maximumFractionDigits: 2 })) + '%';
      if (!r.met.length) return;
      met.append(el('div', { class: 'muted' }, 'Встретились по пути'),
        el('ul', null, r.met.slice(0, 12).map((m) => el('li', { class: m.isNew ? 'new' : '' },
          Core.placeName({ name: m.n, cat: m.c }), el('small', null, (CAT[m.c] || '') + (m.isNew ? ' · впервые' : ''))))),
        ...(r.met.length > 12 ? [el('div', { class: 'muted' }, 'и ещё ' + (r.met.length - 12))] : []));
    }).catch(() => mkad.remove());
  }

  $('#importGpx').addEventListener('click', () => $('#gpxFiles').click());
  $('#gpxFiles').addEventListener('change', async (e) => {
    const files = Array.from(e.target.files || []);
    const added = [];
    let failed = 0;
    for (const f of files) {
      try {
        const gpx = Core.parseGPX(await f.text());
        const t = addTrack('gpx', gpx.tracks, { date: gpx.time ? Date.parse(gpx.time) : f.lastModified });
        if (t) added.push(t); else failed++;
      } catch (err) { failed++; }
    }
    e.target.value = '';
    if (!added.length) { toast('В файлах не нашлось трека.'); return; }
    showSummary(added, failed);
    fitLines(added.flatMap((t) => t.lines));
  });

  /* ручная разметка: между кликами линия ложится по пешеходным улицам, если граф загружен */
  const draft = { coords: [], hist: [], lastNode: null };
  function clearDraft() { draft.coords = []; draft.hist = []; draft.lastNode = null; layers.draft.clearLayers(); }
  function drawDraft() {
    layers.draft.clearLayers();
    if (draft.coords.length) layers.draft.addLayer(L.polyline(draft.coords, { color: cssVar('map-explored'), weight: 5, opacity: 0.9, interactive: false }));
    for (const h of draft.hist) {
      if (h.pt) layers.draft.addLayer(L.marker(h.pt, { icon: divIcon('mk-draft', 14, 14), interactive: false, keyboard: false }));
    }
  }
  app.registerMode('draw', {
    click(ll) {
      const p = [ll.lat, ll.lng], g = S.graph;
      const snap = g ? Core.nearestNode(g, ll.lat, ll.lng, 60, 10) : null;
      const before = draft.coords.length, prevNode = draft.lastNode;
      if (snap && prevNode !== null && g.comp[prevNode] === g.comp[snap.node]) {
        if (!S.router) S.router = Core.makeRouter(g);
        const path = Core.shortestPath(g, S.router, prevNode, snap.node);
        if (path) draft.coords = draft.coords.concat(path.slice(draft.coords.length ? 1 : 0));
        else draft.coords.push(p);
      } else if (snap) draft.coords.push([g.lat[snap.node], g.lon[snap.node]]);
      else draft.coords.push(p);
      draft.hist.push({ n: draft.coords.length - before, prev: prevNode, pt: snap ? [g.lat[snap.node], g.lon[snap.node]] : p });
      draft.lastNode = snap ? snap.node : null;
      drawDraft();
    },
    undo() {
      const h = draft.hist.pop();
      if (!h) return;
      draft.coords.length = Math.max(0, draft.coords.length - h.n);
      draft.lastNode = h.prev;
      drawDraft();
    },
    ok() {
      if (draft.coords.length < 2) { toast('Поставьте хотя бы две точки вдоль улицы.'); return; }
      const t = addTrack('manual', [draft.coords.slice()]);
      app.setMode(null);
      if (t) toast('Отмечено ' + fmtKm(t.km) + ' км, из них новых ' + fmtKm(t.newKm) + ' км.');
    },
    leave: clearDraft
  });
  $('#drawBtn').addEventListener('click', () => {
    app.setMode('draw', S.graph
      ? 'Кликайте по улицам вдоль пройденного пути: между точками линия ляжет по улицам'
      : 'Кликайте вдоль пройденного пути. После первого построения маршрута линия будет прилипать к улицам');
  });

  app.on('theme', renderTracks);
  app.on('favorites', renderFavorites);
  render();
}
