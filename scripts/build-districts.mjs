/* Границы районов Москвы из OpenStreetMap → src/data/districts.json.
   Запуск: npm run data:districts. Контуры упрощаются до ~12 м, координаты — 5 знаков. */
import { writeFileSync } from 'node:fs';
import { simplifyDP, px, py, pointInRing, distToSegment } from '../src/core/geo.js';

const MIRRORS = [
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter'
];
const QUERY = '[out:json][timeout:180];area(3600102269)->.m;rel(area.m)["boundary"="administrative"]["admin_level"="8"];out geom;';
const OUT = new URL('../src/data/districts.json', import.meta.url);

async function fetchData() {
  for (const url of MIRRORS) {
    try {
      const res = await fetch(url, { method: 'POST', headers: { 'User-Agent': 'rundom-data (github.com/hvalmyr/rundom)' }, body: new URLSearchParams({ data: QUERY }), signal: AbortSignal.timeout(240000) });
      if (res.ok) return await res.json();
      console.warn(url, res.status);
    } catch (e) { console.warn(url, e.message); }
  }
  throw new Error('Overpass недоступен');
}

/* Склейка отрезков границы (ways) в замкнутые кольца. */
function stitch(parts) {
  const rings = [], left = parts.map((p) => p.slice());
  const key = (p) => p[0].toFixed(7) + ',' + p[1].toFixed(7);
  while (left.length) {
    let ring = left.shift();
    let guard = 0;
    while (key(ring[0]) !== key(ring[ring.length - 1]) && guard++ < 5000) {
      const end = key(ring[ring.length - 1]);
      const i = left.findIndex((p) => key(p[0]) === end || key(p[p.length - 1]) === end);
      if (i < 0) break;
      const next = left.splice(i, 1)[0];
      ring = ring.concat(key(next[0]) === end ? next.slice(1) : next.reverse().slice(1));
    }
    if (ring.length > 3) rings.push(ring);
  }
  return rings;
}

const flat = (ring) => ring.flatMap((p) => [px(p[1]), py(p[0])]);

/* Точка подписи: внутри контура и подальше от границ (поиск по сетке). */
function labelPoint(outer) {
  const f = flat(outer);
  let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
  for (let i = 0; i < f.length; i += 2) {
    minx = Math.min(minx, f[i]); maxx = Math.max(maxx, f[i]); miny = Math.min(miny, f[i + 1]); maxy = Math.max(maxy, f[i + 1]);
  }
  let best = null, bd = -1;
  for (let i = 1; i < 24; i++) for (let j = 1; j < 24; j++) {
    const x = minx + (maxx - minx) * i / 24, y = miny + (maxy - miny) * j / 24;
    if (!pointInRing(x, y, f)) continue;
    let d = Infinity;
    for (let k = 0; k < f.length - 2; k += 2) d = Math.min(d, distToSegment(x, y, f[k], f[k + 1], f[k + 2], f[k + 3]));
    if (d > bd) { bd = d; best = [x, y]; }
  }
  const p = best || [(minx + maxx) / 2, (miny + maxy) / 2];
  return [round(p[1] / py(1)), round(p[0] / px(1))];
}

const round = (x) => Math.round(x * 1e5) / 1e5;
const short = (name) => name.replace(/^район\s+/i, '').replace(/\s+район$/i, '');

const data = await fetchData();
const out = [];
for (const rel of data.elements) {
  if (rel.type !== 'relation' || !rel.tags || !rel.tags.name) continue;
  const ways = (role) => rel.members.filter((m) => m.type === 'way' && m.geometry && (m.role || 'outer') === role)
    .map((m) => m.geometry.map((g) => [g.lat, g.lon]));
  const outers = stitch(ways('outer')), inners = stitch(ways('inner'));
  if (!outers.length) { console.warn('нет контура:', rel.tags.name); continue; }
  const simp = (r) => simplifyDP(r, 12).map((p) => [round(p[0]), round(p[1])]);
  /* дырки — к тому внешнему кольцу, в котором лежат */
  const polys = outers.map((o) => [simp(o)]);
  for (const h of inners) {
    const t = polys.find((p) => pointInRing(px(h[0][1]), py(h[0][0]), flat(p[0])));
    if (t) t.push(simp(h));
  }
  const biggest = polys.slice().sort((a, b) => b[0].length - a[0].length)[0][0];
  out.push({ id: rel.id, n: short(rel.tags.name), l: labelPoint(biggest), p: polys });
}
out.sort((a, b) => a.n.localeCompare(b.n, 'ru'));
writeFileSync(OUT, JSON.stringify(out));
console.log('районов:', out.length, 'размер:', Math.round(JSON.stringify(out).length / 1024) + ' КБ');
