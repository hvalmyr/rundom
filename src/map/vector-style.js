/* Векторная подложка rundom: стиль MapLibre из токенов темы.
   Данные — OpenFreeMap (схема OpenMapTiles). Подложка и подписи — два стиля:
   подписи рисуются отдельным слоем поверх линий маршрута, как у «минимальной». */

export const VECTOR_SOURCE = 'https://tiles.openfreemap.org/planet';
const GLYPHS = 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf';
const FONT = ['Noto Sans Regular'];
const FONT_BOLD = ['Noto Sans Bold'];

/* MapLibre не понимает var() и color-mix(): смешиваем hex-цвета сами. */
function mix(a, b, t) {
  const p = (h) => { h = h.replace('#', ''); if (h.length === 3) h = h.replace(/./g, '$&$&'); return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)); };
  const A = p(a), B = p(b);
  return '#' + A.map((v, i) => Math.round(v + (B[i] - v) * t).toString(16).padStart(2, '0')).join('');
}

/* Цвета карты из токенов. v — чтение токена (cssVar из map.js). */
export function vectorPalette(v, dark) {
  const ground = v('map-ground'), ink = v('ink'), petrol = v('petrol');
  return {
    ground,
    water: v('petrol-tint'),
    waterLine: mix(v('petrol-tint'), petrol, 0.25),
    park: mix(ground, petrol, dark ? 0.1 : 0.07),
    wood: mix(ground, petrol, dark ? 0.15 : 0.11),
    landuse: mix(ground, ink, 0.03),
    building: mix(ground, ink, dark ? 0.1 : 0.07),
    buildingLine: mix(ground, ink, dark ? 0.16 : 0.13),
    casing: v('line'),
    road: dark ? mix(ground, ink, 0.12) : v('surface'),
    roadMajor: dark ? mix(ground, ink, 0.2) : v('surface'),
    roadMajorCasing: v('line-strong'),
    path: v('ink-muted'),
    rail: v('line-strong'),
    label: v('ink-muted'),
    place: ink,
    waterLabel: mix(petrol, ground, 0.2),
    halo: ground
  };
}

const name = ['coalesce', ['get', 'name:ru'], ['get', 'name']];
const isRoad = (classes) => ['match', ['get', 'class'], classes, true, false];
const MINOR = ['minor', 'service'];
const MID = ['tertiary', 'secondary'];
const MAJOR = ['primary', 'trunk', 'motorway'];
const PATHS = ['path', 'track'];
/* ширина линии от масштаба: [z, px, z, px, ...] */
const w = (...stops) => ['interpolate', ['exponential', 1.5], ['zoom'], ...stops];

function baseLayers(c) {
  const road = (id, classes, color, width, extra = {}) => ({
    id, type: 'line', source: 'omt', 'source-layer': 'transportation',
    filter: ['all', isRoad(classes), ['!=', ['get', 'brunnel'], 'tunnel']],
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': color, 'line-width': width },
    ...extra
  });
  return [
    { id: 'ground', type: 'background', paint: { 'background-color': c.ground } },
    { id: 'landuse', type: 'fill', source: 'omt', 'source-layer': 'landuse',
      filter: ['match', ['get', 'class'], ['residential', 'commercial', 'industrial', 'retail'], true, false],
      paint: { 'fill-color': c.landuse } },
    { id: 'wood', type: 'fill', source: 'omt', 'source-layer': 'landcover',
      filter: ['match', ['get', 'class'], ['wood', 'forest'], true, false], paint: { 'fill-color': c.wood } },
    { id: 'grass', type: 'fill', source: 'omt', 'source-layer': 'landcover',
      filter: ['match', ['get', 'class'], ['grass', 'farmland', 'scrub', 'wetland'], true, false], paint: { 'fill-color': c.park } },
    { id: 'park', type: 'fill', source: 'omt', 'source-layer': 'park', paint: { 'fill-color': c.park } },
    { id: 'water', type: 'fill', source: 'omt', 'source-layer': 'water',
      filter: ['!=', ['get', 'brunnel'], 'tunnel'], paint: { 'fill-color': c.water } },
    { id: 'waterway', type: 'line', source: 'omt', 'source-layer': 'waterway', minzoom: 11,
      paint: { 'line-color': c.waterLine, 'line-width': w(11, 0.6, 16, 2.5) } },
    { id: 'building', type: 'fill', source: 'omt', 'source-layer': 'building', minzoom: 13,
      paint: { 'fill-color': c.building, 'fill-outline-color': c.buildingLine, 'fill-opacity': ['interpolate', ['linear'], ['zoom'], 13, 0, 14.5, 1] } },

    road('path', PATHS, c.path, w(14, 0.6, 18, 1.6),
      { minzoom: 14, paint: { 'line-color': c.path, 'line-width': w(14, 0.6, 18, 1.6), 'line-dasharray': [2, 1.5], 'line-opacity': 0.55 }, layout: { 'line-join': 'round' } }),
    road('minor-casing', MINOR, c.casing, w(13, 1, 18, 14), { minzoom: 13 }),
    road('mid-casing', MID, c.casing, w(10, 1.5, 18, 20)),
    road('major-casing', MAJOR, c.roadMajorCasing, w(8, 1, 18, 26)),
    road('minor', MINOR, c.road, w(13, 0.5, 18, 11), { minzoom: 12 }),
    road('mid', MID, c.road, w(10, 0.8, 18, 17)),
    road('major', MAJOR, c.roadMajor, w(8, 0.8, 18, 22)),
    { id: 'rail', type: 'line', source: 'omt', 'source-layer': 'transportation', minzoom: 11,
      filter: ['all', isRoad(['rail', 'transit']), ['!=', ['get', 'brunnel'], 'tunnel']],
      paint: { 'line-color': c.rail, 'line-width': w(11, 0.5, 18, 2), 'line-dasharray': [3, 2] } }
  ];
}

