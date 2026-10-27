/* Вкладка «Прогресс»: карта покрытия улиц внутри МКАД, панель района, места и статистика.
   Пока вкладка открыта, карта показывает только районы, улицы, места и контур МКАД. */
import L from 'leaflet';
import * as Core from '../core/index.js';
import { store, save } from '../storage/store.js';
import { cssVar } from '../map/map.js';
import { $, el, fmtKm, syncSeg } from './dom.js';

const CAT = {
  park: 'парк', view: 'смотровая', worship: 'храм', monument: 'памятник', museum: 'музей',
  sight: 'достопримечательность', history: 'история', heritage: 'наследие'
};
const CAT_ORDER = ['park', 'worship', 'monument', 'museum', 'view', 'sight', 'history', 'heritage'];
const STATE = ['не встречено', 'встречено', 'исследовал'];
const DONE = 0.9; /* улица пройдена от 90% длины */
const STREETS_ZOOM = 14, PLACES_ZOOM = 13;
/* линии треков и маршрутов на векторной подложке */
const GL_OVERLAYS = ['explored', 'alt', 'approach', 'route-halo', 'route'];

const pct = (x) => {
  const v = x * 100;
  if (v > 0 && v < 0.1) return '<0,1%';
  return v.toLocaleString('ru-RU', { maximumFractionDigits: v < 10 ? 1 : 0 }) + '%';
};
/* 10 ступеней заливки: 0–10%, 10–20%, …, 90–100%; ноль — без заливки */
const stepOf = (share) => (share > 0 ? Math.min(9, Math.floor(share * 10)) : -1);
const bar = (share) => el('div', { class: 'bar' }, el('div', { style: `width:${Math.min(100, share * 100).toFixed(1)}%` }));

