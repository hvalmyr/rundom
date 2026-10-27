/* Направление маршрута: компас (роза в панели и ручка на карте) или районы на карте. */
import L from 'leaflet';
import * as Core from '../core/index.js';
import { store, save } from '../storage/store.js';
import { divIcon } from '../map/map.js';
import { $, el, syncSeg, toast } from './dom.js';

const SIDES = ['С', 'СВ', 'В', 'ЮВ', 'Ю', 'ЮЗ', 'З', 'СЗ'];
const NS = 'http://www.w3.org/2000/svg';
const norm = (s) => s.toLowerCase().replace(/ё/g, 'е');

export function initDirection(app) {
  const { map, layers, svg } = app;
  const P = store.prefs;

  /* ---------- данные районов: отдельный файл, грузится по требованию ---------- */
  let index = null, loading = null;
  app.loadDistricts = () => {
    if (index) return Promise.resolve(index);
    if (!loading) loading = import('../data/districts.json').then((m) => { index = Core.districtIndex(m.default); return index; });
    return loading;
  };
  app.districtName = (coords) => (index ? index.mainOf(coords) : null);
  const byId = (id) => index && index.list.find((d) => d.id === id);

  /* точка, от которой считается направление */
  function origin() {
    if (P.startMode === 'home') return store.ringStart || store.home;
    return store.A ? [store.A.lat, store.A.lon] : null;
  }
  app.sideName = (deg) => SIDES[Math.round(((deg % 360) + 360) % 360 / 45) % 8];

  /* ---------- роза ---------- */
  function wedge(i) {
    const a0 = (i * 45 - 22.5 - 90) * Math.PI / 180, a1 = (i * 45 + 22.5 - 90) * Math.PI / 180, R = 58, r = 20;
    const p = (rad, a) => `${(rad * Math.cos(a)).toFixed(2)} ${(rad * Math.sin(a)).toFixed(2)}`;
    return `M${p(r, a0)}L${p(R, a0)}A${R} ${R} 0 0 1 ${p(R, a1)}L${p(r, a1)}A${r} ${r} 0 0 0 ${p(r, a0)}Z`;
  }
  function svgEl(tag, attrs, text) {
    const n = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
    if (text) n.textContent = text;
    return n;
  }
  function renderRose() {
    const rose = $('#rose');
    rose.innerHTML = '';
    const on = Math.round(((P.dirBearing % 360) + 360) % 360 / 45) % 8;
    SIDES.forEach((name, i) => {
      const w = svgEl('path', { d: wedge(i), class: 'w' + (i === on ? ' on' : ''), role: 'button', tabindex: '0', 'aria-label': name, 'aria-pressed': String(i === on) });
      const pickSide = () => { P.dirBearing = i * 45; changed(); };
      w.addEventListener('click', pickSide);
      w.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pickSide(); } });
      rose.appendChild(w);
      const a = (i * 45 - 90) * Math.PI / 180;
      rose.appendChild(svgEl('text', { x: (40 * Math.cos(a)).toFixed(1), y: (40 * Math.sin(a) + 3.5).toFixed(1), 'text-anchor': 'middle', class: i === on ? 'on' : '' }, name));
    });
    /* точное направление, если ручку на карте повернули не ровно на сторону света */
    if (P.dirBearing % 45) {
      const a = (P.dirBearing - 90) * Math.PI / 180;
      rose.appendChild(svgEl('line', { class: 'needle', x1: (21 * Math.cos(a)).toFixed(1), y1: (21 * Math.sin(a)).toFixed(1), x2: (60 * Math.cos(a)).toFixed(1), y2: (60 * Math.sin(a)).toFixed(1) }));
    }
    const hub = svgEl('circle', { r: 17, class: 'hub', role: 'button', tabindex: '0', 'aria-label': 'Любое направление' });
    hub.addEventListener('click', () => { P.dirMode = 'any'; changed(); });
    rose.appendChild(hub);
    rose.appendChild(svgEl('text', { y: 3.5, 'text-anchor': 'middle' }, 'любое'));
    $('#outSpread').textContent = '±' + P.dirSpread + '°';
    $('#dirSpread').value = P.dirSpread;
  }

  /* ---------- ручка на карте ---------- */
  function dest(o, deg, m) {
    const a = deg * Math.PI / 180;
    return [o[0] + (m * Math.cos(a)) / 111320, o[1] + (m * Math.sin(a)) / (111320 * Math.cos(o[0] * Math.PI / 180))];
  }
  function renderCompass() {
    layers.compass.clearLayers();
    const o = origin();
    if (P.dirMode !== 'compass' || !o) return;
    const R = Math.max(600, P.km * 1000 * 0.32);
    const cone = [o];
    for (let d = -P.dirSpread; d <= P.dirSpread; d += 5) cone.push(dest(o, P.dirBearing + d, R * 1.25));
    layers.compass.addLayer(L.polygon(cone, { renderer: svg, className: 'cone', interactive: false }));
    const tip = dest(o, P.dirBearing, R);
    const needle = L.polyline([o, tip], { renderer: svg, className: 'needle', interactive: false });
    layers.compass.addLayer(needle);
    const h = L.marker(tip, { icon: divIcon('mk-handle', 16, 16), draggable: true, title: 'Потяните, чтобы повернуть', keyboard: false });
    const bearingTo = (ll) => {
      const b = Core.bearing(o[0], o[1], ll.lat, ll.lng);
      return Math.round(((b % 360) + 360) % 360);
    };
    h.on('drag', (e) => {
      P.dirBearing = bearingTo(e.target.getLatLng());
      needle.setLatLngs([o, e.target.getLatLng()]);
      renderRose();
    });
    h.on('dragend', () => { save(); renderCompass(); });
    layers.compass.addLayer(h);
  }

  /* ---------- районы ---------- */
  const picking = () => app.S.mode === 'districts';
  function renderDistricts() {
    layers.districts.clearLayers();
    if (P.dirMode !== 'districts' || !index) return;
    const sel = new Set(P.districts);
    for (const d of index.list) {
      const on = sel.has(d.id);
      if (!on && !picking()) continue;
      const poly = L.polygon(d.p, { renderer: svg, className: 'district' + (on ? ' sel' : ''), interactive: picking() });
      if (picking()) {
        poly.bindTooltip(d.n, { sticky: true, direction: 'top', offset: [0, -8], className: 'dtip' });
        poly.on('click', (e) => { L.DomEvent.stop(e); toggle(d.id); });
      }
      layers.districts.addLayer(poly);
      if (on) layers.districts.addLayer(L.marker(d.l, { icon: divIcon('mk-dlabel', 0, 0, d.n), interactive: false, keyboard: false }));
    }
  }
  function toggle(id) {
    P.districts = P.districts.includes(id) ? P.districts.filter((x) => x !== id) : [...P.districts, id];
    changed();
  }
  function renderChips() {
    const box = $('#distChips');
    box.innerHTML = '';
    for (const id of P.districts) {
      const d = byId(id);
      if (!d) continue;
      box.appendChild(el('button', { class: 'chip dist', type: 'button', 'aria-label': 'Убрать ' + d.n, onclick: () => toggle(id) }, d.n + ' ×'));
    }
    box.appendChild(el('button', {
      class: 'chip add', type: 'button', onclick: () => {
        if (picking()) { app.setMode(null); return; }
        app.setMode('districts', 'Нажимайте на районы, чтобы выбрать. Ещё раз — снять выбор');
        renderDistricts(); renderChips();
        if (!P.districts.length) map.setZoom(Math.min(map.getZoom(), 12));
      }
    }, picking() ? 'Готово' : '+ на карте'));
    syncSeg($('#strictSeg'), 'strict', P.distStrict ? '1' : '0');
    syncSeg($('#multiSeg'), 'multi', P.distMulti);
    $('#multiSeg').hidden = P.districts.length < 2;
    $('#distHint').textContent = P.distStrict
      ? 'Кольцо целиком в выбранных районах, кроме подводки и пути до района.'
      : 'Самая дальняя точка — в районе, выходить за его границы можно.';
  }
  app.registerMode('districts', { ok() { app.setMode(null); }, leave() { setTimeout(() => { renderDistricts(); renderChips(); }); } });

  /* поиск района по названию */
  const search = $('#distSearch'), sug = $('#distSug');
  search.addEventListener('input', async () => {
    const q = norm(search.value.trim());
    sug.innerHTML = '';
    if (q.length < 2) { sug.hidden = true; return; }
    const idx = await app.loadDistricts();
    const found = idx.list.filter((d) => norm(d.n).includes(q)).slice(0, 8);
    for (const d of found) {
      sug.appendChild(el('button', {
        type: 'button', onclick: () => {
          if (!P.districts.includes(d.id)) toggle(d.id);
          map.fitBounds(L.polygon(d.p).getBounds(), { padding: [40, 40] });
          search.value = ''; sug.hidden = true;
        }
      }, d.n, P.districts.includes(d.id) ? el('small', null, 'уже выбран') : null));
    }
    if (!found.length) sug.appendChild(el('button', { type: 'button', disabled: true }, 'Такого района нет'));
    sug.hidden = false;
  });
  document.addEventListener('click', (e) => { if (!sug.contains(e.target) && e.target !== search) sug.hidden = true; });

  /* ---------- переключатели ---------- */
  async function changed() {
    save();
    syncSeg($('#dirSeg'), 'dir', P.dirMode);
    $('#compassBox').hidden = P.dirMode !== 'compass';
    $('#districtBox').hidden = P.dirMode !== 'districts';
    if (P.dirMode !== 'districts' && picking()) app.setMode(null);
    renderRose(); renderCompass();
    if (P.dirMode === 'districts') {
      try { await app.loadDistricts(); } catch (e) { toast('Не удалось загрузить границы районов.'); }
    }
    renderChips(); renderDistricts();
  }
  $('#dirSeg').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    P.dirMode = b.dataset.dir; changed();
  });
  $('#strictSeg').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    P.distStrict = b.dataset.strict === '1'; changed();
  });
  $('#multiSeg').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    P.distMulti = b.dataset.multi; changed();
  });
  $('#dirSpread').addEventListener('input', (e) => { P.dirSpread = parseInt(e.target.value, 10); save(); renderRose(); renderCompass(); });

  /* Ограничение для генератора; null — направление любое. */
  app.directionSpec = async () => {
    if (P.dirMode === 'compass') return { dir: { bearing: P.dirBearing, spread: P.dirSpread }, label: app.sideName(P.dirBearing) + ' ±' + P.dirSpread + '°' };
    if (P.dirMode === 'districts' && P.districts.length) {
      const idx = await app.loadDistricts();
      const zones = [];
      P.districts.forEach((id) => {
        const i = idx.list.findIndex((d) => d.id === id);
        if (i >= 0) zones.push({ name: idx.list[i].n, test: idx.tests[i] });
      });
      return { districts: { zones, mode: P.distMulti, strict: P.distStrict }, label: zones.map((z) => z.name).join(', ') };
    }
    return null;
  };

  app.on('origin', renderCompass);
  app.on('start', renderCompass);
  app.on('km', renderCompass);
  /* границы нужны и для названий: грузим их в фоне */
  setTimeout(() => app.loadDistricts().then(() => { renderChips(); renderDistricts(); }).catch(() => {}), 1200);
  changed();
}
