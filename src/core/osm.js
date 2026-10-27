/* OpenStreetMap: правила проходимости, запросы Overpass и разбор ответов. */
import { hav, px, py } from './geo.js';

/* ---------- правила проходимости ---------- */
var PATHLIKE = { pedestrian: 1, footway: 1, path: 1, cycleway: 1, track: 1, bridleway: 1 };
var STREET = { living_street: 1, residential: 1, unclassified: 1, service: 1, road: 1 };
var ROADS = { tertiary: 1, tertiary_link: 1 };
var MAIN = { secondary: 1, secondary_link: 1, primary: 1, primary_link: 1 };
var CLOSED_ACCESS = { no: 1, 'private': 1, customers: 1, permit: 1, delivery: 1, agricultural: 1, forestry: 1, military: 1 };
var CLS = { path: 0, street: 1, road: 2, main: 3, steps: 4 };
var SURFACE = {
  asphalt: 0, paved: 0, concrete: 0, 'concrete:plates': 0.05, 'concrete:lanes': 0.05, paving_stones: 0.02,
  sett: 0.1, cobblestone: 0.15, unhewn_cobblestone: 0.3, compacted: 0.05, fine_gravel: 0.08, gravel: 0.2,
  unpaved: 0.2, dirt: 0.3, earth: 0.3, ground: 0.3, grass: 0.35, mud: 0.8, sand: 0.8, wood: 0.1, metal: 0.05,
  tartan: 0, rubber: 0, woodchips: 0.15, pebblestone: 0.25
};

function isFootYes(t) { return t.foot === 'yes' || t.foot === 'designated' || t.foot === 'permissive'; }

/* null: путь не нужен; {ok:false, closed:true}: закрыт для пешехода; {ok:true,...}: проходим. */
function classifyWay(t, o) {
  var hw = t.highway;
  if (!hw) return null;
  if (!(PATHLIKE[hw] || STREET[hw] || ROADS[hw] || MAIN[hw] || hw === 'steps')) return null;
  if (t.indoor === 'yes' || t.indoor === 'room' || t.indoor === 'corridor') return null;
  if (t.service === 'parking_aisle' || t.service === 'drive-through') return null;
  var footYes = isFootYes(t);
  if (t.foot === 'no' || t.foot === 'private' || t.foot === 'use_sidepath') return { ok: false, closed: true, why: 'foot' };
  if (!footYes && t.access && CLOSED_ACCESS[t.access]) return { ok: false, closed: true, why: 'access' };

  var cls, pen = 0, appeal = 0, fix = 0;
  if (hw === 'steps') {
    if (o && o.avoidSteps) return { ok: false, closed: false };
    cls = CLS.steps; appeal = 0.3;
  } else if (PATHLIKE[hw]) {
    cls = CLS.path;
    var fw = t.footway;
    if (fw === 'crossing' || t.crossing) { fix = 25; appeal = 0; }
    else if (fw === 'sidewalk') { appeal = 0; }
    else if (hw === 'pedestrian') appeal = 0.7;
    else if (hw === 'track') { appeal = 0.7; if (t.tracktype === 'grade4' || t.tracktype === 'grade5') pen += 0.3; }
    else appeal = 0.55;
    if (hw === 'cycleway') pen += 0.05;
    if (hw === 'bridleway') pen += 0.2;
  } else if (STREET[hw]) {
    cls = CLS.street;
    if (hw === 'living_street') appeal = 0.2;
    if (hw === 'service') { pen += 0.2; if (t.service === 'driveway') pen += 0.6; }
    if (hw === 'unclassified') pen += 0.05;
    if (hw === 'road') pen += 0.1;
    if (t.access === 'destination') pen += 0.2;
  } else if (ROADS[hw]) {
    cls = CLS.road;
  } else {
    cls = CLS.main;
  }
  var sf = SURFACE[t.surface];
  if (sf) pen += sf;
  return { ok: true, cls: cls, pen: pen, appeal: appeal, fix: fix };
}

var GATES = { gate: 1, swing_gate: 1, sliding_gate: 1 };
var WALLS = { wall: 1, fence: 1, hedge: 1, retaining_wall: 1, city_wall: 1 };

/* Закрытые ворота: аналог значка «закрытые ворота» в Organic Maps. */
function isBlockingBarrier(t, strict) {
  var b = t.barrier;
  if (!b) return false;
  var footYes = isFootYes(t);
  if (WALLS[b]) return !footYes;
  if (!GATES[b] && b !== 'lift_gate') return false;
  if (footYes) return false;
  if (t.foot === 'no' || t.foot === 'private') return true;
  var accessClosed = t.access === 'no' || t.access === 'private' || t.access === 'customers' || t.access === 'permit';
  if (b === 'lift_gate') return !!strict && accessClosed;
  return accessClosed || t.locked === 'yes';
}

