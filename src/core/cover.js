/* Покрытие улиц: какие участки улиц района пройдены треком.
   Объект «встречен», если пройден участок его улицы ближе 60 м к нему (объект было видно) или трек
   прошёл ближе 40 м; парк — если трек заходил внутрь.
   Данные района (public/data/d/<id>.json) — улицы как ломаные в целых дельтах 1e-5°.
   Каждая ломаная режется на участки ~25 м; участок пройден, если трек шёл ближе допуска
   улицы к 60% его длины (пробы через 5 м). */
import { hav, px, py, polyLength, pointInRing } from './geo.js';

const Q = 1e5, SEG = 25, PROBE = 5, SHARE = 0.6, OBJ_NEAR = 40, OBJ_STREET = 60;
const CELL = 50, KEY = 100003;
/* версия правил расчёта: при её смене покрытие треков пересчитывается */
const COVER_VERSION = 2;
const ALONG = Math.PI / 4; /* трек засчитывается, если идёт вдоль участка (±45°), а не поперёк */

function decodeLine(c, o) {
  const pts = [];
  let a = o[0], b = o[1];
  for (let i = 0; i < c.length; i += 2) { a += c[i]; b += c[i + 1]; pts.push([a / Q, b / Q]); }
  return pts;
}

/* Точки через step метров вдоль ломаной, включая концы. */
function along(pts, step) {
  const out = [pts[0]];
  let carry = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i], L = hav(a[0], a[1], b[0], b[1]);
    let pos = step - carry;
    while (pos < L) { const t = pos / L; out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]); pos += step; }
    carry = L - (pos - step);
  }
  const last = pts[pts.length - 1];
  if (out[out.length - 1] !== last) out.push(last);
  return out;
}

/* Ломаная → куски равной длины ~SEG м. */
function pieces(pts) {
  const L = polyLength(pts), n = Math.max(1, Math.round(L / SEG)), part = L / n;
  const out = [];
  let cur = [pts[0]], acc = 0;
  for (let i = 1; i < pts.length; i++) {
    let a = pts[i - 1];
    const b = pts[i];
    let seg = hav(a[0], a[1], b[0], b[1]);
    while (acc + seg >= part - 1e-6 && out.length < n - 1) {
      const t = (part - acc) / seg, m = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
      cur.push(m); out.push(cur); cur = [m];
      seg -= part - acc; acc = 0; a = m;
    }
    acc += seg; cur.push(b);
  }
  out.push(cur);
  return out;
}

const flatRing = (r) => r.flatMap((p) => [px(p[1]), py(p[0])]);

/* Файл района → структура для расчёта покрытия. */
function decodeDistrict(f) {
  const streets = [], segStreet = [], segLen = [], probeStart = [0], probes = [], box = [];
  for (const s of f.s) {
    const st = { n: s.n || '', t: s.t || 20, from: segLen.length, to: 0, len: 0 };
    for (const c of s.c) {
      const line = decodeLine(c, f.o);
      if (line.length < 2) continue;
      for (const p of pieces(line)) {
        const len = polyLength(p);
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        for (const q of along(p, PROBE)) {
          const x = px(q[1]), y = py(q[0]);
          probes.push(x, y);
          if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
        }
        segStreet.push(streets.length); segLen.push(len); box.push(x0, y0, x1, y1);
        probeStart.push(probes.length / 2);
        st.len += len;
      }
    }
    st.to = segLen.length;
    streets.push(st);
  }
  const objects = (f.ob || []).map((o) => {
    const lat = (f.o[0] + o.p[0]) / Q, lon = (f.o[1] + o.p[1]) / Q;
    return { n: o.n, c: o.c, s: o.s || '', w: o.w || null, lat, lon, x: px(lon), y: py(lat), segs: [] };
  });
  const byName = new Map(streets.map((st, i) => [st.n, i]));
  for (const o of objects) {
    const si = byName.get(o.s);
    if (!o.s || si === undefined) continue;
    for (let g = streets[si].from; g < streets[si].to; g++) {
      for (let p = probeStart[g]; p < probeStart[g + 1]; p++) {
        if (Math.hypot(probes[2 * p] - o.x, probes[2 * p + 1] - o.y) <= OBJ_STREET) { o.segs.push(g); break; }
      }
    }
  }
  const parks = (f.pk || []).map((p) => {
    const rings = p.r.map((r) => decodeLine(r, f.o));
    const flat = rings.map(flatRing);
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const r of flat) for (let i = 0; i < r.length; i += 2) {
      x0 = Math.min(x0, r[i]); x1 = Math.max(x1, r[i]); y0 = Math.min(y0, r[i + 1]); y1 = Math.max(y1, r[i + 1]);
    }
    return { n: p.n, ha: p.ha, w: p.w || null, rings, flat, box: [x0, y0, x1, y1] };
  });
  return {
    id: f.id, n: f.n, v: f.v, about: f.about || null, streets, objects, parks,
    segStreet: Int32Array.from(segStreet), segLen: Float32Array.from(segLen),
    probeStart: Int32Array.from(probeStart), probes: Float64Array.from(probes), box: Float64Array.from(box),
    total: segLen.reduce((s, x) => s + x, 0)
  };
}

