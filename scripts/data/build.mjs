/* Данные покрытия из выгрузки OpenStreetMap → <out>/index.json и <out>/d/<id>.json.
   Запуск: node scripts/data/build.mjs <Moscow.osm.pbf> [out=public/data].
   Что собирается: контур МКАД, пешеходные «улицы» районов внутри МКАД (тротуары и вторые
   полосы проспектов присоединены к своей улице), объекты и парки, абзац «О районе» из Википедии.
   Объекты и парки с платным или закрытым входом (fee, access) и всё внутри стен Кремля не берутся:
   их не встретить на пробежке. У объектов со статьёй в Википедии — короткое описание и фото
   из Wikimedia Commons с автором и лицензией. */
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { dirname } from 'node:path';
import { readPbf } from './pbf.mjs';
import { placeInfo } from './wiki-places.mjs';
import { classifyWay } from '../../src/core/osm.js';
import { hav, px, py, simplifyDP, pointInRing, distToSegment, polyLength } from '../../src/core/geo.js';

const [, , FILE, OUT = 'public/data'] = process.argv;
if (!FILE) { console.error('usage: build.mjs <file.osm.pbf> [out]'); process.exit(2); }
const CACHE = process.env.WIKI_CACHE || '.cache/wiki.json';
const CENTER = [55.7558, 37.6176];
const Q = 1e5; /* координаты в файлах — целые 1e-5 градуса (≈1,1 м по широте) */
const t0 = Date.now();
const log = (...a) => console.log(((Date.now() - t0) / 1000).toFixed(1) + 's', ...a);

/* ---------- проход 1: какие пути нужны отношениям (парки, районы) ---------- */
const relWays = new Set();
const parkRels = [], districtTags = new Map();
const districts = JSON.parse(readFileSync(new URL('../../src/data/districts.json', import.meta.url)));
const districtIds = new Set(districts.map((d) => d.id));
const CARRIER = { trunk: 1, primary: 1, secondary: 1, tertiary: 1 };
/* вход платный или закрыт: на пробежке туда не попасть */
const closedEntry = (t) => (t.fee && t.fee !== 'no') || /^(private|no|customers|permit|military|delivery)$/.test(t.access || '');
const isPark = (t) => t && t.name && (t.leisure === 'park' || t.leisure === 'garden' || t.leisure === 'nature_reserve') && !closedEntry(t);
let header = {};
readPbf(FILE, {
  header(h) { header = h; },
  relation(id, members, t) {
    if (!t) return;
    if (districtIds.has(id)) districtTags.set(id, t);
    if (isPark(t) && t.type === 'multipolygon') {
      const ways = members.filter((m) => m.type === 'way' && (m.role === 'outer' || m.role === ''));
      for (const m of ways) relWays.add(m.ref);
      parkRels.push({ id, t, ways: ways.map((m) => m.ref) });
    }
  }
});
log('проход 1: парков-отношений', parkRels.length);

/* ---------- проход 2: узлы, пути ---------- */
let nCap = 6e6, nN = 0;
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
const coords = (refs) => {
  const out = [];
  for (const r of refs) { const i = findNode(r); if (i >= 0) out.push([nLat[i], nLon[i]]); }
  return out;
};
const centroid = (pts) => [pts.reduce((s, p) => s + p[0], 0) / pts.length, pts.reduce((s, p) => s + p[1], 0) / pts.length];

const ways = [];          /* пешеходные пути: {id, name, hw, side, pts} */
const mkadNodes = [];     /* узлы МКАД для контура */
const objects = [];       /* {name, cat, p, wiki, tags} */
const parks = [];         /* {name, rings, wiki} */
const relWayGeom = new Map();

/* Справка о месте из тегов OSM — есть у мест и без статьи в Википедии. Ключи короткие: файл района мал. */
const clip = (v, n) => { v = String(v).replace(/\s+/g, ' ').trim(); return v.length > n ? v.slice(0, n - 1).replace(/\s+\S*$/, '') + '…' : v; };
const RELIGION = { christian: 'христианство', muslim: 'ислам', jewish: 'иудаизм', buddhist: 'буддизм' };
const DENOM = { russian_orthodox: 'православный', orthodox: 'православный', old_believers: 'старообрядческий', catholic: 'католический',
  roman_catholic: 'католический', lutheran: 'лютеранский', protestant: 'протестантский', armenian_apostolic: 'армянский апостольский',
  baptist: 'баптистский', evangelical: 'евангельский', sunni: 'суннитский', shia: 'шиитский' };
