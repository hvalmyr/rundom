/* Векторная подложка rundom: стиль MapLibre из токенов темы.
   Данные — свои тайлы Москвы (data/moscow.pmtiles, схема rundom, scripts/tiles/process.lua).
   Одна карта: подложка, затем линии приложения (пройденное, варианты, маршрут), сверху подписи —
   они не теряются под линией маршрута. Адреса глифов нет: MapLibre рисует подписи сам шрифтом
   страницы (Inter). */

/* Первое имя задаёт начертание (MapLibre угадывает вес по слову SemiBold), второе — семейство. */
const FONT = ['Inter'];
const FONT_BOLD = ['Inter SemiBold', 'Inter'];

/* Цвета карты — токены map-* из tokens.css. v — чтение токена (cssVar из map.js). */
export function vectorPalette(v) {
  return {
    ground: v('map-ground'),
    water: v('map-water'),
    waterLine: v('map-water-line'),
    park: v('map-park'),
    wood: v('map-wood'),
    landuse: v('map-landuse'),
    building: v('map-building'),
    buildingLine: v('map-building-line'),
    casing: v('map-road-casing'),
    road: v('map-road'),
    roadMajor: v('map-road-major'),
    roadMajorCasing: v('map-road-major-casing'),
    path: v('map-path'),
    rail: v('map-rail'),
    lit: v('map-lit'),
    label: v('map-label'),
    place: v('map-place'),
    waterLabel: v('map-water-label'),
    halo: v('map-ground'),
    explored: v('map-explored'),
    route: v('map-route'),
    alt: v('ink-muted'),
    paper: v('paper'),
    ink: v('ink'),
    inkMuted: v('ink-muted'),
    carmine: v('carmine'),
    carmineStrong: v('carmine-strong')
  };
}

const cls = (...classes) => ['match', ['get', 'class'], classes, true, false];
const not = (k, v) => ['!=', ['get', k], v];
const is = (k, v) => ['==', ['get', k], v];
/* run: 1 — генератор строит здесь маршрут, 0 — закрыто для пешехода */
const closed = is('run', 0);
/* значение по классу: у класса k — a, у остальных — b */
const by = (k, a, b) => ['match', ['get', 'class'], k, a, b];
const MINOR = ['minor', 'service'];
/* ширина линии от масштаба: [z, px, z, px, ...] */
const w = (...stops) => ['interpolate', ['exponential', 1.5], ['zoom'], ...stops];

