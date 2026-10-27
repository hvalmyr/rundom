/* Закрытия, запретные зоны, «одна улица» для правила без повторов и окрестность дома. */
import { px, py, pointInRing } from './geo.js';
import { computeComponents, nearestNode } from './graph.js';

/* ---------- зоны ---------- */
/* zone: {shape:'poly', ring:[[lat,lon],...]} или {shape:'circle', c:[lat,lon], r: метры} */
function zoneTest(zone) {
  if (zone.shape === 'circle') {
    var cx = px(zone.c[1]), cy = py(zone.c[0]), r2 = zone.r * zone.r;
    return function (x, y) { return (x - cx) * (x - cx) + (y - cy) * (y - cy) <= r2; };
  }
  var flat = [], minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
  zone.ring.forEach(function (p) {
    var x = px(p[1]), y = py(p[0]);
    flat.push(x, y);
    if (x < minx) minx = x; if (x > maxx) maxx = x; if (y < miny) miny = y; if (y > maxy) maxy = y;
  });
  return function (x, y) { return x >= minx && x <= maxx && y >= miny && y <= maxy && pointInRing(x, y, flat); };
}

/* Двоичная куча пар [ключ, узел] для коротких поисков Дейкстры. */
function heap() {
  var a = [];
  return {
    get size() { return a.length; },
    push: function (k, v) {
      var i = a.length; a.push([k, v]);
      while (i > 0) { var p = (i - 1) >> 1; if (a[p][0] <= a[i][0]) break; var t = a[p]; a[p] = a[i]; a[i] = t; i = p; }
    },
    pop: function () {
      var top = a[0], last = a.pop();
      if (a.length) {
        a[0] = last;
        for (var i = 0; ;) {
          var l = 2 * i + 1, r = l + 1, m = i;
          if (l < a.length && a[l][0] < a[m][0]) m = l;
          if (r < a.length && a[r][0] < a[m][0]) m = r;
          if (m === i) break;
          var t = a[m]; a[m] = a[i]; a[i] = t; i = m;
        }
      }
      return top;
    }
  };
}

/* Узел, к которому относится отметка: ближайший в радиусе r. */
function snap(g, p, r) {
  var s = nearestNode(g, p[0], p[1], r);
  return s ? s.node : -1;
}

/* Кратчайший по длине путь между узлами без учёта закрытий: рёбра закрытого отрезка. */
function segmentEdges(g, a, b) {
  if (a === b) return [];
  var dist = new Map(), prev = new Map(), h = heap();
  dist.set(a, 0); h.push(0, a);
  while (h.size) {
    var top = h.pop(), d = top[0], v = top[1];
    if (d > dist.get(v)) continue;
    if (v === b) break;
    if (d > 3000) return [];
    for (var k = g.adjStart[v]; k < g.adjStart[v + 1]; k++) {
      var e = g.adjEdge[k], w = g.eF[e] === v ? g.eT[e] : g.eF[e];
      var nd = d + g.eLen[e];
      if (!dist.has(w) || nd < dist.get(w)) { dist.set(w, nd); prev.set(w, e); h.push(nd, w); }
    }
  }
  if (!prev.has(b)) return [];
  var out = [], v2 = b;
  while (v2 !== a) { var pe = prev.get(v2); out.push(pe); v2 = g.eF[pe] === v2 ? g.eT[pe] : g.eF[pe]; }
  return out;
}

/* Выключает рёбра под закрытиями и в зонах, пересчитывает компоненты связности.
   spec: {gates:[[lat,lon]], segments:[{a:[lat,lon], b:[lat,lon]}], zones:[zone]}. Возвращает число выключенных рёбер. */
function applyBlocks(g, spec) {
  spec = spec || {};
  var bl = new Uint8Array(g.E), count = 0;
  function block(e) { if (!bl[e]) { bl[e] = 1; count++; } }
  (spec.gates || []).forEach(function (p) {
    var v = snap(g, p, 25);
    if (v < 0) return;
    for (var k = g.adjStart[v]; k < g.adjStart[v + 1]; k++) block(g.adjEdge[k]);
  });
  (spec.segments || []).forEach(function (s) {
    var a = snap(g, s.a, 30), b = snap(g, s.b, 30);
    if (a < 0 || b < 0) return;
    segmentEdges(g, a, b).forEach(block);
  });
  var tests = (spec.zones || []).map(zoneTest);
  if (tests.length) {
    for (var e = 0; e < g.E; e++) {
      var ax = g.X[g.eF[e]], ay = g.Y[g.eF[e]], bx = g.X[g.eT[e]], by = g.Y[g.eT[e]];
      for (var i = 0; i < tests.length; i++) {
        if (tests[i](ax, ay) || tests[i](bx, by) || tests[i]((ax + bx) / 2, (ay + by) / 2)) { block(e); break; }
      }
    }
  }
  g.eBlock = count ? bl : null;
  computeComponents(g);
  return count;
}

/* ---------- «одна улица» ---------- */
/* Для каждого ребра — параллельные рёбра рядом: другая сторона улицы, тротуар.
   Соседние звенья той же линии сюда не попадают: они не перекрываются вдоль оси. */
