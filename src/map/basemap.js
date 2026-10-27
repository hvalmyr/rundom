/* Векторная карта MapLibre внутри Leaflet. Модуль грузится отдельно от приложения:
   панель появляется сразу, карта — когда догрузится MapLibre. */
import 'maplibre-gl/dist/maplibre-gl.css';
import { setWorkerUrl, addProtocol } from 'maplibre-gl';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';
import { maplibreGL } from '@maplibre/maplibre-gl-leaflet';
import { vectorPalette, vectorStyle, linesGeoJSON, overlaySource } from './vector-style.js';
import { pmtilesProtocol, pmtilesSource } from './pmtiles.js';

/* MapLibre ищет воркер рядом со своим модулем, а Vite его оттуда переносит: путь задаём явно. */
setWorkerUrl(workerUrl);
addProtocol('pmtiles', pmtilesProtocol);

/* свои тайлы Москвы: собираются вместе с данными покрытия (scripts/tiles) */
const TILES = new URL('data/moscow.pmtiles', document.baseURI).href;

/* Подписи рисуются шрифтом страницы: подгружаем кириллицу Inter заранее, иначе первые
   буквы MapLibre нарисует запасным шрифтом. */
const fontsReady = document.fonts
  ? Promise.all(['400', '600'].map((wt) => document.fonts.load(wt + ' 16px Inter', 'Аа Яя Aa'))).catch(() => {})
  : Promise.resolve();

/* st — состояние линий из фасада в map.js: {data, paint, hidden}. */
export async function createBasemap(map, st, { cssVar, onError }) {
  const [rd] = await Promise.all([pmtilesSource(TILES), fontsReady]);
  const style = () => vectorStyle(vectorPalette(cssVar), rd, st);
  const layer = maplibreGL({ style: style(), interactive: false });
  layer.addTo(map);
  const gl = layer.getMaplibreMap();
  gl.on('error', (e) => { console.warn(e.error); onError(); });

  const when = (fn) => (gl.isStyleLoaded() ? fn() : gl.once('styledata', fn));
  return {
    data(id) { when(() => gl.getSource(overlaySource(id))?.setData(linesGeoJSON(st.data[id]))); },
    paint(layerId, prop, value) { when(() => gl.getLayer(layerId) && gl.setPaintProperty(layerId, prop, value)); },
    visible(layerId, on) { when(() => gl.getLayer(layerId) && gl.setLayoutProperty(layerId, 'visibility', on ? 'visible' : 'none')); },
    /* смена темы: стиль заново из токенов, данные и правки линий берутся из st */
    restyle() { gl.setStyle(style(), { diff: false }); },
    /* номер линии слоя layerId в радиусе r пикселей от точки, или null */
    pick(layerId, latlng, r) {
      if (!gl.isStyleLoaded() || !gl.getLayer(layerId)) return null;
      const p = gl.project([latlng.lng, latlng.lat]);
      const f = gl.queryRenderedFeatures([[p.x - r, p.y - r], [p.x + r, p.y + r]], { layers: [layerId] });
      return f.length ? f[0].properties.i : null;
    }
  };
}
