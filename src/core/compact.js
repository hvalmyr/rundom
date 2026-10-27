/* Компактная запись улиц, парков и мест: тайлы своего графа и кэш ответов Overpass.
   Разворачивается обратно в элементы в форме ответа Overpass, дальше их разбирают
   parseNetwork и parseContext, как живой ответ. Теги урезаны до тех, что читают правила. */
import { isSignalNode } from './osm.js';

var E6 = 1e6;
var WAY_KEYS = ['highway', 'name', 'foot', 'access', 'footway', 'crossing', 'crossing:signals', 'service', 'surface', 'tracktype', 'indoor'];
/* теги узлов: ворота и заборы, светофоры и регулируемые переходы */
var NODE_KEYS = ['barrier', 'foot', 'access', 'locked', 'name', 'highway', 'crossing', 'crossing:signals'];
var keptNode = function (t) { return !!(t && (t.barrier || isSignalNode(t))); };
var PARK_KEYS = ['name', 'leisure', 'landuse', 'natural'];
var POI_KEYS = ['name', 'name:ru', 'tourism', 'historic', 'man_made', 'amenity', 'waterway'];

function pick(t, keys) {
  var o = {}, any = false;
  if (!t) return o;
  for (var i = 0; i < keys.length; i++) if (t[keys[i]] !== undefined) { o[keys[i]] = t[keys[i]]; any = true; }
  return any ? o : {};
}

/* словарь наборов тегов: одинаковые наборы пишутся один раз */
function tagTable() {
  var list = [], idx = new Map();
  return {
    list: list,
    add: function (t) {
      var k = JSON.stringify(t);
      var i = idx.get(k);
      if (i === undefined) { i = list.length; list.push(t); idx.set(k, i); }
      return i;
    }
  };
}

function deltas(arr) {
  var out = new Array(arr.length), prev = 0;
  for (var i = 0; i < arr.length; i++) { out[i] = arr[i] - prev; prev = arr[i]; }
  return out;
}
function undelta(arr) {
  var out = new Array(arr.length), acc = 0;
  for (var i = 0; i < arr.length; i++) { acc += arr[i]; out[i] = acc; }
  return out;
}
var q = function (x) { return Math.round(x * E6); };

/* ---------- улицы ---------- */
/* elements: узлы {id, lat, lon, tags?} и пути {id, nodes, tags}, как в ответе Overpass */
function packNetwork(elements) {
  var nodes = new Map(), ways = [];
  for (var i = 0; i < elements.length; i++) {
    var e = elements[i];
    if (e.type === 'node') nodes.set(e.id, e);
    else if (e.type === 'way' && e.nodes && e.tags) ways.push(e);
  }
  var used = new Set();
  ways.forEach(function (w) { w.nodes.forEach(function (id) { if (nodes.has(id)) used.add(id); }); });
  nodes.forEach(function (nd, id) { if (keptNode(nd.tags)) used.add(id); });
  var ids = Array.from(used).sort(function (a, b) { return a - b; });
  var at = new Map();
  ids.forEach(function (id, k) { at.set(id, k); });
  var T = tagTable(), wn = [], wt = [], wid = [], b = [];
  ways.sort(function (a, c) { return a.id - c.id; });
  ways.forEach(function (w) {
    var refs = [];
    for (var j = 0; j < w.nodes.length; j++) { var k = at.get(w.nodes[j]); if (k !== undefined) refs.push(k); }
    if (refs.length < 2) return;
    wid.push(w.id); wt.push(T.add(pick(w.tags, WAY_KEYS)));
    wn.push(refs.length);
    for (var r = 0; r < refs.length; r++) wn.push(refs[r]);
  });
  ids.forEach(function (id, k) {
    var nd = nodes.get(id);
    if (keptNode(nd.tags)) b.push(k, T.add(pick(nd.tags, NODE_KEYS)));
  });
  return {
    v: 1, T: T.list,
    n: deltas(ids),
    a: deltas(ids.map(function (id) { return q(nodes.get(id).lat); })),
    o: deltas(ids.map(function (id) { return q(nodes.get(id).lon); })),
    w: deltas(wid), wt: wt, wn: wn, b: b
  };
}

function unpackNetwork(c, out) {
  out = out || [];
  var ids = undelta(c.n), la = undelta(c.a), lo = undelta(c.o), wid = undelta(c.w);
  var bt = new Map();
  for (var i = 0; i < c.b.length; i += 2) bt.set(c.b[i], c.T[c.b[i + 1]]);
  for (var k = 0; k < ids.length; k++) {
    var nd = { type: 'node', id: ids[k], lat: la[k] / E6, lon: lo[k] / E6 };
    if (bt.has(k)) nd.tags = bt.get(k);
    out.push(nd);
  }
  for (var w = 0, p = 0; w < wid.length; w++) {
    var len = c.wn[p++], refs = new Array(len);
    for (var r = 0; r < len; r++) refs[r] = ids[c.wn[p++]];
    out.push({ type: 'way', id: wid[w], tags: c.T[c.wt[w]], nodes: refs });
  }
  return out;
}