const HERITAGE = { 2: 'федерального значения', 3: 'регионального значения', 4: 'местного значения' };
function factsOf(t) {
  const f = {};
  const year = t.start_date || t['building:start_date'] || t['construction_date'];
  if (year && /\d{3,4}/.test(year)) f.y = clip(year.replace(/^~/, 'около ').replace(/\.\.|–|--/, '–'), 24);
  const arch = t.architect || t['architect:ru'];
  if (arch) f.ar = clip(arch.replace(/;\s*/g, ', '), 80);
  const art = t.artist_name || t['artist:name'] || t.sculptor;
  if (art) f.au = clip(art.replace(/;\s*/g, ', '), 80);
  const subj = t['subject:ru'] || t.subject || t['memorial:subject'];
  if (subj && !/^Q\d+$/.test(subj)) f.sb = clip(subj, 80);
  if (t.inscription) f.in = clip(t['inscription:ru'] || t.inscription, 160);
  if (t.amenity === 'place_of_worship') {
    const d = DENOM[t.denomination] || RELIGION[t.religion];
    if (d) f.de = d;
  }
  if (t.heritage) f.he = HERITAGE[t.heritage] || 'есть';
  if (t.opening_hours) f.oh = clip(t.opening_hours, 60);
  const site = t.website || t['contact:website'] || t.url;
  if (site && /^https?:\/\//.test(site)) f.ws = site.length > 120 ? undefined : site;
  if (t.description || t['description:ru']) f.ds = clip(t['description:ru'] || t.description, 200);
  const cm = /^File:(.+)$/.exec(t.wikimedia_commons || '') || /commons\.wikimedia\.org\/wiki\/File:([^?#]+)/.exec(t.image || '');
  if (cm) f.cm = decodeURIComponent(cm[1]).replace(/_/g, ' ');
  for (const k of Object.keys(f)) if (f[k] === undefined) delete f[k];
  return f;
}
/* при слиянии двойников — дополняем справку тем, чего в ней ещё нет */
const mergeFacts = (a, b) => { for (const k of Object.keys(b)) if (!(k in a)) a[k] = b[k]; };

function objectCategory(t) {
  if (!t.name || closedEntry(t)) return null;
  if (t.memorial === 'plaque' || t.memorial === 'stolperstein' || t.historic === 'boundary_stone') return null;
  if (t.tourism === 'viewpoint') return 'view';
  if (t.amenity === 'place_of_worship') return 'worship';
  if (t.historic === 'monument' || t.historic === 'memorial' || t.memorial === 'statue' || t.memorial === 'bust') return 'monument';
  if (t.tourism === 'museum') return 'museum';
  if (t.tourism === 'attraction') return 'sight';
  if (t.historic) return 'history';
  if (t.heritage) return 'heritage';
  return null;
}

readPbf(FILE, {
  node(id, lat, lon, t) {
    if (nN === nCap) {
      nCap *= 1.5;
      const g = (a) => { const b = new Float64Array(nCap); b.set(a); return b; };
      nId = g(nId); nLat = g(nLat); nLon = g(nLon);
    }
    nId[nN] = id; nLat[nN] = lat; nLon[nN] = lon; nN++;
    if (t) {
      const cat = objectCategory(t);
      if (cat) objects.push({ name: t.name, cat, p: [lat, lon], wiki: t.wikipedia || '', wd: t.wikidata || '', f: factsOf(t) });
    }
  },
  way(id, refs, t) {
    if (relWays.has(id)) relWayGeom.set(id, coords(refs));
    if (!t) return;
    const hw = t.highway;
    if ((hw === 'motorway' || hw === 'trunk') && /^МКАД/.test(t.name || t.ref || '')) {
      for (const p of coords(refs)) mkadNodes.push(p);
      return;
    }
    if (isPark(t) && refs.length > 3 && refs[0] === refs[refs.length - 1]) {
      parks.push({ name: t.name, rings: [coords(refs)], wiki: t.wikipedia || '', wd: t.wikidata || '', f: factsOf(t) });
      return;
    }
    const cat = objectCategory(t);
    if (cat && refs.length) {
      const pts = coords(refs);
      if (pts.length) objects.push({ name: t.name, cat, p: centroid(pts), wiki: t.wikipedia || '', wd: t.wikidata || '', f: factsOf(t) });
    }
    if (!hw || t.area === 'yes') return;
    /* ось большой улицы без права прохода (foot=no, trunk): опора для её тротуаров */
    const carrier = t.name && CARRIER[hw] && t.tunnel !== 'yes' && t.covered !== 'yes' && (hw === 'trunk' || t.foot === 'no' || t.foot === 'use_sidepath');
    const c = classifyWay(t, {});
    if (!carrier && (!c || !c.ok)) return;
    if (c && c.fix) return; /* переходы — не улица */
    const pts = coords(refs);
    if (pts.length < 2) return;
    ways.push({ id, name: t.name || '', hw, carrier: !!carrier, side: t.footway === 'sidewalk' || t.path === 'sidewalk', pts });
  }
});
log('проход 2: узлов', nN, 'путей', ways.length, 'объектов', objects.length, 'парков', parks.length, 'узлов МКАД', mkadNodes.length);

for (const r of parkRels) {
  const segs = r.ways.map((w) => relWayGeom.get(w)).filter((g) => g && g.length > 1);
  const rings = stitch(segs);
  if (rings.length) parks.push({ name: r.t.name, rings, wiki: r.t.wikipedia || '', wd: r.t.wikidata || '', f: factsOf(r.t) });
}
nId = nLat = nLon = null;

/* ---------- МКАД: внутренняя кромка по угловой выборке ---------- */
const BINS = 720;
const mkadR = new Float64Array(BINS).fill(Infinity), mkadP = new Array(BINS);
const cx = px(CENTER[1]), cy = py(CENTER[0]);
for (const p of mkadNodes) {
  const x = px(p[1]) - cx, y = py(p[0]) - cy, r = Math.hypot(x, y);
  if (r < 8000) continue; /* развязки внутри города с тем же ref */
  const b = Math.floor(((Math.atan2(y, x) / Math.PI + 1) / 2) * BINS) % BINS;
  if (r < mkadR[b]) { mkadR[b] = r; mkadP[b] = p; }
}
const mkad = [];
for (let b = 0; b < BINS; b++) if (mkadP[b]) mkad.push(mkadP[b]);
if (mkad.length < BINS * 0.8) throw new Error('МКАД: мало точек контура (' + mkad.length + ')');
const mkadRing = simplifyDP([...mkad, mkad[0]], 15);
const mkadFlat = mkadRing.flatMap((p) => [px(p[1]), py(p[0])]);
const inMkad = (lat, lon) => pointInRing(px(lon), py(lat), mkadFlat);
log('МКАД: точек', mkadRing.length, 'длина', Math.round(polyLength(mkadRing) / 1000), 'км');

/* ---------- районы ---------- */
const dFlat = districts.map((d) => d.p.map((poly) => poly.map((ring) => ring.flatMap((p) => [px(p[1]), py(p[0])]))));
const dBox = districts.map((d) => {
  const b = [Infinity, Infinity, -Infinity, -Infinity];
  for (const poly of d.p) for (const p of poly[0]) { b[0] = Math.min(b[0], p[0]); b[1] = Math.min(b[1], p[1]); b[2] = Math.max(b[2], p[0]); b[3] = Math.max(b[3], p[1]); }
  return b;
});
function districtAt(lat, lon) {
  const x = px(lon), y = py(lat);
  for (let i = 0; i < districts.length; i++) {
    const b = dBox[i];
    if (lat < b[0] || lat > b[2] || lon < b[1] || lon > b[3]) continue;
    for (const poly of dFlat[i]) {
      if (!pointInRing(x, y, poly[0])) continue;
      let hole = false;
      for (let h = 1; h < poly.length; h++) if (pointInRing(x, y, poly[h])) { hole = true; break; }
      if (!hole) return i;
    }
  }
  return -1;
}

/* ---------- сетка для поиска ближних отрезков ---------- */
const CELL = 50;
const gkey = (x, y) => Math.floor(x / CELL) * 100003 + Math.floor(y / CELL);
function segGrid(list) {
  const g = new Map();
  list.forEach((w, wi) => {
    for (let i = 1; i < w.xy.length / 2; i++) {
      const x1 = w.xy[2 * i - 2], y1 = w.xy[2 * i - 1], x2 = w.xy[2 * i], y2 = w.xy[2 * i + 1];
      const n = Math.max(1, Math.ceil(Math.hypot(x2 - x1, y2 - y1) / CELL));
      const seen = new Set();
      for (let s = 0; s <= n; s++) {
        const k = gkey(x1 + (x2 - x1) * s / n, y1 + (y2 - y1) * s / n);
        if (seen.has(k)) continue; seen.add(k);
        const a = g.get(k); const v = [wi, i];
        if (a) a.push(v); else g.set(k, [v]);
      }
    }
  });
  return g;
}
/* ближайший отрезок из сетки к точке: {wi, d, ang} */
function nearest(g, list, x, y, maxD, filter) {
  let best = null;
  const c0 = Math.floor(x / CELL), r0 = Math.floor(y / CELL), R = Math.ceil(maxD / CELL);
  for (let i = -R; i <= R; i++) for (let j = -R; j <= R; j++) {
    const a = g.get((c0 + i) * 100003 + (r0 + j));
    if (!a) continue;
    for (const [wi, k] of a) {
      if (filter && !filter(wi)) continue;
      const xy = list[wi].xy;
      const d = distToSegment(x, y, xy[2 * k - 2], xy[2 * k - 1], xy[2 * k], xy[2 * k + 1]);
      if (d <= maxD && (!best || d < best.d)) best = { wi, d, ang: Math.atan2(xy[2 * k + 1] - xy[2 * k - 1], xy[2 * k] - xy[2 * k - 2]) };
    }
  }
  return best;
}
const angDiff = (a, b) => { let d = Math.abs(a - b) % Math.PI; return Math.min(d, Math.PI - d); };

/* ---------- обрезка по МКАД и упрощение ---------- */
const kept = [];
for (const w of ways) {
  let run = [];
  const flush = () => { if (run.length > 1) kept.push({ ...w, pts: simplifyDP(run, 3) }); run = []; };
  for (const p of w.pts) { if (inMkad(p[0], p[1])) run.push(p); else flush(); }
  flush();
}
for (const w of kept) w.xy = w.pts.flatMap((p) => [px(p[1]), py(p[0])]);
log('внутри МКАД путей', kept.length, 'км', Math.round(kept.reduce((s, w) => s + polyLength(w.pts), 0) / 1000));

/* ---------- одна улица: тротуары и вторые полосы присоединяются к улице ----------
   Тротуар (и безымянная дорожка), идущий вдоль улицы ближе 25 м, отбрасывается: его покрывает ось
   улицы с расширенным допуском. Вторая полоса проспекта с тем же именем ближе 45 м — тоже.
   Ось без права прохода (foot=no) остаётся только там, где к ней присоединились тротуары. */
const PATHS = { footway: 1, path: 1, cycleway: 1, pedestrian: 1, steps: 1 };
const named = kept.map((w, i) => (w.name && !PATHS[w.hw] ? i : -1)).filter((i) => i >= 0);
const namedList = named.map((i) => kept[i]);
const ng = segGrid(namedList);
/* пробы вдоль пути через step м: [x, y, угол] */
function probesOf(w, step) {
  const out = [];
  for (let i = 1; i < w.xy.length / 2; i++) {
    const x1 = w.xy[2 * i - 2], y1 = w.xy[2 * i - 1], x2 = w.xy[2 * i], y2 = w.xy[2 * i + 1];
    const L = Math.hypot(x2 - x1, y2 - y1), a = Math.atan2(y2 - y1, x2 - x1);
    for (let s = Math.min(step / 2, L / 2); s < L; s += step) out.push([x1 + (x2 - x1) * s / L, y1 + (y2 - y1) * s / L, a]);
  }
  return out;
}
/* самая частая параллельная улица ближе maxD, если вдоль неё ≥70% проб */
function alongShare(w, maxD, filter) {
  const votes = new Map(), pr = probesOf(w, 10);
  for (const [x, y, a] of pr) {
    const r = nearest(ng, namedList, x, y, maxD, filter);
    if (r && angDiff(r.ang, a) < 0.45) { const nm = namedList[r.wi].name; votes.set(nm, (votes.get(nm) || 0) + 1); }
  }
  let best = null;
  for (const [nm, c] of votes) if (!best || c > best.c) best = { name: nm, c };
  return best && pr.length && best.c / pr.length >= 0.7 ? best.name : null;
}
let merged = 0, dual = 0;
for (const w of kept) {
  if (w.carrier || (w.name && !PATHS[w.hw]) || (w.name && !w.side)) continue;
  const nm = alongShare(w, 25);
  if (nm) { w.drop = true; w.to = nm; merged++; }
}
/* вторая полоса проспекта */
const byName = new Map();
named.forEach((ki, li) => { const nm = kept[ki].name; (byName.get(nm) || byName.set(nm, []).get(nm)).push(li); });
for (const [nm, lis] of byName) {
  lis.sort((a, b) => polyLength(namedList[b].pts) - polyLength(namedList[a].pts));
  const main = new Set();
  for (const li of lis) {
    const w = namedList[li];
    if (main.size && CARRIER[w.hw] && alongShare(w, 45, (wi) => main.has(wi)) === nm) { w.drop = true; w.to = nm; dual++; continue; }
    main.add(li);
  }
}
/* ось без права прохода — только вдоль присоединённых тротуаров */
const sideGrid = new Map();
for (const w of kept) if (w.drop && w.to) for (const [x, y] of probesOf(w, 10)) {
  const k = gkey(x, y); (sideGrid.get(k) || sideGrid.set(k, []).get(k)).push(x, y, w.to);
}
const sideNear = (x, y, nm, R) => {
  const c0 = Math.floor(x / CELL), r0 = Math.floor(y / CELL);
  for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
    const a = sideGrid.get((c0 + i) * 100003 + (r0 + j)) || [];
    for (let q = 0; q < a.length; q += 3) if (a[q + 2] === nm && Math.hypot(a[q] - x, a[q + 1] - y) <= R) return true;
  }
  return false;
};
let carriers = 0;
for (const w of kept) {
  if (!w.carrier || w.drop) continue;
  const pr = probesOf(w, 10);
  if (pr.filter(([x, y]) => sideNear(x, y, w.name, 45)).length < pr.length * 0.5) w.drop = true; else carriers++;
}
/* допуск улицы: 90-й перцентиль расстояния от присоединённых путей до её оси + 10 м, от 20 до 50 м;
   путь, у которого оси рядом не осталось, возвращается как есть */
const axis = kept.filter((w) => w.name && !PATHS[w.hw] && !w.drop);
const ag = segGrid(axis);
const dists = new Map();
let back = 0;
for (const w of kept) {
  if (!w.drop || !w.to) continue;
  const ds = probesOf(w, 10).map(([x, y]) => { const r = nearest(ag, axis, x, y, 60, (wi) => axis[wi].name === w.to); return r ? r.d : Infinity; });
  ds.sort((a, b) => a - b);
  const p90 = ds[Math.floor(ds.length * 0.9)] ?? Infinity;
  if (p90 > 40) { w.drop = false; w.name = w.name || ''; back++; continue; }
  (dists.get(w.to) || dists.set(w.to, []).get(w.to)).push(p90);
}
const tolOf = new Map();
for (const [nm, ds] of dists) tolOf.set(nm, Math.min(50, Math.max(20, Math.round(Math.max(...ds) + 10))));
log('осей без прохода', carriers, 'возвращено путей', back);
log('присоединено тротуаров и дорожек', merged, 'вторых полос', dual);

/* ---------- нарезка на участки ~25 м и раскладка по районам ---------- */
function cut(pts, step) {
  /* ломаная → куски длиной ~step (по точкам ломаной и вставленным точкам) */
  const out = []; let cur = [pts[0]], acc = 0;
  const L = polyLength(pts), n = Math.max(1, Math.round(L / step)), part = L / n;
  for (let i = 1; i < pts.length; i++) {
    let a = pts[i - 1]; const b = pts[i];
    let seg = hav(a[0], a[1], b[0], b[1]);
    while (acc + seg >= part - 1e-6 && out.length < n - 1) {
      const t = (part - acc) / seg;
      const m = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
      m.cut = true;
      cur.push(m); out.push(cur); cur = [m];
      seg -= part - acc; acc = 0; a = m;
    }
    acc += seg; cur.push(b);
  }
  out.push(cur);
  return out;
}
const D = districts.map(() => ({ streets: new Map(), km: 0 }));
let total = 0;
for (const w of kept) {
  if (w.drop) continue;
  const key = w.name || '';
  const tol = key ? (tolOf.get(key) || 20) : 20;
  /* в цепочку идут точки самого пути; точки нарезки нужны только на границах районов */
  let chainD = -2, chain = null, end = null;
  const close = () => { if (chain && chain[chain.length - 1] !== end) chain.push(end); };
  for (const piece of cut(w.pts, 25)) {
    const m = piece[Math.floor(piece.length / 2)], mm = piece.length % 2 ? m : [(piece[piece.length / 2 - 1][0] + m[0]) / 2, (piece[piece.length / 2 - 1][1] + m[1]) / 2];
    const di = districtAt(mm[0], mm[1]);
    if (di !== chainD) { close(); chain = null; }
    end = piece[piece.length - 1];
    if (di < 0) { chainD = -2; continue; }
    const len = polyLength(piece);
    D[di].km += len; total += len;
    if (!chain) {
      const st = D[di].streets;
      if (!st.has(key)) st.set(key, { n: key, t: tol, chains: [] });
      chain = [piece[0], ...piece.slice(1).filter((p) => !p.cut)];
      st.get(key).chains.push(chain); chainD = di;
    } else chain.push(...piece.slice(1).filter((p) => !p.cut));
  }
  close();
}
log('всего внутри МКАД', Math.round(total / 1000), 'км');

/* ---------- объекты и парки ---------- */
/* стены Кремля: вход на территорию по билетам, тегов fee у объектов внутри часто нет */
const KREMLIN = [[55.7562, 37.6170], [55.7549, 37.6185], [55.7539, 37.6194], [55.7525, 37.6208], [55.7500, 37.6236],
  [55.7488, 37.6138], [55.7495, 37.6117], [55.7531, 37.6133], [55.7562, 37.6170]].flatMap((p) => [px(p[1]), py(p[0])]);
const inKremlin = (p) => pointInRing(px(p[1]), py(p[0]), KREMLIN);
const dedup = [];
const grid = new Map();
let kremlinDropped = 0;
for (const o of objects) {
  if (!inMkad(o.p[0], o.p[1])) continue;
  if (inKremlin(o.p)) { kremlinDropped++; continue; }
  const k = gkey(px(o.p[1]), py(o.p[0]));
  const near = (grid.get(k) || []).find((q) => q.name === o.name && hav(q.p[0], q.p[1], o.p[0], o.p[1]) < 150);
  if (near) { if (!near.wiki) near.wiki = o.wiki; if (!near.wd) near.wd = o.wd; mergeFacts(near.f, o.f); continue; }
  dedup.push(o); (grid.get(k) || grid.set(k, []).get(k)).push(o);
}
const sList = axis.filter((w) => !w.drop), sGrid = segGrid(sList);
function streetNear(p) {
  const r = nearest(sGrid, sList, px(p[1]), py(p[0]), 60);
  return r ? sList[r.wi].name : '';
}
const area = (ring) => { let s = 0; for (let i = 1; i < ring.length; i++) s += (px(ring[i - 1][1]) * py(ring[i][0]) - px(ring[i][1]) * py(ring[i - 1][0])); return Math.abs(s / 2); };
const parkList = [];
for (const p of parks) {
  const outer = p.rings.slice().sort((a, b) => area(b) - area(a));
  if (area(outer[0]) < 10000) continue; /* меньше гектара — сквер, не парк */
  const c = centroid(outer[0]);
  if (!inMkad(c[0], c[1]) || inKremlin(c)) continue;
  if (parkList.some((q) => q.name === p.name && hav(q.c[0], q.c[1], c[0], c[1]) < 300)) continue;
  parkList.push({ name: p.name, c, rings: outer.filter((r) => area(r) >= 2000).map((r) => simplifyDP(r, 8)), wiki: p.wiki, wd: p.wd, f: p.f, area: area(outer[0]) });
}
log('объектов', dedup.length, 'парков', parkList.length, 'убрано в Кремле', kremlinDropped);

/* ---------- Википедия: первый абзац о районе ---------- */
let cache = {};
try { cache = JSON.parse(readFileSync(CACHE, 'utf8')); } catch { /* нет кэша */ }
for (const k of Object.keys(cache)) if (!cache[k]) delete cache[k]; /* «нет статьи» перепроверяем */
/* Википедия ограничивает частоту: запросы по одному с паузой, на 429 и 5xx — повтор;
   «нет статьи» кэшируется только по 404. */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function wiki(title) {
  if (!title) return null;
  if (title in cache) return cache[title];
  const t = title.replace(/^ru:/, '');
  if (t === title && /^[a-z-]+:/.test(title)) return (cache[title] = null);
  const url = 'https://ru.wikipedia.org/api/rest_v1/page/summary/' + encodeURIComponent(t.replace(/ /g, '_'));
  for (let attempt = 0; attempt < 5; attempt++) {
    await sleep(attempt ? 2000 * 2 ** attempt : 250);
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'rundom-data (github.com/hvalmyr/rundom)' }, signal: AbortSignal.timeout(20000) });
      if (res.status === 404) return (cache[title] = null);
      if (!res.ok) { console.warn('wiki', res.status, t); continue; }
      const j = await res.json();
      return (cache[title] = j.extract ? { t: trimText(j.extract), u: j.content_urls && j.content_urls.desktop ? j.content_urls.desktop.page : 'https://ru.wikipedia.org/wiki/' + encodeURIComponent(t) } : null);
    } catch (e) { console.warn('wiki', t, e.message); }
  }
  return null;
}
function trimText(s) {
  s = s.replace(/\u0301/g, '').replace(/\s+/g, ' ').trim();
  if (s.length <= 650) return s;
  const cutAt = s.lastIndexOf('. ', 600);
  return cutAt > 250 ? s.slice(0, cutAt + 1) : s.slice(0, 600).replace(/\s+\S*$/, '') + '…';
}

