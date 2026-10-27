/* Подбор маршрутов нужной длины и их оценка. */
import { hav, bearing, mulberry32 } from './geo.js';
import { CLS } from './osm.js';
import { poiNear } from './graph.js';
import { buildCost, makeRouter } from './routing.js';

/* ---------- оценка маршрута ---------- */
function analyzeRoute(g, nodes, edges, prefs) {
  var total = 0, app = 0, main = 0, path = 0, park = 0, expl = 0, steps = 0, cross = 0;
  var byName = new Map();
  for (var i = 0; i < edges.length; i++) {
    var e = edges[i], L = g.eLen[e];
    total += L;
    app += L * g.eAp[e];
    if (g.eCls[e] === CLS.main || g.eCls[e] === CLS.road) main += L;
    if (g.eCls[e] === CLS.path && g.eAp[e] >= 0.5) path += L;
    if (g.ePark[e]) park += L;
    if (g.eExpl[e]) expl += L;
    if (g.eCls[e] === CLS.steps) steps += L;
    if (g.eFix[e] > 0) cross++;
    var ni = g.eName[e];
    if (ni >= 0) byName.set(ni, (byName.get(ni) || 0) + L);
  }
  /* повороты на перекрёстках */
  var turns = 0;
  for (var j = 1; j < nodes.length - 1; j++) {
    var v = nodes[j];
    if (g.deg[v] < 3) continue;
    var a = j - 1, accD = 0;
    while (a > 0 && accD < 12) { accD += hav(g.lat[nodes[a]], g.lon[nodes[a]], g.lat[nodes[a - 1]], g.lon[nodes[a - 1]]); a--; }
    var b = j + 1, accE = 0;
    while (b < nodes.length - 1 && accE < 12) { accE += hav(g.lat[nodes[b]], g.lon[nodes[b]], g.lat[nodes[b + 1]], g.lon[nodes[b + 1]]); b++; }
    var b1 = bearing(g.lat[nodes[a]], g.lon[nodes[a]], g.lat[v], g.lon[v]);
    var b2 = bearing(g.lat[v], g.lon[v], g.lat[nodes[b]], g.lon[nodes[b]]);
    var d = Math.abs(b2 - b1); if (d > 180) d = 360 - d;
    if (d > 35) turns++;
  }
  /* интересные места рядом */
  var poiSeen = new Map();
  if (g.pois && g.pois.length) {
    for (var q = 0; q < nodes.length; q++) {
      var pi = poiNear(g, g.X[nodes[q]], g.Y[nodes[q]], 70);
      if (pi >= 0 && !poiSeen.has(pi)) poiSeen.set(pi, g.pois[pi]);
    }
  }
  var poiList = [];
  poiSeen.forEach(function (p) { poiList.push(p); });
  var topNames = Array.from(byName.entries()).sort(function (a2, b2) { return b2[1] - a2[1]; })
    .slice(0, 4).map(function (en) { return g.names[en[0]]; });

  var km = total / 1000 || 1;
  return {
    length: total,
    appeal: total ? app / total : 0,
    mainShare: total ? main / total : 0,
    pathShare: total ? path / total : 0,
    parkShare: total ? park / total : 0,
    exploredShare: total ? expl / total : 0,
    newShare: total ? 1 - expl / total : 0,
    stepsLen: steps,
    crossings: cross,
    turns: turns,
    turnsPerKm: turns / km,
    pois: poiList,
    streets: topNames
  };
}

function scoreRoute(m, prefs, err, overlap) {
  prefs = prefs || {};
  var nov = prefs.novelty || 0, poiW = prefs.poi === undefined ? 0.5 : prefs.poi;
  var wApp = 0.3, wMain = 0.15, wNov = 0.1 + 0.15 * Math.abs(nov), wTurn = 0.15, wPoi = 0.05 + 0.2 * poiW;
  var sum = wApp + wMain + wNov + wTurn + wPoi;
  var novTerm = nov > 0 ? m.newShare : (nov < 0 ? m.exploredShare : 0.5);
  var s = wApp * m.appeal + wMain * (1 - m.mainShare) + wNov * novTerm +
    wTurn * (1 - Math.min(1, m.turnsPerKm / 4)) + wPoi * Math.min(1, m.pois.length / 3);
  var score = 100 * s / sum - overlap * 60 - err * 100;
  return Math.max(0, Math.min(100, score));
}

