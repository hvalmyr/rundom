/* Сеть улиц для покрытия: пути OSM → один связный граф, где у каждой улицы одна линия.
   Порядок (каждое правило применяется к одному и тому же графу, по одному разу и в одном месте):
   1. Граф: узлы OSM, общие для путей, — перекрёстки; рёбра — куски путей между ними. Разрывы оцифровки
      (конец пути в нескольких метрах от другого пути, разрыв названной улицы до 25 м) замыкаются.
   2. Оси без права прохода (foot=no, trunk) остаются только там, где вдоль идут тротуары.
   3. Слияние: ребро режется на куски по STEP м; кусок, идущий параллельно уже принятой линии ближе допуска,
      поглощается ею (тротуары и дублёры — осью улицы, вторая проезжая часть — первой, близкие параллельные
      дорожки — друг другом). Принимаются линии по старшинству: названные улицы, безымянные проезды,
      тротуары, остальные дорожки. Каждый узел, у которого остались непоглощённые рёбра, связывается
      с точкой на поглотившей линии: связи не теряются.
   4. Упрощение до неподвижной точки: тупики короче DEAD (от свободного конца до перекрёстка или названной
      улицы), петли с обходом короче DEAD, подводы — безымянные цепочки короче DEAD от улицы до развилки во дворе;
      двор, оставшийся без связи с сетью (безымянный кусок короче YARD), уходит целиком.
      Улицы с названиями не удаляются и не укорачиваются.
   5. Связность: главная компонента — с наибольшей длиной; отдельный кусок ближе JOIN м к ней присоединяется
      связью, остальные остаются, только если в них есть названные улицы или они длиннее ISLAND.
   Переходы (наземные и подземные) — связи графа: соединяют, но в покрытие не входят. */
import { KX, KY, pointInRing } from '../../src/core/geo.js';
import { classifyWay } from '../../src/core/osm.js';

/* версия правил сборки сети: при её смене длина сети не сравнивается с прошлым релизом (scripts/data/check.mjs) */
export const NET_VERSION = 1;
export const DEAD = 50;     /* м: тупики и петли короче — убираются */
export const YARD = 1000;   /* м: дворовая сеть на коротких подводах короче — убирается */
export const ISLAND = 1000; /* м: отдельный кусок без названных улиц короче — убирается */
const JOIN = 30;            /* м: отдельный кусок ближе к сети — присоединяется связью */
const STEP = 8;             /* м: длина куска при слиянии */
const ANG = 0.45;           /* рад: «параллельно» — расхождение направлений меньше ~26° */
const FILL = 16;            /* м: непоглощённый промежуток короче между поглощёнными кусками — тоже поглощается */
const MINRUN = 16;          /* м: поглощённый отрезок дорожки короче — не поглощается (случайное сближение) */
const MERGE = 4;            /* м: точки связи на одной линии ближе — один узел */
const TINY = 3;             /* м: безымянное ребро короче стягивается в точку */
const PATHS = { footway: 1, path: 1, cycleway: 1, pedestrian: 1, steps: 1, track: 1, bridleway: 1, corridor: 1 };
/* класс ребра: A — названная улица (проезжая часть или названная пешеходная), S — безымянный проезд,
   W — тротуар (footway=sidewalk), P — прочие дорожки, C — переход (связь, не покрытие) */
const RANK = { A: 0, S: 1, W: 2, P: 3 };

/* Допуск поглощения куска src линией tgt, м (0 — не поглощает). Названное поглощается только линией с тем же именем.
   У широкой улицы тротуары дальше от оси: допуск растёт с числом полос (у раздельных проезжих частей — обеих).
   Если известны здания (walls), допуск больше: дорожка за домом всё равно не поглощается. */
function radius(src, tgt, walls) {
  if (src.name && src.name !== tgt.name) return 0;
  const t = tgt.cls, wide = Math.min(walls ? 15 : 22, 3 * (tgt.lanesTot || tgt.lanes)), far = walls ? 9 : 0;
  switch (src.cls) {
    case 'A': return t === 'A' ? 45 : 0;              /* вторая проезжая часть проспекта */
    case 'S': return t === 'A' ? Math.max(25, 19 + far + wide) : t === 'S' ? 8 : 0;
    case 'W': return t === 'A' ? Math.max(30, 21 + far + wide) : t === 'S' ? 15 : 5;
    default: return t === 'A' ? Math.max(25, 19 + far + wide) : t === 'S' ? 12 : 5;
  }
}

/* Улица с двумя сторонами — дорога больше чем в две полосы: число полос из тега, без него — магистрали (primary, trunk). */
const WIDE_DEFAULT = { primary: 4, primary_link: 2, trunk: 4, trunk_link: 2, motorway: 4 };
function laneCount(t, hw) {
  const n = parseInt(t.lanes, 10);
  if (n > 0) return n;
  const f = parseInt(t['lanes:forward'], 10) || 0, b = parseInt(t['lanes:backward'], 10) || 0;
  return f + b || WIDE_DEFAULT[hw] || 2;
}
const CARRIER = { trunk: 1, primary: 1, secondary: 1, tertiary: 1 };
/* под землёй: трек по поверхности там не пройдёт (арки зданий — building_passage — на поверхности) */
const underground = (t) => (t.tunnel && t.tunnel !== 'no' && t.tunnel !== 'building_passage') || parseFloat(t.layer) < 0 ||
  t.location === 'underground' || (t.indoor && t.indoor !== 'no');

/* Теги пути OSM → свойства для buildNetwork (без узлов) или null, если путь не нужен.
   Переходы и подземные ходы — связи (conn): соединяют сеть, в покрытие не входят. */
