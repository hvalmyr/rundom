/* Сколько метров трека пришлось на улицы, которых ещё нет среди пройденного. */
import { hav, px, py, resample } from './geo.js';

const CELL = 25, KEY = 100003;

function pointGrid(lines, step) {
  const map = new Map();
  for (const line of lines) {
    for (const p of resample(line, step)) {
      const x = px(p[1]), y = py(p[0]);
      const k = Math.floor(x / CELL) * KEY + Math.floor(y / CELL);
      const arr = map.get(k);
      if (arr) arr.push(x, y); else map.set(k, [x, y]);
    }
  }
  return map;
}

function near(map, x, y, tol) {
  const cx = Math.floor(x / CELL), cy = Math.floor(y / CELL);
  for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
    const arr = map.get((cx + i) * KEY + (cy + j));
    if (!arr) continue;
    for (let q = 0; q < arr.length; q += 2) {
      const dx = arr[q] - x, dy = arr[q + 1] - y;
      if (dx * dx + dy * dy <= tol * tol) return true;
    }
  }
  return false;
}

/* Трек считается пройденным повторно там, где он ближе tol метров к уже пройденному
   (обе стороны улицы и тротуары засчитываются как одна улица). */
export function newDistance(lines, refLines, tol = 22) {
  const ref = pointGrid(refLines, 12);
  let fresh = 0;
  for (const line of lines) {
    const pts = resample(line, 12);
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i];
      const mx = px((a[1] + b[1]) / 2), my = py((a[0] + b[0]) / 2);
      if (!near(ref, mx, my, tol)) fresh += hav(a[0], a[1], b[0], b[1]);
    }
  }
  return fresh;
}