function baseLayers(c) {
  const src = { source: 'rd', 'source-layer': 'road' };
  const line = (id, filter, paint, extra = {}) => ({
    id, type: 'line', ...src, filter,
    layout: { 'line-cap': 'round', 'line-join': 'round' }, paint, ...extra
  });
  /* закрытые для пешехода улицы и дорожки — бледнее: бежать по ним генератор не станет */
  const fade = (o) => ['case', closed, o * 0.35, o];
  const ground = not('brunnel', 'tunnel');
  const PATHS = cls('path', 'steps');
  return [
    { id: 'ground', type: 'background', paint: { 'background-color': c.ground } },
    { id: 'landuse', type: 'fill', source: 'rd', 'source-layer': 'landuse',
      filter: cls('residential', 'commercial', 'industrial', 'retail', 'railway', 'garages', 'construction'),
      paint: { 'fill-color': c.landuse } },
    { id: 'cemetery', type: 'fill', source: 'rd', 'source-layer': 'landuse', filter: is('class', 'cemetery'),
      paint: { 'fill-color': c.park } },
    { id: 'wood', type: 'fill', source: 'rd', 'source-layer': 'landcover', filter: is('class', 'wood'),
      paint: { 'fill-color': c.wood } },
    { id: 'grass', type: 'fill', source: 'rd', 'source-layer': 'landcover', filter: is('class', 'grass'),
      paint: { 'fill-color': c.park } },
    { id: 'park', type: 'fill', source: 'rd', 'source-layer': 'park', paint: { 'fill-color': c.park } },
    { id: 'water', type: 'fill', source: 'rd', 'source-layer': 'water', paint: { 'fill-color': c.water } },
    { id: 'waterway', type: 'line', source: 'rd', 'source-layer': 'waterway',
      paint: { 'line-color': c.waterLine, 'line-width': w(10, by('stream', 0, 0.6), 17, by('stream', 1.5, 3)) } },
    { id: 'building', type: 'fill', source: 'rd', 'source-layer': 'building', minzoom: 13,
      paint: { 'fill-color': c.building, 'fill-outline-color': c.buildingLine, 'fill-opacity': ['interpolate', ['linear'], ['zoom'], 13, 0, 14.5, 1] } },

    /* подземные переходы и тоннели дорожек — пунктиром поверх домов: по ним тоже бегают */
    line('path-tunnel', ['all', PATHS, is('brunnel', 'tunnel'), is('run', 1)],
      { 'line-color': c.path, 'line-width': w(15, 0.8, 18, 2), 'line-dasharray': [1, 1.5], 'line-opacity': 0.4 }, { minzoom: 15, layout: { 'line-join': 'round' } }),
    /* освещённые дорожки — тёплый ореол под линией: вечером бегут там */
    line('path-lit', ['all', PATHS, ground, is('lit', 1), is('run', 1)],
      { 'line-color': c.lit, 'line-width': w(15, 2.5, 18, 7), 'line-opacity': ['interpolate', ['linear'], ['zoom'], 15, 0, 16, 0.5] }, { minzoom: 15 }),
    /* пешеходные мосты — обводка, как у улиц */
    line('path-bridge-casing', ['all', PATHS, is('brunnel', 'bridge')],
      { 'line-color': c.roadMajorCasing, 'line-width': w(14, 3, 18, 8) }, { minzoom: 14 }),
    line('path-bridge', ['all', PATHS, is('brunnel', 'bridge')],
      { 'line-color': c.road, 'line-width': w(14, 1.8, 18, 6) }, { minzoom: 14 }),
    /* асфальтовые дорожки — сплошной линией, грунтовые — пунктиром */
    line('path', ['all', is('class', 'path'), ground, ['!', ['has', 'unpaved']], ['!', ['has', 'crossing']]],
      { 'line-color': c.path, 'line-width': w(13, 0.5, 18, 1.8), 'line-opacity': fade(0.6) }, { minzoom: 13 }),
    line('path-unpaved', ['all', is('class', 'path'), ground, ['has', 'unpaved']],
      { 'line-color': c.path, 'line-width': w(13, 0.6, 18, 1.8), 'line-dasharray': [2, 1.5], 'line-opacity': fade(0.6) },
      { minzoom: 13, layout: { 'line-join': 'round' } }),
    /* лестницы — частые поперечные штрихи */
    line('steps', ['all', is('class', 'steps'), ground],
      { 'line-color': c.path, 'line-width': w(14, 2, 18, 5), 'line-dasharray': [0.25, 0.25], 'line-opacity': fade(0.8) },
      { minzoom: 14, layout: { 'line-join': 'round' } }),

    line('minor-casing', ['all', cls(...MINOR), ground], { 'line-color': c.casing, 'line-width': w(13, 1, 18, 14), 'line-opacity': fade(1) }, { minzoom: 13 }),
    line('mid-casing', ['all', is('class', 'mid'), ground], { 'line-color': c.casing, 'line-width': w(10, 1.5, 18, 20) }),
    line('major-casing', ['all', is('class', 'major'), ground], { 'line-color': c.roadMajorCasing, 'line-width': w(8, 1, 18, 26) }),
    line('minor', ['all', cls(...MINOR), ground], { 'line-color': c.road, 'line-width': w(13, 0.5, 18, 11), 'line-opacity': fade(1) }, { minzoom: 12 }),
    line('mid', ['all', is('class', 'mid'), ground], { 'line-color': c.road, 'line-width': w(10, 0.8, 18, 17) }),
    line('major', ['all', is('class', 'major'), ground], { 'line-color': c.roadMajor, 'line-width': w(8, 0.8, 18, 22) }),
    /* переходы — зебра поверх проезжей части */
    line('crossing', ['all', is('class', 'path'), ['has', 'crossing']],
      { 'line-color': c.path, 'line-width': w(15, 2, 18, 7), 'line-dasharray': [0.3, 0.3], 'line-opacity': 0.5 },
      { minzoom: 15, layout: { 'line-join': 'round' } }),
    line('rail', ['all', cls('rail', 'tram'), ground],
      { 'line-color': c.rail, 'line-width': w(10, by('tram', 0.4, 0.5), 18, by('tram', 1.2, 2)), 'line-dasharray': [3, 2] },
      { layout: {} })
  ];
}

