/* «Верёвка»: выбранный маршрут тянут мышью или пальцем.
   Притяжение — маршрут обязан пройти через точку; отталкивание (Shift, на телефоне — меню) — обходит круг.
   После правки маршрут перестраивается под ту же дистанцию и остаётся похожим на прежний. */
import L from 'leaflet';
import * as Core from '../core/index.js';
import { store, save } from '../storage/store.js';
import { divIcon, cssVar } from '../map/map.js';
import { el, uid, round5, toast } from './dom.js';

const REPEL_R = 150;
const LONG_PRESS = 400;

export function initRope(app) {
  const { map, S, svg, svgTop } = app;
  const rope = L.layerGroup().addTo(map);
  const preview = L.layerGroup().addTo(map);

  let lenCost = null, lenFor = null;
  function lc(g) {
    if (lenFor !== g) {
      lenCost = new Float64Array(g.E);
      for (let e = 0; e < g.E; e++) lenCost[e] = g.eLen[e] + g.eFix[e];
      lenFor = g;
    }
    return lenCost;
  }
  const router = (g) => { if (!S.router) S.router = Core.makeRouter(g); return S.router; };
  const sel = () => S.routes[S.sel];
  const editable = () => !!(sel() && S.lastGen && S.lastGen.g === S.graph && !S.busy);
  const edits = (r) => r.edits || { pulls: [], repels: [] };
  const ringOf = (r) => r.nodes.slice(r.apN - 1, r.apN - 1 + r.ringN);

  /* ---------- на карте ---------- */
  function render() {
    rope.clearLayers(); preview.clearLayers();
    const r = sel();
    if (!r || !S.routeLayers || !S.lastGen) return;
    const hit = L.polyline(r.ringCoords || r.coords, { renderer: svgTop, className: 'rope-hit', interactive: true, weight: 18 });
    rope.addLayer(hit);
    const line = S.routeLayers.line;
    hit.on('mouseover', () => { if (editable()) line.setStyle({ weight: 6.5 }); });
    hit.on('mouseout', () => line.setStyle({ weight: 5 }));
    const path = hit.getElement();
    L.DomEvent.on(path, 'mousedown', onMouseDown);
    path.addEventListener('touchstart', onTouchStart, { passive: false });

    const e = edits(r);
    e.pulls.forEach((p, i) => {
      const m = L.marker([p.lat, p.lon], { icon: divIcon('mk-bead', 14, 14), draggable: true, title: 'Точка притяжения', keyboard: false });
      m.on('dragend', () => {
        const ll = m.getLatLng(), s = snap(ll);
        if (!s) { toast('Рядом нет улицы. Точка осталась на месте.'); render(); return; }
        const pulls = e.pulls.slice(); pulls[i] = s;
        rebuild({ pulls, repels: e.repels });
      });
      m.bindPopup(() => el('div', { class: 'pop' }, el('strong', null, 'Точка притяжения'),
        el('button', { class: 'btn small', type: 'button', onclick: () => { map.closePopup(); rebuild({ pulls: e.pulls.filter((_, k) => k !== i), repels: e.repels }); } }, 'Убрать')));
      rope.addLayer(m);
    });
    e.repels.forEach((c, i) => {
      const circle = L.circle(c.c, { renderer: svg, className: 'repel', radius: c.r, interactive: false });
      /* ручка радиуса — на восточном краю круга */
      const edge = () => [c.c[0], c.c[1] + c.r / (111320 * Math.cos(c.c[0] * Math.PI / 180))];
      const center = L.marker(c.c, { icon: divIcon('mk-repel', 16, 16), draggable: true, title: 'Точка отталкивания', keyboard: false });
      const handle = L.marker(edge(), { icon: divIcon('mk-rhandle', 10, 10), draggable: true, title: 'Радиус', keyboard: false });
      const change = (next) => { const repels = e.repels.slice(); repels[i] = next; rebuild({ pulls: e.pulls, repels }); };
      center.on('drag', () => { circle.setLatLng(center.getLatLng()); });
      center.on('dragend', () => { const ll = center.getLatLng(); change({ c: round5([ll.lat, ll.lng]), r: c.r }); });
      handle.on('drag', () => { circle.setRadius(Math.max(40, map.distance(c.c, handle.getLatLng()))); });
      handle.on('dragend', () => change({ c: c.c, r: Math.round(Math.max(40, Math.min(1500, map.distance(c.c, handle.getLatLng())))) }));
      center.bindPopup(() => el('div', { class: 'pop' }, el('strong', null, 'Отталкивание · ' + c.r + ' м'),
        el('button', { class: 'btn small', type: 'button', onclick: () => { map.closePopup(); rebuild({ pulls: e.pulls, repels: e.repels.filter((_, k) => k !== i) }); } }, 'Убрать'),
        el('button', {
          class: 'btn small', type: 'button', onclick: () => {
            map.closePopup();
            store.zones.push({ id: uid(), name: 'Зона ' + (store.zones.length + 1), shape: 'circle', c: c.c, r: c.r, on: true });
            save(); app.renderBlocks(); toast('Круг сохранён в «Закрытия и зоны».');
          }
        }, 'Сохранить как зону')));
      rope.addLayer(circle); rope.addLayer(center); rope.addLayer(handle);
    });
  }

  function snap(ll) {
    const g = S.graph;
    const s = g && Core.nearestNode(g, ll.lat, ll.lng, 120, 30);
    if (!s) return null;
    return { node: s.node, lat: g.lat[s.node], lon: g.lon[s.node] };
  }

  /* соседние опорные точки кольца вокруг индекса k: старт, точки притяжения, финиш */
  function neighbours(r, k) {
    const ring = ringOf(r);
    const pts = [{ i: 0, node: ring[0] }, { i: ring.length - 1, node: ring[ring.length - 1] }];
    for (const p of edits(r).pulls) { const i = ring.indexOf(p.node); if (i >= 0) pts.push({ i, node: p.node }); }
    let prev = pts[0], next = pts[1];
    for (const p of pts) {
      if (p.i <= k && p.i >= prev.i) prev = p;
      if (p.i >= k && p.i <= next.i) next = p;
    }
    return { prev, next };
  }
  function nearestIndex(r, ll) {
    const c = r.ringCoords || r.coords;
    let best = 0, bd = Infinity;
    for (let i = 0; i < c.length; i++) {
      const d = (c[i][0] - ll.lat) ** 2 + ((c[i][1] - ll.lng) * 0.56) ** 2;
      if (d < bd) { bd = d; best = i; }
    }
    return best;
  }

  /* ---------- перетаскивание ---------- */
  let drag = null;
  function begin(ll) {
    const r = sel();
    if (!editable()) return false;
    const k = nearestIndex(r, ll);
    drag = { r, ...neighbours(r, k), node: null, moved: false, raf: 0 };
    map.dragging.disable();
    S.routeLayers.line.setStyle({ opacity: 0.25 }); S.routeLayers.halo.setStyle({ opacity: 0.25 });
    return true;
  }
  /* живой предпросмотр: участок между соседними опорными точками сразу ложится по улицам */
  function move(ll) {
    if (!drag) return;
    drag.moved = true; drag.ll = ll;
    if (drag.raf) return;
    drag.raf = requestAnimationFrame(() => {
      if (!drag) return;
      drag.raf = 0;
      const g = S.graph, s = snap(drag.ll);
      preview.clearLayers();
      if (!s || g.comp[s.node] !== g.comp[drag.prev.node]) {
        preview.addLayer(L.polyline([[g.lat[drag.prev.node], g.lon[drag.prev.node]], [drag.ll.lat, drag.ll.lng], [g.lat[drag.next.node], g.lon[drag.next.node]]],
          { color: cssVar('map-route'), weight: 2.5, dashArray: '5 4', interactive: false }));
        drag.node = null;
        return;
      }
      const R = router(g), cost = lc(g);
      const a = R.route(cost, drag.prev.node, s.node, null, 1), b = R.route(cost, s.node, drag.next.node, null, 1);
      if (!a || !b) return;
      const coords = a.nodes.concat(b.nodes.slice(1)).map((v) => [g.lat[v], g.lon[v]]);
      preview.addLayer(L.polyline(coords, { color: cssVar('map-route'), weight: 4, opacity: 1, interactive: false, lineCap: 'round', lineJoin: 'round' }));
      preview.addLayer(L.marker([s.lat, s.lon], { icon: divIcon('mk-bead', 14, 14), interactive: false, keyboard: false }));
      drag.node = s;
    });
  }
  function end(repel) {
    if (!drag) return;
    const d = drag; drag = null;
    cancelAnimationFrame(d.raf);
    map.dragging.enable();
    preview.clearLayers();
    if (S.routeLayers) { S.routeLayers.line.setStyle({ opacity: 1, weight: 5 }); S.routeLayers.halo.setStyle({ opacity: 1 }); }
    if (!d.moved) return;
    const e = edits(d.r);
    if (repel) { rebuild({ pulls: e.pulls, repels: [...e.repels, { c: round5([d.ll.lat, d.ll.lng]), r: REPEL_R }] }); return; }
    /* предпросмотр мог не успеть отрисоваться: точку ищем ещё раз */
    if (!d.node) {
      const s = snap(d.ll);
      if (s && S.graph.comp[s.node] === S.graph.comp[d.prev.node]) d.node = s;
    }
    if (!d.node) { toast('Рядом нет улицы, до которой можно дотянуть маршрут.'); return; }
    rebuild({ pulls: [...e.pulls, d.node], repels: e.repels });
  }

  function onMouseDown(ev) {
    if (ev.button !== 0) return;
    L.DomEvent.stop(ev);
    if (!begin(map.mouseEventToLatLng(ev))) return;
    const mm = (e) => move(map.mouseEventToLatLng(e));
    const mu = (e) => { document.removeEventListener('mousemove', mm); document.removeEventListener('mouseup', mu); end(e.shiftKey); };
    document.addEventListener('mousemove', mm);
    document.addEventListener('mouseup', mu);
  }

  /* Палец: обычный свайп по линии двигает карту, долгое нажатие — тянуть или меню. */
  function onTouchStart(ev) {
    if (ev.touches.length !== 1 || !editable()) return;
    ev.preventDefault(); ev.stopPropagation();
    const t0 = ev.touches[0];
    let last = { x: t0.clientX, y: t0.clientY }, armed = false, panning = false;
    const llOf = (t) => map.mouseEventToLatLng(t);
    const timer = setTimeout(() => {
      if (panning) return;
      armed = true;
      if (navigator.vibrate) navigator.vibrate(15);
      begin(llOf(t0));
    }, LONG_PRESS);
    const tm = (e) => {
      const t = e.touches[0];
      e.preventDefault();
      if (armed) {
        if (Math.hypot(t.clientX - t0.clientX, t.clientY - t0.clientY) > 8) move(llOf(t));
      } else {
        if (Math.hypot(t.clientX - t0.clientX, t.clientY - t0.clientY) > 10) panning = true;
        if (panning) map.panBy([last.x - t.clientX, last.y - t.clientY], { animate: false });
      }
      last = { x: t.clientX, y: t.clientY };
    };
    const te = () => {
      clearTimeout(timer);
      document.removeEventListener('touchmove', tm);
      document.removeEventListener('touchend', te);
      document.removeEventListener('touchcancel', te);
      if (!armed) return;
      if (drag && drag.moved) { end(false); return; }
      if (drag) end(false);
      menu(llOf(t0));
    };
    document.addEventListener('touchmove', tm, { passive: false });
    document.addEventListener('touchend', te);
    document.addEventListener('touchcancel', te);
  }

  /* меню долгого нажатия без движения */
  function menu(ll) {
    const r = sel(); if (!r) return;
    const e = edits(r);
    L.popup({ closeButton: false }).setLatLng(ll).setContent(el('div', { class: 'pop' },
      el('button', {
        class: 'btn small primary', type: 'button', onclick: () => {
          map.closePopup();
          const s = snap(ll);
          if (!s) { toast('Рядом нет улицы.'); return; }
          rebuild({ pulls: [...e.pulls, s], repels: e.repels });
        }
      }, 'Притянуть сюда'),
      el('button', { class: 'btn small', type: 'button', onclick: () => { map.closePopup(); rebuild({ pulls: e.pulls, repels: [...e.repels, { c: round5([ll.lat, ll.lng]), r: REPEL_R }] }); } }, 'Оттолкнуть отсюда'))).openOn(map);
  }

  /* ---------- перестройка под ту же дистанцию ---------- */
  async function rebuild(next) {
    const r = sel(), o = S.lastGen;
    if (!r || !o || S.busy) return;
    const g = o.g, ring = ringOf(r), start = ring[0], finish = ring[ring.length - 1];
    const R = router(g), cost = lc(g);
    const len = (res) => res.edges.reduce((s, e) => s + g.eLen[e], 0);

    /* честная проверка: через новую точку кольцо может стать длиннее заданного */
    for (const p of next.pulls) {
      const a = R.route(cost, start, p.node, null, 1), b = R.route(cost, p.node, finish, null, 1);
      if (!a || !b) { app.say('До этой точки нет пути без закрытий и зон. Правка не применена.', 'warn'); render(); return; }
      const min = len(a) + len(b) + 2 * (r.approach || 0);
      if (min > o.length * (1 + o.tol)) {
        app.say('Через эту точку кольцо не короче ' + app.fmtKm(min) + ' км. Уберите точку или увеличьте дистанцию.', 'warn');
        render(); return;
      }
    }

    const spec = app.blocksSpec();
    Core.applyBlocks(g, { ...spec, zones: [...spec.zones, ...next.repels.map((c) => ({ shape: 'circle', c: c.c, r: c.r }))] });
    const ac = new AbortController(); S.abort = ac;
    app.setBusy(true); app.say('Перестраиваю маршрут…');
    try {
      const home = r.apN > 1 || !!o.exits;
      const opts = {
        ...o, A: start, B: finish, prefer: r.edges, maxAttempts: 450,
        /* опорные точки прежнего варианта — первыми кандидатами: форма меняется только там, где тянули */
        keep: r.via || [],
        forced: [...o.forced, ...next.pulls.map((p) => p.node)],
        exits: home ? [r.nodes[0]] : null, ringStart: home ? start : null
      };
      const res = await app.runGenerator(opts, 4, ac, 0.05);
      /* в допуск — самый похожий на прежний; иначе ближайший по длине */
      const ok = res.routes.filter((x) => !x.off);
      const nr = ok.length ? ok[0] : res.routes.reduce((b, x) => (!b || x.err < b.err ? x : b), null);
      if (!nr) {
        app.say('С этой правкой кольцо ' + app.fmtKm(o.length) + ' км не получилось. Правка не применена.', 'warn');
      } else {
        nr.edits = { pulls: next.pulls, repels: next.repels };
        nr.history = [...(r.history || []), r];
        S.routes[S.sel] = nr;
        app.say(nr.off
          ? 'С этой правкой кольцо ' + app.fmtKm(o.length) + ' км не укладывается: ближайший вариант ' + app.fmtKm(nr.length) + ' км. «Отменить шаг» вернёт прежний маршрут.'
          : 'Маршрут перестроен: ' + app.fmtKm(nr.length) + ' км.', nr.off ? 'warn' : '');
        app.renderResults(); app.drawRoutes(false);
      }
    } catch (e) {
      if (e && e.name === 'AbortError') app.say('Перестройка отменена.');
      else app.say((e && e.message) || 'Не удалось перестроить маршрут.', 'warn');
    } finally {
      Core.applyBlocks(g, spec);
      app.setBusy(false); S.abort = null;
      render();
    }
  }

  function restore(to) {
    if (!to) return;
    S.routes[S.sel] = to;
    app.renderResults(); app.drawRoutes(false);
    app.say('Маршрут: ' + app.fmtKm(to.length) + ' км.');
  }
  app.ropeUndo = () => { const r = sel(); if (r && r.history && r.history.length && !S.busy) restore(r.history[r.history.length - 1]); };
  app.ropeReset = () => { const r = sel(); if (r && r.history && r.history.length && !S.busy) restore(r.history[0]); };
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'z' && !/INPUT|TEXTAREA/.test(document.activeElement.tagName)) {
      const r = sel();
      if (r && r.history && r.history.length) { e.preventDefault(); app.ropeUndo(); }
    }
  });

  app.on('routeDrawn', render);
}
