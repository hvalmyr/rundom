/* Закрытые для пешехода ворота и пути на карте. Рисуются сразу по видимой области из своих тайлов графа
   (public/data/g), не дожидаясь построения маршрута. Где тайлов нет, берутся из графа последнего
   построения (Overpass). Правила те же, что у генератора: isBlockingBarrier и classifyWay. */
import L from 'leaflet';
import * as Core from '../core/index.js';
import { store } from '../storage/store.js';
import { viewTiles } from '../data/streets.js';
import { cssVar, divIcon } from '../map/map.js';
import { el } from './dom.js';

const GATES_ZOOM = 15, WAYS_ZOOM = 14;

export function initGates(app) {
  const { map, layers, S } = app;
  /* разобранный тайл: ворота с тегами и закрытые пути — линии */
  const parsedTiles = new Map();
  function parseTile(t) {
    let p = parsedTiles.get(t.key);
    if (p) return p;
    const parsed = Core.parseNetwork({ elements: Core.unpackNetwork(t.net) });
    const ways = [];
    for (const w of parsed.ways) {
      const c = Core.classifyWay(w.tags, {});
      if (!c || c.ok || !c.closed) continue;
      const line = [];
      for (const id of w.nodes) { const nd = parsed.nodes.get(id); if (nd) line.push([nd.lat, nd.lon]); }
      if (line.length > 1) ways.push({ id: w.id, line });
    }
    p = { barriers: parsed.barriers, ways };
    parsedTiles.set(t.key, p);
    return p;
  }

  /* что за преграда — словами, без тегов карты */
  const BARRIER = { gate: 'Ворота', lift_gate: 'Шлагбаум', swing_gate: 'Поворотный шлагбаум', sliding_gate: 'Откатные ворота',
    wall: 'Стена', fence: 'Забор', hedge: 'Живая изгородь', retaining_wall: 'Подпорная стена', city_wall: 'Крепостная стена' };
  const ACCESS = { private: 'частный проход', no: 'проход закрыт', customers: 'только для посетителей', permit: 'по пропускам',
    military: 'военный объект', delivery: 'только для доставки', destination: 'только к местам внутри' };
  function gatePopup(c) {
    return el('div', { class: 'pop' },
      el('strong', null, 'Закрытый проход'),
      el('div', { class: 'sub' }, [BARRIER[c.barrier] || 'Преграда', ACCESS[c.access], c.name].filter(Boolean).join(' · ') + '. По данным карты OpenStreetMap'),
      el('button', { class: 'btn small', type: 'button', onclick: () => { app.reopenGate(c); map.closePopup(); } }, 'На самом деле открыто'));
  }

  let seq = 0;
  async function render() {
    const my = ++seq;
    const z = map.getZoom();
    if (!store.layers.gates || z < WAYS_ZOOM || app.tab === 'progress') { layers.gates.clearLayers(); layers.closed.clearLayers(); return; }
    const b = map.getBounds().pad(0.25);
    const view = await viewTiles([b.getSouth(), b.getWest(), b.getNorth(), b.getEast()]);
    if (my !== seq) return;
    const gates = new Map(), ways = new Map();
    const inView = (lat, lon) => b.contains([lat, lon]);
    for (const t of (view && view.tiles) || []) {
      const p = parseTile(t);
      for (const nd of p.barriers) {
        if (!inView(nd.lat, nd.lon) || !Core.isBlockingBarrier(nd.tags, store.prefs.strictGates)) continue;
        gates.set(nd.id, { lat: nd.lat, lon: nd.lon, barrier: nd.tags.barrier, access: nd.tags.access || '', name: nd.tags.name || '' });
      }
      for (const w of p.ways) if (!ways.has(w.id) && w.line.some((q) => inView(q[0], q[1]))) ways.set(w.id, w.line);
    }
    /* вне тайлов — что знает граф последнего построения */
    const g = S.graph;
    if (g && !(view && view.covered)) {
      for (const c of g.closedGates) if (inView(c.lat, c.lon)) gates.set('g' + c.lat + ',' + c.lon, c);
      g.closedWays.forEach((ln, i) => { if (ln.some((q) => inView(q[0], q[1]))) ways.set('g' + i, ln); });
    }
    layers.gates.clearLayers(); layers.closed.clearLayers();
    const gray = cssVar('map-gate-osm');
    for (const ln of ways.values()) layers.closed.addLayer(L.polyline(ln, { color: gray, weight: 2, dashArray: '4 5', opacity: 0.9, interactive: false }));
    if (z < GATES_ZOOM) return;
    /* одни и те же ворота из тайла и из графа — одной отметкой */
    const seen = new Set();
    for (const c of gates.values()) {
      const k = c.lat.toFixed(6) + ',' + c.lon.toFixed(6);
      if (seen.has(k) || app.isReopened(c)) continue;
      seen.add(k);
      const m = L.marker([c.lat, c.lon], { icon: divIcon('mk-gate', 6, 18), keyboard: false, title: 'Закрыто для пешехода' });
      m.bindPopup(() => gatePopup(c));
      layers.gates.addLayer(m);
    }
  }

  let timer = null;
  const later = () => { clearTimeout(timer); timer = setTimeout(render, 250); };
  map.on('moveend', later);
  for (const ev of ['graph', 'blocks', 'layers', 'tab', 'theme']) app.on(ev, later);
  /* «строго к шлагбаумам» меняет, какие ворота закрыты */
  document.getElementById('strictGates').addEventListener('change', later);
  app.renderGates = later;
  later();
}
