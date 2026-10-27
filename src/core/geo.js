/* Геометрия: расстояния, упрощение и передискретизация ломаных, точка в многоугольнике, ГПСЧ. */
/* ---------- геометрия ---------- */
var DEG = Math.PI / 180;
var EARTH = 6371008.8;
var LAT0 = 55.75;
var KX = EARTH * DEG * Math.cos(LAT0 * DEG);
var KY = EARTH * DEG;

function hav(aLat, aLon, bLat, bLon) {
  var dLat = (bLat - aLat) * DEG, dLon = (bLon - aLon) * DEG;
  var s1 = Math.sin(dLat / 2), s2 = Math.sin(dLon / 2);
  var h = s1 * s1 + Math.cos(aLat * DEG) * Math.cos(bLat * DEG) * s2 * s2;
  return 2 * EARTH * Math.asin(Math.min(1, Math.sqrt(h)));
}
function px(lon) { return lon * KX; }
function py(lat) { return lat * KY; }

function bearing(aLat, aLon, bLat, bLon) {
  var y = Math.sin((bLon - aLon) * DEG) * Math.cos(bLat * DEG);
  var x = Math.cos(aLat * DEG) * Math.sin(bLat * DEG) -
    Math.sin(aLat * DEG) * Math.cos(bLat * DEG) * Math.cos((bLon - aLon) * DEG);
  return (Math.atan2(y, x) / DEG + 360) % 360;
}

function polyLength(c) {
  var s = 0;
  for (var i = 1; i < c.length; i++) s += hav(c[i - 1][0], c[i - 1][1], c[i][0], c[i][1]);
  return s;
}

function distToSegment(x, y, x1, y1, x2, y2) {
  var dx = x2 - x1, dy = y2 - y1;
  var l2 = dx * dx + dy * dy;
  var t = l2 === 0 ? 0 : ((x - x1) * dx + (y - y1) * dy) / l2;
  t = Math.max(0, Math.min(1, t));
  var cx = x1 + t * dx, cy = y1 + t * dy;
  return Math.sqrt((x - cx) * (x - cx) + (y - cy) * (y - cy));
}

/* Упрощение ломаной (Дуглас-Пекер, без рекурсии). tol в метрах. */
function simplifyDP(pts, tol) {
  var n = pts.length;
  if (n < 3) return pts.slice();
  var X = new Float64Array(n), Y = new Float64Array(n);
  for (var i = 0; i < n; i++) { X[i] = px(pts[i][1]); Y[i] = py(pts[i][0]); }
  var keep = new Uint8Array(n);
  keep[0] = 1; keep[n - 1] = 1;
  var stack = [[0, n - 1]];
  while (stack.length) {
    var seg = stack.pop(), a = seg[0], b = seg[1];
    var maxD = 0, idx = -1;
    for (var k = a + 1; k < b; k++) {
      var d = distToSegment(X[k], Y[k], X[a], Y[a], X[b], Y[b]);
      if (d > maxD) { maxD = d; idx = k; }
    }
    if (idx !== -1 && maxD > tol) {
      keep[idx] = 1;
      stack.push([a, idx]);
      stack.push([idx, b]);
    }
  }
  var out = [];
  for (var j = 0; j < n; j++) if (keep[j]) out.push(pts[j]);
  return out;
}

/* Точки вдоль ломаной через каждые step метров (включая начало и конец). */
function resample(pts, step) {
  if (!pts.length) return [];
  var out = [[pts[0][0], pts[0][1]]];
  var carry = 0;
  for (var i = 1; i < pts.length; i++) {
    var a = pts[i - 1], b = pts[i];
    var seg = hav(a[0], a[1], b[0], b[1]);
    if (seg === 0) continue;
    var pos = step - carry;
    while (pos <= seg) {
      var t = pos / seg;
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
      pos += step;
    }
    carry = seg - (pos - step);
  }
  var last = pts[pts.length - 1];
  var lo = out[out.length - 1];
  if (lo[0] !== last[0] || lo[1] !== last[1]) out.push([last[0], last[1]]);
  return out;
}

/* Попадание точки в многоугольник; ring = плоский массив [x0,y0,x1,y1,...] в метрах. */
function pointInRing(x, y, ring) {
  var inside = false;
  var n = ring.length / 2;
  for (var i = 0, j = n - 1; i < n; j = i++) {
    var xi = ring[2 * i], yi = ring[2 * i + 1], xj = ring[2 * j], yj = ring[2 * j + 1];
    if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) inside = !inside;
  }
  return inside;
}

function mulberry32(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    var t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

export { DEG, KX, KY, hav, px, py, bearing, polyLength, distToSegment, simplifyDP, resample, pointInRing, mulberry32 };
