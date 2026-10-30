/* «Свой маршрут»: человек сам ставит точки на карте, между ними линия ложится по улицам.
   Нажатие на карту — новая точка в конце; точку можно перетащить, двойной щелчок её убирает.
   Линию можно схватить и потянуть: между соседними точками появится новая, а маршрут перестраивается на ходу.
   Результат — такая же карточка, как у подобранных вариантов: звезда, GPX, ссылка; «Сохранить» кладёт его в библиотеку с пометкой «свой». */
import L from 'leaflet';
import * as Core from '../core/index.js';
import { store, save } from '../storage/store.js';
import { ui, saveUi } from '../storage/session.js';
import { divIcon } from '../map/map.js';
import { $, uid, fmtKm, syncSeg, toast, userMessage } from './dom.js';

const round5 = (p) => [Math.round(p[0] * 1e5) / 1e5, Math.round(p[1] * 1e5) / 1e5];
/* зона захвата линии, пикселей: с пальцем шире */
const GRAB = L.Browser.mobile ? 22 : 15;
const LIVE_MS = 90, MORPH_MS = 170;
/* на телефоне при перетаскивании точки сверху появляется поле: отпущенная в нём точка удаляется */
const TRASH = L.Browser.mobile || matchMedia('(pointer: coarse)').matches;