function ensureTwins(g) {
  if (g.twinStart) return;
  var cell = 50, near = 22, map = new Map();
  for (var e = 0; e < g.E; e++) {
    var ax = g.X[g.eF[e]], ay = g.Y[g.eF[e]], bx = g.X[g.eT[e]], by = g.Y[g.eT[e]];
    var x0 = Math.floor((Math.min(ax, bx) - near) / cell), x1 = Math.floor((Math.max(ax, bx) + near) / cell);
    var y0 = Math.floor((Math.min(ay, by) - near) / cell), y1 = Math.floor((Math.max(ay, by) + near) / cell);
    if ((x1 - x0 + 1) * (y1 - y0 + 1) > 64) continue;
    for (var i = x0; i <= x1; i++) for (var j = y0; j <= y1; j++) {
      var key = i * 100003 + j, arr = map.get(key);
      if (arr) arr.push(e); else map.set(key, [e]);
    }
  }
  var pairs = [];
  var cos25 = Math.cos(25 * Math.PI / 180);
  map.forEach(function (arr) {
    for (var p = 0; p < arr.length; p++) for (var q = p + 1; q < arr.length; q++) {
      var e1 = arr[p], e2 = arr[q];
      if (twinOf(e1, e2)) pairs.push(e1 < e2 ? e1 * g.E + e2 : e2 * g.E + e1);
    }
  });
  function twinOf(e1, e2) {
    var a1 = g.eF[e1], b1 = g.eT[e1], a2 = g.eF[e2], b2 = g.eT[e2];
    if (a1 === a2 || a1 === b2 || b1 === a2 || b1 === b2) return false;
    var dx = g.X[b1] - g.X[a1], dy = g.Y[b1] - g.Y[a1], l1 = Math.sqrt(dx * dx + dy * dy);
    var ex = g.X[b2] - g.X[a2], ey = g.Y[b2] - g.Y[a2], l2 = Math.sqrt(ex * ex + ey * ey);
    if (l1 < 4 || l2 < 4) return false;
    if (Math.abs(dx * ex + dy * ey) / (l1 * l2) < cos25) return false;
    var ux = dx / l1, uy = dy / l1;
    var mx = (g.X[a2] + g.X[b2]) / 2 - g.X[a1], my = (g.Y[a2] + g.Y[b2]) / 2 - g.Y[a1];
    if (Math.abs(mx * uy - my * ux) > near) return false;
    var t1 = (g.X[a2] - g.X[a1]) * ux + (g.Y[a2] - g.Y[a1]) * uy;
    var t2 = (g.X[b2] - g.X[a1]) * ux + (g.Y[b2] - g.Y[a1]) * uy;
    var lo = Math.max(0, Math.min(t1, t2)), hi = Math.min(l1, Math.max(t1, t2));
    return hi - lo >= 0.4 * Math.min(l1, l2);
  }
  pairs.sort(function (a, b) { return a - b; });
  var deg = new Int32Array(g.E + 1), uniq = [];
  for (var k = 0; k < pairs.length; k++) {
    if (k && pairs[k] === pairs[k - 1]) continue;
    var u = Math.floor(pairs[k] / g.E), w = pairs[k] - u * g.E;
    uniq.push(u, w); deg[u]++; deg[w]++;
  }
  g.twinStart = new Int32Array(g.E + 1);
  for (var e3 = 0; e3 < g.E; e3++) g.twinStart[e3 + 1] = g.twinStart[e3] + deg[e3];
  g.twinEdge = new Int32Array(g.twinStart[g.E]);
  var fill = g.twinStart.slice(0, g.E);
  for (var m = 0; m < uniq.length; m += 2) {
    g.twinEdge[fill[uniq[m]]++] = uniq[m + 1];
    g.twinEdge[fill[uniq[m + 1]]++] = uniq[m];
  }
}

/* ---------- окрестность выхода ---------- */
/* Узлы, до которых от src не дальше maxLen метров по открытым улицам. */
function reachWithin(g, src, maxLen) {
  var dist = new Map(), prev = new Map(), h = heap(), bl = g.eBlock;
  dist.set(src, 0); prev.set(src, -1); h.push(0, src);
  var out = [];
  while (h.size) {
    var top = h.pop(), d = top[0], v = top[1];
    if (d > dist.get(v)) continue;
    out.push(v);
    for (var k = g.adjStart[v]; k < g.adjStart[v + 1]; k++) {
      var e = g.adjEdge[k];
      if (bl && bl[e]) continue;
      var w = g.eF[e] === v ? g.eT[e] : g.eF[e];
      var nd = d + g.eLen[e];
      if (nd <= maxLen && (!dist.has(w) || nd < dist.get(w))) { dist.set(w, nd); prev.set(w, e); h.push(nd, w); }
    }
  }
  return {
    nodes: out, dist: dist,
    /* путь от src до v: узлы и рёбра */
    path: function (v) {
      var nodes = [v], edges = [], x = v;
      while (prev.get(x) >= 0) { var pe = prev.get(x); edges.push(pe); x = g.eF[pe] === x ? g.eT[pe] : g.eF[pe]; nodes.push(x); }
      return { nodes: nodes.reverse(), edges: edges.reverse() };
    }
  };
}

export { zoneTest, applyBlocks, ensureTwins, reachWithin };
