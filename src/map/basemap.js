/* Векторная карта MapLibre внутри Leaflet. Модуль грузится отдельно от приложения:
   панель появляется сразу, карта — когда догрузится MapLibre. */
import 'maplibre-gl/dist/maplibre-gl.css';
import { setWorkerUrl, addProtocol } from 'maplibre-gl';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';
import { maplibreGL } from '@maplibre/maplibre-gl-leaflet';
import { vectorPalette, vectorStyle, linesGeoJSON, polysGeoJSON, overlaySource } from './vector-style.js';
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
  const layer = maplibreGL({ style: style(), interactive: false, padding: 0.3 });
  layer.addTo(map);
  const gl = layer.getMaplibreMap();
  gl.on('error', (e) => { console.warn(e.error); onError(); });

  /* Правка ложится сразу, если источник или слой уже есть в стиле. isStyleLoaded() тут не годится:
     он ложен, пока догружаются тайлы подложки, и линия маршрута ждала бы следующего события стиля —
     поэтому трек обновлялся с задержкой или не обновлялся вовсе. Пока стиль грузится (старт, смена темы),
     правка ждёт style.load; данные она берёт из st в момент применения. */
  const when = (has, fn) => (has() ? fn() : gl.once('style.load', () => has() && fn()));
  return {
    data(id) {
      const src = overlaySource(id);
      when(() => gl.getSource(src), () => gl.getSource(src).setData(linesGeoJSON(st.data[id])));
    },
    polys(id) {
      when(() => gl.getSource('rd-' + id), () => gl.getSource('rd-' + id).setData(polysGeoJSON(st.polys[id])));
    },
    paint(layerId, prop, value) { when(() => gl.getLayer(layerId), () => gl.setPaintProperty(layerId, prop, value)); },
    visible(layerId, on) { when(() => gl.getLayer(layerId), () => gl.setLayoutProperty(layerId, 'visibility', on ? 'visible' : 'none')); },
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
