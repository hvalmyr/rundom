/* Вкладка «Библиотека»: треки GPX и ручные отметки пройденных улиц. */
import L from 'leaflet';
import * as Core from '../core/index.js';
import { store, save } from '../storage/store.js';
import { cssVar, divIcon } from '../map/map.js';
import { $, el, fmtKm, uid, round5, toast } from './dom.js';

const KIND = { gpx: 'GPX', route: 'маршрут', manual: 'вручную' };

export function initLibraryPanel(app) {
  const { map, layers, S } = app;
  const lineKm = (lines) => lines.reduce((s, l) => s + Core.polyLength(l), 0);

  function fitLines(entries) {
    const pts = entries.flatMap((en) => en.lines.flat());
    if (pts.length) map.fitBounds(L.latLngBounds(pts), { padding: [40, 40] });
  }

  function render() {
    layers.explored.clearLayers();
    const color = cssVar('map-explored');
    const list = $('#exploredList');
    list.innerHTML = '';
    for (const en of store.explored) {
      for (const ln of en.lines) {
        layers.explored.addLayer(L.polyline(ln, { color, weight: 2.5, opacity: 0.9, lineCap: 'round', lineJoin: 'round', interactive: false }));
      }
    }
    for (const en of store.explored.slice().reverse()) {
      list.appendChild(el('div', { class: 'item' },
        el('div', { class: 'grow' },
          el('div', { class: 'name' }, en.name),
          el('div', { class: 'meta' }, fmtKm(en.km || 0) + ' км · ' + (KIND[en.kind] || '') + ' · ' + (en.added || ''))),
        el('button', { class: 'btn small', type: 'button', onclick: () => { fitLines([en]); app.sheet.peek(); } }, 'Показать'),
        el('button', {
          class: 'btn small ghost', type: 'button', 'aria-label': 'Удалить ' + en.name,
          onclick: () => { store.explored = store.explored.filter((x) => x.id !== en.id); render(); save(); }
        }, 'Удалить')));
    }
    if (!store.explored.length) list.appendChild(el('p', { class: 'empty' }, 'Здесь появятся ваши пробежки.'));
    app.emit('explored');
  }

  function addExplored(name, kind, lines) {
    const clean = lines.map((l) => Core.simplifyDP(l, 4).map(round5)).filter((l) => l.length > 1);
    if (!clean.length) return false;
    store.explored.push({ id: uid(), name, kind, added: new Date().toLocaleDateString('ru-RU'), lines: clean, km: lineKm(clean) });
    render(); save();
    return true;
  }
  app.addExplored = addExplored;
  app.renderExplored = render;

  $('#importGpx').addEventListener('click', () => $('#gpxFiles').click());
  $('#gpxFiles').addEventListener('change', async (e) => {
    const files = Array.from(e.target.files || []);
    let ok = 0, empty = 0;
    for (const f of files) {
      try {
        const gpx = Core.parseGPX(await f.text());
        if (addExplored(gpx.name || f.name.replace(/\.gpx$/i, ''), 'gpx', gpx.tracks)) ok++; else empty++;
      } catch (err) { empty++; }
    }
    e.target.value = '';
    toast('Загружено файлов: ' + ok + (empty ? ', без трека: ' + empty : ''));
    if (ok) fitLines(store.explored.slice(-ok));
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
      addExplored('Отметка ' + new Date().toLocaleDateString('ru-RU'), 'manual', [draft.coords.slice()]);
      app.setMode(null);
    },
    leave: clearDraft
  });
  $('#drawBtn').addEventListener('click', () => {
    app.setMode('draw', S.graph
      ? 'Кликайте по улицам вдоль пройденного пути: между точками линия ляжет по улицам'
      : 'Кликайте вдоль пройденного пути. После первого построения маршрута линия будет прилипать к улицам');
  });

  app.on('theme', render);
  render();
}