/* Градиент маршрута: от бледного старта (0%) к насыщенному финишу (100%) — на развилках видно, куда дальше.
   Нужен источник с lineMetrics. hex — цвет линии в виде #rrggbb (иначе без градиента). */
export function routeGradient(hex, flat = false) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(String(hex).trim());
  const to = hex, from = m && !flat ? `rgba(${parseInt(m[1], 16)}, ${parseInt(m[2], 16)}, ${parseInt(m[3], 16)}, 0.28)` : hex;
  return ['interpolate', ['linear'], ['line-progress'], 0, from, 1, to];
}

/* Линии приложения. Источник у каждой свой, данные задаёт приложение (ov.data). */
export const OVERLAYS = ['explored', 'alt', 'approach', 'route-halo', 'route', 'cov-off', 'cov-on', 'cov-left', 'cov-right', 'cov-mkad'];
const OVERLAY_SOURCE = { 'route-halo': 'route' };
export const overlaySource = (id) => 'rd-' + (OVERLAY_SOURCE[id] || id);

function overlayLayers(c) {
  const line = (id, paint, layout = {}) => ({
    id, type: 'line', source: overlaySource(id),
    layout: { 'line-cap': 'round', 'line-join': 'round', ...layout },
    paint
  });
  return [
    line('explored', { 'line-color': c.explored, 'line-width': 2.5, 'line-opacity': 0.9 }),
    line('alt', { 'line-color': c.alt, 'line-width': 3, 'line-opacity': 0.45 }),
    /* подводка — цепочка точек: штрих почти нулевой длины с круглыми концами */
    line('approach', { 'line-color': c.route, 'line-width': 3.5, 'line-dasharray': [0.01, 2] }),
    line('route-halo', { 'line-color': c.paper, 'line-width': 9 }),
    line('route', { 'line-color': c.route, 'line-width': 5, 'line-gradient': routeGradient(c.route) })
  ];
}

/* Вкладка «Прогресс» целиком рисуется внутри карты: маска за МКАД, заливки и границы районов, пройденные улицы,
   затемнение вокруг выбранного района. Всё двигается и масштабируется вместе с картой, а не перерисовывается
   поверх. Лежит над подписями; по умолчанию скрыто (приложение включает, пока открыта вкладка). */
