/* Вкладка «Прогресс»: сводка по библиотеке и места из OpenStreetMap.
   Карта покрытия МКАД, районы и объекты — следующие этапы. */
import L from 'leaflet';
import * as Core from '../core/index.js';
import { store, save } from '../storage/store.js';
import { overpass } from '../data/overpass.js';
import { divIcon } from '../map/map.js';
import { $, el, fmtKm, toast } from './dom.js';

const CATS = {
  view: 'Видовая точка', park: 'Парк', water: 'Вода, набережная', sight: 'Достопримечательность',
  art: 'Арт-объект', history: 'Памятник', other: 'Место'
};
const MAX_SHOWN = 700;

export function initProgressPanel(app) {
  const { map, layers, S } = app;

  function renderStats() {
    const km = store.explored.reduce((s, en) => s + (en.km || 0), 0);
    $('#progKm').textContent = fmtKm(km);
    $('#progCount').textContent = String(store.explored.length);
  }

  function renderOsm() {
    layers.osm.clearLayers();
    for (const p of S.osmPois.slice(0, MAX_SHOWN)) {
      const via = app.isForced(p.id);
      const m = L.marker([p.lat, p.lon], { icon: divIcon('mk-poi' + (via ? ' via' : ''), 16, 16), title: p.name });
      m.bindPopup(() => el('div', { class: 'pop' },
        el('strong', null, p.name || 'Без названия'),
        el('div', { class: 'sub' }, CATS[p.cat] || CATS.other),
        el('button', {
          class: 'btn small' + (app.isForced(p.id) ? '' : ' primary'), type: 'button',
          onclick: () => { app.toggleForced(p); map.closePopup(); }
        }, app.isForced(p.id) ? 'Убрать из маршрута' : 'Пройти через')));
      layers.osm.addLayer(m);
    }
    const n = S.osmPois.length;
    $('#osmInfo').textContent = n ? 'Загружено мест: ' + n + (n > MAX_SHOWN ? ' (на карте первые ' + MAX_SHOWN + ')' : '') : '';
  }

  $('#showOsm').addEventListener('change', (e) => { store.layers.osm = e.target.checked; app.syncLayers(); save(); });
  $('#loadOsm').addEventListener('click', async () => {
    if (map.getZoom() < 13) { toast('Приблизьте карту до масштаба 13 или крупнее, затем загрузите места.'); return; }
    const b = map.getBounds();
    const area = '(' + [b.getSouth(), b.getWest(), b.getNorth(), b.getEast()].map((x) => x.toFixed(5)).join(',') + ')';
    const btn = $('#loadOsm');
    btn.disabled = true; $('#osmInfo').textContent = 'Загружаю…';
    try {
      const ctx = Core.parseContext(await overpass(Core.contextQuery(area), new AbortController().signal));
      const have = new Set(S.osmPois.map((p) => p.id));
      for (const p of ctx.pois) if (!have.has(p.id)) S.osmPois.push({ id: p.id, name: p.name, lat: p.lat, lon: p.lon, cat: p.cat });
      store.layers.osm = true; app.syncLayers(); renderOsm(); save();
    } catch (e) { $('#osmInfo').textContent = ''; toast('Не удалось загрузить места. Попробуйте позже.'); }
    btn.disabled = false;
  });

  app.on('explored', renderStats);
  app.on('forced', renderOsm);
  renderStats();
}
