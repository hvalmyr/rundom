/* Карта Leaflet: векторная подложка rundom, слои, значки и цвета из токенов темы. */
import L from 'leaflet';
import { store, save } from '../storage/store.js';
import { toast } from '../ui/dom.js';

const ATTR_OSM = '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>';

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
  /* ссылка на Leaflet без флага, который Leaflet 1.9 ставит по умолчанию */
  map.attributionControl.setPrefix('<a href="https://leafletjs.com" target="_blank" rel="noopener">Leaflet</a>');
  map.attributionControl.addAttribution(ATTR_OSM);

  /* Векторная карта: подложка, линии приложения и подписи в одной карте MapLibre.
     Пока она грузится, фасад gl копит линии и правки, потом отдаёт их ей. */
  const st = { data: {}, paint: {}, hidden: {} };
  let impl = null, tileErrors = 0;
  const gl = {
    /* линии слоя: массив линий [[lat, lon], ...] */
    lines(id, lines) { st.data[id] = lines; impl?.data(id); },
    paint(layerId, prop, value) { (st.paint[layerId] ||= {})[prop] = value; impl?.paint(layerId, prop, value); },
    visible(layerId, on) { st.hidden[layerId] = !on; impl?.visible(layerId, on); },
    pick(layerId, latlng, r) { return impl ? impl.pick(layerId, latlng, r) : null; }
  };
  import('./basemap.js')
    .then((m) => m.createBasemap(map, st, {
      cssVar,
      onError: () => { if (++tileErrors === 8) toast('Карта не загружается. Проверьте подключение к интернету.'); }
    }))
    .then((b) => { impl = b; })
    .catch((e) => { console.error(e); toast('Карта не загрузилась. Обновите страницу.'); });
  const setTiles = () => impl?.restyle();

  /* холст по умолчанию (неинтерактивные линии) лежит над зонами и тупиками и забирал щелчки по ним */
  map.getPane('overlayPane').style.pointerEvents = 'none';

  /* зоны и закрытые отрезки — SVG под линиями маршрута: штриховка и цвета из CSS */
  map.createPane('zones');
  map.getPane('zones').style.zIndex = 380;
  const svg = L.svg({ pane: 'zones', padding: 0.3 });
  map.addLayer(svg);
  svg._container.insertAdjacentHTML('afterbegin',
    '<defs><pattern id="rd-hatch" width="7" height="7" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">' +
    '<line x1="0" y1="0" x2="0" y2="7" style="stroke:var(--carmine);stroke-width:1.6;opacity:.5"/></pattern></defs>');

  /* интерактивное поверх векторной карты: выбор районов, захват линии маршрута */
  map.createPane('top');
  map.getPane('top').style.zIndex = 420;
  const svgTop = L.svg({ pane: 'top', padding: 0.3 });
  map.addLayer(svgTop);

  const layers = {};
  ['districts', 'zones', 'compass', 'closed', 'gates', 'blocks', 'osm', 'draft', 'km', 'home', 'ab'].forEach((k) => { layers[k] = L.layerGroup().addTo(map); });

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

  return { map, gl, layers, svg, svgTop, setTiles, toggleLayer };
}