export function initCustomRoute(app) {
  const { map, S } = app;
  const mapEl = map.getContainer();
  const custom = ui.custom || { pts: [], loop: false };
  const keep = () => { ui.custom = { pts: custom.pts, loop: custom.loop, id: custom.id }; saveUi(); };
  custom.id ||= uid();
  /* История действий: снимки точек и признака «вернуться к старту». Ctrl+Z — назад, Ctrl+Shift+Z (или Ctrl+Y) — вперёд. */
  const snap = () => JSON.stringify({ pts: custom.pts, loop: custom.loop });
  let hist = [snap()], hi = 0;
  const commit = () => {
    const s = snap();
    if (s === hist[hi]) return;
    hist = hist.slice(0, hi + 1); hist.push(s);
    if (hist.length > 100) hist.shift();
    hi = hist.length - 1;
  };
  function restore(i) {
    if (i < 0 || i >= hist.length) return;
    hi = i;
    const s = JSON.parse(hist[i]);
    custom.pts = s.pts; custom.loop = s.loop;
    $('#customLoop').checked = custom.loop;
    keep(); drawMarkers(); rebuild();
  }
  const undo = () => restore(hi - 1), redo = () => restore(hi + 1);
  const markerLayer = L.layerGroup().addTo(map);
  const trash = document.createElement('div');
  trash.className = 'trashzone'; trash.hidden = true; trash.setAttribute('aria-hidden', 'true');
  trash.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg>';
  mapEl.parentElement.appendChild(trash);
  const trashShow = (on) => { if (TRASH) { trash.hidden = !on; if (!on) trash.classList.remove('over'); } };
  /* точка (в пикселях контейнера карты) над полем? */
  function overTrash(cp) {
    if (trash.hidden) return false;
    const r = trash.getBoundingClientRect(), m = mapEl.getBoundingClientRect();
    const x = m.left + cp.x, y = m.top + cp.y, pad = 14;
    const over = x >= r.left - pad && x <= r.right + pad && y >= r.top - pad && y <= r.bottom + pad;
    trash.classList.toggle('over', over);
    return over;
  }
  let markers = [];
  /* варианты каждого вида ждут своей очереди: при переключении они меняются местами */
  const stash = { auto: null, custom: null };
  let seq = 0, ac = null;

  const kind = () => (store.prefs.routeKind === 'custom' ? 'custom' : 'auto');
  const active = () => kind() === 'custom' && app.tab === 'route' && !S.mode;

  function drawMarkers() {
    markerLayer.clearLayers(); markers = [];
    if (kind() !== 'custom' || app.tab !== 'route') return;
    custom.pts.forEach((p, i) => {
      const m = L.marker(p, { icon: divIcon('mk-pt', 22, 22, String(i + 1)), draggable: true, title: 'Точка ' + (i + 1) + ': перетащите; двойной щелчок — убрать', keyboard: false });
      /* двойной щелчок или правая кнопка — убрать точку */
      const drop = () => { custom.pts.splice(i, 1); keep(); commit(); drawMarkers(); rebuild(); };
      m.on('dragstart', () => trashShow(true));
      m.on('drag', () => {
        const ll = m.getLatLng();
        if (overTrash(map.latLngToContainerPoint(ll))) return;
        custom.pts[i] = round5([ll.lat, ll.lng]); live();
      });
      m.on('dragend', () => {
        const ll = m.getLatLng(), gone = overTrash(map.latLngToContainerPoint(ll));
        trashShow(false);
        if (gone) { drop(); return; }
        custom.pts[i] = round5([ll.lat, ll.lng]); keep(); commit(); rebuild();
      });
      m.on('dblclick', (e) => { L.DomEvent.stop(e); drop(); });
      m.on('contextmenu', (e) => { L.DomEvent.stop(e); drop(); });
      markerLayer.addLayer(m); markers.push(m);
    });
  }

  /* улицы вокруг точек: зона — вокруг отрезка от первой точки до самой дальней */
  async function graphFor(pts, signal) {
    const A = pts[0];
    let B = A, far = 0;
    for (const p of pts) { const d = Core.hav(A[0], A[1], p[0], p[1]); if (d > far) { far = d; B = p; } }
    let need = 0;
    for (const p of pts) need = Math.max(need, Math.min(Core.hav(A[0], A[1], p[0], p[1]), Core.hav(B[0], B[1], p[0], p[1])));
    const R = Math.min(5000, 1200 + need);
    if (far > 12000) throw new Error('Точки слишком далеко друг от друга: уложитесь в 12 км от первой.');
    return app.ensureGraph({ A, B, R }, signal);
  }

  /* отрезки между точками считаются один раз: при перетаскивании меняются только два соседних */
  let legCache = new Map(), legGraph = null, legKey = '';
  function build(g, pts) {
    const prefs = store.prefs;
    if (!S.router) S.router = Core.makeRouter(g);
    const key = JSON.stringify([prefs.appeal, prefs.main, prefs.novelty, prefs.poi]);
    if (legGraph !== g || legKey !== key) { legCache = new Map(); legGraph = g; legKey = key; }
    const cost = Core.buildCost(g, { appeal: prefs.appeal / 100, mainAvoid: prefs.main / 100, novelty: prefs.novelty / 100, poi: prefs.poi / 100 });
    const seqPts = custom.loop && pts.length > 2 ? [...pts, pts[0]] : pts;
    const snap = seqPts.map((p) => Core.nearestNode(g, p[0], p[1], 150, 10));
    const nodes = [], edges = [], coords = [], legs = [0];
    let loose = 0;
    for (let i = 1; i < seqPts.length; i++) {
      const a = snap[i - 1], b = snap[i];
      let r = null;
      if (a && b) {
        const k = a.node + '>' + b.node;
        if (legCache.has(k)) r = legCache.get(k);
        else { r = S.router.route(cost, a.node, b.node, null, 1); legCache.set(k, r); if (legCache.size > 400) legCache.delete(legCache.keys().next().value); }
      }
      if (r) {
        for (const n of r.nodes) { nodes.push(n); coords.push([g.lat[n], g.lon[n]]); }
        edges.push(...r.edges);
      } else {
        /* нет пути (закрытый проход, зона, другая часть города): прямая линия, в расчёт улиц не входит */
        loose++;
        coords.push(seqPts[i - 1], seqPts[i]);
      }
      legs.push(coords.length - 1);
    }
    return { legs, nodes, edges, coords: coords.filter((p, i) => i === 0 || p[0] !== coords[i - 1][0] || p[1] !== coords[i - 1][1]), loose };
  }

  /* Перестройка «на ходу»: старая линия плавно перетекает в новую (обе берутся по 120 точек вдоль длины). */
  let morphRaf = 0;
  function resample(c, n) {
    const cum = [0];
    for (let i = 1; i < c.length; i++) cum.push(cum[i - 1] + Core.hav(c[i - 1][0], c[i - 1][1], c[i][0], c[i][1]));
    const total = cum[cum.length - 1] || 1, out = [];
    for (let k = 0, i = 1; k < n; k++) {
      const d = total * k / (n - 1);
      while (i < c.length - 1 && cum[i] < d) i++;
      const span = cum[i] - cum[i - 1] || 1, f = Math.min(1, Math.max(0, (d - cum[i - 1]) / span));
      out.push([c[i - 1][0] + (c[i][0] - c[i - 1][0]) * f, c[i - 1][1] + (c[i][1] - c[i - 1][1]) * f]);
    }
    return out;
  }
  function morph(from, to, done) {
    cancelAnimationFrame(morphRaf);
    const a = resample(from, 120), b = resample(to, 120), t0 = performance.now();
    const step = (now) => {
      const t = Math.min(1, (now - t0) / MORPH_MS), e = t * t * (3 - 2 * t);
      app.gl.lines('route', [a.map((p, i) => [p[0] + (b[i][0] - p[0]) * e, p[1] + (b[i][1] - p[1]) * e])]);
      if (t < 1) morphRaf = requestAnimationFrame(step); else { morphRaf = 0; done(); }
    };
    morphRaf = requestAnimationFrame(step);
  }

  async function rebuild(liveMode = false) {
    if (kind() !== 'custom') return;
    const my = ++seq;
    if (ac) ac.abort();
    const pts = custom.pts;
    const clear = () => { cancelAnimationFrame(morphRaf); S.routes = []; S.sel = -1; S.lastGen = null; app.renderResults(); app.drawRoutes(false); syncSave(); };
    if (pts.length < 2) {
      if (S.routes.length) clear();
      app.say(pts.length ? 'Поставьте ещё одну точку.' : '');
      syncSave();
      return;
    }
    ac = new AbortController();
    try {
      if (!liveMode) app.say('Прокладываю по улицам…');
      const g = await graphFor(pts, ac.signal);
      if (my !== seq) return;
      const b = build(g, pts);
      const length = Core.polyLength(b.coords);
      const metrics = Core.analyzeRoute(g, b.nodes, b.edges, store.prefs);
      const r = { id: custom.id, loop: custom.loop, length, coords: b.coords.map(round5), approach: 0, err: 0, off: false, repeat: 0, metrics, custom: true, legs: b.legs, pts: pts.map((p) => p.slice()) };
      r.ringCoords = r.coords; r.approachCoords = null;
      const title = Core.routeTitle(metrics, 'Свой маршрут ' + fmtKm(length) + ' км');
      const district = app.districtName(r.coords);
      r.name = district && !title.includes(district) ? district + ' · ' + title : title;
      const prev = S.routes[0];
      S.lastGen = null;
      S.routes = [r]; S.sel = 0;
      app.renderResults();
      if (liveMode && prev && prev.coords.length > 1) morph(prev.coords, r.coords, () => { if (my === seq) app.drawRoutes(false); });
      else { cancelAnimationFrame(morphRaf); app.drawRoutes(false); }
      app.say(b.loose ? 'Часть отрезков проложена прямо: между этими точками нет пути по улицам.' : '', b.loose ? 'warn' : undefined);
      syncSave();
    } catch (e) {
      if (e && e.name === 'AbortError') return;
      app.say(userMessage(e, 'Не удалось проложить маршрут.'), 'warn');
    }
  }
  /* пока точку тянут, маршрут пересчитывается не чаще раза в LIVE_MS */
  let liveTimer = 0;
  function live() {
    if (liveTimer) return;
    liveTimer = setTimeout(() => { liveTimer = 0; rebuild(true); }, LIVE_MS);
  }

  /* ---------- кнопки ---------- */
  /* убрать последнюю поставленную точку: Backspace */
  const dropLast = () => { if (!custom.pts.length) return; custom.pts.pop(); keep(); commit(); drawMarkers(); rebuild(); };
  $('#customClear').addEventListener('click', () => {
    custom.pts = []; custom.id = uid(); keep(); commit(); drawMarkers(); rebuild();
    toast('Точки убраны. Ctrl+Z вернёт их.');
  });
  $('#customLoop').addEventListener('change', (e) => { custom.loop = e.target.checked; keep(); commit(); rebuild(); });
  document.addEventListener('keydown', (e) => {
    if (!active() || e.altKey) return;
    const t = e.target;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    const mod = e.ctrlKey || e.metaKey;
    /* по коду клавиши, а не по букве: работает и в русской раскладке */
    if (mod && e.code === 'KeyZ') { e.preventDefault(); if (e.shiftKey) redo(); else undo(); }
    else if (mod && e.code === 'KeyY') { e.preventDefault(); redo(); }
    else if (!mod && (e.key === 'Backspace' || e.key === 'Delete')) { e.preventDefault(); dropLast(); }
  });
  /* сохранить в библиотеку: помечается как сделанный пользователем */
  const saveBtn = $('#customSave');
  function syncSave() {
    const r = S.routes[0];
    saveBtn.hidden = !(kind() === 'custom' && r && r.custom);
    if (!saveBtn.hidden) saveBtn.textContent = app.favorites.items.some((f) => f.id === r.id) ? 'Убрать из библиотеки' : 'Сохранить в библиотеку';
  }
  saveBtn.addEventListener('click', () => { const r = S.routes[0]; if (r && r.custom) app.toggleFavorite(r); syncSave(); });
  app.on('favorites', syncSave);

  /* Слои вкладки «Маршрут» живут только на ней: в «Библиотеке» и «Прогрессе» у карты свои, независимые.
     Дом, старт и финиш, направление и выбранные районы, кроме того, относятся только к подбору. */
  function syncRouteLayers() {
    const onRoute = app.tab === 'route', auto = kind() === 'auto';
    const want = { home: onRoute && auto, ab: onRoute && auto, compass: onRoute && auto, districts: onRoute && auto, zones: onRoute, blocks: onRoute };
    for (const [name, on] of Object.entries(want)) {
      const ly = app.layers[name];
      if (on && !map.hasLayer(ly)) map.addLayer(ly);
      if (!on && map.hasLayer(ly)) map.removeLayer(ly);
    }
    mapEl.classList.toggle('adding', active());
  }

  /* ---------- линия: схватить и потянуть ---------- */
  /* ближайшая к точке (в пикселях контейнера) точка линии маршрута: {leg, ll} или null */
  function lineNear(cp, radius = GRAB) {
    const r = S.routes[0];
    if (!active() || !r || !r.custom || !r.legs || r.coords.length < 2) return null;
    const pts = r.coords.map((q) => map.latLngToContainerPoint(q));
    let best = null;
    for (let k = 1; k < pts.length; k++) {
      const q = L.LineUtil.closestPointOnSegment(cp, pts[k - 1], pts[k]), d = cp.distanceTo(q);
      if (d <= radius && (!best || d < best.d)) best = { k, d, q };
    }
    if (!best) return null;
    return { leg: r.legs.reduce((a, st, i) => (st < best.k ? i : a), 0), ll: map.containerPointToLatLng(best.q) };
  }
  const grip = L.marker([0, 0], { icon: divIcon('mk-grip', 30, 30), interactive: false, keyboard: false, zIndexOffset: 900 });
  let gripOn = false, emph = false;
  /* линия «в фокусе»: кольцо под курсором и линия толще; показывает, что нажатие на неё точку не поставит, а потянуть можно */
  function focusLine(hit) {
    if (hit) {
      if (!gripOn) { grip.addTo(map); gripOn = true; }
      grip.setLatLng(hit.ll);
    } else if (gripOn) { map.removeLayer(grip); gripOn = false; }
    if (!!hit !== emph) {
      emph = !!hit;
      app.gl.paint('route', 'line-width', emph ? 8 : 5);
      app.gl.paint('route-halo', 'line-width', emph ? 13 : 9);
      mapEl.classList.toggle('on-line', emph);
    }
  }
  const evPoint = (ev) => {
    const t = ev.touches && ev.touches[0] ? ev.touches[0] : ev.changedTouches && ev.changedTouches[0] ? ev.changedTouches[0] : ev;
    return map.mouseEventToContainerPoint({ clientX: t.clientX, clientY: t.clientY });
  };
  let drag = null, justDragged = 0;
  function dragMove(ev) {
    if (!drag) return;
    if (ev.cancelable) ev.preventDefault();
    const cp = evPoint(ev), ll = map.containerPointToLatLng(cp);
    if (!drag.moved && cp.distanceTo(drag.start) > 3) { drag.moved = true; trashShow(true); }
    if (!drag.moved) return;
    if (overTrash(cp)) { drag.gone = true; return; }
    drag.gone = false;
    custom.pts[drag.idx] = round5([ll.lat, ll.lng]);
    if (markers[drag.idx]) markers[drag.idx].setLatLng(ll);
    live();
  }
  function dragEnd() {
    if (!drag) return;
    const d = drag; drag = null;
    document.removeEventListener('mousemove', dragMove); document.removeEventListener('mouseup', dragEnd);
    document.removeEventListener('touchmove', dragMove); document.removeEventListener('touchend', dragEnd);
    map.dragging.enable(); mapEl.classList.remove('rerouting');
    justDragged = Date.now();
    trashShow(false);
    if (!d.moved || d.gone) custom.pts.splice(d.idx, 1); /* просто нажали на линию или бросили точку в поле: точки не будет */
    clearTimeout(liveTimer); liveTimer = 0;
    keep(); if (d.moved && !d.gone) commit(); drawMarkers(); rebuild(d.moved && !d.gone);
  }
  function dragStart(ev) {
    if (drag || (ev.button !== undefined && ev.button !== 0)) return;
    const hit = lineNear(evPoint(ev));
    if (!hit) return;
    /* карту не двигаем: вместо этого тянем линию */
    ev.stopPropagation(); if (ev.cancelable) ev.preventDefault();
    const idx = Math.min(hit.leg + 1, custom.pts.length);
    custom.pts.splice(idx, 0, round5([hit.ll.lat, hit.ll.lng]));
    drag = { idx, moved: false, start: evPoint(ev) };
    focusLine(null);
    drawMarkers();
    map.dragging.disable(); mapEl.classList.add('rerouting');
    document.addEventListener('mousemove', dragMove); document.addEventListener('mouseup', dragEnd);
    document.addEventListener('touchmove', dragMove, { passive: false }); document.addEventListener('touchend', dragEnd);
  }
  /* на захвате: раньше, чем карта начнёт тащить себя */
  mapEl.addEventListener('mousedown', dragStart, true);
  mapEl.addEventListener('touchstart', dragStart, { capture: true, passive: false });
  map.on('mousemove', (e) => {
    if (drag || !active()) { if (!active()) focusLine(null); return; }
    focusLine(lineNear(e.containerPoint));
  });
  mapEl.addEventListener('mouseleave', () => focusLine(null));

  /* нажатие на пустое место карты — новая точка в конце */
  map.on('click', (e) => {
    if (!active() || drag || Date.now() - justDragged < 350) return;
    if (lineNear(e.containerPoint)) return; /* линия: её тянут, точку нажатием не ставят */
    custom.pts.push(round5([e.latlng.lat, e.latlng.lng]));
    keep(); commit(); drawMarkers(); rebuild();
  });

  function setKind(k, first) {
    if (!first) {
      stash[kind()] = { routes: S.routes, sel: S.sel, lastGen: S.lastGen };
      if (S.mode) app.setMode(null);
      store.prefs.routeKind = k; save();
      const next = stash[k] || { routes: [], sel: -1, lastGen: null };
      if (S.lineId) app.hideLine();
      S.routes = next.routes; S.sel = next.sel; S.lastGen = next.lastGen;
      app.renderResults(); app.drawRoutes(false);
      app.say('');
    }
    syncSeg($('#kindSeg'), 'kind', k);
    $('#autoBox').hidden = k !== 'auto'; $('#customBox').hidden = k !== 'custom';
    $('#customLoop').checked = custom.loop;
    drawMarkers();
    syncRouteLayers();
    syncSave();
    /* свой маршрут после перезагрузки или возвращения на вкладку без варианта — строится заново */
    if (k === 'custom' && !S.routes.length && custom.pts.length > 1) rebuild();
  }
  app.setKind = (k) => { if (k !== kind()) setKind(k); };
  $('#kindSeg').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (b && b.dataset.kind !== kind()) setKind(b.dataset.kind);
  });
  /* точки видны только на вкладке «Маршрут» */
  app.on('tab', () => { drawMarkers(); syncRouteLayers(); syncSave(); });
  setKind(kind(), true);
}
