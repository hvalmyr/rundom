/* Стоимость рёбер и поиск пути A*. */
import { CLS } from './osm.js';

var CLASS_PEN = function (cls, mainAvoid) {
  switch (cls) {
    case CLS.path: return 0;
    case CLS.street: return 0.05;
    case CLS.road: return 0.15 + 0.6 * mainAvoid;
    case CLS.main: return 0.4 + 2.6 * mainAvoid;
    default: return 0.5;
  }
};

/* Стоимость ребра ≥ его длины (иначе A* с эвклидовой эвристикой был бы неверным). */
function buildCost(g, prefs) {
  prefs = prefs || {};
  var aw = prefs.appeal === undefined ? 0.35 : prefs.appeal;
  var nov = prefs.novelty || 0;
  var ma = prefs.mainAvoid === undefined ? 0.6 : prefs.mainAvoid;
  var cost = new Float64Array(g.E);
  for (var e = 0; e < g.E; e++) {
    var m = 1 + g.ePen[e] + CLASS_PEN(g.eCls[e], ma) + (1 - g.eAp[e]) * aw;
    if (nov > 0 && g.eExpl[e]) m += 0.9 * nov;
    else if (nov < 0 && !g.eExpl[e]) m += 0.9 * (-nov);
    cost[e] = g.eLen[e] * m + g.eFix[e];
  }
  return cost;
}

/* ---------- A* ---------- */
function makeRouter(g) {
  var n = g.n;
  var gs = new Float64Array(n), stamp = new Uint32Array(n), done = new Uint32Array(n);
  var prevE = new Int32Array(n);
  var cap = g.adjEdge.length + 16;
  var hN = new Int32Array(cap), hK = new Float64Array(cap), hs = 0;
  var cur = 0;

  function push(node, key) {
    var i = hs++;
    while (i > 0) {
      var p = (i - 1) >> 1;
      if (hK[p] <= key) break;
      hN[i] = hN[p]; hK[i] = hK[p]; i = p;
    }
    hN[i] = node; hK[i] = key;
  }
  function pop() {
    var top = hN[0];
    hs--;
    if (hs > 0) {
      var node = hN[hs], key = hK[hs], i = 0;
      for (;;) {
        var l = 2 * i + 1;
        if (l >= hs) break;
        var r = l + 1;
        var c = (r < hs && hK[r] < hK[l]) ? r : l;
        if (hK[c] >= key) break;
        hN[i] = hN[c]; hK[i] = hK[c]; i = c;
      }
      hN[i] = node; hK[i] = key;
    }
    return top;
  }

  function route(cost, src, dst, used, usedMul) {
    if (src === dst) return { nodes: [src], edges: [], cost: 0 };
    cur++;
    hs = 0;
    var X = g.X, Y = g.Y, dx0 = X[dst], dy0 = Y[dst], bl = g.eBlock;
    gs[src] = 0; stamp[src] = cur; prevE[src] = -1;
    var h0 = Math.sqrt((X[src] - dx0) * (X[src] - dx0) + (Y[src] - dy0) * (Y[src] - dy0)) * 0.995;
    push(src, h0);
    var found = false;
    while (hs > 0) {
      var v = pop();
      if (done[v] === cur) continue;
      done[v] = cur;
      if (v === dst) { found = true; break; }
      var gv = gs[v];
      for (var k = g.adjStart[v]; k < g.adjStart[v + 1]; k++) {
        var e = g.adjEdge[k];
        if (bl && bl[e]) continue;
        var w = g.eF[e] === v ? g.eT[e] : g.eF[e];
        if (done[w] === cur) continue;
        var c = cost[e];
        if (used && used[e]) c *= usedMul;
        var ng = gv + c;
        if (stamp[w] !== cur || ng < gs[w]) {
          stamp[w] = cur; gs[w] = ng; prevE[w] = e;
          var ddx = X[w] - dx0, ddy = Y[w] - dy0;
          push(w, ng + Math.sqrt(ddx * ddx + ddy * ddy) * 0.995);
        }
      }
    }
    if (!found) return null;
    var edges = [], nodes = [dst], v2 = dst;
    while (v2 !== src) {
      var pe = prevE[v2];
      edges.push(pe);
      v2 = g.eF[pe] === v2 ? g.eT[pe] : g.eF[pe];
      nodes.push(v2);
    }
    edges.reverse(); nodes.reverse();
    return { nodes: nodes, edges: edges, cost: gs[dst] };
  }
  return { route: route };
}

/* Кратчайший путь по длине (для ручной разметки изученных улиц). */
function shortestPath(g, router, a, b) {
  var cost = new Float64Array(g.E);
  for (var e = 0; e < g.E; e++) cost[e] = g.eLen[e] + g.eFix[e];
  var r = router.route(cost, a, b, null, 1);
  if (!r) return null;
  return r.nodes.map(function (n) { return [g.lat[n], g.lon[n]]; });
}

export { buildCost, makeRouter, shortestPath };