/* ---------- парки и места ---------- */
/* parks: [{type:'way'|'relation', id, tags, rings:[[[lat,lon],...]]}], pois: [{type, id, lat, lon, tags}] */
function packContext(parks, pois) {
  var T = tagTable();
  return {
    v: 1, T: T.list,
    p: parks.map(function (p) {
      return [p.type === 'way' ? 0 : 1, p.id, T.add(pick(p.tags, PARK_KEYS)), p.rings.map(function (r) {
        var flat = [];
        r.forEach(function (pt) { flat.push(q(pt[0]), q(pt[1])); });
        return deltas(flat);
      })];
    }),
    q: pois.map(function (e) { return [e.type[0], e.id, q(e.lat), q(e.lon), T.add(pick(e.tags, POI_KEYS))]; })
  };
}

var TYPES = { n: 'node', w: 'way', r: 'relation' };
function unpackContext(c, out) {
  out = out || [];
  c.p.forEach(function (p) {
    var rings = p[3].map(function (d) {
      var flat = undelta(d), geom = [];
      for (var i = 0; i < flat.length; i += 2) geom.push({ lat: flat[i] / E6, lon: flat[i + 1] / E6 });
      return geom;
    });
    if (p[0] === 0) out.push({ type: 'way', id: p[1], tags: c.T[p[2]], geometry: rings[0] });
    else out.push({ type: 'relation', id: p[1], tags: c.T[p[2]], members: rings.map(function (g) { return { type: 'way', role: 'outer', geometry: g }; }) });
  });
  c.q.forEach(function (e) { out.push({ type: TYPES[e[0]], id: e[1], lat: e[2] / E6, lon: e[3] / E6, tags: c.T[e[4]] }); });
  return out;
}

/* Парки и места из ответа Overpass (out geom / out center) в форму packContext. */
function contextFromOverpass(elements) {
  var parks = [], pois = [];
  elements.forEach(function (e) {
    var t = e.tags || {};
    if (e.type === 'way' && e.geometry && (t.leisure || t.landuse || t.natural)) {
      parks.push({ type: 'way', id: e.id, tags: t, rings: [e.geometry.map(function (p) { return [p.lat, p.lon]; })] });
    } else if (e.type === 'relation' && e.members && (t.leisure || t.landuse)) {
      var rings = e.members.filter(function (m) { return m.type === 'way' && m.geometry && (m.role === 'outer' || m.role === ''); })
        .map(function (m) { return m.geometry.map(function (p) { return [p.lat, p.lon]; }); });
      parks.push({ type: 'relation', id: e.id, tags: t, rings: rings });
    } else {
      var lat = e.lat !== undefined ? e.lat : e.center && e.center.lat;
      var lon = e.lon !== undefined ? e.lon : e.center && e.center.lon;
      if (lat !== undefined && lon !== undefined) pois.push({ type: e.type, id: e.id, lat: lat, lon: lon, tags: t });
    }
  });
  return { parks: parks, pois: pois };
}

/* ---------- сетка тайлов графа: ~2,2 × 2,2 км в Москве ---------- */
var GRID = { lat: 0.02, lon: 0.035 };
function tileKey(x, y) { return x + '_' + y; }
function tileOf(lat, lon, grid) { grid = grid || GRID; return [Math.floor(lon / grid.lon), Math.floor(lat / grid.lat)]; }
/* тайлы, задевающие прямоугольник [юг, запад, север, восток] */
function tilesInBox(box, grid) {
  grid = grid || GRID;
  var a = tileOf(box[0], box[1], grid), b = tileOf(box[2], box[3], grid), out = [];
  for (var x = a[0]; x <= b[0]; x++) for (var y = a[1]; y <= b[1]; y++) out.push(tileKey(x, y));
  return out;
}

/* Элементы из нескольких тайлов: один и тот же путь или парк лежит в соседних тайлах. */
function dedupeElements(elements) {
  var seen = new Set(), out = [];
  for (var i = 0; i < elements.length; i++) {
    /* путь может быть и парком (с контуром), и местом (точкой): это разные элементы */
    var e = elements[i], k = e.type[0] + e.id + (e.geometry || e.members ? 'g' : '');
    if (seen.has(k)) continue;
    seen.add(k); out.push(e);
  }
  return out;
}

export { GRID, tileKey, tileOf, tilesInBox, packNetwork, unpackNetwork, packContext, unpackContext, contextFromOverpass, dedupeElements };
