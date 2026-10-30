/* Вкладка «Прогресс»: карта покрытия улиц внутри МКАД, панель района, места и статистика.
   Пока вкладка открыта, карта показывает только районы, улицы, места и контур МКАД. */
import L from 'leaflet';
import * as Core from '../core/index.js';
import { store, save } from '../storage/store.js';
import { ui, saveUi } from '../storage/session.js';
import { $, el, fmtKm, fmt1, syncSeg } from './dom.js';
import { placeMarker, placeSvg } from './place-icons.js';
import { pillSelect } from './pill-select.js';
import { about, photo, placeCard, panelHead, reveal, fmtCredit, fmtLicense, phone, scrollToPanel } from './place-card.js';

const CAT = {
  park: 'парк', view: 'смотровая', worship: 'храм', monument: 'памятник', museum: 'музей',
  sight: 'достопримечательность', history: 'история', heritage: 'наследие'
};
const CAT_ORDER = ['park', 'worship', 'monument', 'museum', 'view', 'sight', 'history', 'heritage'];
const STATE = ['не встречено', 'встречено', 'исследовал'];
const DONE = 0.9; /* улица пройдена от 90% длины */
const STREETS_ZOOM = 14, PLACES_ZOOM = 13;
/* линии треков и маршрутов на векторной подложке */
const COV_GL = ['cov-mask', 'cov-mute', 'cov-fill', 'cov-fill-line', 'cov-hot', 'cov-hot-line', 'cov-dim', 'cov-mkad', 'cov-off', 'cov-on', 'cov-left', 'cov-right'];
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
  /* Заливки и границы районов, пройденные улицы, маска и затемнение — в самой карте (app.gl);
     здесь, поверх неё, остаются только значки мест, парки и подсвеченная улица. */
  const pane = (name, z) => { map.createPane(name); map.getPane(name).style.zIndex = z; return name; };
  const topR = L.svg({ pane: pane('covTop', 430), padding: 0.3 });
  /* значки мест — в своей панели: обычная панель маркеров во вкладке скрыта */
  pane('covMarks', 640);
  const G = { sel: L.layerGroup(), places: L.layerGroup() };
  const WORLD = [[-85, -180], [-85, 180], [85, 180], [85, -180]];
  /* заливка района по ступени покрытия: 10 ступеней; ноль — без заливки */
  const OPACITY = [0.05, 0.1, 0.15, 0.2, 0.26, 0.32, 0.39, 0.46, 0.54, 0.62];

  let active = false, built = false, selected = null, tab = 'streets', sortBy = 'share', streetShown = 60;
  let placeCat = 'all', placeDists = [], placeShown = 12, dCat = 'all', distShown = 8, focus = null, segFrom = null;
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
        return { id: dist.id, i, park: true, n: p.n, c: 'park', lat: c[0], lon: c[1], rings: p.rings, w: p.w, f: p.f, ha: p.ha };
      }),
      ...dist.objects.map((o, i) => ({ id: dist.id, i, park: false, n: o.n, c: o.c, lat: o.lat, lon: o.lon, s: o.s, w: o.w, f: o.f }))
    ].map((p) => ({ ...p, st: stateOf(p.id, p.i, p.park, p.c, p.n) }));
  }

  /* ---------- основа карты: маска за МКАД, районы ---------- */
  const flatOf = (r) => r.flatMap((q) => [Core.px(q[1]), Core.py(q[0])]);
  /* районы для поиска под курсором: рамка и круги в плоских метрах */
  const hit = new Map();
  async function build() {
    if (built) return;
    const ring = Core.decodeRing(idx().mkad);
    app.gl.polys('cov-mask', [[WORLD, ring]]);
    app.gl.polys('cov-mute', [[ring]]);
    app.gl.lines('cov-mkad', [[...ring, ring[0]]]);
    const dIdx = await app.loadDistricts();
    for (const d of idx().d) {
      const src = dIdx.list.find((x) => x.id === d.id);
      if (!src) continue;
      /* L.polygon тут только считает рамку и круги: на карту он не добавляется */
      const poly = L.polygon(src.p);
      polys.set(d.id, poly);
      const parts = src.p.map((part) => part.map(flatOf));
      const b = poly.getBounds();
      hit.set(d.id, { box: [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()], parts, rings: src.p });
    }
    built = true;
  }
  /* район под точкой: рамка, потом попадание в контур без дыр */
  function districtAt(ll) {
    const x = Core.px(ll.lng), y = Core.py(ll.lat);
    for (const [id, h] of hit) {
      if (ll.lng < h.box[0] || ll.lng > h.box[2] || ll.lat < h.box[1] || ll.lat > h.box[3]) continue;
      for (const part of h.parts) if (Core.pointInRing(x, y, part[0]) && !part.slice(1).some((r) => Core.pointInRing(x, y, r))) return id;
    }
    return null;
  }
  /* Вид границы и заливки района. state: 0 — обычный, 1 — выбранный, 2 — приглушённый (выбран другой), 3 — под курсором. */
  function look(id, state) {
    const k = stepOf(shareOf(id)), cv = k < 0 ? 0 : OPACITY[k];
    const empty = k < 0 ? 1 : 0;
    if (state === 1) return { o: cv, b: 1, w: 3, k: 2 };
    if (state === 3) return { o: Math.max(0.06, cv), b: 1, w: 2.4, k: empty };
    if (state === 2) return { o: cv * 0.3, b: 0.5, w: 1.2, k: empty };
    return { o: cv, b: empty ? 0.85 : 1, w: 2, k: empty };
  }
  const featuresOf = (id, state) => hit.get(id).rings.map((rings) => ({ rings, p: look(id, state) }));
  let fillFor = null;
  /* заливка кармином по доле пройденного и контур; при выбранном районе остальные приглушены */
  function paintFills() {
    const key = version + '|' + selected;
    if (fillFor !== key) {
      fillFor = key;
      app.gl.polys('cov-fill', [...hit.keys()].flatMap((id) => featuresOf(id, id === selected ? 0 : selected ? 2 : 0)));
    }
    hotFor = null; dimFor = null;
    paintHot(); paintDim();
  }
  /* выбранный район и район под курсором — отдельным слоем, чтобы не пересчитывать все районы при каждом движении мыши */
  let hotFor = null;
  function paintHot() {
    const key = selected + '|' + hovered + '|' + version;
    if (hotFor === key) return;
    hotFor = key;
    const list = [];
    if (hovered && hovered !== selected && hit.has(hovered)) list.push(...featuresOf(hovered, 3));
    if (selected && hit.has(selected)) list.push(...featuresOf(selected, 1));
    app.gl.polys('cov-hot', list);
  }
  let dimFor = null, hovered = null;
  function paintDim() {
    const key = selected + '|' + hovered;
    if (dimFor === key) return;
    dimFor = key;
    if (!selected || !hit.get(selected)) { app.gl.polys('cov-dim', []); return; }
    const holes = [selected, hovered].filter((id) => id && hit.get(id)).flatMap((id) => hit.get(id).rings.map((rings) => rings[0]));
    app.gl.polys('cov-dim', [[WORLD, ...holes]]);
  }
  /* указатель над районом: подсказка с названием и долей, курсор-рука */
  const tip = el('div', { class: 'dtip float', hidden: true });
  mapEl.appendChild(tip);
  let hoverId = null;
  map.on('mousemove', (e) => {
    if (!active || !built) return;
    /* над кнопками карты (масштаб, определение места) подсказки района нет */
    const id = e.originalEvent && e.originalEvent.target.closest && e.originalEvent.target.closest('.leaflet-control') ? null : districtAt(e.latlng);
    if (id !== hoverId) {
      hoverId = id;
      mapEl.classList.toggle('pick-alt', !!id);
      const next = id && id !== selected ? id : null;
      if (next !== hovered) { hovered = next; paintHot(); paintDim(); }
      tip.hidden = !id;
      if (id) tip.textContent = info(id).n + ' · ' + pct(shareOf(id));
    }
    if (id) { tip.style.left = e.containerPoint.x + 'px'; tip.style.top = (e.containerPoint.y - 14) + 'px'; }
  });
  mapEl.addEventListener('mouseleave', () => { hoverId = null; tip.hidden = true; if (hovered) { hovered = null; paintHot(); paintDim(); } });
  map.on('click', (e) => {
    if (!active || !built) return;
    const id = districtAt(e.latlng);
    if (id) select(id);
  });

  /* ---------- улицы ---------- */
  const ll = (dist, p) => [dist.probes[2 * p + 1] / Core.KY, dist.probes[2 * p] / Core.KX];
  function segLine(dist, s) {
    const out = [];
    for (let p = dist.probeStart[s]; p < dist.probeStart[s + 1]; p++) out.push(ll(dist, p));
    return out;
  }
  /* Участки → ломаные по состоянию: 0 — не пройдено, 1 — целиком, 2 — только левая сторона, 3 — только правая.
     Соседние участки одной цепочки и одного состояния склеиваются. */
  function linesFor(dist) {
    const key = version;
    const hit = lineCache.get(dist.id);
    if (hit && hit.key === key) return hit.runs;
    const cov = C.covered(dist.id), runs = [[], [], [], []];
    let cur = null, curState = -1, last = null;
    for (let s = 0; s < dist.segLen.length; s++) {
      const m = cov.get(s) || 0, st = !m ? 0 : m === 3 ? 1 : m === 1 ? 2 : 3, line = segLine(dist, s);
      const joins = cur && st === curState && last && last[0] === line[0][0] && last[1] === line[0][1];
      if (joins) cur.push(...line.slice(1));
      else { cur = line; runs[st].push(cur); curState = st; }
      last = line[line.length - 1];
    }
    lineCache.set(dist.id, { key, runs });
    return runs;
  }
  const inView = (minZoom) => {
    if (map.getZoom() < minZoom) return [];
    const b = map.getBounds();
    return idx().d.filter((d) => !(d.b[0] > b.getNorth() || d.b[2] < b.getSouth() || d.b[1] > b.getEast() || d.b[3] < b.getWest())).map((d) => d.id);
  };
  let drawSeq = 0, streetsFor = null;
  async function drawStreets() {
    const seq = ++drawSeq;
    if (!store.layers.covStreets) { streetsFor = null; for (const id of ['cov-off', 'cov-on', 'cov-left', 'cov-right']) app.gl.lines(id, []); return; }
    /* при выбранном районе — только его улицы: соседи затемнены одинаково на любом масштабе */
    const ids = new Set(selected ? [selected] : inView(STREETS_ZOOM));
    const dists = [];
    for (const id of ids) { try { dists.push(await C.district(id)); } catch (e) { /* нет файла */ } }
    if (seq !== drawSeq || !active) return;
    /* то же самое, что уже нарисовано, — не трогаем: при движении карты данные не меняются */
    const key = version + ':' + dists.map((d) => d.id).join(',');
    if (key === streetsFor) return;
    streetsFor = key;
    const runs = dists.map(linesFor);
    /* основа — все улицы, пройденное — поверх; у односторонне пройденной под линией сбоку остаётся основа */
    app.gl.lines('cov-off', runs.flatMap((r) => [...r[0], ...r[2], ...r[3]]));
    app.gl.lines('cov-on', runs.flatMap((r) => r[1]));
    app.gl.lines('cov-left', runs.flatMap((r) => r[2]));
    app.gl.lines('cov-right', runs.flatMap((r) => r[3]));
  }

  /* ---------- места на карте ---------- */
  /* места видимых районов; при выбранном районе — только его, чтобы карта не пестрила */
  let placesSeq = 0;
  let placesKey = null;
  /* force — места поменялись; без него при движении карты значки не трогаем, пока набор районов тот же */
  async function drawPlaces(force = false) {
    const ids = selected ? [selected] : inView(PLACES_ZOOM);
    const key = ids.join(',') + '|' + selected + '|' + store.layers.covPlaces;
    if (!force && key === placesKey) return;
    placesKey = key;
    const my = ++placesSeq;
    G.places.clearLayers();
    if (!store.layers.covPlaces) return;
    for (const id of ids) {
      let dist;
      try { dist = await C.district(id); } catch (e) { continue; }
      if (!active || my !== placesSeq) return;
      for (const p of placesOf(dist)) {
        if (p.park) {
          G.places.addLayer(L.polygon(p.rings, { renderer: topR, className: 'cov-park st' + p.st, interactive: false }));
        }
        const on = isFocus(p);
        const m = L.marker([p.lat, p.lon], { pane: 'covMarks', icon: placeMarker(p.c, 'st' + p.st + (on ? ' on' : '')), title: p.n, keyboard: false, zIndexOffset: on ? 1000 : 0 });
        m.on('click', () => openPlace(p));
        G.places.addLayer(m);
      }
    }
  }
  /* место в фокусе — то, чья карточка открыта: его значок подсвечен, остальные спокойные */
  const isFocus = (p) => !!focus && focus.id === p.id && focus.i === p.i && focus.park === p.park;
  function setFocus(p) {
    if (p === focus || (p && focus && isFocus(p))) return;
    focus = p ? { id: p.id, i: p.i, park: p.park } : null;
    G.places.eachLayer((l) => {
      const e = l.getElement && l.getElement();
      if (!e || !l.getLatLng || !e.firstChild || !e.firstChild.classList.contains('mk-place')) return;
      const ll = l.getLatLng();
      const hit = !!p && Math.abs(ll.lat - p.lat) < 1e-7 && Math.abs(ll.lng - p.lon) < 1e-7;
      e.firstChild.classList.toggle('on', hit);
      l.setZIndexOffset(hit ? 1000 : 0);
    });
  }
  function toggleVisited(p) {
    const key = C.placeKey(p.id, p.c, p.n);
    if (store.visited[key]) delete store.visited[key]; else store.visited[key] = Date.now();
    save();
    renderAll(false);
  }
  /* место открывается в панели района: справка вместо раздела, «назад» — к району */
  let placeView = null;
  function openPlace(p, move = true) {
    if (p.id !== selected) select(p.id, false);
    placeView = { id: p.id, i: p.i, park: p.park };
    setFocus(p);
    renderPanel();
    if (phone.matches && app.sheet) { app.sheet.open(); scrollToPanel(panel); }
    else panel.scrollTop = 0;
    if (move) {
      if (map.getZoom() < 16) map.setView([p.lat, p.lon], 16, { animate: false });
      setTimeout(() => reveal(map, [p.lat, p.lon]), phone.matches ? 260 : 0);
    }
  }
  function closePlace() { placeView = null; setFocus(null); renderPanel(); }

  /* ---------- панель района ---------- */
  const panel = el('div', { class: 'dpanel', id: 'dpanel', hidden: true });
  function placePanel() {
    if (phone.matches) $('#dpanelSlot').appendChild(panel);
    else mapEl.parentElement.appendChild(panel);
  }
  phone.addEventListener('change', placePanel);
  placePanel();

  /* на компьютере панель района закрывает правую часть карты */
  const fitPad = () => (phone.matches ? { padding: [30, 30] } : { paddingTopLeft: [30, 30], paddingBottomRight: [400, 30] });
  async function select(id, fit = true) {
    if (id !== selected) { placeView = null; setFocus(null); hovered = null; }
    selected = id; tab = tab || 'streets'; streetShown = 60; dCat = 'all';
    G.sel.clearLayers();
    if (fit && polys.get(id)) map.fitBounds(polys.get(id).getBounds(), fitPad());
    try { if (!stats.has(id)) stats.set(id, await C.stats(id)); } catch (e) { /* покажем без улиц */ }
    renderAll();
  }
  function closePanel() { selected = null; placeView = null; hovered = null; setFocus(null); G.sel.clearLayers(); renderAll(); }

  function highlightStreet(dist, si) {
    G.sel.clearLayers();
    const st = dist.streets[si], lines = [];
    for (let s = st.from; s < st.to; s++) lines.push(segLine(dist, s));
    const l = L.polyline(lines, { renderer: topR, className: 'cov-hl', interactive: false });
    G.sel.addLayer(l);
    map.fitBounds(l.getBounds(), { ...fitPad(), maxZoom: 17 });
  }

  function renderPanel() {
    keep();
    panel.innerHTML = '';
    panel.hidden = !selected || !active;
    if (panel.hidden) return;
    const d = info(selected), s = stats.get(selected);
    const pv = placeView && s && placesOf(s.dist).find((p) => p.i === placeView.i && p.park === placeView.park);
    if (pv) { renderPlaceView(d, pv); return; }
    if (s) placeView = null; /* район ещё грузится — справка откроется, когда он загрузится */
    panel.append(panelHead(d.n, closePanel));
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
    /* панель перерисовывается целиком: подложка встаёт на прежний раздел и едет к новому */
    seg.style.setProperty('--i', '0');
    syncSeg(seg, 't', segFrom || tab);
    const to = tab;
    requestAnimationFrame(() => requestAnimationFrame(() => syncSeg(seg, 't', to)));
    segFrom = tab;
    panel.append(seg);
    const body = el('div', { class: 'dp-body' });
    panel.append(body);

    if (tab === 'streets') {
      const sorts = el('div', { class: 'chips' }, [['share', 'по %'], ['len', 'по длине'], ['name', 'по названию']].map(([k, t]) =>
        el('button', { class: 'chip', type: 'button', 'aria-pressed': String(sortBy === k), onclick: () => { sortBy = k; renderPanel(); } }, t)));
      const list = named.slice().sort((a, b) => sortBy === 'name' ? a.n.localeCompare(b.n, 'ru')
        : sortBy === 'len' ? b.len - a.len : (b.done / b.len - a.done / a.len) || b.len - a.len);
      /* таблица: улица, пройдено из длины, процент; фон строки — петроль по доле пройденного, 10 ступеней */
      const km = (m) => fmt1(m / 1000);
      const srow = (tag, attrs, n, done, len) => el(tag, { ...attrs, class: (attrs.class || 'srow') + ' lv' + Math.max(0, stepOf(done / len)) },
        el('span', { class: 'n' }, n), el('span', { class: 'k' }, km(done) + ' / ' + km(len)), el('span', { class: 'p' }, pct(done / len)));
      const rows = el('div', { class: 'stable', role: 'table', 'aria-label': 'Улицы района' },
        el('div', { class: 'shead', role: 'row' }, el('span', null, 'Улица'), el('span', null, 'пройдено, км'), el('span', null, '%')),
        list.slice(0, streetShown).map((x) => srow('button', { type: 'button', onclick: () => highlightStreet(dist, x.i) }, x.n, x.done, x.len)));
      body.append(sorts, rows);
      if (list.length > streetShown) body.append(el('button', { class: 'btn small more-btn', type: 'button', onclick: () => { streetShown = Infinity; renderPanel(); } }, 'Показать все ' + list.length));
    } else if (tab === 'places') {
      body.append(catChips(places, dCat, (c) => { dCat = c; renderPanel(); }));
      const list = places.filter((p) => dCat === 'all' || p.c === dCat).sort(byState);
      body.append(el('div', { class: 'plist' }, list.map((p) => placeRow(p, true))));
      if (!list.length) body.append(el('p', { class: 'hint' }, 'Здесь таких мест нет.'));
    } else {
      if (dist.about) {
        body.append(el('p', { class: 'about' }, dist.about.t),
          el('a', { class: 'src', href: dist.about.u, target: '_blank', rel: 'noopener' }, 'Текст: Википедия, CC BY-SA'));
      } else body.append(el('p', { class: 'hint' }, 'Справки о районе нет.'));
      /* достопримечательности района с описанием: с фото — первыми */
      const known = places.filter((p) => p.w && p.w.t).sort((a, b) => (!!b.w.i - !!a.w.i) || CAT_ORDER.indexOf(a.c) - CAT_ORDER.indexOf(b.c));
      if (known.length) {
        body.append(el('h3', { class: 'dp-sub' }, 'Что посмотреть'),
          /* фото над названием, справа от фото — откуда текст и чьё фото */
          el('div', { class: 'sights' }, known.slice(0, 12).map((p) => el('article', { class: 'sight' },
            el('div', { class: 'sight-top' },
              p.w.i ? el('span', { class: 'ph' }, el('img', { src: p.w.i.s, alt: '', loading: 'lazy', decoding: 'async' })) : el('span', { class: 'sight-ic', html: placeSvg(p.c) }),
              el('div', { class: 'sight-src' },
                el('a', { href: p.w.u, target: '_blank', rel: 'noopener' }, 'Википедия'),
                el('span', null, 'текст: CC BY-SA'),
                p.w.i ? el('span', null, 'фото: ', el('a', { href: p.w.i.f, target: '_blank', rel: 'noopener' }, fmtCredit(p.w.i.a)), ', ' + fmtLicense(p.w.i.l)) : null)),
            el('button', { class: 'pname', type: 'button', onclick: () => openPlace(p) }, Core.placeName({ name: p.n, cat: p.c })),
            el('p', null, p.w.t)))));
      }
    }
  }
  function renderPlaceView(d, p) {
    const fid = 'cov:' + C.placeKey(p.id, p.c, p.n);
    panel.append(panelHead(null, closePanel, { t: d.n, on: closePlace }),
      el('div', { class: 'dp-prog', title: 'Пройдено улиц района' }, bar(shareOf(d.id)),
        el('div', { class: 'muted dp-line' }, d.n + ' · пройдено ' + pct(shareOf(d.id)))),
      placeCard({
        p, title: Core.placeName({ name: p.n, cat: p.c }), sub: [CAT[p.c], STATE[p.st], p.s].filter(Boolean).join(' · '),
        buttons: [
          el('button', { class: 'btn small' + (p.st === 2 ? '' : ' primary'), type: 'button', onclick: () => toggleVisited(p) }, p.st === 2 ? 'Снять отметку' : 'Исследовал'),
          el('button', {
            class: 'btn small', type: 'button',
            onclick: () => { app.toggleForced({ id: fid, name: p.n, lat: p.lat, lon: p.lon }); renderPanel(); }
          }, app.isForced(fid) ? 'Убрать из маршрута' : 'Провести маршрут')]
      }));
  }
  /* сначала места со справкой: с фото, со статьёй, с фактами */
  const richness = (p) => (p.w && p.w.i ? 4 : 0) + (p.w && p.w.t ? 2 : 0) + (p.f && Object.keys(p.f).length ? 1 : 0);
  const byState = (a, b) => (b.st - a.st) || richness(b) - richness(a) || CAT_ORDER.indexOf(a.c) - CAT_ORDER.indexOf(b.c) || a.n.localeCompare(b.n, 'ru');
  /* типы мест — одной прокручиваемой строкой: значок, название, сколько мест; выбранный виден сразу */
  function catChips(list, cur, on) {
    const n = (c) => list.filter((p) => p.c === c).length;
    const cats = CAT_ORDER.filter((c) => n(c));
    const row = el('div', { class: 'pills', role: 'group', 'aria-label': 'Тип места' },
      [['all', 'Все', list.length], ...cats.map((c) => [c, CAT[c][0].toUpperCase() + CAT[c].slice(1), n(c)])].map(([k, t, cnt]) =>
        el('button', { class: 'chip cat', type: 'button', 'aria-pressed': String(cur === k), onclick: () => on(k) },
          k === 'all' ? null : el('span', { class: 'ic', 'aria-hidden': 'true', html: placeSvg(k) }), t, el('span', { class: 'n' }, String(cnt)))));
    requestAnimationFrame(() => {
      const b = row.querySelector('[aria-pressed="true"]');
      if (b) row.scrollLeft = b.offsetLeft - (row.clientWidth - b.offsetWidth) / 2;
    });
    return row;
  }
  /* строка места раскрывается на месте: фото, справка, кнопки; открытой остаётся одна */
  let openRow = null;
  const rowKey = (p) => p.id + ':' + (p.park ? 'p' : 'o') + p.i;
  /* inPanel — строка в панели района: открывает справку в самой панели */
  function placeRow(p, inPanel) {
    const k = rowKey(p), fid = 'cov:' + C.placeKey(p.id, p.c, p.n);
    const rich = !!(p.w || (p.f && Object.keys(p.f).length) || p.ha);
    const item = el('div', { class: 'pitem' });
    const detail = () => el('div', { class: 'pdetail', id: 'pd-' + k.replace(':', '-') },
      p.w && p.w.i ? photo(p.w.i) : null,
      about(p) || el('p', { class: 'hint' }, 'Справки об этом месте пока нет.'),
      el('div', { class: 'btns' },
        el('button', { class: 'btn small', type: 'button', onclick: () => openPlace(p) }, 'На карте'),
        el('button', {
          class: 'btn small', type: 'button',
          onclick: (e) => { app.toggleForced({ id: fid, name: p.n, lat: p.lat, lon: p.lon }); e.target.textContent = app.isForced(fid) ? 'Убрать из маршрута' : 'Провести маршрут'; }
        }, app.isForced(fid) ? 'Убрать из маршрута' : 'Провести маршрут')));
    const head = el('button', {
      class: 'pname' + (inPanel ? ' go' : ''), type: 'button', ...(inPanel ? {} : { 'aria-expanded': String(openRow === k), 'aria-controls': 'pd-' + k.replace(':', '-') }),
      onclick: () => {
        if (inPanel) { openPlace(p); return; }
        const open = head.getAttribute('aria-expanded') !== 'true';
        document.querySelectorAll('.pitem.open').forEach((x) => { x.classList.remove('open'); x.querySelector('.pname').setAttribute('aria-expanded', 'false'); x.querySelector('.pdetail')?.remove(); });
        openRow = open ? k : null;
        if (open) { item.classList.add('open'); head.setAttribute('aria-expanded', 'true'); item.append(detail()); }
      }
    }, el('span', { class: 'pt' }, Core.placeName({ name: p.n, cat: p.c }), el('span', { class: 'chev', 'aria-hidden': 'true' })),
      el('small', null, CAT[p.c] + ' · ' + STATE[p.st], rich ? el('span', { class: 'has', title: 'Есть справка', 'aria-label': ', есть справка' }, p.w && p.w.i ? ' · фото' : ' · справка') : null));
    item.append(el('div', { class: 'prow' },
      el('span', { class: 'pic st' + p.st, 'aria-hidden': 'true', html: placeSvg(p.c) }), head,
      el('button', { class: 'btn small ghost', type: 'button', onclick: () => toggleVisited(p) }, p.st === 2 ? 'Снять' : 'Исследовал')));
    if (!inPanel && openRow === k) { item.classList.add('open'); item.append(detail()); }
    return item;
  }

  /* ---------- вкладка: сводка, районы, места ---------- */
  function renderCards() {
    keep();
    const I = idx();
    let done = 0;
    for (const id of stats.keys()) done += doneOf(id);
    const visited = Object.keys(store.visited);
    const total = I.d.reduce((s, d) => s + d.ob + d.pk, 0);
    const runs = app.tracks.items, runKm = runs.reduce((s, t) => s + (t.km || 0), 0), freshKm = runs.reduce((s, t) => s + (t.newKm || 0), 0);
    const card = (label, big, sub, attrs) => el(attrs ? 'button' : 'div', { class: 'ccard', ...attrs },
      el('div', { class: 'muted' }, label), el('div', { class: 'cbig' }, big), el('div', { class: 'muted' }, sub));
    $('#covCards').replaceChildren(
      card('Улицы МКАД', netM ? pct(done / netM) : '…', fmtKm(done) + (netM ? ' из ' + Math.round(netM / 1000).toLocaleString('ru-RU') + ' км' : ' км')),
      card('Районы', [...polys.keys()].filter((id) => shareOf(id) >= 0.05).length + ' / ' + I.d.length, 'с покрытием от 5%'),
      card('Места', met.size + ' / ' + total.toLocaleString('ru-RU'), 'встречено · ' + visited.length + ' исследовал', {
        type: 'button', 'aria-expanded': String(catsOpen), 'aria-controls': 'covCats', title: 'Места по типам',
        onclick: () => { catsOpen = !catsOpen; renderCards(); }
      }),
      /* длины треков хранятся в метрах; «впервые» — там, где не проходила ни одна более ранняя пробежка */
      card('Пробежки', String(runs.length), runs.length ? fmtKm(runKm) + ' км всего · ' + fmtKm(freshKm) + ' км впервые' : 'загрузите трек в «Библиотеке»'),
      catsOpen ? catCards() : '');
  }
  /* длина улиц МКАД считается по файлам всех районов: до тех пор в карточке многоточие */
  let netM = 0;
  C.ready.then((ix) => ix && C.networkM().then((m) => { netM = m; if (active) renderCards(); }));
  /* места по типам: сколько встречено и исследовано из всех; считается по разобранным файлам районов */
  let catsOpen = false;
  function catCards() {
    const all = [...decoded.values()].flatMap(placesOf);
    if (!allLoaded) return el('p', { class: 'hint ccats', id: 'covCats' }, 'Считаем места по районам…');
    return el('div', { class: 'ccats', id: 'covCats' }, CAT_ORDER.filter((c) => all.some((p) => p.c === c)).map((c) => {
      const list = all.filter((p) => p.c === c), m = list.filter((p) => p.st > 0).length, v = list.filter((p) => p.st === 2).length;
      return el('button', {
        class: 'ccat', type: 'button', title: 'Показать в списке',
        onclick: () => { placeCat = c; placeShown = 12; store.layers.covList = 'places'; save(); syncList(); renderPlaceList(); $('#covListSeg').scrollIntoView({ behavior: 'smooth', block: 'start' }); }
      }, el('span', { class: 'ic', 'aria-hidden': 'true', html: placeSvg(c) }),
      el('span', { class: 'cn' }, CAT[c][0].toUpperCase() + CAT[c].slice(1)),
      el('span', { class: 'cv' }, m + ' / ' + list.length),
      el('span', { class: 'cs' }, v ? 'исследовал ' + v : ''),
      el('span', { class: 'cb', 'aria-hidden': 'true' }, el('span', { style: 'width:' + (100 * m / list.length).toFixed(1) + '%' })));
    }));
  }
  /* районы — свёрнутым списком: длинный список не прячет места ниже */
  function renderDistricts() {
    const list = idx().d.slice().sort((a, b) => (shareOf(b.id) - shareOf(a.id)) || a.n.localeCompare(b.n, 'ru'));
    const shown = list.slice(0, distShown);
    if (selected && !shown.some((d) => d.id === selected)) shown.push(list.find((d) => d.id === selected));
    $('#covDistricts').replaceChildren(...shown.map((d) =>
      el('button', { class: 'drow' + (d.id === selected ? ' on' : ''), type: 'button', onclick: () => select(d.id) },
        el('span', { class: 'n' }, d.n), bar(shareOf(d.id)), el('span', { class: 'p' }, pct(shareOf(d.id))))),
    list.length > distShown + 1
      ? el('button', { class: 'btn small more-btn', type: 'button', onclick: () => { distShown = distShown > 8 ? 8 : Infinity; renderDistricts(); } },
        distShown > 8 ? 'Свернуть' : 'Все районы · ' + list.length)
      : '');
    $('#distCount').textContent = ' · ' + list.length;
  }
  async function renderPlaceList() {
    keep();
    const box = $('#covPlaces');
    const dists = [];
    for (const d of idx().d) {
      if (placeDists.length && !placeDists.includes(d.id)) continue;
      const p = loadedDist(d.id);
      if (p) dists.push(p);
    }
    const all = dists.flatMap(placesOf);
    const list = all.filter((p) => placeCat === 'all' || p.c === placeCat).sort(byState);
    $('#placeCount').textContent = all.length ? ' · ' + all.length : '';
    box.replaceChildren(
      catChips(all, placeCat, (c) => { placeCat = c; placeShown = 12; renderPlaceList(); }),
      el('div', { class: 'plist' }, list.slice(0, placeShown).map((p) => {
        const row = placeRow(p);
        if (placeDists.length !== 1) row.querySelector('small').append(' · ' + info(p.id).n);
        return row;
      })),
      list.length > placeShown ? el('button', { class: 'btn small more-btn', type: 'button', onclick: () => { placeShown += 40; renderPlaceList(); } }, 'Показать ещё') : '',
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
    if (active) { renderPlaceList(); if (catsOpen) renderCards(); }
  }
  /* фильтр мест по районам — то же поле с пилюлями, что и на вкладке маршрута; пусто — все районы */
  const placePick = pillSelect($('#placePick'), {
    options: () => idx().d,
    selected: () => placeDists,
    name: (id) => (idx().d.find((d) => d.id === id) || {}).n,
    toggle: (id, adding) => { placeDists = adding ? [...placeDists, id] : placeDists.filter((x) => x !== id); placeShown = 12; placePick.render(); renderPlaceList(); },
    placeholder: ['Все районы', 'Ещё район']
  });

  /* что выбрано во вкладке — переживает перезагрузку */
  function keep() {
    if (!restored) return; /* до восстановления не затираем сохранённое */
    ui.cov = { selected, tab, placeView, dCat, placeCat, placeDists, catsOpen, sortBy };
    saveUi();
  }
  let restored = false;
  function restore() {
    restored = true;
    const c = ui.cov;
    if (!c) return;
    if (Array.isArray(c.placeDists)) placeDists = c.placeDists.filter((id) => info(id));
    if (c.placeCat) placeCat = c.placeCat;
    if (c.sortBy) sortBy = c.sortBy;
    catsOpen = !!c.catsOpen;
    placePick.render();
    if (c.selected && info(c.selected)) {
      selected = c.selected; tab = c.tab || 'streets'; dCat = c.dCat || 'all';
      placeView = c.placeView || null;
    }
  }

  function renderAll(redrawStreets = true) {
    keep();
    if (!active) { renderPanel(); return; }
    paintFills(); renderCards(); renderDistricts(); renderPanel(); renderPlaceList();
    if (redrawStreets) drawStreets();
    drawPlaces(true);
  }

  /* ---------- переключатели ---------- */
  /* районы и места — один список с переключателем, а не два раздела подряд */
  function syncList() {
    const v = store.layers.covList === 'places' ? 'places' : 'districts';
    syncSeg($('#covListSeg'), 'list', v);
    $('#covDistricts').hidden = v !== 'districts';
    $('#covPlacesBox').hidden = v !== 'places';
  }
  $('#covListSeg').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    store.layers.covList = b.dataset.list; save(); syncList();
  });
  syncList();
  /* слои вкладки: улицы и места включаются отдельно; обозначения свёрнуты в кнопку, как на карте маршрута */
  const syncChecks = () => {
    $('#covPlacesOn').checked = store.layers.covPlaces; $('#covStreetsOn').checked = store.layers.covStreets;
    $('#covToolsToggle').setAttribute('aria-expanded', String(!!store.layers.covToolsOpen));
    $('#covToolsBody').hidden = !store.layers.covToolsOpen;
  };
  $('#covPlacesOn').addEventListener('change', (e) => { store.layers.covPlaces = e.target.checked; save(); drawPlaces(true); });
  $('#covStreetsOn').addEventListener('change', (e) => { store.layers.covStreets = e.target.checked; save(); drawStreets(); });
  $('#covToolsToggle').addEventListener('click', () => { store.layers.covToolsOpen = !store.layers.covToolsOpen; save(); syncChecks(); });
  $('#covLegend').replaceChildren(...[...Array(10)].map((_, k) => el('span', { class: 'cv' + k, title: k * 10 + '–' + (k + 1) * 10 + '%' })));

  /* ---------- вход и выход из режима ---------- */
  async function enter() {
    active = true;
    mapEl.classList.add('cov');
    /* треки и маршруты нарисованы на векторной подложке: прячем их там */
    if (app.gl) for (const id of GL_OVERLAYS) app.gl.visible(id, false);
    for (const g of Object.values(G)) g.addTo(map);
    for (const id of COV_GL) app.gl.visible(id, true);
    dimFor = null; placesKey = null;
    syncChecks();
    if (!(await C.ready)) { $('#covNote').hidden = false; return; }
    if (!active) return;
    await build();
    if (!decoded.size) { placePick.render(); loadAll(); }
    await computeStats();
    if (!restored) {
      restore();
      if (selected && !stats.has(selected)) { try { stats.set(selected, await C.stats(selected)); } catch (e) { /* покажем без улиц */ } }
    }
    if (active) renderAll();
  }
  function leave() {
    active = false; drawSeq++;
    mapEl.classList.remove('cov', 'zooming');
    if (app.gl) for (const id of GL_OVERLAYS) app.gl.visible(id, true);
    app.syncLayers();
    for (const g of Object.values(G)) map.removeLayer(g);
    for (const id of COV_GL) app.gl.visible(id, false);
    panel.hidden = true;
  }
  app.on('tab', () => { if (app.tab === 'progress') enter(); else if (active) leave(); });
  const refresh = async () => { if (!active) return; await computeStats(); renderAll(); };
  app.on('explored', refresh);
  app.on('coverage', refresh);
  app.on('theme', () => { lineCache.clear(); streetsFor = null; if (active) drawStreets(); });
  /* значки мест и парки на время изменения масштаба быстро гаснут и после него так же появляются на новых местах */
  /* после масштабирования они возвращаются не сразу, а с задержкой: пусть карта сперва устоится */
  const SHOW_DELAY = 350;
  let showTimer = 0;
  map.on('zoomstart', () => { if (active) { clearTimeout(showTimer); mapEl.classList.add('zooming'); } });
  map.on('zoomend', () => { clearTimeout(showTimer); showTimer = setTimeout(() => mapEl.classList.remove('zooming'), SHOW_DELAY); });
  map.on('moveend', () => { if (active) { drawStreets(); drawPlaces(); } });
  S.coverageSelect = select;
}