export function streetWay(t) {
  const hw = t.highway;
  if (!hw || t.area === 'yes') return null;
  /* ось большой улицы без права прохода (foot=no, trunk): опора для её тротуаров */
  const carrier = !!t.name && !!CARRIER[hw] && !underground(t) && t.covered !== 'yes' && (hw === 'trunk' || t.foot === 'no' || t.foot === 'use_sidepath');
  const c = classifyWay(t, {});
  if (!carrier && (!c || !c.ok)) return null;
  const conn = !carrier && (underground(t) || !!(c && c.fix));
  const lanes = PATHS[hw] ? 0 : laneCount(t, hw);
  return { name: t.name || '', hw, lanes, two: lanes > 2, carrier, side: t.footway === 'sidewalk' || t.path === 'sidewalk', conn };
}

const angDiff = (a, b) => { const d = Math.abs(a - b) % Math.PI; return Math.min(d, Math.PI - d); };

/* ways: [{name, hw, ids (узлы OSM), pts [[lat, lon]], two, carrier, side, conn}];
   opt.walls — контуры зданий, opt.green — контуры парков ([[lat, lon]]), opt.conn — выдать и связи (для отладки)
   → {edges: [{name, two, pts}], tol: Map имя → допуск, м, metrics} */
export function buildNetwork(ways, opt = {}) {
  const log = opt.log || (() => {});
  const VX = [], VY = [];
  const newV = (x, y) => { VX.push(x); VY.push(y); return VX.length - 1; };
  const E = [];
  const lenOf = (x, y) => { let s = 0; for (let i = 1; i < x.length; i++) s += Math.hypot(x[i] - x[i - 1], y[i] - y[i - 1]); return s; };
  const addE = (a, b, x, y, p) => {
    const e = { a, b, x, y, len: lenOf(x, y), name: p.name, cls: p.cls, lanes: p.lanes || 0, two: !!p.two, carrier: !!p.carrier, link: !!p.link, dead: false };
    E.push(e);
    return e;
  };
  const clsOf = (w) => (w.conn ? 'C' : w.name && (!PATHS[w.hw] || w.hw === 'pedestrian') ? 'A' : !PATHS[w.hw] ? 'S' : w.side ? 'W' : 'P');

  /* ---------- 1. граф ---------- */
  const use = new Map();
  for (const w of ways) w.ids.forEach((id, i) => use.set(id, (use.get(id) || 0) + (i === 0 || i === w.ids.length - 1 ? 2 : 1)));
  const vOf = new Map();
  const vAt = (id, x, y) => { let v = vOf.get(id); if (v === undefined) { v = newV(x, y); vOf.set(id, v); } return v; };
  const input = { named: new Map(), walk: new Set(), km: 0 };
  for (const w of ways) {
    const p = { name: w.name || '', cls: clsOf(w), lanes: w.lanes, two: w.two, carrier: w.carrier };
    let x = [], y = [], a = -1;
    for (let i = 0; i < w.ids.length; i++) {
      const X = w.pts[i][1] * KX, Y = w.pts[i][0] * KY;
      if (!x.length || X !== x[x.length - 1] || Y !== y[y.length - 1]) { x.push(X); y.push(Y); }
      if (i === 0) { a = vAt(w.ids[i], X, Y); continue; }
      if (i === w.ids.length - 1 || use.get(w.ids[i]) >= 2) {
        const b = vAt(w.ids[i], X, Y);
        if (x.length > 1) {
          const e = addE(a, b, x, y, p);
          if (p.cls !== 'C') {
            input.km += e.len;
            if (p.name) input.named.set(p.name, (input.named.get(p.name) || 0) + e.len);
            if (p.name && !p.carrier) input.walk.add(p.name);
          }
        }
        a = b; x = [X]; y = [Y];
      }
    }
  }
  log('граф: узлов', VX.length, 'рёбер', E.length, 'км', Math.round(input.km / 1000), 'названий', input.named.size);

  /* ---------- общее: сетка отрезков, степени, разрезание рёбер ---------- */
  const CELL = 32;
  const ck = (cx, cy) => cx * 1e6 + cy;
  function gridOf(filter) {
    const g = new Map();
    E.forEach((e, ei) => { if (!e.dead && filter(e)) for (let k = 0; k < e.x.length - 1; k++) gridAdd(g, ei, k); });
    return g;
  }
  function gridAdd(g, ei, k) {
    const e = E[ei], x1 = e.x[k], y1 = e.y[k], x2 = e.x[k + 1], y2 = e.y[k + 1];
    const n = Math.max(1, Math.ceil(Math.hypot(x2 - x1, y2 - y1) / CELL));
    let last = NaN;
    for (let s = 0; s <= n; s++) {
      const key = ck(Math.floor((x1 + (x2 - x1) * s / n) / CELL), Math.floor((y1 + (y2 - y1) * s / n) / CELL));
      if (key === last) continue;
      last = key;
      const arr = g.get(key);
      if (arr) { if (arr[arr.length - 2] !== ei || arr[arr.length - 1] !== k) arr.push(ei, k); } else g.set(key, [ei, k]);
    }
  }
  /* обход отрезков сетки в радиусе R от точки: fn(ei, k) */
  function around(g, x, y, R, fn) {
    const c0 = Math.floor(x / CELL), r0 = Math.floor(y / CELL), n = Math.ceil(R / CELL);
    for (let i = -n; i <= n; i++) for (let j = -n; j <= n; j++) {
      const a = g.get(ck(c0 + i, r0 + j));
      if (a) for (let q = 0; q < a.length; q += 2) fn(a[q], a[q + 1]);
    }
  }
  /* проекция точки на отрезок k ребра e: {t, d, x, y}; side — точка сбоку от отрезка, а не за его концом */
  function proj(e, k, x, y) {
    const x1 = e.x[k], y1 = e.y[k], dx = e.x[k + 1] - x1, dy = e.y[k + 1] - y1, L2 = dx * dx + dy * dy;
    const t0 = L2 ? ((x - x1) * dx + (y - y1) * dy) / L2 : 0, t = Math.max(0, Math.min(1, t0));
    const X = x1 + dx * t, Y = y1 + dy * t;
    return { t, d: Math.hypot(x - X, y - Y), x: X, y: Y, side: t0 >= 0 && t0 <= 1 };
  }
  /* Вставка узлов в рёбра: ins — Map ребро → [{k, t, x, y, v?}]; v пустое — узел создаётся.
     Точки ближе MERGE друг к другу — один узел, ближе MERGE к концу ребра — его конец. Возвращает узел каждой вставки (в поле v). */
  function splitAt(ins) {
    for (const [ei, list] of ins) {
      const e = E[ei];
      const cum = [0];
      for (let i = 1; i < e.x.length; i++) cum.push(cum[i - 1] + Math.hypot(e.x[i] - e.x[i - 1], e.y[i] - e.y[i - 1]));
      for (const p of list) p.s = cum[p.k] + (cum[p.k + 1] - cum[p.k]) * p.t;
      list.sort((p, q) => p.s - q.s);
      const L = cum[cum.length - 1], cuts = [];
      for (const p of list) {
        if (p.s < MERGE) { p.v = e.a; continue; }
        if (L - p.s < MERGE) { p.v = e.b; continue; }
        const prev = cuts[cuts.length - 1];
        if (prev && p.s - prev.s < MERGE) { p.v = prev.v; continue; }
        p.v = newV(p.x, p.y);
        cuts.push(p);
      }
      if (!cuts.length) continue;
      e.dead = true;
      let a = e.a, x = [e.x[0]], y = [e.y[0]], i = 1;
      for (const c of cuts) {
        while (cum[i] < c.s) { x.push(e.x[i]); y.push(e.y[i]); i++; }
        x.push(c.x); y.push(c.y);
        const ne = addE(a, c.v, x, y, e);
        ne.tol = e.tol;
        a = c.v; x = [c.x]; y = [c.y];
        if (cum[i] === c.s) i++;
      }
      for (; i < e.x.length; i++) { x.push(e.x[i]); y.push(e.y[i]); }
      addE(a, e.b, x, y, e).tol = e.tol;
    }
  }
  const liveKm = () => Math.round(E.reduce((s, e) => s + (e.dead || e.cls === 'C' ? 0 : e.len), 0) / 1000);
  const linkE = (v, w, p) => addE(v, w, [VX[v], VX[w]], [VY[v], VY[w]], { name: '', cls: p.cls, link: true });

  /* ---------- 1б. разрывы оцифровки ---------- */
  {
    const deg = new Int32Array(VX.length), inc = new Int32Array(VX.length).fill(-1);
    E.forEach((e, ei) => { deg[e.a]++; deg[e.b]++; inc[e.a] = ei; inc[e.b] = ei; });
    const g = gridOf(() => true), ins = new Map(), links = [];
    let closedNamed = 0, closed = 0;
    for (let v = 0; v < VX.length; v++) {
      if (deg[v] !== 1) continue;
      const e0 = E[inc[v]];
      const R = e0.name && e0.cls !== 'C' ? 25 : 4;
      let best = null;
      around(g, VX[v], VY[v], R, (ei, k) => {
        if (ei === inc[v]) return;
        const t = E[ei];
        /* названная улица дотягивается до себя же на 25 м, до любой другой — на 12 м */
        const r = e0.name && e0.cls !== 'C' ? (t.name === e0.name ? 25 : 12) : 4;
        const p = proj(t, k, VX[v], VY[v]);
        if (p.d <= r && (!best || p.d < best.d)) best = { ei, k, ...p };
      });
      if (!best) continue;
      (ins.get(best.ei) || ins.set(best.ei, []).get(best.ei)).push(best);
      links.push([v, best, e0]);
      if (E[best.ei].name === e0.name && e0.name) closedNamed++; else closed++;
    }
    splitAt(ins);
    for (const [v, p, e0] of links) {
      if (p.v === v) continue;
      const l = linkE(v, p.v, e0);
      if (e0.name && E[p.ei].name === e0.name) l.name = e0.name; /* разрыв в улице — часть улицы */
    }
    log('разрывов замкнуто: в названных улицах', closedNamed, 'прочих', closed);
  }

  /* ---------- 2. оси без права прохода ---------- */
  {
    const g = gridOf((e) => !e.carrier && e.cls !== 'C' && e.cls !== 'A');
    let kept = 0, gone = 0;
    for (const e of E) {
      if (e.dead || !e.carrier) continue;
      let n = 0, hit = 0;
      for (let k = 0; k < e.x.length - 1; k++) {
        const L = Math.hypot(e.x[k + 1] - e.x[k], e.y[k + 1] - e.y[k]), a = Math.atan2(e.y[k + 1] - e.y[k], e.x[k + 1] - e.x[k]);
        for (let s = 5; s < L; s += 10) {
          const x = e.x[k] + (e.x[k + 1] - e.x[k]) * s / L, y = e.y[k] + (e.y[k + 1] - e.y[k]) * s / L;
          let ok = false;
          n++;
          around(g, x, y, 35, (ei, kk) => {
            if (ok) return;
            const t = E[ei];
            if (proj(t, kk, x, y).d <= 35 && angDiff(Math.atan2(t.y[kk + 1] - t.y[kk], t.x[kk + 1] - t.x[kk]), a) < ANG) ok = true;
          });
          if (ok) hit++;
        }
      }
      if (n && hit >= n * 0.5) kept++; else { e.dead = true; gone++; }
    }
    log('осей без прохода: оставлено', kept, 'убрано', gone, '; сеть', liveKm(), 'км');
  }

  /* ---------- 3. слияние: одна улица — одна линия ---------- */
  const absorbedD = new Map(); /* имя улицы → расстояния поглощённых кусков до оси */
  let dualN = 0;
  const dualNames = new Set();
  {
    /* уплотнение: отрезки не длиннее STEP */
    for (const e of E) {
      if (e.dead || e.cls === 'C') continue;
      const x = [e.x[0]], y = [e.y[0]];
      for (let i = 1; i < e.x.length; i++) {
        const L = Math.hypot(e.x[i] - e.x[i - 1], e.y[i] - e.y[i - 1]), n = Math.ceil(L / STEP);
        for (let s = 1; s < n; s++) { x.push(e.x[i - 1] + (e.x[i] - e.x[i - 1]) * s / n); y.push(e.y[i - 1] + (e.y[i] - e.y[i - 1]) * s / n); }
        x.push(e.x[i]); y.push(e.y[i]);
      }
      e.x = x; e.y = y;
    }
    const order = E.map((e, i) => i).filter((i) => !E[i].dead && E[i].cls !== 'C')
      .sort((i, j) => RANK[E[i].cls] - RANK[E[j].cls] || E[j].len - E[i].len);
    const g = new Map();
    /* здания: кусок не поглощается линией, от которой его отделяет дом */
    const wg = new Map(), walls = !!(opt.walls && opt.walls.length);
    for (const w of opt.walls || []) for (let i = 1; i < w.length; i++) {
      const x1 = w[i - 1][1] * KX, y1 = w[i - 1][0] * KY, x2 = w[i][1] * KX, y2 = w[i][0] * KY;
      const n = Math.max(1, Math.ceil(Math.hypot(x2 - x1, y2 - y1) / (CELL / 2)));
      let last = NaN;
      for (let q = 0; q <= n; q++) {
        const key = ck(Math.floor((x1 + (x2 - x1) * q / n) / CELL), Math.floor((y1 + (y2 - y1) * q / n) / CELL));
        if (key === last) continue;
        last = key;
        const arr = wg.get(key);
        if (arr) arr.push(x1, y1, x2, y2); else wg.set(key, [x1, y1, x2, y2]);
      }
    }
    const cross = (ax, ay, bx, by, cx, cy, dx, dy) => {
      const d1 = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax), d2 = (bx - ax) * (dy - ay) - (by - ay) * (dx - ax);
      const d3 = (dx - cx) * (ay - cy) - (dy - cy) * (ax - cx), d4 = (dx - cx) * (by - cy) - (dy - cy) * (bx - cx);
      return d1 * d2 < 0 && d3 * d4 < 0;
    };
    function blocked(x1, y1, x2, y2) {
      if (!walls) return false;
      const n = Math.max(1, Math.ceil(Math.hypot(x2 - x1, y2 - y1) / (CELL / 2)));
      let last = NaN;
      for (let q = 0; q <= n; q++) {
        const key = ck(Math.floor((x1 + (x2 - x1) * q / n) / CELL), Math.floor((y1 + (y2 - y1) * q / n) / CELL));
        if (key === last) continue;
        last = key;
        const a = wg.get(key);
        if (a) for (let i = 0; i < a.length; i += 4) if (cross(x1, y1, x2, y2, a[i], a[i + 1], a[i + 2], a[i + 3])) return true;
      }
      return false;
    }
    /* бульвар — не проспект: между его проезжими частями идут аллеи */
    const alleys = gridOf((e) => e.cls === 'P');
    function alleyBetween(x, y, X, Y, a) {
      const mx = (x + X) / 2, my = (y + Y) / 2, r = Math.hypot(X - x, Y - y) / 2 - 5;
      if (r <= 0) return false;
      let hit = false;
      around(alleys, mx, my, r, (ti, kk) => {
        if (hit) return;
        const t = E[ti], q = proj(t, kk, mx, my);
        if (q.side && q.d <= r && angDiff(Math.atan2(t.y[kk + 1] - t.y[kk], t.x[kk + 1] - t.x[kk]), a) < ANG) hit = true;
      });
      return hit;
    }
    for (const ei of order) {
      const e = E[ei], n = e.x.length - 1;
      const tgt = new Int32Array(n).fill(-1), tk = new Int32Array(n), segL = new Float64Array(n);
      const maxR = 50;
      for (let k = 0; k < n; k++) {
        const x = (e.x[k] + e.x[k + 1]) / 2, y = (e.y[k] + e.y[k + 1]) / 2, a = Math.atan2(e.y[k + 1] - e.y[k], e.x[k + 1] - e.x[k]);
        segL[k] = Math.hypot(e.x[k + 1] - e.x[k], e.y[k + 1] - e.y[k]);
        let best = -1, bk = 0, bd = Infinity;
        around(g, x, y, maxR, (ti, kk) => {
          const t = E[ti], r = radius(e, t, walls);
          if (!r) return;
          const p = proj(t, kk, x, y);
          /* только сбоку: продолжение той же линии за её концом — не параллель */
          if (!p.side || p.d > r || p.d >= bd) return;
          if (angDiff(Math.atan2(t.y[kk + 1] - t.y[kk], t.x[kk + 1] - t.x[kk]), a) >= ANG) return;
          if (e.cls === 'A' && alleyBetween(x, y, p.x, p.y, a)) return;
          if (blocked(x, y, p.x, p.y)) return;
          best = ti; bk = kk; bd = p.d;
        });
        /* поглощение второй проезжей частью — поглощение осью, в которую влилась она сама */
        if (best >= 0 && E[best].tgt && E[best].tgt[bk] >= 0) { const t = E[best]; best = t.tgt[bk]; bk = t.tk[bk]; }
        tgt[k] = best; tk[k] = bk;
        if (best >= 0 && E[best].name) {
          const nm = E[best].name;
          (absorbedD.get(nm) || absorbedD.set(nm, []).get(nm)).push(proj(E[best], bk, x, y).d);
        }
      }
      /* сглаживание: короткие промежутки между поглощёнными кусками — тоже поглощены;
         короткое случайное сближение дорожки с линией — не поглощение (тротуар поглощается любым куском) */
      const runs = [];
      for (let k = 0; k < n;) {
        let j = k, L = 0;
        const on = tgt[k] >= 0;
        while (j < n && (tgt[j] >= 0) === on) { L += segL[j]; j++; }
        runs.push({ from: k, to: j, on, L });
        k = j;
      }
      for (let r = 1; r < runs.length - 1; r++) {
        const R = runs[r];
        if (!R.on && R.L < FILL && runs[r - 1].on && runs[r + 1].on) for (let k = R.from; k < R.to; k++) { tgt[k] = tgt[R.from - 1]; tk[k] = tk[R.from - 1]; }
      }
      if (e.cls !== 'W') for (const R of runs) if (R.on && R.L < MINRUN && !(R.from === 0 && R.to === n)) for (let k = R.from; k < R.to; k++) tgt[k] = -1;
      if (tgt.some((t) => t >= 0)) {
        e.tgt = tgt; e.tk = tk;
        /* раздельные проезжие части: у оси две стороны */
        if (e.cls === 'A') {
          dualN++; dualNames.add(e.name);
          for (let k = 0; k < n; k++) if (tgt[k] >= 0) {
            const t = E[tgt[k]];
            t.two = true; t.lanesTot = Math.max(t.lanesTot || 0, t.lanes + e.lanes); e.lanesTot = Math.max(e.lanesTot || 0, t.lanesTot);
          }
        }
      }
      /* в сетку — принятые куски и поглощённые куски проезжих частей (через них тротуары дальней стороны идут к оси) */
      for (let k = 0; k < n; k++) if (tgt[k] < 0 || e.cls === 'A') gridAdd(g, ei, k);
    }
    /* поглощённые куски убираются; рёбра режутся на непоглощённые отрезки.
       seg[ei][k] → [новое ребро, номер отрезка в нём] — куда указывают поглощения */
    const where = new Map();
    const snaps = []; /* [узел, ребро-поглотитель (старое), отрезок] */
    const nE = E.length;
    for (let ei = 0; ei < nE; ei++) {
      const e = E[ei];
      if (e.dead || !e.tgt) continue;
      e.dead = true;
      const n = e.x.length - 1, map = new Int32Array(2 * n).fill(-1);
      for (let k = 0; k < n;) {
        if (e.tgt[k] >= 0) { k++; continue; }
        let j = k;
        while (j < n && e.tgt[j] < 0) j++;
        const a = k === 0 ? e.a : newV(e.x[k], e.y[k]), b = j === n ? e.b : newV(e.x[j], e.y[j]);
        const ne = addE(a, b, e.x.slice(k, j + 1), e.y.slice(k, j + 1), e);
        for (let q = k; q < j; q++) { map[2 * q] = E.length - 1; map[2 * q + 1] = q - k; }
        if (k > 0) snaps.push([a, e.tgt[k - 1], e.tk[k - 1]]);
        if (j < n) snaps.push([b, e.tgt[j], e.tk[j]]);
        k = j;
      }
      where.set(ei, map);
    }
    /* концы поглощённых кусков в старых узлах: узел, у которого остались другие рёбра, связывается с поглотителем */
    const live = new Uint8Array(VX.length);
    for (const e of E) if (!e.dead) { live[e.a] = 1; live[e.b] = 1; }
    for (let ei = 0; ei < nE; ei++) {
      const e = E[ei];
      if (!e.tgt) continue;
      const n = e.x.length - 1;
      if (e.tgt[0] >= 0 && live[e.a]) snaps.push([e.a, e.tgt[0], e.tk[0]]);
      if (e.tgt[n - 1] >= 0 && live[e.b]) snaps.push([e.b, e.tgt[n - 1], e.tk[n - 1]]);
    }
    /* одна связь на узел — к ближайшей точке поглотителя */
    const best = new Map();
    for (const [v, ti, k0] of snaps) {
      let ri = ti, rk = k0;
      const m = where.get(ti);
      if (m) { ri = m[2 * k0]; rk = m[2 * k0 + 1]; }
      if (ri < 0) continue;
      const t = E[ri];
      let p = null;
      for (let k = Math.max(0, rk - 3); k <= Math.min(t.x.length - 2, rk + 3); k++) {
        const q = proj(t, k, VX[v], VY[v]);
        if (!p || q.d < p.d) p = { ei: ri, k, ...q };
      }
      if (!best.has(v) || p.d < best.get(v).d) best.set(v, p);
    }
    /* кусок внутри коридора улицы (поперечная дорожка между поглощёнными тротуаром и осью): оба конца привязываются
       к одной точке оси — это не дорога, а петля из двух связей */
    let inner = 0;
    for (const e of E) {
      if (e.dead || e.name || e.len >= DEAD || !best.has(e.a) || !best.has(e.b)) continue;
      const p = best.get(e.a), q = best.get(e.b);
      if (Math.hypot(p.x - q.x, p.y - q.y) < 3 * MERGE) { e.dead = true; inner++; }
    }
    const used = new Uint8Array(VX.length);
    for (const e of E) if (!e.dead) { used[e.a] = 1; used[e.b] = 1; }
    for (const v of [...best.keys()]) if (!used[v]) best.delete(v);
    const ins = new Map();
    for (const p of best.values()) (ins.get(p.ei) || ins.set(p.ei, []).get(p.ei)).push(p);
    /* связь — продолжение того, что осталось у узла: у переходов — тоже переход */
    const keptCls = new Map(), keptNames = new Map();
    for (const e of E) if (!e.dead) for (const v of [e.a, e.b]) if (best.has(v)) {
      const c = keptCls.get(v);
      keptCls.set(v, c === undefined || c === 'C' ? e.cls : c);
      if (e.name && e.cls === 'A') { const m = keptNames.get(v) || keptNames.set(v, new Map()).get(v); m.set(e.name, (m.get(e.name) || 0) + 1); }
    }
    splitAt(ins);
    let links = 0;
    for (const [v, p] of best) {
      if (p.v === v) continue;
      const l = linkE(v, p.v, { cls: keptCls.get(v) === 'C' ? 'C' : 'P' });
      /* связь, продолжающая названную улицу до оси (поперечная улица, остаток второй проезжей части), — часть
         этой улицы: линия доходит до перекрёстка и не рвётся */
      const tn = E[p.ei].name, names = keptNames.get(v);
      let nm = names && names.has(tn) ? tn : '';
      /* конец поперечной улицы (у узла одно её ребро) тянется до оси другой улицы */
      if (!nm && names && E[p.ei].cls === 'A') for (const [n, c] of names) if (c === 1) { nm = n; break; }
      if (nm) { l.name = nm; l.cls = 'A'; }
      links++;
    }
    log('слияние: поглощено рёбер', [...where.keys()].length, 'вторых проезжих частей', dualN, 'связей с осью', links, 'кусков внутри коридора', inner, '; сеть', liveKm(), 'км');
  }

  /* ---------- 3б. стягивание крошечных безымянных рёбер ---------- */
  const par = new Int32Array(VX.length).map((_, i) => i);
  const root = (v) => { while (par[v] !== v) { par[v] = par[par[v]]; v = par[v]; } return v; };
  {
    const onNamed = new Uint8Array(VX.length);
    for (const e of E) if (!e.dead && e.name) { onNamed[e.a] = 1; onNamed[e.b] = 1; }
    let n = 0;
    for (const e of E) {
      if (e.dead || e.name || e.len >= TINY) continue;
      const a = root(e.a), b = root(e.b);
      e.dead = true; n++;
      if (a === b) continue;
      /* остаётся узел на названной улице: её геометрия не меняется */
      if (onNamed[b] && !onNamed[a]) par[a] = b; else par[b] = a;
    }
    for (const e of E) {
      if (e.dead) continue;
      e.a = root(e.a); e.b = root(e.b);
      e.x[0] = VX[e.a]; e.y[0] = VY[e.a]; e.x[e.x.length - 1] = VX[e.b]; e.y[e.y.length - 1] = VY[e.b];
      e.len = lenOf(e.x, e.y);
    }
    log('стянуто коротких рёбер', n);
  }

  /* ---------- 4. упрощение: тупики, петли, карманы ---------- */
  const adj = Array.from({ length: VX.length }, () => []);
  E.forEach((e, ei) => { if (!e.dead) { adj[e.a].push(ei); adj[e.b].push(ei); } });
  const liveAt = (v) => adj[v].filter((ei) => !E[ei].dead);
  const degree = (v) => { let d = 0; for (const ei of adj[v]) if (!E[ei].dead) d += E[ei].a === E[ei].b ? 2 : 1; return d; };
  const other = (e, v) => (e.a === v ? e.b : e.a);

  /* цепочка тупика от листа v: до перекрёстка, до названной улицы или пока не станет длинной */
  function deadChain(v) {
    const chain = [];
    let len = 0, cur = v, conn = true, last = -1;
    for (;;) {
      const next = liveAt(cur).filter((ei) => ei !== last);
      if (next.length !== 1) break;
      const ei = next[0], e = E[ei];
      if (e.name) break;
      chain.push(ei); len += e.len; conn = conn && e.cls === 'C'; last = ei;
      const nx = other(e, cur);
      if (nx === v || chain.length > 1e4) break;
      cur = nx;
      if (degree(cur) !== 2 || (len >= DEAD && !conn)) break;
    }
    return { chain, len, conn, end: cur };
  }
  const gone = { dead: 0, loops: 0, access: 0, yards: 0, islands: 0 };
  const kill = (ei, why) => { const e = E[ei]; if (!e.dead) { e.dead = true; if (e.cls !== 'C') gone[why] += e.len; } };
  function pruneDeadEnds() {
    let n = 0;
    const stack = [];
    for (let v = 0; v < VX.length; v++) if (degree(v) === 1) stack.push(v);
    while (stack.length) {
      const v = stack.pop();
      if (degree(v) !== 1) continue;
      const c = deadChain(v);
      if (!c.chain.length || (c.len >= DEAD && !c.conn)) continue;
      for (const ei of c.chain) kill(ei, 'dead');
      n++;
      if (degree(c.end) === 1) stack.push(c.end);
    }
    return n;
  }
  /* кратчайший обход ребра e (без него) не длиннее limit */
  function detour(ei, limit) {
    const e = E[ei], dist = new Map([[e.a, 0]]), done = new Set();
    for (;;) {
      let u = -1, du = Infinity;
      for (const [w, d] of dist) if (!done.has(w) && d < du) { u = w; du = d; }
      if (u < 0 || du >= limit) return false;
      if (u === e.b) return true;
      done.add(u);
      for (const xi of adj[u]) {
        const x = E[xi];
        if (xi === ei || x.dead) continue;
        const w = other(x, u), d = du + x.len;
        if (d < limit && (!dist.has(w) || d < dist.get(w))) dist.set(w, d);
      }
    }
  }
  function pruneLoops() {
    let n = 0;
    const list = E.map((e, i) => i).filter((i) => !E[i].dead && !E[i].name && E[i].len < DEAD)
      .sort((i, j) => (E[j].cls === 'C') - (E[i].cls === 'C') || E[j].len - E[i].len);
    for (const ei of list) {
      const e = E[ei];
      if (e.dead) continue;
      if (e.a === e.b || detour(ei, DEAD - e.len)) { kill(ei, 'loops'); n++; }
    }
    return n;
  }
  /* Подводы и дворы. Подвод — безымянная цепочка короче DEAD от улицы с названием до развилки вне улицы (не в парке).
     Подводы убираются. Оторвавшийся от сети кусок без названных улиц короче YARD — двор: уходит целиком;
     к большим кускам (внутриквартальные сети микрорайонов) подводы возвращаются — это их связь с городом. */
  const green = (opt.green || []).map((r) => {
    const f = r.flatMap((p) => [p[1] * KX, p[0] * KY]);
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let i = 0; i < f.length; i += 2) { x0 = Math.min(x0, f[i]); x1 = Math.max(x1, f[i]); y0 = Math.min(y0, f[i + 1]); y1 = Math.max(y1, f[i + 1]); }
    return { f, b: [x0, y0, x1, y1] };
  });
  const inPark = (x, y) => green.some((g) => x >= g.b[0] && x <= g.b[2] && y >= g.b[1] && y <= g.b[3] && pointInRing(x, y, g.f));
  function pruneYards() {
    const street = new Uint8Array(VX.length);
    for (const e of E) if (!e.dead && e.name) { street[e.a] = 1; street[e.b] = 1; }
    const cut = new Set(), chains = [];
    for (let s0 = 0; s0 < VX.length; s0++) {
      if (!street[s0]) continue;
      for (const e0 of adj[s0]) {
        if (E[e0].dead || E[e0].name || cut.has(e0)) continue;
        const chain = [e0];
        let len = E[e0].len, cur = other(E[e0], s0), last = e0;
        while (len < DEAD && !street[cur] && degree(cur) === 2) {
          const nx = liveAt(cur).find((ei) => ei !== last);
          if (E[nx].name) break;
          chain.push(nx); len += E[nx].len; last = nx; cur = other(E[nx], cur);
        }
        if (len >= DEAD || street[cur] || cur === s0 || degree(cur) < 3 || inPark(VX[cur], VY[cur])) continue;
        for (const ei of chain) cut.add(ei);
        chains.push({ chain, end: cur });
      }
    }
    const p = new Int32Array(VX.length).map((_, i) => i);
    const f = (v) => { while (p[v] !== v) { p[v] = p[p[v]]; v = p[v]; } return v; };
    E.forEach((e, ei) => { if (!e.dead && !cut.has(ei)) { const a = f(e.a), b = f(e.b); if (a !== b) p[a] = b; } });
    const comp = new Map();
    E.forEach((e, ei) => {
      if (e.dead || cut.has(ei)) return;
      const r = f(e.a), c = comp.get(r) || comp.set(r, { len: 0, named: 0, edges: [] }).get(r);
      if (e.cls !== 'C') c.len += e.len;
      if (e.name) c.named++;
      c.edges.push(ei);
    });
    let main = null;
    for (const c of comp.values()) if (!main || c.len > main.len) main = c;
    let n = 0;
    const yard = new Set();
    for (const c of comp.values()) {
      if (c === main || c.named || c.len >= YARD) continue;
      for (const ei of c.edges) kill(ei, 'yards');
      yard.add(c); n++;
    }
    for (const { chain, end } of chains) {
      const c = comp.get(f(end));
      if (c === main || yard.has(c)) { for (const ei of chain) kill(ei, 'access'); n++; }
    }
    return n;
  }
  /* компоненты связности: [{len, named, edges}] по убыванию длины */
  function components() {
    const p = new Int32Array(VX.length).map((_, i) => i);
    const f = (v) => { while (p[v] !== v) { p[v] = p[p[v]]; v = p[v]; } return v; };
    for (const e of E) if (!e.dead) { const a = f(e.a), b = f(e.b); if (a !== b) p[a] = b; }
    const m = new Map();
    E.forEach((e, ei) => {
      if (e.dead) return;
      const r = f(e.a);
      const c = m.get(r) || m.set(r, { root: r, len: 0, named: 0, edges: [] }).get(r);
      if (e.cls !== 'C') c.len += e.len;
      if (e.name) c.named++;
      c.edges.push(ei);
    });
    return [...m.values()].sort((a, b) => b.len - a.len);
  }

  const tally = { joined: 0, dead: 0, loops: 0, yards: 0, islands: 0, islandKm: 0 };
  for (let round = 0; round < 20; round++) {
    const d = pruneDeadEnds(), l = pruneLoops();
    const p = pruneYards();
    tally.dead += d; tally.loops += l; tally.yards += p;
    if (!d && !l && !p) break;
  }
  /* ---------- 5. связность ----------
     Отдельный кусок присоединяется к основной сети связью (как переход: соединяет, в покрытие не входит), если до неё
     не больше JOIN м; кусок из одних переходов убирается; не присоединённый без названных улиц короче ISLAND — тоже. */
  {
    const comps = components(), main = comps[0];
    const inMain = new Set(main ? main.edges.map((ei) => E[ei]) : []);
    const g = gridOf((e) => inMain.has(e) && e.cls !== 'C');
    const ins = new Map(), joins = [];
    for (const c of comps.slice(1)) {
      if (!c.len) { for (const ei of c.edges) E[ei].dead = true; continue; }
      let best = null;
      for (const ei of c.edges) for (const v of [E[ei].a, E[ei].b]) {
        around(g, VX[v], VY[v], JOIN, (ti, k) => {
          const p = proj(E[ti], k, VX[v], VY[v]);
          if (p.d <= JOIN && (!best || p.d < best.d)) best = { ei: ti, k, from: v, ...p };
        });
      }
      if (best) { (ins.get(best.ei) || ins.set(best.ei, []).get(best.ei)).push(best); joins.push(best); tally.joined++; continue; }
      if (c.named || c.len >= ISLAND) continue;
      for (const ei of c.edges) kill(ei, 'islands');
      tally.islands++; tally.islandKm += c.len;
    }
    splitAt(ins);
    for (const p of joins) linkE(p.from, p.v, { cls: 'C' });
    for (let v = 0; v < adj.length; v++) adj[v].length = 0;
    for (let v = adj.length; v < VX.length; v++) adj.push([]);
    E.forEach((e, ei) => { if (!e.dead) { adj[e.a].push(ei); adj[e.b].push(ei); } });
    pruneDeadEnds();
  }
  log('сеть', liveKm(), 'км; упрощение: тупиков', tally.dead, 'петель', tally.loops, 'подводов и дворов', tally.yards, 'присоединено кусков', tally.joined, 'убрано отдельных кусков', tally.islands, '(', Math.round(tally.islandKm / 1000), 'км ); убрано км:',
    Object.fromEntries(Object.entries(gone).map(([k, v]) => [k, Math.round(v / 1000)])));

  /* ---------- допуски улиц и выдача ---------- */
  /* допуск улицы: 90-й перцентиль расстояния поглощённых кусков до оси + 10 м, от 20 м; у узкой улицы (до двух полос)
     не больше 30 м — иначе засчитается бег по соседнему переулку, у широкой — до 70 м */
  const wide = new Set();
  for (const e of E) if (!e.dead && e.name && (e.two || (e.lanesTot || e.lanes) > 2)) wide.add(e.name);
  const tol = new Map();
  for (const [nm, ds] of absorbedD) {
    ds.sort((a, b) => a - b);
    tol.set(nm, Math.min(wide.has(nm) ? 70 : 30, Math.max(20, Math.round(ds[Math.floor(ds.length * 0.9)] + 10))));
  }
  const edges = [];
  for (const e of E) {
    if (e.dead || (e.cls === 'C' && !opt.conn)) continue;
    edges.push({ name: e.name, two: e.two, cls: e.link && e.cls !== 'C' ? 'L' : e.cls, pts: e.x.map((x, i) => [e.y[i] / KY, x / KX]) });
  }
  const metrics = measure();
  return { edges, tol, metrics };

  /* ---------- проверки качества ---------- */
  function measure() {
    const comps = components();
    const m = { components: comps.length, mainShare: 0, otherKm: 0, otherNamed: 0, deadShort: 0, deadShortNamed: 0, loopsShort: 0,
      lostNamed: [], lostCarrier: [], shortened: [], parallel2: 0, parallel3: 0, km: {}, twoKm: 0, connKm: 0 };
    const total = comps.reduce((s, c) => s + c.len, 0);
    m.mainShare = total ? comps[0].len / total : 0;
    m.others = [];
    for (const c of comps.slice(1)) {
      m.otherKm += c.len / 1000;
      if (c.named) m.otherNamed++;
      const e0 = E[c.edges[0]], names = [...new Set(c.edges.map((ei) => E[ei].name).filter(Boolean))];
      m.others.push(Math.round(c.len) + ' м ' + (e0.y[0] / KY).toFixed(5) + ',' + (e0.x[0] / KX).toFixed(5) + (names.length ? ' ' + names.slice(0, 3).join(', ') : ''));
    }
    /* короткие тупики: без названных — должно быть 0; с названными — разрешены */
    for (let v = 0; v < VX.length; v++) {
      if (degree(v) !== 1) continue;
      const c = deadChain(v);
      if (!c.chain.length) { m.deadShortNamed++; continue; }
      if (c.len < DEAD) m.deadShort++;
    }
    for (let ei = 0; ei < E.length; ei++) {
      const e = E[ei];
      if (e.dead || e.name || e.len >= DEAD) continue;
      if (e.a === e.b || detour(ei, DEAD - e.len)) m.loopsShort++;
    }
    const out = new Map();
    for (const e of E) {
      if (e.dead) continue;
      if (e.cls === 'C') { m.connKm += e.len / 1000; continue; }
      const k = e.link ? 'L' : e.cls;
      m.km[k] = (m.km[k] || 0) + e.len / 1000;
      if (e.two) m.twoKm += e.len / 1000;
      if (e.name) out.set(e.name, (out.get(e.name) || 0) + e.len);
    }
    for (const [nm, L] of input.named) {
      const o = out.get(nm) || 0;
      /* ось без права прохода и без тротуаров — не улица для пробежки (foot=no): не потеря */
      if (!o) (input.walk.has(nm) ? m.lostNamed : m.lostCarrier).push(nm);
      else if (o < L * 0.5 && L - o > 100 && !dualNames.has(nm)) m.shortened.push(nm + ' ' + Math.round(L) + '→' + Math.round(o) + ' м');
    }
    for (const k of Object.keys(m.km)) m.km[k] = Math.round(m.km[k]);
    m.twoKm = Math.round(m.twoKm); m.connKm = Math.round(m.connKm); m.otherKm = Math.round(m.otherKm);
    /* параллельные линии у названных улиц: пробы через 20 м; «две линии» — параллельная линия ближе 20 м с одной стороны,
       «три линии» — с обеих (ось и два тротуара) */
    const g = gridOf((e) => e.cls !== 'C');
    let probes = 0, two = 0, three = 0;
    E.forEach((e, ei) => {
      if (e.dead || e.cls !== 'A' || e.link) return; /* основа проб — сами улицы, не связи с осью */
      let next = 10, at = 0;
      for (let k = 0; k < e.x.length - 1; k++) {
        const dx = e.x[k + 1] - e.x[k], dy = e.y[k + 1] - e.y[k], L = Math.hypot(dx, dy), a = Math.atan2(dy, dx);
        for (; next < at + L; next += 20) {
          const x = e.x[k] + dx * (next - at) / L, y = e.y[k] + dy * (next - at) / L;
          let left = false, right = false;
          around(g, x, y, 20, (ti, kk) => {
            const t = E[ti];
            if (ti === ei || t.a === e.a || t.b === e.b || t.a === e.b || t.b === e.a) return;
            const q = proj(t, kk, x, y);
            if (!q.side || q.d <= 2 || q.d > 20 || angDiff(Math.atan2(t.y[kk + 1] - t.y[kk], t.x[kk + 1] - t.x[kk]), a) >= ANG) return;
            if (dx * (q.y - y) - dy * (q.x - x) > 0) left = true; else right = true;
          });
          probes++;
          if (left || right) two++;
          if (left && right) three++;
        }
        at += L;
      }
    });
    m.parallel2 = probes ? two / probes : 0;
    m.parallel3 = probes ? three / probes : 0;
    return m;
  }
}