/* Светофор на узле: сам светофор на дороге или регулируемый переход (узел на проезжей части). */
function isSignalNode(t) {
  return !!t && (t.highway === 'traffic_signals' || t.crossing === 'traffic_signals' || t['crossing:signals'] === 'yes');
}
/* Путь-переход со светофором (footway=crossing и т. п. с тегом регулирования). */
function isSignalWay(t) {
  return t.crossing === 'traffic_signals' || t['crossing:signals'] === 'yes';
}

/* ---------- Overpass: запросы и разбор ---------- */
function aroundStr(R, A, B) {
  var r = Math.round(R);
  if (!B || hav(A[0], A[1], B[0], B[1]) < 30) return '(around:' + r + ',' + A[0].toFixed(6) + ',' + A[1].toFixed(6) + ')';
  return '(around:' + r + ',' + A[0].toFixed(6) + ',' + A[1].toFixed(6) + ',' + B[0].toFixed(6) + ',' + B[1].toFixed(6) + ')';
}

function loadRadius(dAB, L, cap) {
  var c = 1.25;
  var a = L / (2 * c);
  var h = dAB / 2;
  var b = Math.sqrt(Math.max(0, a * a - h * h));
  var R = Math.max(a - h, b) + 300;
  return Math.max(900, Math.min(cap || 5000, R));
}

var HW_RE = '^(pedestrian|footway|path|steps|cycleway|track|bridleway|living_street|residential|service|unclassified|tertiary|tertiary_link|secondary|secondary_link|primary|primary_link|road)$';
var BARRIER_RE = '^(gate|lift_gate|swing_gate|sliding_gate|wall|fence|hedge|retaining_wall|city_wall)$';

function networkQuery(area) {
  return '[out:json][timeout:150][maxsize:536870912];\n' +
    'way["highway"~"' + HW_RE + '"]' + area + '->.w;\n' +
    '.w out body qt;\n' +
    'node(w.w);\nout skel qt;\n' +
    'node["barrier"~"' + BARRIER_RE + '"]' + area + ';\nout body;\n' +
    /* светофоры: регулируемые переходы считаются в карточке маршрута */
    '(node["highway"="traffic_signals"]' + area + ';node["crossing"="traffic_signals"]' + area + ';node["crossing:signals"="yes"]' + area + ';);\nout body qt;';
}

function contextQuery(area) {
  return '[out:json][timeout:90][maxsize:268435456];\n' +
    '(\n' +
    ' way["leisure"~"^(park|garden|nature_reserve)$"]' + area + ';\n' +
    ' way["landuse"~"^(forest|recreation_ground|village_green)$"]' + area + ';\n' +
    ' way["natural"="wood"]' + area + ';\n' +
    ' relation["leisure"~"^(park|garden|nature_reserve)$"]' + area + ';\n' +
    ' relation["landuse"~"^(forest|recreation_ground)$"]' + area + ';\n' +
    ');\nout geom qt;\n' +
    '(\n' +
    ' nwr["tourism"~"^(attraction|viewpoint|museum|artwork|gallery)$"]' + area + ';\n' +
    ' nwr["historic"~"^(monument|memorial|castle|fort|ruins|archaeological_site|wayside_cross|city_gate|tower|manor)$"]' + area + ';\n' +
    ' nwr["man_made"~"^(tower|lighthouse|obelisk)$"]["name"]' + area + ';\n' +
    ' nwr["amenity"="fountain"]["name"]' + area + ';\n' +
    ' nwr["waterway"="dam"]' + area + ';\n' +
    ');\nout center qt;';
}

function parseNetwork(json) {
  var nodes = new Map(), ways = [], barriers = [], signals = new Set();
  var els = (json && json.elements) || [];
  for (var i = 0; i < els.length; i++) {
    var e = els[i];
    if (e.type === 'node') {
      /* узел без тегов из node(w.w) не затирает тот же узел с тегами */
      if (!e.tags && nodes.has(e.id)) continue;
      nodes.set(e.id, e);
      if (e.tags && e.tags.barrier) barriers.push(e);
      if (isSignalNode(e.tags)) signals.add(e.id);
    } else if (e.type === 'way' && e.tags && e.nodes) {
      ways.push(e);
    }
  }
  return { nodes: nodes, ways: ways, barriers: barriers, signals: signals };
}

