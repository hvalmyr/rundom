/* Подбор маршрутов нужной длины и их оценка. */
import { hav, bearing, mulberry32 } from './geo.js';
import { CLS } from './osm.js';
import { poiNear } from './graph.js';
import { buildCost, makeRouter } from './routing.js';
import { ensureTwins, reachWithin } from './blocks.js';

/* ---------- оценка маршрута ---------- */
function analyzeRoute(g, nodes, edges, prefs) {
  var total = 0, app = 0, main = 0, path = 0, park = 0, expl = 0, steps = 0, cross = 0, sinceSig = Infinity;
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
    /* Регулируемые переходы: рёбра со светофором подряд — один переход; переходы через островок
       или через соседние полосы одной улицы (между ними меньше 40 м) — тоже один. */
    if (g.eSig && g.eSig[e]) { if (sinceSig > 40) cross++; sinceSig = 0; }
    else sinceSig += L;
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
/* o.exits — узлы выходов из дома: кольцо стартует в точке не дальше o.approachMax от выхода,
   подводка бежится туда и обратно. o.ringStart — точка старта кольца, заданная вручную.
   o.noRepeat — кольцо не проходит одну улицу (с её тротуарами) дважды.
   o.dir = {bearing, spread} — кольцо лежит в секторе bearing ± spread градусов от старта: все опорные точки
   берутся в нём, улицы вне сектора дороже, а вариант, у которого вне сектора больше DIR_OUT длины
   или который уходит назад за старт дальше DIR_BACK метров, отбрасывается. У самого старта (DIR_R0) можно всё.
   o.districts = {zones:[{name, test(x,y)}], mode:'one'|'all', strict} — дальняя точка в районе;
   'one' — каждый вариант уходит в один случайный район, 'all' — кольцо проходит через все;
   strict — между первым входом в районы и последним выходом кольцо не покидает их.
   o.prefer — рёбра прежнего маршрута (правка «верёвкой»): по ним идти чуть выгоднее,
   из найденных берётся самый похожий на прежний.
   o.avoid — рёбра уже показанных вариантов (повторное построение с теми же настройками):
   похожие на них опускаются в конец, чтобы каждый раз выходили новые кольца. */
var DIR_OUT = 0.03, DIR_BACK = 120, DIR_SLACK = 8, DIR_FALLBACK = 0.3;
function createGenerator(g, o) {
  var rng = mulberry32(o.seed || 1);
  var router = makeRouter(g);
  var prefs = o.prefs || {};
  var cost = buildCost(g, prefs);
  var strictCost = null, preferMask = null, preferLen = 0;
  if (o.prefer && o.prefer.length) {
    /* дороже всё, что не лежит на прежнем маршруте: стоимость не меньше длины, A* остаётся честным */
    preferMask = new Uint8Array(g.E);
    o.prefer.forEach(function (e) { if (!preferMask[e]) { preferMask[e] = 1; preferLen += g.eLen[e]; } });
    for (var pe = 0; pe < g.E; pe++) if (!preferMask[pe]) cost[pe] *= 1.25;
  }
  var A = o.A, B = o.B, L = o.length, tol = o.tol === undefined ? 0.08 : o.tol;
  var forced = (o.forced || []).filter(function (v) { return v !== A && v !== B; });
  var comp = g.comp[A];
  var X = g.X, Y = g.Y;
  function dist(u, v) { var dx = X[u] - X[v], dy = Y[u] - Y[v]; return Math.sqrt(dx * dx + dy * dy); }
  var dAB = dist(A, B);
  var home = !!(o.exits && o.exits.length);
  var loopish = home || dAB < 0.1 * L;
  var ax = X[A], ay = Y[A], bx = X[B], by = Y[B];
  var noRepeat = !!o.noRepeat;
  if (noRepeat) ensureTwins(g);

  /* старт кольца: выход + подводка; без дома — сама точка A */
  var starts = null, fixed = null, cur = { d: 0, nodes: [A], edges: [] }, Lr = L;
  if (home) {
    if (o.ringStart !== undefined && o.ringStart !== null) {
      var lenCost = new Float64Array(g.E);
      for (var le = 0; le < g.E; le++) lenCost[le] = g.eLen[le];
      o.exits.forEach(function (x) {
        var r = router.route(lenCost, x, o.ringStart, null, 1);
        if (!r) return;
        var d = 0;
        for (var i = 0; i < r.edges.length; i++) d += g.eLen[r.edges[i]];
        if (!fixed || d < fixed.d) fixed = { node: o.ringStart, d: d, nodes: r.nodes, edges: r.edges };
      });
    } else {
      starts = [];
      var best = new Map();
      o.exits.forEach(function (x) {
        var reach = reachWithin(g, x, o.approachMax === undefined ? 1000 : o.approachMax);
        reach.nodes.forEach(function (v) {
          var d = reach.dist.get(v);
          if (v !== x && g.deg[v] < 3) return;
          var b0 = best.get(v);
          if (!b0 || d < b0.d) best.set(v, { node: v, d: d, reach: reach });
        });
      });
      best.forEach(function (st) { starts.push(st); });
      starts.sort(function (p, q) { return p.d - q.d; });
    }
  }
  function chooseStart() {
    if (!home) return true;
    var st = fixed;
    if (!st && starts.length) {
      /* чаще короткая подводка: желаемая длина — квадрат случайного числа от предела */
      var want = starts[starts.length - 1].d * rng() * rng(), lo = 0, hi = starts.length - 1;
      while (lo < hi) { var mid = (lo + hi) >> 1; if (starts[mid].d < want) lo = mid + 1; else hi = mid; }
      st = starts[Math.min(starts.length - 1, lo + Math.floor(rng() * 4))];
      if (!st.nodes) { var pth = st.reach.path(st.node); st.nodes = pth.nodes; st.edges = pth.edges; }
    }
    if (!st) return false;
    Lr = L - 2 * st.d;
    if (Lr < Math.min(1500, L * 0.4)) return false;
    cur = st; A = B = st.node;
    ax = bx = X[A]; ay = by = Y[A];
    return true;
  }

  var pool = [];
  for (var v = 0; v < g.n; v++) {
    if (g.comp[v] !== comp || g.deg[v] === 0) continue;
    if ((dist(v, A) + dist(v, B)) * 1.12 <= L * 1.05) pool.push(v);
  }
  /* ---------- направление ---------- */
  var A0 = A, dirPool = null, secPool = null, zones = null, inZone = null, zonePools = null, unreachable = [];
  var dirR0 = Math.max(200, 0.05 * L), dirSin = 0, dirCos = 1, dirCost = null;
  function angleOff(v, from) {
    var b = Math.atan2(X[v] - X[from], Y[v] - Y[from]) * 180 / Math.PI;
    var d = Math.abs(((b - o.dir.bearing) % 360 + 540) % 360 - 180);
    return d;
  }
  /* узел в секторе: у старта — любой, дальше — не шире spread + slack и не позади старта */
  function inSector(v, slack) {
    var dx = X[v] - X[A0], dy = Y[v] - Y[A0];
    if (dx * dirSin + dy * dirCos < -DIR_BACK) return false;
    if (dx * dx + dy * dy <= dirR0 * dirR0) return true;
    return angleOff(v, A0) <= o.dir.spread + slack;
  }
  if (o.dir) {
    dirSin = Math.sin(o.dir.bearing * Math.PI / 180); dirCos = Math.cos(o.dir.bearing * Math.PI / 180);
    /* дальняя точка — подальше, остальные опорные — просто в секторе */
    secPool = pool.filter(function (v) { return dist(v, A0) >= dirR0 && angleOff(v, A0) <= o.dir.spread * 0.85; });
    dirPool = secPool.filter(function (v) { return dist(v, A0) >= 0.15 * L; });
    var sec = new Uint8Array(g.n);
    for (var sv = 0; sv < g.n; sv++) if (g.comp[sv] === comp) sec[sv] = inSector(sv, 0) ? 1 : 0;
    setDirCost(4);
  }
  /* улицы вне сектора дороже в k раз: A* сам держит кольцо внутри */
  function setDirCost(k) {
    dirCost = new Float64Array(cost);
    for (var de = 0; de < g.E; de++) if (!sec[g.eF[de]] || !sec[g.eT[de]]) dirCost[de] *= k;
  }
  var dirSoft = false;
  if (o.districts && o.districts.zones.length) {
    var all = o.districts.zones;
    inZone = new Int16Array(g.n).fill(-1);
    var near = all.map(function () { return Infinity; });
    for (var zv = 0; zv < g.n; zv++) {
      if (g.comp[zv] !== comp) continue;
      for (var zi = 0; zi < all.length; zi++) if (all[zi].test(X[zv], Y[zv])) { inZone[zv] = zi; break; }
      if (inZone[zv] >= 0) near[inZone[zv]] = Math.min(near[inZone[zv]], dist(zv, A0));
    }
    zones = [];
    all.forEach(function (z, i) {
      /* кольцо длины L уходит от старта не дальше ~L/2, по улицам — меньше */
      if (near[i] * 2 * 1.15 > L) unreachable.push({ name: z.name, dist: near[i] });
      else zones.push(i);
    });
    zonePools = all.map(function () { return []; });
    pool.forEach(function (v) { if (inZone[v] >= 0) zonePools[inZone[v]].push(v); });
    zones = zones.filter(function (i) { return zonePools[i].length; });
  }
  var curZone = -1;
  var strict = !!(o.districts && o.districts.strict && zones);
  /* «строго»: улицы вне районов дороже, маршрут сам держится внутри */
  if (strict) {
    strictCost = new Float64Array(dirCost || cost);
    for (var se = 0; se < g.E; se++) if (inZone[g.eF[se]] < 0 && inZone[g.eT[se]] < 0) strictCost[se] *= 3;
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
  var accepted = [], fallback = [], dirFallback = [];
  var used = new Uint8Array(g.E), seen = new Uint8Array(g.E);
  var state = { done: pool.length < 5 && !forced.length, error: pool.length < 5 ? 'pool' : null };
  if (home && !fixed && (!starts || !starts.length)) { state.done = true; state.error = 'exits'; }
  if (dirPool && !dirPool.length) { state.done = true; state.error = 'dir'; }
  if (zones && (!zones.length || (o.districts.mode === 'all' && unreachable.length))) { state.done = true; state.error = 'districts'; }
  state.unreachable = unreachable;
  var dirRejects = 0;

  function pick(arr) { return arr[Math.floor(rng() * arr.length)]; }
  /* o.keep — опорные точки прежнего варианта: при правке «верёвкой» берутся чаще остальных */
  var keep = (o.keep || []).filter(function (v) { return g.comp[v] === comp; });
  function pickVia() {
    if (keep.length && rng() < 0.6) return pick(keep);
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
    /* одна «дальняя» точка — в секторе компаса или в районе; при «строго» и остальные в районах */
    if (dirPool) {
      vias.push(pick(dirPool)); k = Math.max(0, k - 1);
      /* при направлении все опорные точки — в секторе, иначе кольцо тянется за его край */
      for (var di = 0; di < k; di++) vias.push(pick(secPool));
      return order(vias);
    }
    if (zones) {
      if (o.districts.mode === 'all') zones.forEach(function (i) { vias.push(pick(zonePools[i])); });
      else { curZone = pick(zones); vias.push(pick(zonePools[curZone])); }
      k = Math.max(0, k - 1);
      if (strict) {
        var inner = [];
        zones.forEach(function (i) { inner = inner.concat(o.districts.mode === 'all' || i === curZone ? zonePools[i] : []); });
        for (var q = 0; q < k; q++) vias.push(pick(inner));
        return order(vias);
      }
    }
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

  /* ребро и, без повторов, параллельные ему рёбра той же улицы */
  function mark(arr, e) {
    arr[e] = 1;
    if (noRepeat) for (var k = g.twinStart[e]; k < g.twinStart[e + 1]; k++) arr[g.twinEdge[k]] = 1;
  }

  function buildRoute(seq) {
    used.fill(0);
    var nodes = [seq[0]], edges = [];
    for (var i = 1; i < seq.length; i++) {
      var r = router.route(strictCost || dirCost || cost, seq[i - 1], seq[i], used, noRepeat ? 40 : 6);
      if (!r) return null;
      for (var j = 0; j < r.edges.length; j++) { mark(used, r.edges[j]); edges.push(r.edges[j]); }
      for (var q = 1; q < r.nodes.length; q++) nodes.push(r.nodes[q]);
    }
    return { nodes: nodes, edges: edges };
  }

  function consider(seq) {
    var r = buildRoute(seq);
    if (!r || !r.edges.length) return;
    var ring = 0, overlap = 0;
    seen.fill(0);
    for (var i = 0; i < r.edges.length; i++) {
      var ed = r.edges[i];
      ring += g.eLen[ed];
      if (seen[ed]) overlap += g.eLen[ed];
      mark(seen, ed);
    }
    var eu = estimate(seq);
    if (eu > 50) c = 0.7 * c + 0.3 * Math.max(1.05, Math.min(2, ring / eu));
    var dirOk = !(dirPool || zones) || directionOk(r);
    if (!dirOk) { dirRejects++; if (!(r.dirOut <= DIR_FALLBACK)) return; }
    var total = ring + 2 * cur.d;
    var err = Math.abs(total - L) / L;
    var ov = ring ? overlap / ring : 0;
    /* трек целиком: подводка, кольцо, подводка обратно */
    var nodes = r.nodes, edges = r.edges;
    if (cur.edges.length) {
      var back = cur.nodes.slice().reverse();
      nodes = cur.nodes.concat(r.nodes.slice(1), back.slice(1));
      edges = cur.edges.concat(r.edges, cur.edges.slice().reverse());
    }
    var cand = {
      nodes: nodes, edges: edges, length: total, err: err, overlap: ov, repeat: overlap, via: seq.slice(1, -1),
      approach: cur.d, apN: cur.nodes.length, ringN: r.nodes.length,
      district: r.zone !== undefined && r.zone >= 0 ? o.districts.zones[r.zone].name : null
    };
    var mask = new Uint8Array(g.E);
    for (var k = 0; k < edges.length; k++) mask[edges[k]] = 1;
    cand.mask = mask;
    var clean = noRepeat ? overlap <= Math.max(60, 0.015 * ring) : ov <= 0.2;
    if (!dirOk) { cand.dirOut = r.dirOut; if (err <= tol && clean) dirFallback.push(cand); return; }
    if (err <= tol && clean) accepted.push(cand);
    else if (err <= 0.35 && ov <= (noRepeat ? 0.1 : 0.3)) fallback.push(cand);
  }

  /* Дальняя от старта кольца точка в нужном секторе или районе; для «строго» — кольцо внутри районов. */
  function directionOk(r) {
    var far = r.nodes[0], fd = 0;
    for (var i = 0; i < r.nodes.length; i++) { var d = dist(r.nodes[i], A); if (d > fd) { fd = d; far = r.nodes[i]; } }
    if (dirPool) {
      if (fd < 200 || angleOff(far, A0) > o.dir.spread) return false;
      var outLen = 0, ringLen = 0;
      for (var oe = 0; oe < r.edges.length; oe++) {
        var ol = g.eLen[r.edges[oe]];
        ringLen += ol;
        if (!inSector(r.nodes[oe], DIR_SLACK) || !inSector(r.nodes[oe + 1], DIR_SLACK)) outLen += ol;
      }
      /* выйти из сектора бывает нужно (река, железная дорога): такой вариант — запасной */
      if (outLen > DIR_OUT * ringLen) { r.dirOut = outLen / ringLen; return false; }
    }
    if (!zones) return true;
    var zf = inZone[far];
    if (o.districts.mode === 'all') {
      if (zf < 0) return false;
      var hit = {};
      for (var j = 0; j < r.nodes.length; j++) if (inZone[r.nodes[j]] >= 0) hit[inZone[r.nodes[j]]] = 1;
      for (var z = 0; z < zones.length; z++) if (!hit[zones[z]]) return false;
    } else if (zf !== curZone) return false;
    if (strict) {
      var first = -1, last = -1;
      for (var k = 0; k < r.nodes.length; k++) if (inZone[r.nodes[k]] >= 0) { if (first < 0) first = k; last = k; }
      var out = 0, tot = 0;
      for (var e = 0; e < r.edges.length; e++) {
        tot += g.eLen[r.edges[e]];
        if (e >= first && e < last && inZone[r.nodes[e]] < 0 && inZone[r.nodes[e + 1]] < 0) out += g.eLen[r.edges[e]];
      }
      if (out > 0.03 * tot) return false;
    }
    r.zone = zf;
    return true;
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
    /* Целиком в секторе кольцо не складывается (сектор перекрыт рекой или путями, и обход
       вчетверо дороже раздувает длину): дальше штраф мягче, подойдут варианты с выходом из сектора. */
    if (dirCost && !dirSoft && attempts > maxAttempts / 3 && !accepted.length && !dirFallback.length) {
      dirSoft = true; setDirCost(1.5); c = 1.3; win = 0.2;
      if (strictCost) strictCost = null;
    }
    if (!directTried) {
      directTried = true;
      if (!forced.length && A !== B) { consider([A, B]); return; }
    }
    if (!chooseStart()) { rejects++; return; }
    var seq = null, tries = 0;
    while (tries++ < 40) {
      var vias = makeVias();
      var s = [A].concat(vias, [B]);
      var est = estimate(s) * c;
      if (est >= Lr * (1 - win) && est <= Lr * (1 + win)) { seq = s; break; }
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
    /* в секторе целиком не вышло — варианты, у которых вне сектора меньше всего */
    if (pool1.length < count && dirFallback.length) {
      dirFallback.sort(function (a, b) { return a.dirOut - b.dirOut; });
      for (var df = 0; df < dirFallback.length && pool1.length < count * 2; df++) pool1.push(dirFallback[df]);
    }
    if (pool1.length < count) {
      fallback.sort(function (a, b) { return (a.err + a.overlap) - (b.err + b.overlap); });
      for (var i = 0; i < fallback.length && pool1.length < count * 3; i++) pool1.push(fallback[i]);
      approx = true;
    }
    pool1.forEach(function (r) {
      r.metrics = analyzeRoute(g, r.nodes, r.edges, prefs);
      r.score = scoreRoute(r.metrics, prefs, r.err, r.overlap);
      if (preferMask) {
        var shared = 0;
        for (var i = 0; i < r.edges.length; i++) if (preferMask[r.edges[i]]) shared += g.eLen[r.edges[i]];
        r.similar = Math.min(1, shared / Math.max(1, r.length + preferLen - shared));
        r.score += 80 * r.similar;
      }
    });
    pool1.forEach(function (r) { if (r.dirOut) r.score -= 200 * r.dirOut; });
    if (o.avoid && o.avoid.length) {
      var seen = o.avoid.map(function (edges) {
        var m = new Uint8Array(g.E), len = 0;
        edges.forEach(function (e) { if (!m[e]) { m[e] = 1; len += g.eLen[e]; } });
        return { mask: m, length: len };
      });
      pool1.forEach(function (r) {
        var worst = 0;
        seen.forEach(function (sv) { worst = Math.max(worst, similarity(sv, r)); });
        r.seen = worst;
        r.score -= 150 * worst;
      });
    }
    pool1.sort(function (a, b) {
      var ea = a.err <= tol ? 0 : 1, eb = b.err <= tol ? 0 : 1;
      if (ea !== eb) return ea - eb;
      /* почти такой же, как уже показанный, — после всех новых */
      var sa = a.seen > 0.7 ? 1 : 0, sb = b.seen > 0.7 ? 1 : 0;
      if (sa !== sb) return sa - sb;
      return b.score - a.score;
    });
    var picked = [];
    /* «один район на вариант»: сначала по лучшему варианту в каждый район */
    if (zones && zones.length > 1 && o.districts.mode !== 'all') {
      var got = {};
      for (var pi = 0; pi < pool1.length && picked.length < count; pi++) {
        var pc = pool1[pi];
        if (pc.district && !got[pc.district]) { got[pc.district] = 1; picked.push(pc); }
      }
    }
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
      /* подводка отдельно: рисуется пунктиром */
      r.approachCoords = r.apN > 1 ? r.coords.slice(0, r.apN) : null;
      r.ringCoords = r.apN > 1 ? r.coords.slice(r.apN - 1, r.apN - 1 + r.ringN) : r.coords;
      r.off = r.err > tol;
      delete r.mask;
    });
    return { routes: picked, approx: approx && !accepted.length, attempts: attempts, accepted: accepted.length };
  }

  return {
    run: run, results: results, state: state,
    progress: function () { return { attempts: attempts, max: maxAttempts, accepted: accepted.length, dirRejects: dirRejects }; },
    poolSize: pool.length
  };
}

export { analyzeRoute, scoreRoute, createGenerator };
