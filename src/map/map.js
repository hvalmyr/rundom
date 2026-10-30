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
  /* Масштаб ограничен: ближе 18 карты нет, дальше 11 район уже не разобрать.
     Масштабирование — своё, непрерывное: колесо, кнопки и двойной щелчок ведут масштаб к цели кадр за кадром,
     а векторная карта перерисовывается на каждом кадре (как в Яндекс Картах), без отложенной анимации Leaflet.
     Холст векторной карты шире окна на треть с каждой стороны: при сдвиге по краям не видно пустоты. */
  const map = L.map('map', {
    zoomControl: true, preferCanvas: true, zoomSnap: 0, zoomDelta: 0.5, zoomAnimation: false, markerZoomAnimation: false,
    scrollWheelZoom: false, doubleClickZoom: false, minZoom: 11, maxZoom: 18
  })
    .setView([store.view.lat, store.view.lon], store.view.z);
  {
    let target = null, anchor = null, raf = 0, last = 0;
    const clamp = (z) => Math.max(map.getMinZoom(), Math.min(map.getMaxZoom(), z));
    const tick = (now) => {
      const dt = Math.min(64, now - last); last = now;
      const cur = map.getZoom(), d = target - cur;
      if (Math.abs(d) < 0.004) { map.setZoomAround(anchor, target, { animate: false }); raf = 0; target = null; return; }
      /* к цели примерно за 0,2 с: быстро в начале, мягко в конце */
      map.setZoomAround(anchor, cur + d * (1 - Math.exp(-dt / 70)), { animate: false });
      raf = requestAnimationFrame(tick);
    };
    /* delta — на сколько уровней; point — точка окна, которая остаётся на месте (по умолчанию центр) */
    const zoomBy = (delta, point) => {
      target = clamp((target === null ? map.getZoom() : target) + delta);
      anchor = point || map.getSize().divideBy(2);
      if (!raf) { last = performance.now(); raf = requestAnimationFrame(tick); }
    };
    map.getContainer().addEventListener('wheel', (e) => {
      e.preventDefault();
      const px = e.deltaY * (e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? 800 : 1);
      /* одно деление мыши (≈100) — полуровня; щипок на трекпаде (ctrl) чувствительнее */
      zoomBy(Math.max(-1, Math.min(1, -px / (e.ctrlKey ? 60 : 200))), map.mouseEventToContainerPoint(e));
    }, { passive: false });
    map.zoomIn = (d) => { zoomBy(d || map.options.zoomDelta); return map; };
    map.zoomOut = (d) => { zoomBy(-(d || map.options.zoomDelta)); return map; };
    map.on('dblclick', (e) => zoomBy(e.originalEvent.shiftKey ? -1 : 1, e.containerPoint));
  }
  L.control.scale({ imperial: false }).addTo(map);
  /* ссылка на Leaflet без флага, который Leaflet 1.9 ставит по умолчанию */
  map.attributionControl.setPrefix('<a href="https://leafletjs.com" target="_blank" rel="noopener">Leaflet</a>');
  map.attributionControl.addAttribution(ATTR_OSM);

  /* Векторная карта: подложка, линии приложения и подписи в одной карте MapLibre.
     Пока она грузится, фасад gl копит линии и правки, потом отдаёт их ей. */
  const st = { data: {}, polys: {}, paint: {}, hidden: {} };
  let impl = null, tileErrors = 0;
  const gl = {
    /* линии слоя: массив линий [[lat, lon], ...] */
    lines(id, lines) { st.data[id] = lines; impl?.data(id); },
    /* заливки: массив многоугольников, у каждого первый круг — контур, остальные — дыры */
    polys(id, polys) { st.polys[id] = polys; impl?.polys(id); },
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