export function initCoverageMap(app) {
  const { map, S } = app;
  const C = app.coverage;
  const mapEl = map.getContainer();

  /* ---------- слои ---------- */
  const pane = (name, z) => { map.createPane(name); map.getPane(name).style.zIndex = z; return name; };
  const maskR = L.svg({ pane: pane('covMask', 384), padding: 0.5 });
  const fillR = L.svg({ pane: pane('covFill', 386), padding: 0.3 });
  const lineR = L.canvas({ pane: pane('covLines', 388), padding: 0.3 });
  const topR = L.svg({ pane: pane('covTop', 430), padding: 0.3 });
  const G = { base: L.layerGroup(), fill: L.layerGroup(), lines: L.layerGroup(), sel: L.layerGroup(), places: L.layerGroup() };

  let active = false, built = false, selected = null, tab = 'streets', sortBy = 'share', streetShown = 60;
  let placeCat = 'all', placeDist = 'all', placeShown = 40, dCat = 'all';
  const polys = new Map(), stats = new Map();
  const lineCache = new Map();
  let met = new Set(), version = 0, allLoaded = false;

  /* ---------- данные ---------- */
  const idx = () => C.index;
  const info = (id) => idx().d.find((d) => d.id === id);
  async function computeStats() {
    await Promise.all(app.tracks.items.map((t) => C.ensure(t).catch(() => null)));
    met = C.met();
    stats.clear();
    for (const id of C.touched()) {
      try { stats.set(id, await C.stats(id)); } catch (e) { /* район не загрузился */ }
    }
    version++;
  }
  const shareOf = (id) => (stats.get(id) || { share: 0 }).share;
  const doneOf = (id) => (stats.get(id) || { done: 0 }).done;
  const stateOf = (id, i, park, cat, name) => {
    if (store.visited[C.placeKey(id, cat, name)]) return 2;
    return met.has((park ? 'p' : '') + id + ':' + i) ? 1 : 0;
  };
  function placesOf(dist) {
    return [
      ...dist.parks.map((p, i) => {
        const c = p.rings[0].reduce((a, q) => [a[0] + q[0] / p.rings[0].length, a[1] + q[1] / p.rings[0].length], [0, 0]);
        return { id: dist.id, i, park: true, n: p.n, c: 'park', lat: c[0], lon: c[1], rings: p.rings };
      }),
      ...dist.objects.map((o, i) => ({ id: dist.id, i, park: false, n: o.n, c: o.c, lat: o.lat, lon: o.lon, s: o.s }))
    ].map((p) => ({ ...p, st: stateOf(p.id, p.i, p.park, p.c, p.n) }));
  }

  /* ---------- основа карты: маска за МКАД, районы ---------- */
  async function build() {
    if (built) return;
    const ring = Core.decodeRing(idx().mkad);
    const world = [[-85, -180], [-85, 180], [85, 180], [85, -180]];
    G.base.addLayer(L.polygon([world, ring], { renderer: maskR, className: 'cov-mask', interactive: false }));
    G.base.addLayer(L.polygon(ring, { renderer: maskR, className: 'cov-mute', interactive: false }));
    G.base.addLayer(L.polyline([...ring, ring[0]], { renderer: maskR, className: 'cov-mkad', interactive: false }));
    const dIdx = await app.loadDistricts();
    for (const d of idx().d) {
      const src = dIdx.list.find((x) => x.id === d.id);
      if (!src) continue;
      const poly = L.polygon(src.p, { renderer: fillR, className: 'cov-d' });
      poly.bindTooltip(() => d.n + ' · ' + pct(shareOf(d.id)), { sticky: true, direction: 'top', offset: [0, -8], className: 'dtip' });
      poly.on('click', (e) => { L.DomEvent.stop(e); select(d.id); });
      G.fill.addLayer(poly);
      polys.set(d.id, poly);
    }
    built = true;
  }
  function paintFills() {
    for (const [id, poly] of polys) {
      const p = poly.getElement();
      if (!p) continue;
      const k = stepOf(shareOf(id));
      p.setAttribute('class', 'leaflet-interactive cov-d ' + (store.layers.covOutline ? 'outline' : k < 0 ? 'empty' : 'cv' + k) + (id === selected ? ' sel' : ''));
    }
  }

  /* ---------- улицы ---------- */
  const ll = (dist, p) => [dist.probes[2 * p + 1] / Core.KY, dist.probes[2 * p] / Core.KX];
  function segLine(dist, s) {
    const out = [];
    for (let p = dist.probeStart[s]; p < dist.probeStart[s + 1]; p++) out.push(ll(dist, p));
    return out;
  }
  /* участки → две ломаные (пройдено / нет), соседние участки одной цепочки склеиваются */
  function linesFor(dist) {
    const key = version + ':' + cssVar('ink');
    const hit = lineCache.get(dist.id);
    if (hit && hit.key === key) return hit.layers;
    const cov = C.covered(dist.id), runs = [[], []];
    let cur = null, curState = -1, last = null;
    for (let s = 0; s < dist.segLen.length; s++) {
      const st = cov.has(s) ? 0 : 1, line = segLine(dist, s);
      const joins = cur && st === curState && last && last[0] === line[0][0] && last[1] === line[0][1];
      if (joins) cur.push(...line.slice(1));
      else { cur = line; runs[st].push(cur); curState = st; }
      last = line[line.length - 1];
    }
    const layers = [
      L.polyline(runs[1], { renderer: lineR, color: cssVar('ink-muted'), weight: 1, opacity: 0.6, interactive: false }),
      L.polyline(runs[0], { renderer: lineR, color: cssVar('ink'), weight: 2.4, opacity: 0.95, interactive: false, lineCap: 'round' })
    ];
    lineCache.set(dist.id, { key, layers });
    return layers;
  }
  const inView = (minZoom) => {
    if (map.getZoom() < minZoom) return [];
    const b = map.getBounds();
    return idx().d.filter((d) => !(d.b[0] > b.getNorth() || d.b[2] < b.getSouth() || d.b[1] > b.getEast() || d.b[3] < b.getWest())).map((d) => d.id);
  };
  let drawSeq = 0;
  async function drawStreets() {
    const seq = ++drawSeq;
    const ids = new Set(inView(STREETS_ZOOM));
    if (selected) ids.add(selected);
    const dists = [];
    for (const id of ids) { try { dists.push(await C.district(id)); } catch (e) { /* нет файла */ } }
    if (seq !== drawSeq || !active) return;
    G.lines.clearLayers();
    for (const d of dists) for (const l of linesFor(d)) G.lines.addLayer(l);
  }

  /* ---------- места на карте ---------- */
  async function drawPlaces() {
    G.places.clearLayers();
    if (!store.layers.covPlaces) return;
    const ids = new Set(inView(PLACES_ZOOM));
    if (selected) ids.add(selected);
    for (const id of ids) {
      let dist;
      try { dist = await C.district(id); } catch (e) { continue; }
      if (!active) return;
      for (const p of placesOf(dist)) {
        if (p.park) {
          G.places.addLayer(L.polygon(p.rings, { renderer: topR, className: 'cov-park st' + p.st, interactive: false }));
        }
        const m = L.circleMarker([p.lat, p.lon], { renderer: topR, radius: p.park ? 4 : 5, className: 'cov-pl st' + p.st });
        m.bindPopup(() => placePopup(p));
        G.places.addLayer(m);
      }
    }
  }
  function placePopup(p) {
    const key = C.placeKey(p.id, p.c, p.n), st = stateOf(p.id, p.i, p.park, p.c, p.n);
    const fid = 'cov:' + key;
    return el('div', { class: 'pop' },
      el('strong', null, Core.placeName({ name: p.n, cat: p.c })),
      el('div', { class: 'sub' }, [CAT[p.c], STATE[st], p.s].filter(Boolean).join(' · ')),
      el('div', { class: 'btns' },
        el('button', { class: 'btn small', type: 'button', onclick: () => { toggleVisited(p); map.closePopup(); } }, st === 2 ? 'Снять отметку' : 'Исследовал'),
        el('button', {
          class: 'btn small', type: 'button',
          onclick: () => { app.toggleForced({ id: fid, name: p.n, lat: p.lat, lon: p.lon }); map.closePopup(); }
        }, app.isForced(fid) ? 'Убрать из маршрута' : 'Провести маршрут')));
  }
  function toggleVisited(p) {
    const key = C.placeKey(p.id, p.c, p.n);
    if (store.visited[key]) delete store.visited[key]; else store.visited[key] = Date.now();
    save();
    renderAll(false);
  }
  function showPlace(p) {
    if (p.id !== selected) select(p.id, false);
    map.setView([p.lat, p.lon], Math.max(map.getZoom(), 16));
    L.popup().setLatLng([p.lat, p.lon]).setContent(placePopup(p)).openOn(map);
    if (app.sheet) app.sheet.peek();
  }

  /* ---------- панель района ---------- */
  const panel = el('div', { class: 'dpanel', id: 'dpanel', hidden: true });
  const phone = window.matchMedia('(max-width: 860px)');
  function placePanel() {
    if (phone.matches) $('#dpanelSlot').appendChild(panel);
    else mapEl.parentElement.appendChild(panel);
  }
  phone.addEventListener('change', placePanel);
  placePanel();

  /* на компьютере панель района закрывает правую часть карты */
  const fitPad = () => (phone.matches ? { padding: [30, 30] } : { paddingTopLeft: [30, 30], paddingBottomRight: [400, 30] });
  async function select(id, fit = true) {
    selected = id; tab = tab || 'streets'; streetShown = 60; dCat = 'all';
    G.sel.clearLayers();
    if (fit && polys.get(id)) map.fitBounds(polys.get(id).getBounds(), fitPad());
    try { if (!stats.has(id)) stats.set(id, await C.stats(id)); } catch (e) { /* покажем без улиц */ }
    renderAll(false);
  }
  function closePanel() { selected = null; G.sel.clearLayers(); renderAll(false); }

  function highlightStreet(dist, si) {
    G.sel.clearLayers();
    const st = dist.streets[si], lines = [];
    for (let s = st.from; s < st.to; s++) lines.push(segLine(dist, s));
    const l = L.polyline(lines, { renderer: topR, className: 'cov-hl', interactive: false });
    G.sel.addLayer(l);
    map.fitBounds(l.getBounds(), { ...fitPad(), maxZoom: 17 });
  }

  function renderPanel() {
    panel.innerHTML = '';
    panel.hidden = !selected || !active;
    if (panel.hidden) return;
    const d = info(selected), s = stats.get(selected);
    panel.append(el('div', { class: 'dp-head' },
      el('h2', null, d.n),
      el('button', { class: 'iconbtn ghost', type: 'button', 'aria-label': 'Закрыть', onclick: closePanel, html: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>' })));
    if (!s) { panel.append(el('p', { class: 'hint' }, 'Данные района не загрузились.')); return; }
    const dist = s.dist;
    const named = dist.streets.map((st, i) => ({ i, n: st.n, len: st.len, done: s.byStreet[i] })).filter((x) => x.n && x.len > 0);
    const passed = named.filter((x) => x.done / x.len >= DONE).length;
    const longest = named.filter((x) => x.done / x.len < DONE).sort((a, b) => (b.len - b.done) - (a.len - a.done))[0];
    const places = placesOf(dist);
    const metN = places.filter((p) => p.st > 0).length;
    panel.append(
      el('div', { class: 'dp-big' }, pct(s.share)),
      el('div', { class: 'muted' }, fmtKm(s.done) + ' из ' + fmtKm(s.total) + ' км'),
      bar(s.share),
      el('div', { class: 'dp-line' }, 'Пройдено улиц: ' + passed + ' из ' + named.length),
      longest ? el('div', { class: 'dp-line muted' }, 'Самая длинная непройденная: ' + longest.n + ', ' + fmtKm(longest.len - longest.done) + ' км') : null);
    const seg = el('div', { class: 'seg', role: 'group', 'aria-label': 'Раздел' },
      el('button', { type: 'button', 'data-t': 'streets' }, 'Улицы'),
      el('button', { type: 'button', 'data-t': 'places' }, 'Места · ' + metN),
      el('button', { type: 'button', 'data-t': 'about' }, 'О районе'));
    seg.addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) { tab = b.dataset.t; renderPanel(); } });
    syncSeg(seg, 't', tab);
    panel.append(seg);
    const body = el('div', { class: 'dp-body' });
    panel.append(body);

    if (tab === 'streets') {
      const sorts = el('div', { class: 'chips' }, [['share', 'по %'], ['len', 'по длине'], ['name', 'по названию']].map(([k, t]) =>
        el('button', { class: 'chip', type: 'button', 'aria-pressed': String(sortBy === k), onclick: () => { sortBy = k; renderPanel(); } }, t)));
      const list = named.slice().sort((a, b) => sortBy === 'name' ? a.n.localeCompare(b.n, 'ru')
        : sortBy === 'len' ? b.len - a.len : (b.done / b.len - a.done / a.len) || b.len - a.len);
      const rows = el('div', { class: 'srows' }, list.slice(0, streetShown).map((x) =>
        el('button', { class: 'srow', type: 'button', onclick: () => highlightStreet(dist, x.i) },
          el('span', { class: 'n' }, x.n), el('span', { class: 'k' }, fmtKm(x.len) + ' км'), el('span', { class: 'p' }, pct(x.done / x.len)))));
      const un = dist.streets.find((st) => !st.n);
      if (un && un.len) {
        const i = dist.streets.indexOf(un);
        rows.appendChild(el('div', { class: 'srow muted' }, el('span', { class: 'n' }, 'Безымянные дорожки'), el('span', { class: 'k' }, fmtKm(un.len) + ' км'), el('span', { class: 'p' }, pct(s.byStreet[i] / un.len))));
      }
      body.append(sorts, rows);
      if (list.length > streetShown) body.append(el('button', { class: 'btn small', type: 'button', onclick: () => { streetShown = Infinity; renderPanel(); } }, 'Показать все ' + list.length));
    } else if (tab === 'places') {
      body.append(catChips(places, dCat, (c) => { dCat = c; renderPanel(); }));
      const list = places.filter((p) => dCat === 'all' || p.c === dCat).sort(byState);
      body.append(el('div', { class: 'plist' }, list.map(placeRow)));
      if (!list.length) body.append(el('p', { class: 'hint' }, 'Здесь таких мест нет.'));
    } else {
      if (dist.about) {
        body.append(el('p', { class: 'about' }, dist.about.t),
          el('a', { class: 'src', href: dist.about.u, target: '_blank', rel: 'noopener' }, 'Текст: Википедия, CC BY-SA'));
      } else body.append(el('p', { class: 'hint' }, 'Справки о районе нет.'));
    }
  }
  const byState = (a, b) => (b.st - a.st) || CAT_ORDER.indexOf(a.c) - CAT_ORDER.indexOf(b.c) || a.n.localeCompare(b.n, 'ru');
  function catChips(list, cur, on) {
    const cats = CAT_ORDER.filter((c) => list.some((p) => p.c === c));
    return el('div', { class: 'chips' },
      [['all', 'Все'], ...cats.map((c) => [c, CAT[c][0].toUpperCase() + CAT[c].slice(1)])].map(([k, t]) =>
        el('button', { class: 'chip', type: 'button', 'aria-pressed': String(cur === k), onclick: () => on(k) }, t)));
  }
  function placeRow(p) {
    return el('div', { class: 'prow' },
      el('span', { class: 'pdot st' + p.st, 'aria-hidden': 'true' }),
      el('button', { class: 'pname', type: 'button', onclick: () => showPlace(p) },
        Core.placeName({ name: p.n, cat: p.c }), el('small', null, CAT[p.c] + ' · ' + STATE[p.st])),
      el('button', { class: 'btn small ghost', type: 'button', onclick: () => toggleVisited(p) }, p.st === 2 ? 'Снять' : 'Исследовал'));
  }

  /* ---------- вкладка: сводка, районы, места ---------- */
  function renderCards() {
    const I = idx();
    let done = 0;
    for (const id of stats.keys()) done += doneOf(id);
    const visited = Object.keys(store.visited);
    const vPark = visited.filter((k) => k.split('|')[1] === 'park').length;
    const metObj = [...met].filter((k) => k[0] !== 'p').length, metPark = met.size - metObj;
    const obTotal = I.d.reduce((s, d) => s + d.ob, 0), pkTotal = I.d.reduce((s, d) => s + d.pk, 0);
    const card = (label, big, sub) => el('div', { class: 'ccard' }, el('div', { class: 'muted' }, label), el('div', { class: 'cbig' }, big), el('div', { class: 'muted' }, sub));
    $('#covCards').replaceChildren(
      card('Улицы МКАД', pct(done / (I.km * 1000)), fmtKm(done) + ' из ' + Math.round(I.km).toLocaleString('ru-RU') + ' км'),
      card('Районы', [...polys.keys()].filter((id) => shareOf(id) >= 0.05).length + ' / ' + I.d.length, 'с покрытием от 5%'),
      card('Места', metObj + ' / ' + obTotal.toLocaleString('ru-RU'), 'встречено · ' + (visited.length - vPark) + ' исследовал'),
      card('Парки', metPark + ' / ' + pkTotal, 'встречено · ' + vPark + ' исследовал'));
  }
  function renderDistricts() {
    const list = idx().d.slice().sort((a, b) => (shareOf(b.id) - shareOf(a.id)) || a.n.localeCompare(b.n, 'ru'));
    $('#covDistricts').replaceChildren(...list.map((d) =>
      el('button', { class: 'drow' + (d.id === selected ? ' on' : ''), type: 'button', onclick: () => select(d.id) },
        el('span', { class: 'n' }, d.n), bar(shareOf(d.id)), el('span', { class: 'p' }, pct(shareOf(d.id))))));
  }
  async function renderPlaceList() {
    const box = $('#covPlaces');
    const dists = [];
    for (const d of idx().d) {
      if (placeDist !== 'all' && d.id !== Number(placeDist)) continue;
      const p = loadedDist(d.id);
      if (p) dists.push(p);
    }
    const all = dists.flatMap(placesOf);
    const list = all.filter((p) => placeCat === 'all' || p.c === placeCat).sort(byState);
    box.replaceChildren(
      catChips(all, placeCat, (c) => { placeCat = c; placeShown = 40; renderPlaceList(); }),
      el('div', { class: 'plist' }, list.slice(0, placeShown).map((p) => {
        const row = placeRow(p);
        if (placeDist === 'all') row.querySelector('small').append(' · ' + info(p.id).n);
        return row;
      })),
      list.length > placeShown ? el('button', { class: 'btn small', type: 'button', onclick: () => { placeShown += 80; renderPlaceList(); } }, 'Показать ещё') : '',
      allLoaded ? '' : el('p', { class: 'hint' }, 'Загружаем места всех районов…'));
  }
  /* файлы районов: уже разобранные, без ожидания */
  const decoded = new Map();
  const loadedDist = (id) => decoded.get(id) || null;
  async function loadAll() {
    const ids = idx().d.map((d) => d.id);
    let n = 0;
    const worker = async () => {
      while (ids.length) {
        const id = ids.shift();
        try { decoded.set(id, await C.district(id)); } catch (e) { /* пропустим */ }
        if (++n % 15 === 0 && active) renderPlaceList();
      }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
    allLoaded = true;
    if (active) renderPlaceList();
  }
  function fillDistSelect() {
    const sel = $('#placeDist');
    sel.replaceChildren(el('option', { value: 'all' }, 'Все районы'),
      ...idx().d.slice().sort((a, b) => a.n.localeCompare(b.n, 'ru')).map((d) => el('option', { value: String(d.id) }, d.n)));
    sel.value = placeDist;
  }
  $('#placeDist').addEventListener('change', (e) => { placeDist = e.target.value; placeShown = 40; renderPlaceList(); });

  function renderAll(redrawStreets = true) {
    if (!active) { renderPanel(); return; }
    paintFills(); renderCards(); renderDistricts(); renderPanel(); renderPlaceList();
    if (redrawStreets) drawStreets();
    drawPlaces();
  }

  /* ---------- переключатели ---------- */
  const syncChecks = () => { $('#covOutline').checked = store.layers.covOutline; $('#covPlacesOn').checked = store.layers.covPlaces; };
  $('#covOutline').addEventListener('change', (e) => { store.layers.covOutline = e.target.checked; save(); paintFills(); });
  $('#covPlacesOn').addEventListener('change', (e) => { store.layers.covPlaces = e.target.checked; save(); drawPlaces(); });
  $('#covLegend').replaceChildren(...[...Array(10)].map((_, k) => el('span', { class: 'cv' + k, title: k * 10 + '–' + (k + 1) * 10 + '%' })));

  /* ---------- вход и выход из режима ---------- */
  async function enter() {
    active = true;
    mapEl.classList.add('cov');
    /* треки и маршруты нарисованы на векторной подложке: прячем их там */
    if (app.gl) for (const id of GL_OVERLAYS) app.gl.visible(id, false);
    for (const g of Object.values(G)) g.addTo(map);
    syncChecks();
    if (!(await C.ready)) { $('#covNote').hidden = false; return; }
    if (!active) return;
    await build();
    if (!decoded.size) { fillDistSelect(); loadAll(); }
    await computeStats();
    if (active) renderAll();
  }
  function leave() {
    active = false; drawSeq++;
    mapEl.classList.remove('cov');
    if (app.gl) for (const id of GL_OVERLAYS) app.gl.visible(id, true);
    app.syncLayers();
    for (const g of Object.values(G)) map.removeLayer(g);
    panel.hidden = true;
  }
  app.on('tab', () => { if (app.tab === 'progress') enter(); else if (active) leave(); });
  const refresh = async () => { if (!active) return; await computeStats(); renderAll(); };
  app.on('explored', refresh);
  app.on('coverage', refresh);
  app.on('theme', () => { lineCache.clear(); if (active) drawStreets(); });
  map.on('moveend', () => { if (active) { drawStreets(); drawPlaces(); } });
  S.coverageSelect = select;
}
