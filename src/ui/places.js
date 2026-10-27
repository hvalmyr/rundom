/* Места для маршрута («пройти через»): подгружаются сами по видимой области.
   Внутри МКАД — из данных покрытия (./data), за МКАД — из Overpass при масштабе 14 и крупнее. */
import L from 'leaflet';
import * as Core from '../core/index.js';
import { store, save } from '../storage/store.js';
import { overpass } from '../data/overpass.js';
import { placeMarker } from './place-icons.js';
import { $, el } from './dom.js';
import { placeCard, placePanel } from './place-card.js';

const CATS = {
  view: 'Видовая точка', park: 'Парк', water: 'Вода, набережная', sight: 'Достопримечательность',
  art: 'Арт-объект', history: 'Памятник', worship: 'Храм', monument: 'Памятник', museum: 'Музей',
  heritage: 'Объект наследия', other: 'Место'
};
const MAX_SHOWN = 700, MIN_ZOOM = 13, OSM_ZOOM = 14;

export function initPlaces(app) {
  const { map, layers, S } = app;
  const C = app.coverage;
  const have = new Set(S.osmPois.map((p) => p.id));
  const add = (p) => { if (!have.has(p.id)) { have.add(p.id); S.osmPois.push(p); } };
  const fromData = new Set(), osmBoxes = [];
  let mkadFlat = null;

  /* место открывается в панели — как район в «Прогрессе»: справа над картой или в листе на телефоне */
  const panel = placePanel(app, $('#placeSlot'));
  let shownId = null;
  function showPlace(p, move = true) {
    const forced = app.isForced(p.id);
    panel.show(p.name ? Core.placeName(p) : 'Без названия', placeCard({
      p, sub: CATS[p.cat] || CATS.other,
      buttons: [el('button', {
        class: 'btn small' + (forced ? '' : ' primary'), type: 'button',
        onclick: () => { app.toggleForced(p); showPlace(p, false); }
      }, forced ? 'Убрать из маршрута' : 'Пройти через')]
    }), move ? [p.lat, p.lon] : null, () => { shownId = null; render(); });
    shownId = p.id;
    render();
  }
  app.on('tab', () => { if (app.tab === 'progress') panel.hide(); });

  function render() {
    layers.osm.clearLayers();
    const b = map.getBounds().pad(0.2);
    const shown = S.osmPois.filter((p) => b.contains([p.lat, p.lon]) || app.isForced(p.id)).slice(0, MAX_SHOWN);
    for (const p of shown) {
      const on = shownId === p.id;
      const m = L.marker([p.lat, p.lon], { icon: placeMarker(p.cat, (app.isForced(p.id) ? 'via' : '') + (on ? ' on' : '')), title: p.name, zIndexOffset: on ? 1000 : 0 });
      m.on('click', () => showPlace(p));
      layers.osm.addLayer(m);
    }
    $('#osmInfo').textContent = !store.layers.osm ? ''
      : map.getZoom() < MIN_ZOOM ? 'Приблизьте карту, чтобы увидеть места.'
        : shown.length ? 'Мест на карте: ' + shown.length : '';
  }

  const insideMkad = (lat, lon) => mkadFlat && Core.pointInRing(Core.px(lon), Core.py(lat), mkadFlat);
  let seq = 0;
  async function load() {
    const my = ++seq;
    if (!store.layers.osm || map.getZoom() < MIN_ZOOM || app.tab === 'progress') { render(); return; }
    const b = map.getBounds(), idx = await C.ready;
    if (idx) {
      if (!mkadFlat) mkadFlat = Core.decodeRing(idx.mkad).flatMap((q) => [Core.px(q[1]), Core.py(q[0])]);
      for (const d of idx.d) {
        if (fromData.has(d.id) || d.b[0] > b.getNorth() || d.b[2] < b.getSouth() || d.b[1] > b.getEast() || d.b[3] < b.getWest()) continue;
        try {
          const dist = await C.district(d.id);
          fromData.add(d.id);
          for (const o of dist.objects) add({ id: 'cov:' + C.placeKey(d.id, o.c, o.n), name: o.n, lat: o.lat, lon: o.lon, cat: o.c, w: o.w, f: o.f });
          for (const p of dist.parks) {
            const r = p.rings[0], c = r.reduce((a, q) => [a[0] + q[0] / r.length, a[1] + q[1] / r.length], [0, 0]);
            add({ id: 'cov:' + C.placeKey(d.id, 'park', p.n), name: p.n, lat: c[0], lon: c[1], cat: 'park', park: true, w: p.w, f: p.f, ha: p.ha });
          }
        } catch (e) { /* район не загрузился */ }
      }
    }
    if (my !== seq) return;
    render();
    /* за МКАД данных нет: спрашиваем Overpass, если видна территория снаружи и её ещё не грузили */
    const corners = [b.getNorthWest(), b.getNorthEast(), b.getSouthWest(), b.getSouthEast()];
    const outside = !idx || corners.some((c) => !insideMkad(c.lat, c.lng));
    if (!outside || map.getZoom() < OSM_ZOOM || osmBoxes.some((x) => x.contains(b))) return;
    const box = b.pad(0.3);
    osmBoxes.push(box);
    const area = '(' + [box.getSouth(), box.getWest(), box.getNorth(), box.getEast()].map((x) => x.toFixed(5)).join(',') + ')';
    try {
      const ctx = Core.parseContext(await overpass(Core.contextQuery(area), new AbortController().signal));
      for (const p of ctx.pois) if (!insideMkad(p.lat, p.lon)) add({ id: p.id, name: p.name, lat: p.lat, lon: p.lon, cat: p.cat });
      if (my === seq) render();
    } catch (e) { osmBoxes.splice(osmBoxes.indexOf(box), 1); }
  }
  let timer = null;
  const later = () => { clearTimeout(timer); timer = setTimeout(load, 500); };

  app.on('layers', load);
  map.on('moveend', later);
  app.on('forced', render);
  app.on('tab', later);
  later();
}
