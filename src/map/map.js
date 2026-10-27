/* Карта Leaflet: подложки, слои, значки и цвета из токенов темы. */
import L from 'leaflet';
import { store, save } from '../storage/store.js';
import { toast } from '../ui/dom.js';

const ATTR_OSM = '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>';

const ESRI = 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/';

/* У «минимальной» подложки подписи идут отдельным слоем поверх линий маршрута. */
export const TILES = {
  carto: {
    name: 'Минимальная (Esri Canvas)',
    url: (dark) => ESRI + (dark ? 'World_Dark_Gray_Base' : 'World_Light_Gray_Base') + '/MapServer/tile/{z}/{y}/{x}',
    labels: (dark) => ESRI + (dark ? 'World_Dark_Gray_Reference' : 'World_Light_Gray_Reference') + '/MapServer/tile/{z}/{y}/{x}',
    o: { maxZoom: 19, maxNativeZoom: 16, attribution: 'Tiles © Esri, HERE, Garmin, ' + ATTR_OSM }
  },
  osm: { name: 'OpenStreetMap', url: () => 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', o: { maxZoom: 19, attribution: ATTR_OSM } },
  topo: {
    name: 'OpenTopoMap (рельеф, тропы)', url: () => 'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png',
    o: { maxZoom: 17, subdomains: 'abc', attribution: ATTR_OSM + ', SRTM | © OpenTopoMap (CC-BY-SA)' }
  }
};

export function isDark() {
  const t = document.documentElement.getAttribute('data-theme');
  if (t) return t === 'dark';
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

/* Значение CSS-токена: Leaflet рисует canvas и не понимает var(). */
export function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue('--' + name).trim();
}

export function divIcon(cls, w, h, html) {
  return L.divIcon({ html: `<div class="${cls}">${html || ''}</div>`, className: '', iconSize: [w, h], iconAnchor: [w / 2, h / 2] });
}

export function createMap() {
  const map = L.map('map', { zoomControl: true, preferCanvas: true, zoomSnap: 0.5 })
    .setView([store.view.lat, store.view.lon], store.view.z);
  L.control.scale({ imperial: false }).addTo(map);

  map.createPane('labels');
  map.getPane('labels').style.zIndex = 450;
  map.getPane('labels').style.pointerEvents = 'none';

  let tileLayer = null, labelLayer = null, tileErrors = 0;
  function setTiles(key) {
    if (!TILES[key]) key = 'carto';
    if (tileLayer) map.removeLayer(tileLayer);
    if (labelLayer) { map.removeLayer(labelLayer); labelLayer = null; }
    tileErrors = 0;
    const t = TILES[key];
    if (t.labels) labelLayer = L.tileLayer(t.labels(isDark()), { ...t.o, pane: 'labels', attribution: '' }).addTo(map);
    tileLayer = L.tileLayer(t.url(isDark()), t.o);
    tileLayer.on('tileerror', () => {
      tileErrors++;
      if (tileErrors === 8 && key !== 'carto') {
        store.tiles = 'carto'; save(); setTiles('carto');
        toast('Эта подложка не загружается. Переключился на минимальную.');
      }
    });
    tileLayer.addTo(map);
    tileLayer.bringToBack();
  }
  setTiles(store.tiles);

  /* зоны и закрытые отрезки — SVG под линиями маршрута: штриховка и цвета из CSS */
  map.createPane('zones');
  map.getPane('zones').style.zIndex = 380;
  const svg = L.svg({ pane: 'zones', padding: 0.3 });
  map.addLayer(svg);
  svg._container.insertAdjacentHTML('afterbegin',
    '<defs><pattern id="rd-hatch" width="7" height="7" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">' +
    '<line x1="0" y1="0" x2="0" y2="7" style="stroke:var(--carmine);stroke-width:1.6;opacity:.5"/></pattern></defs>');

  /* интерактивное поверх canvas-слоя маршрутов: выбор районов, захват линии маршрута */
  map.createPane('top');
  map.getPane('top').style.zIndex = 420;
  const svgTop = L.svg({ pane: 'top', padding: 0.3 });
  map.addLayer(svgTop);

  const layers = {};
  ['districts', 'zones', 'compass', 'explored', 'closed', 'gates', 'blocks', 'osm', 'routes', 'draft', 'km', 'home', 'ab'].forEach((k) => { layers[k] = L.layerGroup().addTo(map); });

  map.on('moveend', () => {
    const c = map.getCenter();
    store.view = { lat: c.lat, lon: c.lng, z: map.getZoom() };
    save();
  });
  window.addEventListener('resize', () => map.invalidateSize());

  function toggleLayer(layer, on) {
    if (on && !map.hasLayer(layer)) map.addLayer(layer);
    if (!on && map.hasLayer(layer)) map.removeLayer(layer);
  }

  return { map, layers, svg, svgTop, setTiles, toggleLayer };
}