/* Сборка колец из внешних границ relation. */
function assembleRings(segs) {
  var rings = [];
  var pool = segs.filter(function (s) { return s.length > 1; }).map(function (s) { return s.slice(); });
  function key(p) { return p[0].toFixed(7) + ',' + p[1].toFixed(7); }
  while (pool.length) {
    var ring = pool.pop();
    var guard = 0;
    while (key(ring[0]) !== key(ring[ring.length - 1]) && guard++ < 5000) {
      var end = key(ring[ring.length - 1]);
      var found = -1, rev = false;
      for (var i = 0; i < pool.length; i++) {
        if (key(pool[i][0]) === end) { found = i; break; }
        if (key(pool[i][pool[i].length - 1]) === end) { found = i; rev = true; break; }
      }
      if (found < 0) break;
      var nxt = pool.splice(found, 1)[0];
      if (rev) nxt.reverse();
      ring = ring.concat(nxt.slice(1));
    }
    if (ring.length >= 4 && key(ring[0]) === key(ring[ring.length - 1])) rings.push(ring);
  }
  return rings;
}

function ringToXY(ring) {
  var a = new Float64Array(ring.length * 2);
  var minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
  for (var i = 0; i < ring.length; i++) {
    var x = px(ring[i][1]), y = py(ring[i][0]);
    a[2 * i] = x; a[2 * i + 1] = y;
    if (x < minx) minx = x; if (x > maxx) maxx = x;
    if (y < miny) miny = y; if (y > maxy) maxy = y;
  }
  return { xy: a, minx: minx, miny: miny, maxx: maxx, maxy: maxy };
}

function ringCentroid(ring) {
  var sx = 0, sy = 0;
  for (var i = 0; i < ring.length; i++) { sy += ring[i][0]; sx += ring[i][1]; }
  return [sy / ring.length, sx / ring.length];
}

function poiCategory(t) {
  if (t.tourism === 'viewpoint') return 'view';
  if (t.tourism === 'artwork') return 'art';
  if (t.tourism) return 'sight';
  if (t.historic) return 'history';
  if (t.amenity === 'fountain' || t.waterway) return 'water';
  if (t.man_made) return 'sight';
  return 'sight';
}

function parseContext(json) {
  var parks = [], pois = [];
  var els = (json && json.elements) || [];
  for (var i = 0; i < els.length; i++) {
    var e = els[i], t = e.tags || {};
    var isArea = t.leisure === 'park' || t.leisure === 'garden' || t.leisure === 'nature_reserve' ||
      t.landuse === 'forest' || t.landuse === 'recreation_ground' || t.landuse === 'village_green' || t.natural === 'wood';
    if ((e.type === 'way' || e.type === 'relation') && isArea && (e.geometry || e.members)) {
      var rings = [];
      if (e.type === 'way') {
        var r = e.geometry.map(function (p) { return [p.lat, p.lon]; });
        if (r.length >= 4) rings.push(r);
      } else {
        var segs = [];
        e.members.forEach(function (m) {
          if (m.type === 'way' && m.geometry && (m.role === 'outer' || m.role === '')) {
            segs.push(m.geometry.map(function (p) { return [p.lat, p.lon]; }));
          }
        });
        rings = assembleRings(segs);
      }
      for (var k = 0; k < rings.length; k++) {
        var pr = ringToXY(rings[k]);
        pr.name = t.name || '';
        pr.kind = t.leisure || t.landuse || t.natural;
        pr.center = ringCentroid(rings[k]);
        pr.id = e.type + e.id + '_' + k;
        parks.push(pr);
      }
      continue;
    }
    var lat = e.lat !== undefined ? e.lat : (e.center && e.center.lat);
    var lon = e.lon !== undefined ? e.lon : (e.center && e.center.lon);
    if (lat === undefined || lon === undefined) continue;
    pois.push({
      id: e.type[0] + e.id, lat: lat, lon: lon, name: t.name || t['name:ru'] || '',
      cat: poiCategory(t), tags: t
    });
  }
  /* именованные парки тоже показываем как места */
  var seen = {};
  parks.forEach(function (p) {
    if (p.name && !seen[p.name]) {
      seen[p.name] = 1;
      pois.push({ id: 'park_' + p.id, lat: p.center[0], lon: p.center[1], name: p.name, cat: 'park', tags: {} });
    }
  });
  return { parks: parks, pois: pois };
}

export { CLS, classifyWay, isBlockingBarrier, isSignalNode, isSignalWay, aroundStr, loadRadius, networkQuery, contextQuery, parseNetwork, assembleRings, parseContext };
