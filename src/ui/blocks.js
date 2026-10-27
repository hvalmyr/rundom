/* Закрытия и запретные зоны: отметки пользователя, которые генератор обходит.
   Хранятся только на устройстве (localStorage). */
import L from 'leaflet';
import * as Core from '../core/index.js';
import { store, save } from '../storage/store.js';
import { divIcon } from '../map/map.js';
import { $, el, uid, round5, toast, renameable, iconBtn } from './dom.js';

const CROSS = '<svg viewBox="0 0 8 8" aria-hidden="true"><path d="M1 1l6 6M7 1L1 7"/></svg>';
const BAR = '<svg viewBox="0 0 8 8" aria-hidden="true"><path d="M1 4h6M1 1v6M7 1v6"/></svg>';
const ZONE = '<svg viewBox="0 0 8 8" aria-hidden="true"><path d="M1 1h6v6H1z"/></svg>';
const OPEN = '<svg viewBox="0 0 8 8" aria-hidden="true"><path d="M1 4h6"/></svg>';

export function initBlocks(app) {
  const { map, layers, S, svg } = app;

  /* ---------- на карте ---------- */
  function bar(p, q) {
    const deg = Core.bearing(p[0], p[1], q[0], q[1]);
    return L.marker(p, {
      icon: divIcon('', 14, 14, `<div class="mk-bar" style="transform:rotate(${Math.round(deg + 90)}deg)"></div>`),
      interactive: false, keyboard: false
    });
  }
  function renderMap() {
    layers.zones.clearLayers(); layers.blocks.clearLayers();
    for (const z of store.zones) {
      const o = { renderer: svg, className: 'zone' + (z.on ? '' : ' off'), interactive: false };
      layers.zones.addLayer(z.shape === 'circle' ? L.circle(z.c, { ...o, radius: z.r }) : L.polygon(z.ring, o));
    }
    for (const b of store.blocks) {
      if (b.type === 'gate') {
        layers.blocks.addLayer(L.marker(b.p, { icon: divIcon('mk-closed', 16, 16, CROSS), interactive: false, keyboard: false }));
      } else {
        const ln = b.line;
        layers.blocks.addLayer(L.polyline(ln, { renderer: svg, className: 'closed-seg', interactive: false }));
        layers.blocks.addLayer(bar(ln[0], ln[1]));
        layers.blocks.addLayer(bar(ln[ln.length - 1], ln[ln.length - 2]));
      }
    }
  }

  /* ---------- список ---------- */
  function row(kind, entry, extra, onDelete) {
    return el('div', { class: 'item' + (entry.on === false ? ' off' : '') },
      extra || el('span', { class: 'kind', html: kind }),
      el('div', { class: 'grow' }, renameable(entry.name, (v) => { entry.name = v; save(); })),
      iconBtn('remove', 'Удалить ' + entry.name, onDelete, true));
  }
  function renderList() {
    const list = $('#blocksList');
    list.innerHTML = '';
    for (const z of store.zones) {
      const sw = el('input', { class: 'switch', type: 'checkbox', role: 'switch', 'aria-label': 'Учитывать зону ' + z.name });
      sw.checked = z.on;
      sw.addEventListener('change', () => { z.on = sw.checked; changed(); });
      list.appendChild(row(ZONE, z, sw, () => { store.zones = store.zones.filter((x) => x !== z); changed(); }));
    }
    for (const b of store.blocks) {
      list.appendChild(row(b.type === 'gate' ? CROSS : BAR, b, null, () => { store.blocks = store.blocks.filter((x) => x !== b); changed(); }));
    }
    for (const o of store.openGates) {
      list.appendChild(row(OPEN, o, null, () => { store.openGates = store.openGates.filter((x) => x !== o); S.graphKey = ''; changed(); }));
    }
    const n = store.zones.length + store.blocks.length + store.openGates.length;
    $('#blocksCount').textContent = n ? '· ' + n : '';
  }
  function changed() { save(); renderMap(); renderList(); app.emit('blocks'); }

  /* ---------- режимы ---------- */
  const draft = { pts: [] };
  function drawDraft(closed) {
    layers.draft.clearLayers();
    if (draft.pts.length > 1) {
      const o = { renderer: svg, className: 'zone draft', interactive: false };
      layers.draft.addLayer(closed ? L.polygon(draft.pts, o) : L.polyline(draft.pts, o));
    }
    for (const p of draft.pts) layers.draft.addLayer(L.marker(p.p || p, { icon: divIcon('mk-vertex', 8, 8), interactive: false, keyboard: false }));
  }
  const clear = () => { draft.pts = []; layers.draft.clearLayers(); };
  const nextName = (base, arr) => base + ' ' + (arr.length + 1);

  function snapped(ll) {
    const g = S.graph;
    const s = g ? Core.nearestNode(g, ll.lat, ll.lng, 40) : null;
    return s ? { p: round5([g.lat[s.node], g.lon[s.node]]), node: s.node } : { p: round5([ll.lat, ll.lng]), node: null };
  }

  /* Линия отрезка по улице между отметками; null, если улиц ещё нет или путь в обход. */
  function streetLine(a, b) {
    const g = S.graph;
    if (!g) return null;
    const na = Core.nearestNode(g, a[0], a[1], 30), nb = Core.nearestNode(g, b[0], b[1], 30);
    if (!na || !nb) return null;
    if (!S.router) S.router = Core.makeRouter(g);
    const saved = g.eBlock; g.eBlock = null;
    const path = Core.shortestPath(g, S.router, na.node, nb.node);
    g.eBlock = saved;
    return path && Core.polyLength(path) < 3 * Core.hav(a[0], a[1], b[0], b[1]) + 50 ? path.map(round5) : null;
  }
  /* отрезки, отмеченные до загрузки улиц, ложатся на улицы после построения графа */
  app.snapBlocks = () => {
    let n = 0;
    for (const b of store.blocks) {
      if (b.type !== 'segment' || b.line.length > 2) continue;
      const ln = streetLine(b.a, b.b);
      if (ln) { b.line = ln; n++; }
    }
    if (n) { save(); renderMap(); }
  };

  /* закрыто: одна точка и «Готово» — калитка, вторая точка — отрезок по улице между ними */
  app.registerMode('closed', {
    click(ll) {
      const s = snapped(ll);
      if (!draft.pts.length) { draft.pts.push(s); drawDraft(false); return; }
      const a = draft.pts[0];
      store.blocks.push({ id: uid(), type: 'segment', name: 'Закрытый отрезок', a: a.p, b: s.p, line: streetLine(a.p, s.p) || [a.p, s.p] });
      app.setMode(null); changed();
    },
    ok() {
      if (!draft.pts.length) { toast('Нажмите на закрытый проход на карте.'); return; }
      store.blocks.push({ id: uid(), type: 'gate', name: 'Калитка', p: draft.pts[0].p });
      app.setMode(null); changed();
    },
    leave: clear
  });
  $('#addClosed').addEventListener('click', () => app.setMode('closed',
    'Нажмите на закрытый проход и «Готово» — это калитка. Вторая точка на той же улице отметит закрытый отрезок'));

  app.registerMode('zone', {
    click(ll) { draft.pts.push(round5([ll.lat, ll.lng])); drawDraft(true); },
    undo() { draft.pts.pop(); drawDraft(true); },
    ok() {
      if (draft.pts.length < 3) { toast('Нужно хотя бы три угла.'); return; }
      store.zones.push({ id: uid(), name: nextName('Зона', store.zones), shape: 'poly', ring: draft.pts.slice(), on: true });
      app.setMode(null); changed();
    },
    leave: clear
  });
  $('#addZone').addEventListener('click', () => app.setMode('zone', 'Нажимайте по углам зоны, затем «Готово»'));

  app.registerMode('circle', {
    click(ll) {
      const p = round5([ll.lat, ll.lng]);
      if (!draft.pts.length) { draft.pts.push(p); drawDraft(false); $('#bannerText').textContent = 'Теперь нажмите на край круга'; return; }
      const c = draft.pts[0], r = Math.round(Core.hav(c[0], c[1], p[0], p[1]));
      if (r < 15) { toast('Круг слишком маленький.'); return; }
      store.zones.push({ id: uid(), name: nextName('Зона', store.zones), shape: 'circle', c, r, on: true });
      app.setMode(null); changed();
    },
    leave: clear
  });
  $('#addCircle').addEventListener('click', () => app.setMode('circle', 'Нажмите в центр круга'));

  /* ворота из OSM, которые на деле открыты */
  app.reopenGate = (c) => {
    store.openGates.push({ id: uid(), name: 'Открытые ворота' + (c.name ? ': ' + c.name : ''), lat: c.lat, lon: c.lon });
    S.graphKey = '';
    changed();
    toast('Ворота будут считаться открытыми при следующем построении.');
  };
  app.isReopened = (c) => store.openGates.some((o) => Core.hav(o.lat, o.lon, c.lat, c.lon) < 3);

  app.blocksSpec = () => ({
    gates: store.blocks.filter((b) => b.type === 'gate').map((b) => b.p),
    segments: store.blocks.filter((b) => b.type === 'segment').map((b) => ({ a: b.a, b: b.b })),
    zones: store.zones.filter((z) => z.on)
  });
  app.renderBlocks = () => { renderMap(); renderList(); };

  renderMap(); renderList();
}