/* Точки трека в сетке 50 м: x, y и направление движения. */
function trackGrid(lines) {
  const map = new Map(), pts = [];
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const line of lines) {
    if (line.length < 2) continue;
    const q = along(line, PROBE).map((p) => [px(p[1]), py(p[0])]);
    for (let i = 0; i < q.length; i++) {
      const [x, y] = q[i], a = q[Math.max(0, i - 1)], b = q[Math.min(q.length - 1, i + 1)];
      const ang = Math.atan2(b[1] - a[1], b[0] - a[0]);
      const k = Math.floor(x / CELL) * KEY + Math.floor(y / CELL);
      const arr = map.get(k);
      if (arr) arr.push(x, y, ang); else map.set(k, [x, y, ang]);
      pts.push(x, y);
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
  }
  return { map, pts, box: [x0, y0, x1, y1] };
}
const angDiff = (a, b) => { const d = Math.abs(a - b) % Math.PI; return Math.min(d, Math.PI - d); };
/* есть ли точка трека ближе tol; с направлением dir — только идущая вдоль него */
function near(map, x, y, tol, dir) {
  const cx = Math.floor(x / CELL), cy = Math.floor(y / CELL), R = tol > CELL ? 2 : 1, t2 = tol * tol;
  for (let i = -R; i <= R; i++) for (let j = -R; j <= R; j++) {
    const a = map.get((cx + i) * KEY + (cy + j));
    if (!a) continue;
    for (let q = 0; q < a.length; q += 3) {
      const dx = a[q] - x, dy = a[q + 1] - y;
      if (dx * dx + dy * dy <= t2 && (dir === undefined || angDiff(a[q + 2], dir) <= ALONG)) return true;
    }
  }
  return false;
}

/* Что трек покрыл в районе: номера участков, объектов и парков. */
function coverTrack(dist, lines, grid) {
  const tg = grid || trackGrid(lines);
  const segs = [], objs = [], parks = [];
  if (!tg.pts.length) return { segs, objs, parks };
  const [tx0, ty0, tx1, ty1] = tg.box, B = dist.box, n = dist.segLen.length;
  for (let s = 0; s < n; s++) {
    const tol = dist.streets[dist.segStreet[s]].t;
    if (B[4 * s] > tx1 + tol || B[4 * s + 2] < tx0 - tol || B[4 * s + 1] > ty1 + tol || B[4 * s + 3] < ty0 - tol) continue;
    const p0 = dist.probeStart[s], p1 = dist.probeStart[s + 1], need = Math.ceil((p1 - p0) * SHARE);
    const P = dist.probes, dir = Math.atan2(P[2 * p1 - 1] - P[2 * p0 + 1], P[2 * p1 - 2] - P[2 * p0]);
    let hit = 0, miss = 0;
    for (let p = p0; p < p1; p++) {
      if (near(tg.map, P[2 * p], P[2 * p + 1], tol, dir)) { if (++hit >= need) break; }
      else if (++miss > p1 - p0 - need) break;
    }
    if (hit >= need) segs.push(s);
  }
  const done = new Set(segs);
  dist.objects.forEach((o, i) => {
    if (o.x < tx0 - OBJ_STREET || o.x > tx1 + OBJ_STREET || o.y < ty0 - OBJ_STREET || o.y > ty1 + OBJ_STREET) return;
    if (o.segs.some((g) => done.has(g)) || near(tg.map, o.x, o.y, OBJ_NEAR)) objs.push(i);
  });
  dist.parks.forEach((pk, i) => {
    const b = pk.box;
    if (b[0] > tx1 || b[2] < tx0 || b[1] > ty1 || b[3] < ty0) return;
    for (let q = 0; q < tg.pts.length; q += 10) { /* каждые ~50 м */
      const x = tg.pts[q], y = tg.pts[q + 1];
      if (x < b[0] || x > b[2] || y < b[1] || y > b[3]) continue;
      if (pk.flat.some((r) => pointInRing(x, y, r))) { parks.push(i); return; }
    }
  });
  return { segs, objs, parks };
}

/* Районы из индекса, чьи рамки задевает трек. */
function districtsTouched(index, lines) {
  let a0 = Infinity, b0 = Infinity, a1 = -Infinity, b1 = -Infinity;
  for (const l of lines) for (const p of l) { a0 = Math.min(a0, p[0]); a1 = Math.max(a1, p[0]); b0 = Math.min(b0, p[1]); b1 = Math.max(b1, p[1]); }
  return index.d.filter((d) => !(d.b[0] > a1 || d.b[2] < a0 || d.b[1] > b1 || d.b[3] < b0)).map((d) => d.id);
}

/* Покрытие района по набору треков: доля длины и пройденные метры по улицам. */
function districtStats(dist, covered) {
  let done = 0;
  const byStreet = new Float64Array(dist.streets.length);
  for (const s of covered) { done += dist.segLen[s]; byStreet[dist.segStreet[s]] += dist.segLen[s]; }
  return { done, total: dist.total, share: dist.total ? done / dist.total : 0, byStreet };
}

function decodeRing(flat) {
  const pts = [];
  let a = 0, b = 0;
  for (let i = 0; i < flat.length; i += 2) { a += flat[i]; b += flat[i + 1]; pts.push([a / Q, b / Q]); }
  return pts;
}

export { COVER_VERSION, decodeDistrict, trackGrid, coverTrack, districtsTouched, districtStats, decodeRing };