export const POLYS = ['cov-mask', 'cov-mute', 'cov-fill', 'cov-hot', 'cov-dim'];
const polysSource = (id) => 'rd-' + id;
function covLayers(c) {
  const off = { visibility: 'none' };
  const fill = (id, source, paint) => ({ id, type: 'fill', source: polysSource(source), layout: off, paint: { 'fill-antialias': false, ...paint } });
  const flat = (id, o) => fill(id, id, { 'fill-color': c.paper, 'fill-opacity': o });
  /* районы: цвет границы — по свойству k (0 — кармин, 1 — серый, 2 — выбранный), прозрачность и толщина — b и w */
  const tint = (id) => fill(id, id, { 'fill-color': c.carmine, 'fill-opacity': ['get', 'o'] });
  const border = (id, source) => ({
    id, type: 'line', source: polysSource(source), layout: { ...off, 'line-join': 'round' },
    paint: { 'line-color': ['match', ['get', 'k'], 1, c.inkMuted, 2, c.carmineStrong, c.carmine], 'line-opacity': ['interpolate', ['linear'], ['zoom'], 9, ['*', ['get', 'b'], 0.45], 12, ['get', 'b']],
      /* при отдалении границы тоньше: сотня районов не должна сливаться в тёмную сетку */
      'line-width': ['interpolate', ['linear'], ['zoom'], 8, ['*', ['get', 'w'], 0.35], 11, ['*', ['get', 'w'], 0.6], 14, ['get', 'w']] }
  });
  const line = (cid, paint) => ({ id: cid, type: 'line', source: overlaySource(cid), layout: { ...off, 'line-cap': 'round', 'line-join': 'round' }, paint });
  return [
    flat('cov-mute', 0.72),
    tint('cov-fill'), border('cov-fill-line', 'cov-fill'),
    line('cov-off', { 'line-color': c.inkMuted, 'line-width': 1, 'line-opacity': 0.6 }),
    line('cov-on', { 'line-color': c.ink, 'line-width': 2.4, 'line-opacity': 0.95 }),
    /* пройдена одна сторона двусторонней улицы: линия сбоку от оси, тоньше */
    line('cov-left', { 'line-color': c.ink, 'line-width': 1.6, 'line-opacity': 0.95, 'line-offset': -1.6 }),
    line('cov-right', { 'line-color': c.ink, 'line-width': 1.6, 'line-opacity': 0.95, 'line-offset': 1.6 }),
    line('cov-mkad', { 'line-color': c.ink, 'line-width': 1.6, 'line-opacity': 0.7 }),
    tint('cov-hot'), border('cov-hot-line', 'cov-hot'),
    flat('cov-dim', 0.6),
    flat('cov-mask', 0.9)
  ];
}

/* Многоугольники → GeoJSON. Каждый — круги [[lat, lon], ...] (первый — контур, остальные — дыры)
   или {rings, p: свойства}. */
export function polysGeoJSON(polys) {
  return {
    type: 'FeatureCollection',
    features: (polys || []).map((it) => {
      const rings = Array.isArray(it) ? it : it.rings;
      return {
        type: 'Feature', properties: Array.isArray(it) ? {} : it.p || {},
        geometry: { type: 'Polygon', coordinates: rings.map((r) => r.map((p) => [p[1], p[0]])) }
      };
    })
  };
}