/* ---------- описания и фото мест ---------- */
const withWiki = [...dedup, ...parkList].filter((q) => q.wiki || q.wd || q.f.cm);
const info = await placeInfo(withWiki, process.env.PLACES_CACHE || '.cache/places.json');
log('мест со ссылкой на вики', withWiki.length, 'с описанием', [...info.values()].filter((x) => x.t).length, 'с фото', [...info.values()].filter((x) => x.i).length,
  'со справкой из OSM', [...dedup, ...parkList].filter((q) => Object.keys(q.f).some((k) => k !== 'cm')).length);
/* фото с Commons уже в w.i: имя файла в справке больше не нужно */
const factsOut = (q) => { const { cm, ...f } = q.f; return Object.keys(f).length ? f : undefined; };

/* ---------- запись ---------- */
const enc = (p, o) => [Math.round(p[0] * Q) - o[0], Math.round(p[1] * Q) - o[1]];
function encLine(pts, o) {
  const out = []; let pl = 0, pn = 0;
  for (const p of pts) {
    const [a, b] = enc(p, o);
    if (out.length && a === pl && b === pn) continue;
    out.push(a - pl, b - pn); pl = a; pn = b;
  }
  return out;
}
/* каталог не удаляем целиком: dev-сервер Vite следит за public/ */
if (existsSync(OUT + '/d')) rmSync(OUT + '/d', { recursive: true });
mkdirSync(OUT + '/d', { recursive: true });
const version = header.timestamp || Math.floor(Date.now() / 1000);
const index = { v: version, date: new Date(version * 1000).toISOString().slice(0, 10), mkad: encLine(mkadRing, [0, 0]), km: Math.round(total / 100) / 10, d: [] };
const sizes = [];
let about_n = 0;
for (let i = 0; i < districts.length; i++) {
  const d = districts[i], dd = D[i];
  if (dd.km < 2000) continue; /* район за МКАД или почти целиком за ним */
  const o = [Math.round(dBox[i][0] * Q), Math.round(dBox[i][1] * Q)];
  const streets = [...dd.streets.values()].sort((a, b) => (a.n ? 0 : 1) - (b.n ? 0 : 1) || a.n.localeCompare(b.n, 'ru'));
  const tags = districtTags.get(d.id) || {};
  const about = (await wiki(tags.wikipedia || '')) || (await wiki('ru:' + d.n + ' (район Москвы)')) || (await wiki('ru:' + d.n + ' (район)'));
  const objs = dedup.filter((q) => districtAt(q.p[0], q.p[1]) === i)
    .map((q) => ({ n: q.name, c: q.cat, p: enc(q.p, o), s: streetNear(q.p) || undefined, w: info.get(q), f: factsOut(q) }));
  const pk = parkList.filter((q) => districtAt(q.c[0], q.c[1]) === i)
    .map((q) => ({ n: q.name, ha: Math.round(q.area / 1000) / 10, r: q.rings.map((r) => encLine(r, o)), w: info.get(q), f: factsOut(q) }));
  const file = {
    id: d.id, n: d.n, v: version, o,
    s: streets.map((s) => ({ n: s.n || undefined, t: s.t === 20 ? undefined : s.t, c: joinChains(s.chains).map((c) => encLine(c, o)) })),
    ob: objs, pk, about: about || undefined
  };
  if (about) about_n++;
  const json = JSON.stringify(file);
  writeFileSync(`${OUT}/d/${d.id}.json`, json);
  const gz = gzipSync(json).length;
  sizes.push({ n: d.n, gz });
  index.d.push({
    id: d.id, n: d.n, km: Math.round(dd.km / 100) / 10, b: dBox[i],
    st: streets.filter((s) => s.n).length, ob: objs.length, pk: pk.length
  });
}
mkdirSync(dirname(CACHE), { recursive: true });
writeFileSync(CACHE, JSON.stringify(cache));
const ij = JSON.stringify(index);
writeFileSync(`${OUT}/index.json`, ij);
const stats = {
  version, date: index.date, km: index.km, districts: index.d.length,
  streets: index.d.reduce((s, d) => s + d.st, 0), about: about_n, objects: index.d.reduce((s, d) => s + d.ob, 0), parks: index.d.reduce((s, d) => s + d.pk, 0),
  indexGz: gzipSync(ij).length, maxDistrictGz: Math.max(...sizes.map((s) => s.gz)), minDistrictGz: Math.min(...sizes.map((s) => s.gz)),
  totalGz: sizes.reduce((s, x) => s + x.gz, 0) + gzipSync(ij).length
};
writeFileSync(`${OUT}/stats.json`, JSON.stringify(stats, null, 1));
log(stats);
sizes.sort((a, b) => b.gz - a.gz);
console.log('крупнейшие:', sizes.slice(0, 5).map((s) => s.n + ' ' + Math.round(s.gz / 1024) + ' КБ').join(', '));

