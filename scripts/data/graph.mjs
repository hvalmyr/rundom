/* Свой граф улиц из выгрузки OpenStreetMap → <out>/g/<x>_<y>.json и <out>/g/index.json.
   Запуск: node scripts/data/graph.mjs <Moscow.osm.pbf> [out=public/data].
   В тайле ~2,2 × 2,2 км то же, что приложение иначе спрашивает у Overpass (networkQuery и contextQuery):
   пешеходные пути с узлами, ворота и заборы-узлы, светофоры, парки и интересные места — в компактной записи
   src/core/compact.js. Путь лежит в каждом тайле, который задевает, целиком.
   index.json: tiles — файлы, cover — тайлы, где данным можно верить (пустой тайл в покрытии — поле или вода). */
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { readPbf } from './pbf.mjs';
import { classifyWay, isSignalNode } from '../../src/core/osm.js';
import { simplifyDP } from '../../src/core/geo.js';
import { GRID, tileKey, tileOf, packNetwork, packContext } from '../../src/core/compact.js';

const [, , FILE, OUT = 'public/data'] = process.argv;
if (!FILE) { console.error('usage: graph.mjs <file.osm.pbf> [out]'); process.exit(2); }
const t0 = Date.now();
const log = (...a) => console.log(((Date.now() - t0) / 1000).toFixed(1) + 's', ...a);

/* те же отборы, что в запросах Overpass (src/core/osm.js) */
const BARRIER = /^(gate|lift_gate|swing_gate|sliding_gate|wall|fence|hedge|retaining_wall|city_wall)$/;
const parkWay = (t) => /^(park|garden|nature_reserve)$/.test(t.leisure) || /^(forest|recreation_ground|village_green)$/.test(t.landuse) || t.natural === 'wood';
const parkRel = (t) => /^(park|garden|nature_reserve)$/.test(t.leisure) || /^(forest|recreation_ground)$/.test(t.landuse);
const poi = (t) => /^(attraction|viewpoint|museum|artwork|gallery)$/.test(t.tourism) ||
  /^(monument|memorial|castle|fort|ruins|archaeological_site|wayside_cross|city_gate|tower|manor)$/.test(t.historic) ||
  (/^(tower|lighthouse|obelisk)$/.test(t.man_made) && t.name) || (t.amenity === 'fountain' && t.name) || t.waterway === 'dam';

/* ---------- проход 1: пути-члены парков-отношений ---------- */
const relWays = new Set(), rels = [];
let header = {};
readPbf(FILE, {
  header(h) { header = h; },
  relation(id, members, t) {
    if (!t || !parkRel(t)) return;
    const ways = members.filter((m) => m.type === 'way' && (m.role === 'outer' || m.role === '')).map((m) => m.ref);
    ways.forEach((w) => relWays.add(w));
    rels.push({ id, tags: t, ways });
  }
});
log('проход 1: парков-отношений', rels.length);

/* ---------- проход 2: узлы и пути ---------- */
let nCap = 8e6, nN = 0;
let nId = new Float64Array(nCap), nLat = new Float64Array(nCap), nLon = new Float64Array(nCap);
function findNode(id) {
  let lo = 0, hi = nN - 1;
  while (lo <= hi) {
    const m = (lo + hi) >> 1, v = nId[m];
    if (v === id) return m;
    if (v < id) lo = m + 1; else hi = m - 1;
  }
  return -1;
}
const ring = (refs) => {
  const out = [];
  for (const r of refs) { const i = findNode(r); if (i >= 0) out.push([nLat[i], nLon[i]]); }
  return out;
};

const tiles = new Map();
function tile(k) {
  let t = tiles.get(k);
  if (!t) { t = { ways: [], nodes: new Map(), parks: [], pois: [] }; tiles.set(k, t); }
  return t;
}
const keyAt = (lat, lon) => { const [x, y] = tileOf(lat, lon); return tileKey(x, y); };
const nodeEl = (i, tags) => ({ type: 'node', id: nId[i], lat: nLat[i], lon: nLon[i], tags });
const barriers = new Map(); /* индекс узла → теги ворот */
const signals = new Map();  /* индекс узла → теги светофора или регулируемого перехода */
const tagsOf = (i) => barriers.get(i) || signals.get(i);
/* тайлы, где выгрузка вообще есть данные: у её края пути обрезаны, поэтому покрытие — эти тайлы без крайнего ряда */
const present = new Set();
let nWays = 0;

