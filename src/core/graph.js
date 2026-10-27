/* Граф улиц: сборка, поиск ближайшего узла, парки, места и пройденные улицы. */
import { hav, px, py, pointInRing, resample } from './geo.js';
import { CLS, isBlockingBarrier, classifyWay } from './osm.js';

/* ---------- граф ---------- */
function buildGraph(parsed, opts) {
  opts = opts || {};
  var blocked = new Set(), closedGates = [];
  var open = opts.openGates || [];
  function reopened(b) {
    for (var i = 0; i < open.length; i++) if (hav(b.lat, b.lon, open[i].lat, open[i].lon) < 3) return true;
    return false;
  }
  parsed.barriers.forEach(function (b) {
    if (isBlockingBarrier(b.tags, opts.strictGates) && !reopened(b)) {
      blocked.add(b.id);
      closedGates.push({ lat: b.lat, lon: b.lon, barrier: b.tags.barrier, access: b.tags.access || '', name: b.tags.name || '' });
    }
  });

  var idx = new Map(), latA = [], lonA = [];
  var eF = [], eT = [], eL = [], eP = [], eC = [], eAp = [], eFix = [], eName = [];
  var names = [], nameIdx = new Map();
  var closedWays = [];

  function getIdx(id, nd) {
    var k = idx.get(id);
    if (k === undefined) { k = latA.length; idx.set(id, k); latA.push(nd.lat); lonA.push(nd.lon); }
    return k;
  }

  for (var wi = 0; wi < parsed.ways.length; wi++) {
    var w = parsed.ways[wi];
    var c = classifyWay(w.tags, opts);
    if (!c) continue;
    if (!c.ok) {
      if (c.closed && closedWays.length < 4000) {
        var line = [];
        for (var q = 0; q < w.nodes.length; q++) {
          var nq = parsed.nodes.get(w.nodes[q]);
          if (nq) line.push([nq.lat, nq.lon]);
        }
        if (line.length > 1) closedWays.push(line);
      }
      continue;
    }
    var nm = w.tags.name || '';
    var ni = -1;
    if (nm) {
      ni = nameIdx.get(nm);
      if (ni === undefined) { ni = names.length; names.push(nm); nameIdx.set(nm, ni); }
    }
    var ns = w.nodes;
    for (var i = 0; i < ns.length - 1; i++) {
      var a = ns[i], b = ns[i + 1];
      var na = parsed.nodes.get(a), nb = parsed.nodes.get(b);
      if (!na || !nb) continue;
      if (blocked.has(a) || blocked.has(b)) continue;
      var len = hav(na.lat, na.lon, nb.lat, nb.lon);
      if (len < 0.05) continue;
      var ia = getIdx(a, na), ib = getIdx(b, nb);
      if (ia === ib) continue;
      eF.push(ia); eT.push(ib); eL.push(len); eP.push(c.pen); eC.push(c.cls);
      eAp.push(c.appeal); eFix.push(c.fix); eName.push(ni);
    }
  }

  var n = latA.length, E = eF.length;
  var g = {
    n: n, E: E,
    lat: Float64Array.from(latA), lon: Float64Array.from(lonA),
    X: new Float64Array(n), Y: new Float64Array(n),
    eF: Int32Array.from(eF), eT: Int32Array.from(eT),
    eLen: Float64Array.from(eL), ePen: Float32Array.from(eP), eCls: Uint8Array.from(eC),
    eAp: Float32Array.from(eAp), eFix: Float32Array.from(eFix), eName: Int32Array.from(eName),
    eExpl: new Uint8Array(E), ePark: new Uint8Array(E),
    names: names, closedGates: closedGates, closedWays: closedWays,
    pois: [], poiGrid: null
  };
  for (var v = 0; v < n; v++) { g.X[v] = px(g.lon[v]); g.Y[v] = py(g.lat[v]); }

  /* CSR-списки смежности */
  var deg = new Int32Array(n + 1);
  for (var e = 0; e < E; e++) { deg[g.eF[e]]++; deg[g.eT[e]]++; }
  g.adjStart = new Int32Array(n + 1);
  for (var u = 0; u < n; u++) g.adjStart[u + 1] = g.adjStart[u] + deg[u];
  g.adjEdge = new Int32Array(2 * E);
  var fill = g.adjStart.slice(0, n);
  for (var e2 = 0; e2 < E; e2++) {
    g.adjEdge[fill[g.eF[e2]]++] = e2;
    g.adjEdge[fill[g.eT[e2]]++] = e2;
  }
  g.deg = new Int32Array(n);
  for (var u2 = 0; u2 < n; u2++) g.deg[u2] = g.adjStart[u2 + 1] - g.adjStart[u2];

  computeComponents(g);
  return g;
}