/* ---------- цепочки улицы, сходящиеся концами, — в одну ломаную ---------- */
function joinChains(chains) {
  const k = (p) => Math.round(p[0] * Q) + ',' + Math.round(p[1] * Q);
  const ends = new Map(), alive = new Set(chains);
  const add = (c) => { for (const p of [c[0], c[c.length - 1]]) { const kk = k(p); (ends.get(kk) || ends.set(kk, []).get(kk)).push(c); } };
  const drop = (c) => { for (const p of [c[0], c[c.length - 1]]) { const a = ends.get(k(p)); a.splice(a.indexOf(c), 1); } };
  chains.forEach(add);
  const out = [];
  for (const c0 of chains) {
    if (!alive.has(c0)) continue;
    alive.delete(c0); drop(c0);
    let c = c0;
    for (let grow = true; grow;) {
      grow = false;
      for (const atEnd of [true, false]) {
        const p = atEnd ? c[c.length - 1] : c[0];
        const n = (ends.get(k(p)) || [])[0];
        if (!n) continue;
        alive.delete(n); drop(n);
        const nn = k(n[0]) === k(p) ? n : n.slice().reverse();
        c = atEnd ? c.concat(nn.slice(1)) : nn.slice().reverse().concat(c.slice(1));
        grow = true;
      }
    }
    out.push(c);
  }
  return out;
}

/* ---------- склейка колец мультиполигона ---------- */
function stitch(parts) {
  const rings = [], left = parts.map((p) => p.slice());
  const key = (p) => p[0].toFixed(7) + ',' + p[1].toFixed(7);
  while (left.length) {
    let ring = left.shift(), guard = 0;
    while (key(ring[0]) !== key(ring[ring.length - 1]) && guard++ < 5000) {
      const end = key(ring[ring.length - 1]);
      const i = left.findIndex((p) => key(p[0]) === end || key(p[p.length - 1]) === end);
      if (i < 0) break;
      const next = left.splice(i, 1)[0];
      ring = ring.concat(key(next[0]) === end ? next.slice(1) : next.reverse().slice(1));
    }
    if (ring.length > 3 && key(ring[0]) === key(ring[ring.length - 1])) rings.push(ring);
  }
  return rings;
}