function addPark(type, id, tags, rings) {
  rings = rings.map((r) => simplifyDP(r, 4)).filter((r) => r.length >= 4);
  if (!rings.length) return;
  let s = 90, w = 180, n = -90, e = -180;
  for (const r of rings) for (const p of r) { s = Math.min(s, p[0]); n = Math.max(n, p[0]); w = Math.min(w, p[1]); e = Math.max(e, p[1]); }
  const [x0, y0] = tileOf(s, w), [x1, y1] = tileOf(n, e);
  const park = { type, id, tags, rings };
  for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) tile(tileKey(x, y)).parks.push(park);
}
const relGeom = new Map();

readPbf(FILE, {
  node(id, lat, lon, t) {
    if (nN === nCap) {
      nCap *= 1.5;
      const g = (a) => { const b = new Float64Array(nCap); b.set(a); return b; };
      nId = g(nId); nLat = g(nLat); nLon = g(nLon);
    }
    nId[nN] = id; nLat[nN] = lat; nLon[nN] = lon;
    present.add(keyAt(lat, lon));
    if (t) {
      if (t.barrier && BARRIER.test(t.barrier)) barriers.set(nN, t);
      else if (isSignalNode(t)) signals.set(nN, t);
      if (poi(t)) tile(keyAt(lat, lon)).pois.push({ type: 'node', id, lat, lon, tags: t });
    }
    nN++;
  },
  way(id, refs, t) {
    if (relWays.has(id)) relGeom.set(id, ring(refs));
    if (!t) return;
    if (t.highway && classifyWay(t, {}) !== null) {
      const idx = refs.map(findNode).filter((i) => i >= 0);
      if (idx.length < 2) return;
      const keys = new Set(idx.map((i) => keyAt(nLat[i], nLon[i])));
      const way = { type: 'way', id, nodes: idx.map((i) => nId[i]), tags: t };
      for (const k of keys) {
        const tl = tile(k);
        tl.ways.push(way);
        for (const i of idx) if (!tl.nodes.has(i)) tl.nodes.set(i, nodeEl(i, tagsOf(i)));
      }
      nWays++;
      return;
    }
    if (parkWay(t) && refs.length > 3) { addPark('way', id, t, [ring(refs)]); return; }
    if (poi(t) && refs.length) {
      const pts = ring(refs);
      if (!pts.length) return;
      const lat = pts.reduce((s, p) => s + p[0], 0) / pts.length, lon = pts.reduce((s, p) => s + p[1], 0) / pts.length;
      tile(keyAt(lat, lon)).pois.push({ type: 'way', id, lat, lon, tags: t });
    }
  }
});
log('проход 2: узлов', nN, 'пешеходных путей', nWays, 'ворот и заборов', barriers.size, 'светофоров', signals.size);

for (const r of rels) {
  const rings = r.ways.map((w) => relGeom.get(w)).filter((g) => g && g.length > 1);
  if (rings.length) addPark('relation', r.id, r.tags, rings);
}
/* ворота вне пешеходных путей приложение тоже показывает: кладём их в свой тайл */
for (const [i, t] of barriers) {
  const tl = tile(keyAt(nLat[i], nLon[i]));
  if (!tl.nodes.has(i)) tl.nodes.set(i, nodeEl(i, t));
}

/* ---------- запись ---------- */
const dir = OUT + '/g';
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });
let bytes = 0;
const written = [];
for (const [k, t] of tiles) {
  if (!t.ways.length && !t.parks.length && !t.pois.length) continue;
  const net = packNetwork([...t.nodes.values(), ...t.ways]);
  const ctx = packContext(t.parks, t.pois);
  const s = JSON.stringify({ net, ctx });
  writeFileSync(dir + '/' + k + '.json', s);
  bytes += s.length;
  written.push(k);
}
const cover = [];
for (const k of present) {
  const [x, y] = k.split('_').map(Number);
  let inner = true;
  for (let i = -1; i <= 1 && inner; i++) for (let j = -1; j <= 1; j++) if (!present.has(tileKey(x + i, y + j))) { inner = false; break; }
  if (inner) cover.push(k);
}
const date = new Date((header.timestamp || Date.now() / 1000) * 1000).toISOString().slice(0, 10);
writeFileSync(dir + '/index.json', JSON.stringify({
  v: 1, date, grid: GRID,
  tiles: written.sort(), cover: cover.sort()
}));
log('тайлов', written.length, 'в покрытии', cover.length, 'всего', (bytes / 1e6).toFixed(1), 'МБ, данные на', date);