/* Компоненты связности; рёбра из g.eBlock (закрытия, зоны) не соединяют узлы. */
function computeComponents(g) {
  var n = g.n, bl = g.eBlock;
  g.comp = new Int32Array(n).fill(-1);
  g.compSize = [];
  var stack = new Int32Array(n);
  for (var s = 0; s < n; s++) {
    if (g.comp[s] !== -1) continue;
    var cid = g.compSize.length, sp = 0, cnt = 0;
    stack[sp++] = s; g.comp[s] = cid;
    while (sp) {
      var x = stack[--sp]; cnt++;
      for (var k = g.adjStart[x]; k < g.adjStart[x + 1]; k++) {
        var ed = g.adjEdge[k];
        if (bl && bl[ed]) continue;
        var y = g.eF[ed] === x ? g.eT[ed] : g.eF[ed];
        if (g.comp[y] === -1) { g.comp[y] = cid; stack[sp++] = y; }
      }
    }
    g.compSize.push(cnt);
  }
}

function other(g, e, v) { return g.eF[e] === v ? g.eT[e] : g.eF[e]; }

/* сетка узлов для поиска ближайшего */
function ensureGrid(g) {
  if (g.grid) return g.grid;
  var cell = 120, m = new Map();
  for (var v = 0; v < g.n; v++) {
    var key = Math.floor(g.X[v] / cell) * 100003 + Math.floor(g.Y[v] / cell);
    var arr = m.get(key);
    if (arr) arr.push(v); else m.set(key, [v]);
  }
  g.grid = { cell: cell, map: m };
  return g.grid;
}

function nearestNode(g, lat, lon, maxM, minComp) {
  var gr = ensureGrid(g);
  var x = px(lon), y = py(lat);
  var cx = Math.floor(x / gr.cell), cy = Math.floor(y / gr.cell);
  var rings = Math.ceil(maxM / gr.cell) + 1;
  var best = -1, bd = Infinity;
  for (var r = 0; r <= rings; r++) {
    for (var i = -r; i <= r; i++) {
      for (var j = -r; j <= r; j++) {
        if (Math.max(Math.abs(i), Math.abs(j)) !== r) continue;
        var arr = gr.map.get((cx + i) * 100003 + (cy + j));
        if (!arr) continue;
        for (var q = 0; q < arr.length; q++) {
          var v = arr[q];
          if (minComp && g.compSize[g.comp[v]] < minComp) continue;
          var dx = g.X[v] - x, dy = g.Y[v] - y, d = Math.sqrt(dx * dx + dy * dy);
          if (d < bd) { bd = d; best = v; }
        }
      }
    }
    if (best >= 0 && bd <= r * gr.cell) break;
  }
  if (best < 0 || bd > maxM) return null;
  return { node: best, dist: bd };
}