function labelLayers(c) {
  const halo = { 'text-halo-color': c.halo, 'text-halo-width': 1.4, 'text-halo-blur': 0.4 };
  const text = (size, extra = {}) => ({ 'text-field': ['get', 'name'], 'text-font': FONT, 'text-size': size, ...extra });
  const point = ['==', ['geometry-type'], 'Point'];
  return [
    /* вода, туалеты и фонтаны: на пробежке их ищут */
    { id: 'poi', type: 'circle', source: 'rd', 'source-layer': 'poi', minzoom: 15,
      paint: {
        'circle-radius': w(15, 3, 18, 5.5),
        'circle-color': ['match', ['get', 'class'], 'drinking_water', c.waterLabel, 'fountain', c.waterLine, c.label],
        'circle-stroke-color': c.paper, 'circle-stroke-width': 1.5
      } },
    { id: 'poi-label', type: 'symbol', source: 'rd', 'source-layer': 'poi', minzoom: 17,
      layout: text(10, {
        'text-field': ['match', ['get', 'class'], 'drinking_water', 'вода', 'fountain', 'фонтан', 'toilets', 'туалет', ''],
        'text-anchor': 'left', 'text-offset': [0.8, 0], 'text-optional': true
      }),
      paint: { 'text-color': c.label, ...halo } },
    { id: 'water-name', type: 'symbol', source: 'rd', 'source-layer': 'water_name', filter: point,
      layout: text(12), paint: { 'text-color': c.waterLabel, ...halo } },
    { id: 'water-name-line', type: 'symbol', source: 'rd', 'source-layer': 'water_name',
      filter: ['==', ['geometry-type'], 'LineString'],
      layout: text(12, { 'symbol-placement': 'line' }), paint: { 'text-color': c.waterLabel, ...halo } },
    { id: 'park-name', type: 'symbol', source: 'rd', 'source-layer': 'park_name', minzoom: 13,
      layout: text(w(13, 10, 17, 12), { 'text-max-width': 8 }), paint: { 'text-color': c.label, 'text-opacity': 0.85, ...halo } },
    { id: 'street-name', type: 'symbol', source: 'rd', 'source-layer': 'road_name', minzoom: 14,
      layout: text(w(14, 10, 18, 13), { 'symbol-placement': 'line', 'text-max-angle': 30 }),
      paint: { 'text-color': c.label, ...halo } },
    /* Районы Москвы видны раньше всего остального: по ним ориентируются и выбирают маршрут.
       Кварталы — только вблизи. Посёлки вокруг Москвы — тихо, мелким серым: они не цель. */
    { id: 'place-minor', type: 'symbol', source: 'rd', 'source-layer': 'place', minzoom: 11, filter: is('class', 'suburb'),
      layout: text(w(11, 10, 15, 13), { 'text-transform': 'uppercase', 'text-letter-spacing': 0.08, 'text-max-width': 8 }),
      paint: { 'text-color': c.label, ...halo } },
    { id: 'place-quarter', type: 'symbol', source: 'rd', 'source-layer': 'place', minzoom: 14, filter: cls('quarter', 'neighbourhood'),
      layout: text(11, { 'text-max-width': 8 }), paint: { 'text-color': c.label, ...halo } },
    { id: 'place-town', type: 'symbol', source: 'rd', 'source-layer': 'place', minzoom: 10, filter: cls('town', 'village'),
      layout: text(w(10, 10, 14, 12)), paint: { 'text-color': c.label, 'text-opacity': 0.8, ...halo } },
    { id: 'place-city', type: 'symbol', source: 'rd', 'source-layer': 'place', maxzoom: 11, filter: is('class', 'city'),
      layout: text(w(6, 13, 11, 18), { 'text-font': FONT_BOLD }), paint: { 'text-color': c.place, ...halo } }
  ];
}

/* Линии [[lat, lon], ...] → GeoJSON; у каждой линии свойство i — её номер. */
export function linesGeoJSON(lines) {
  return {
    type: 'FeatureCollection',
    features: (lines || []).map((ln, i) => ({
      type: 'Feature', properties: { i },
      geometry: { type: 'LineString', coordinates: ln.map((p) => [p[1], p[0]]) }
    }))
  };
}

/* rd — источник тайлов (pmtilesSource),
   ov: { data: {id: lines}, paint: {layerId: {prop: value}}, hidden: {layerId: true} } */
export function vectorStyle(c, rd, ov) {
  const sources = { rd };
  for (const id of OVERLAYS) sources[overlaySource(id)] ||= { type: 'geojson', data: linesGeoJSON(ov.data[overlaySource(id).slice(3)]), lineMetrics: overlaySource(id) === 'rd-route' };
  for (const id of POLYS) sources[polysSource(id)] = { type: 'geojson', data: polysGeoJSON((ov.polys || {})[id]) };
  const layers = [...baseLayers(c), ...overlayLayers(c), ...labelLayers(c), ...covLayers(c)];
  for (const l of layers) {
    Object.assign(l.paint ||= {}, ov.paint[l.id]);
    if (ov.hidden[l.id]) (l.layout ||= {}).visibility = 'none';
    else if (ov.hidden[l.id] === false && l.layout && l.layout.visibility) l.layout.visibility = 'visible';
  }
  return { version: 8, sources, layers };
}
