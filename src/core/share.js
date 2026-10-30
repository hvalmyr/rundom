/* Маршрут в ссылке: ломаная в кодировке Google Polyline (точность 1e-5) плюс имя и признак кольца.
   Всё лежит во фрагменте адреса (#r=…), на сервер ничего не уходит. */
import { simplifyDP, polyLength } from './geo.js';

export function encodePolyline(pts) {
  let out = '', pLat = 0, pLon = 0;
  const put = (v) => {
    v = v < 0 ? ~(v << 1) : v << 1;
    while (v >= 0x20) { out += String.fromCharCode((0x20 | (v & 0x1f)) + 63); v >>= 5; }
    out += String.fromCharCode(v + 63);
  };
  for (const p of pts) {
    const la = Math.round(p[0] * 1e5), lo = Math.round(p[1] * 1e5);
    put(la - pLat); put(lo - pLon);
    pLat = la; pLon = lo;
  }
  return out;
}

export function decodePolyline(s) {
  const pts = [];
  let i = 0, la = 0, lo = 0;
  const next = () => {
    let r = 0, sh = 0, b;
    do {
      if (i >= s.length) throw new Error('обрыв');
      b = s.charCodeAt(i++) - 63; r |= (b & 0x1f) << sh; sh += 5;
    } while (b >= 0x20);
    return r & 1 ? ~(r >> 1) : r >> 1;
  };
  while (i < s.length) { la += next(); lo += next(); pts.push([la / 1e5, lo / 1e5]); }
  return pts;
}

/* Ссылка на маршрут: часть после «#». Длинные маршруты упрощаются, пока ссылка не станет короче MAX знаков. */
const MAX = 6000;
export function shareHash(route) {
  let coords = route.coords, tol = 2, q;
  for (;;) {
    q = new URLSearchParams({ r: encodePolyline(simplifyDP(coords, tol)), n: route.name || '' });
    if (route.loop) q.set('l', '1');
    if (q.toString().length <= MAX || tol > 40) return q.toString();
    tol *= 2;
  }
}

/* Обратно: {name, loop, coords, length} или null, если в адресе нет маршрута или он испорчен. */
export function parseShare(hash) {
  try {
    const q = new URLSearchParams(String(hash || '').replace(/^#/, ''));
    const r = q.get('r');
    if (!r) return null;
    const coords = decodePolyline(r);
    if (coords.length < 2 || coords.some((p) => !(Math.abs(p[0]) <= 90 && Math.abs(p[1]) <= 180))) return null;
    return { name: (q.get('n') || 'Маршрут по ссылке').slice(0, 120), loop: q.get('l') === '1', coords, length: polyLength(coords) };
  } catch (e) { return null; }
}