function labelLayers(c) {
  const halo = { 'text-halo-color': c.halo, 'text-halo-width': 1.4, 'text-halo-blur': 0.4 };
  return [
    { id: 'water-name', type: 'symbol', source: 'omt', 'source-layer': 'water_name',
      filter: ['==', ['geometry-type'], 'Point'],
      layout: { 'text-field': name, 'text-font': FONT, 'text-size': 12 },
      paint: { 'text-color': c.waterLabel, ...halo } },
    { id: 'water-name-line', type: 'symbol', source: 'omt', 'source-layer': 'water_name',
      filter: ['==', ['geometry-type'], 'LineString'],
      layout: { 'text-field': name, 'text-font': FONT, 'text-size': 12, 'symbol-placement': 'line' },
      paint: { 'text-color': c.waterLabel, ...halo } },
    { id: 'street-name', type: 'symbol', source: 'omt', 'source-layer': 'transportation_name', minzoom: 14,
      filter: isRoad([...MINOR, ...MID, ...MAJOR, 'pedestrian']),
      layout: { 'text-field': name, 'text-font': FONT, 'text-size': w(14, 10, 18, 13), 'symbol-placement': 'line', 'text-max-angle': 30 },
      paint: { 'text-color': c.label, ...halo } },
    { id: 'place-minor', type: 'symbol', source: 'omt', 'source-layer': 'place', minzoom: 12,
      filter: ['match', ['get', 'class'], ['suburb', 'quarter', 'neighbourhood'], true, false],
      layout: { 'text-field': name, 'text-font': FONT, 'text-size': 12, 'text-transform': 'uppercase', 'text-letter-spacing': 0.08, 'text-max-width': 8 },
      paint: { 'text-color': c.label, ...halo } },
    { id: 'place-town', type: 'symbol', source: 'omt', 'source-layer': 'place',
      filter: ['match', ['get', 'class'], ['town', 'village'], true, false],
      layout: { 'text-field': name, 'text-font': FONT, 'text-size': 13 },
      paint: { 'text-color': c.place, ...halo } },
    { id: 'place-city', type: 'symbol', source: 'omt', 'source-layer': 'place', maxzoom: 13,
      filter: ['==', ['get', 'class'], 'city'],
      layout: { 'text-field': name, 'text-font': FONT_BOLD, 'text-size': w(6, 13, 12, 20) },
      paint: { 'text-color': c.place, ...halo } }
  ];
}

const style = (layers) => ({
  version: 8,
  glyphs: GLYPHS,
  sources: { omt: { type: 'vector', url: VECTOR_SOURCE } },
  layers
});

export const vectorBaseStyle = (c) => style(baseLayers(c));
export const vectorLabelStyle = (c) => style(labelLayers(c));