/* ---------- подбор маршрутов ---------- */
function createGenerator(g, o) {
  var rng = mulberry32(o.seed || 1);
  var router = makeRouter(g);
  var prefs = o.prefs || {};
  var cost = buildCost(g, prefs);
  var A = o.A, B = o.B, L = o.length, tol = o.tol === undefined ? 0.08 : o.tol;
  var forced = (o.forced || []).filter(function (v) { return v !== A && v !== B; });
  var comp = g.comp[A];
  var X = g.X, Y = g.Y;
  function dist(u, v) { var dx = X[u] - X[v], dy = Y[u] - Y[v]; return Math.sqrt(dx * dx + dy * dy); }
  var dAB = dist(A, B);
  var loopish = dAB < 0.1 * L;
  var ax = X[A], ay = Y[A], bx = X[B], by = Y[B];

  var pool = [];
  for (var v = 0; v < g.n; v++) {
    if (g.comp[v] !== comp || g.deg[v] === 0) continue;
    if ((dist(v, A) + dist(v, B)) * 1.12 <= L * 1.05) pool.push(v);
  }
  var attract = [];
  if (o.attract) o.attract.forEach(function (v) { if (g.comp[v] === comp && (dist(v, A) + dist(v, B)) * 1.12 <= L * 1.05) attract.push(v); });
  for (var e = 0; e < g.E && attract.length < 600; e += 7) {
    if (g.ePark[e] && g.comp[g.eF[e]] === comp) {
      var u = g.eF[e];
      if ((dist(u, A) + dist(u, B)) * 1.12 <= L * 1.05) attract.push(u);
    }
  }

  var maxAttempts = o.maxAttempts || 160;
  var attempts = 0, rejects = 0, c = 1.3, win = 0.2;
  var accepted = [], fallback = [];
  var used = new Uint8Array(g.E), seen = new Uint8Array(g.E);
  var state = { done: pool.length < 5 && !forced.length, error: pool.length < 5 ? 'pool' : null };

  function pick(arr) { return arr[Math.floor(rng() * arr.length)]; }
  function pickVia() {
    if (attract.length && rng() < 0.4) return pick(attract);
    return pick(pool);
  }

  function order(vias) {
    var key = {};
    if (loopish) {
      var dir = rng() < 0.5 ? 1 : -1;
      vias.forEach(function (v) {
        var ang = Math.atan2(Y[v] - ay, X[v] - ax);
        key[v] = dir * ang;
      });
    } else {
      var l2 = dAB * dAB;
      vias.forEach(function (v) { key[v] = ((X[v] - ax) * (bx - ax) + (Y[v] - ay) * (by - ay)) / l2; });
    }
    return vias.slice().sort(function (p, q) { return key[p] - key[q]; });
  }

  function sideOf(v) { return (bx - ax) * (Y[v] - ay) - (by - ay) * (X[v] - ax) > 0 ? 1 : -1; }

  function makeVias() {
    var k = forced.length ? [0, 1, 1, 2][Math.floor(rng() * 4)] : [1, 1, 2, 2, 3][Math.floor(rng() * 5)];
    var vias = forced.slice();
    var side = rng() < 0.5 ? 1 : -1;
    for (var i = 0; i < k; i++) {
      var cand = pickVia(), tries = 0;
      while (!loopish && sideOf(cand) !== side && tries++ < 8) cand = pickVia();
      if (cand !== A && cand !== B) vias.push(cand);
    }
    return order(vias);
  }

  function estimate(seq) {
    var s = 0;
    for (var i = 1; i < seq.length; i++) s += dist(seq[i - 1], seq[i]);
    return s;
  }

  function buildRoute(seq) {
    used.fill(0);
    var nodes = [seq[0]], edges = [];
    for (var i = 1; i < seq.length; i++) {
      var r = router.route(cost, seq[i - 1], seq[i], used, 6);
      if (!r) return null;
      for (var j = 0; j < r.edges.length; j++) { used[r.edges[j]] = 1; edges.push(r.edges[j]); }
      for (var q = 1; q < r.nodes.length; q++) nodes.push(r.nodes[q]);
    }
    return { nodes: nodes, edges: edges };
  }

  function consider(seq) {
    var r = buildRoute(seq);
    if (!r || !r.edges.length) return;
    var total = 0, overlap = 0;
    seen.fill(0);
    for (var i = 0; i < r.edges.length; i++) {
      var ed = r.edges[i];
      total += g.eLen[ed];
      if (seen[ed]) overlap += g.eLen[ed]; else seen[ed] = 1;
    }
    var eu = estimate(seq);
    if (eu > 50) c = 0.7 * c + 0.3 * Math.max(1.05, Math.min(2, total / eu));
    var err = Math.abs(total - L) / L;
    var ov = total ? overlap / total : 0;
    var cand = { nodes: r.nodes, edges: r.edges, length: total, err: err, overlap: ov, via: seq.slice(1, -1) };
    var mask = new Uint8Array(g.E);
    for (var k = 0; k < r.edges.length; k++) mask[r.edges[k]] = 1;
    cand.mask = mask;
    if (err <= tol && ov <= 0.2) accepted.push(cand);
    else if (err <= 0.35 && ov <= 0.3) fallback.push(cand);
  }

  function similarity(a, b) {
    var shared = 0;
    for (var i = 0; i < b.edges.length; i++) if (a.mask[b.edges[i]]) shared += g.eLen[b.edges[i]];
    var uni = a.length + b.length - shared;
    return uni > 0 ? shared / uni : 1;
  }

  /* A≠B: прямой кратчайший путь тоже кандидат */
  var directTried = false;

  function step() {
    attempts++;
    if (!directTried) {
      directTried = true;
      if (!forced.length && A !== B) { consider([A, B]); return; }
    }
    var seq = null, tries = 0;
    while (tries++ < 40) {
      var vias = makeVias();
      var s = [A].concat(vias, [B]);
      var est = estimate(s) * c;
      if (est >= L * (1 - win) && est <= L * (1 + win)) { seq = s; break; }
      rejects++;
      if (rejects % 60 === 0 && win < 0.5) win += 0.05;
    }
    if (!seq) return;
    consider(seq);
  }

  function run(ms) {
    var t0 = Date.now();
    while (!state.done && Date.now() - t0 < ms) {
      step();
      if (attempts >= maxAttempts) state.done = true;
      else if (accepted.length >= (o.count || 3) * 5 && attempts >= 40) state.done = true;
    }
    return state.done;
  }

  function results() {
    var count = o.count || 3;
    var pool1 = accepted.slice();
    var approx = false;
    if (pool1.length < count) {
      fallback.sort(function (a, b) { return a.err - b.err; });
      for (var i = 0; i < fallback.length && pool1.length < count * 3; i++) pool1.push(fallback[i]);
      approx = true;
    }
    pool1.forEach(function (r) {
      r.metrics = analyzeRoute(g, r.nodes, r.edges, prefs);
      r.score = scoreRoute(r.metrics, prefs, r.err, r.overlap);
    });
    pool1.sort(function (a, b) {
      var ea = a.err <= tol ? 0 : 1, eb = b.err <= tol ? 0 : 1;
      if (ea !== eb) return ea - eb;
      return b.score - a.score;
    });
    var picked = [];
    [0.5, 0.7, 0.9].forEach(function (lim) {
      for (var i = 0; i < pool1.length && picked.length < count; i++) {
        var cand = pool1[i];
        if (picked.indexOf(cand) >= 0) continue;
        var ok = true;
        for (var j = 0; j < picked.length; j++) if (similarity(picked[j], cand) > lim) { ok = false; break; }
        if (ok) picked.push(cand);
      }
    });
    picked.forEach(function (r) {
      r.coords = r.nodes.map(function (n) { return [g.lat[n], g.lon[n]]; });
      r.off = r.err > tol;
      delete r.mask;
    });
    return { routes: picked, approx: approx && !accepted.length, attempts: attempts, accepted: accepted.length };
  }

  return {
    run: run, results: results, state: state,
    progress: function () { return { attempts: attempts, max: maxAttempts, accepted: accepted.length }; },
    poolSize: pool.length
  };
}

export { analyzeRoute, scoreRoute, createGenerator };