/* Парки и интересные места: влияют на «привлекательность» рёбер. */
function applyContext(g, ctx) {
  g.parks = (ctx && ctx.parks) || [];
  g.pois = (ctx && ctx.pois) || [];
  g.ePark.fill(0);
  var E = g.E, i;
  /* сетка парков по их рамкам: ребро проверяется только против парков своей клетки */
  var PC = 400, pgrid = new Map();
  g.parks.forEach(function (p) {
    for (var cx = Math.floor(p.minx / PC); cx <= Math.floor(p.maxx / PC); cx++) {
      for (var cy = Math.floor(p.miny / PC); cy <= Math.floor(p.maxy / PC); cy++) {
        var k = cx * 100003 + cy, arr = pgrid.get(k);
        if (arr) arr.push(p); else pgrid.set(k, [p]);
      }
    }
  });
  for (var e = 0; e < E; e++) {
    var mx = (g.X[g.eF[e]] + g.X[g.eT[e]]) / 2, my = (g.Y[g.eF[e]] + g.Y[g.eT[e]]) / 2;
    var cand = pgrid.get(Math.floor(mx / PC) * 100003 + Math.floor(my / PC));
    if (!cand) continue;
    for (i = 0; i < cand.length; i++) {
      var p = cand[i];
      if (mx < p.minx || mx > p.maxx || my < p.miny || my > p.maxy) continue;
      if (pointInRing(mx, my, p.xy)) { g.ePark[e] = 1; break; }
    }
  }
  buildPoiGrid(g);
  var cell = g.poiGrid.cell;
  for (var e3 = 0; e3 < E; e3++) {
    if (g.ePark[e3]) { if (g.eAp[e3] < 1) g.eAp[e3] = 1; continue; }
    var x = (g.X[g.eF[e3]] + g.X[g.eT[e3]]) / 2, y = (g.Y[g.eF[e3]] + g.Y[g.eT[e3]]) / 2;
    if (poiNear(g, x, y, 60) >= 0 && g.eAp[e3] < 0.8 && g.eCls[e3] !== CLS.main) g.eAp[e3] = 0.8;
  }
}

function buildPoiGrid(g) {
  var cell = 100, m = new Map();
  g.pois.forEach(function (p, i) {
    p.x = px(p.lon); p.y = py(p.lat);
    var key = Math.floor(p.x / cell) * 100003 + Math.floor(p.y / cell);
    var arr = m.get(key);
    if (arr) arr.push(i); else m.set(key, [i]);
  });
  g.poiGrid = { cell: cell, map: m };
}

/* индекс ближайшего места в радиусе r метров, иначе -1 */
function poiNear(g, x, y, r) {
  if (!g.poiGrid) return -1;
  var cell = g.poiGrid.cell;
  var cx = Math.floor(x / cell), cy = Math.floor(y / cell);
  var best = -1, bd = r;
  for (var i = -1; i <= 1; i++) for (var j = -1; j <= 1; j++) {
    var arr = g.poiGrid.map.get((cx + i) * 100003 + (cy + j));
    if (!arr) continue;
    for (var q = 0; q < arr.length; q++) {
      var p = g.pois[arr[q]];
      var d = Math.sqrt((p.x - x) * (p.x - x) + (p.y - y) * (p.y - y));
      if (d <= bd) { bd = d; best = arr[q]; }
    }
  }
  return best;
}

/* Изученные улицы: ребро считается пройденным, если рядом лежит след. */
function applyExplored(g, lines) {
  g.eExpl.fill(0);
  if (!lines || !lines.length) return 0;
  var cell = 25, tol = 22, map = new Map();
  var total = 0;
  lines.forEach(function (line) {
    var pts = resample(line, 12);
    for (var i = 0; i < pts.length; i++) {
      var x = px(pts[i][1]), y = py(pts[i][0]);
      var key = Math.floor(x / cell) * 100003 + Math.floor(y / cell);
      var arr = map.get(key);
      if (arr) arr.push(x, y); else map.set(key, [x, y]);
      total++;
    }
  });
  function near(x, y) {
    var cx = Math.floor(x / cell), cy = Math.floor(y / cell);
    for (var i = -1; i <= 1; i++) for (var j = -1; j <= 1; j++) {
      var arr = map.get((cx + i) * 100003 + (cy + j));
      if (!arr) continue;
      for (var q = 0; q < arr.length; q += 2) {
        var dx = arr[q] - x, dy = arr[q + 1] - y;
        if (dx * dx + dy * dy <= tol * tol) return true;
      }
    }
    return false;
  }
  var marked = 0;
  for (var e = 0; e < g.E; e++) {
    var ax = g.X[g.eF[e]], ay = g.Y[g.eF[e]], bx = g.X[g.eT[e]], by = g.Y[g.eT[e]];
    var hit = 0;
    var ts = [0.25, 0.5, 0.75];
    for (var k = 0; k < 3; k++) {
      if (near(ax + (bx - ax) * ts[k], ay + (by - ay) * ts[k])) hit++;
    }
    if (hit >= 2) { g.eExpl[e] = 1; marked++; }
  }
  return marked;
}

export { buildGraph, computeComponents, other, nearestNode, applyContext, poiNear, applyExplored };
