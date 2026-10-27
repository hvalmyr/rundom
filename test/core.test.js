import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Core from '../src/core/index.js';

/* Синтетическая сетка улиц 20×20 с шагом ~100 м вокруг центра Москвы. */
function gridNetwork(n = 20, step = 0.0009) {
  const elements = [];
  const id = (i, j) => i * n + j + 1;
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
    elements.push({ type: 'node', id: id(i, j), lat: 55.75 + i * step, lon: 37.6 + j * step * 1.78 });
  }
  let w = 1;
  for (let i = 0; i < n; i++) {
    elements.push({ type: 'way', id: w++, tags: { highway: 'residential', name: 'Улица ' + i }, nodes: [...Array(n)].map((_, j) => id(i, j)) });
    elements.push({ type: 'way', id: w++, tags: { highway: 'footway' }, nodes: [...Array(n)].map((_, j) => id(j, i)) });
  }
  return { elements };
}

test('graph builds and generator finds a loop of the requested length', () => {
  const g = Core.buildGraph(Core.parseNetwork(gridNetwork()), {});
  assert.equal(g.n, 400);
  Core.applyContext(g, { parks: [], pois: [] });
  const A = Core.nearestNode(g, 55.758, 37.616, 200, 10).node;
  const gen = Core.createGenerator(g, { A, B: A, length: 4000, tol: 0.1, count: 3, seed: 7, maxAttempts: 120 });
  while (!gen.run(50));
  const res = gen.results();
  assert.ok(res.routes.length > 0, 'at least one route');
  for (const r of res.routes) assert.ok(Math.abs(r.length - 4000) / 4000 <= 0.35);
});

test('GPX round trip keeps points', () => {
  const coords = [[55.75, 37.6], [55.751, 37.601], [55.752, 37.603]];
  const back = Core.parseGPX(Core.toGPX({ name: 'Тест', coords, waypoints: [] }));
  assert.equal(back.name, 'Тест');
  assert.deepEqual(back.tracks[0], coords);
});

test('newDistance counts only streets not run before, both sides as one', () => {
  const street = [[55.75, 37.6], [55.76, 37.6]];
  const otherSide = [[55.75, 37.60015], [55.76, 37.60015]]; /* ~10 м в сторону */
  assert.equal(Math.round(Core.newDistance([otherSide], [street])), 0);
  const fresh = Core.newDistance([street], []);
  assert.ok(Math.abs(fresh - Core.polyLength(street)) < 15);
});

test('track and route titles describe the content', () => {
  assert.equal(Core.trackTitle('2026-10-26T18:10:00', 11320, 'Нескучный сад'), '26 октября, вечер · Нескучный сад · 11,3 км');
  assert.equal(Core.routeTitle({ pois: [{ name: 'Музеон', cat: 'park' }], streets: ['Крымский Вал'] }, 'x'), 'Музеон · Крымский Вал');
  assert.equal(Core.routeTitle({ pois: [], streets: [] }, 'Маршрут'), 'Маршрут');
  assert.equal(Core.routeTitle({ pois: [{ name: 'В. И. Ленину', cat: 'history' }], streets: [] }, 'x'), 'Памятник В. И. Ленину');
  assert.equal(Core.routeTitle({ pois: [{ name: 'Ленину', cat: 'history' }, { name: 'Сквер Тургенева', cat: 'park' }], streets: [] }, 'x'), 'Сквер Тургенева');
});

test('closures and zones cut the graph, reach respects the limit', () => {
  const g = Core.buildGraph(Core.parseNetwork(gridNetwork()), {});
  const c = Core.nearestNode(g, 55.7585, 37.616, 200).node;
  const n = Core.applyBlocks(g, { zones: [{ shape: 'circle', c: [g.lat[c], g.lon[c]], r: 150 }] });
  assert.ok(n > 0);
  assert.notEqual(g.comp[c], g.comp[Core.nearestNode(g, 55.75, 37.6, 50).node]);
  Core.applyBlocks(g, { gates: [[g.lat[c], g.lon[c]]] });
  assert.equal(g.compSize[g.comp[c]], 1);
  Core.applyBlocks(g, {});
  assert.equal(g.eBlock, null);
  const reach = Core.reachWithin(g, c, 250);
  for (const v of reach.nodes) assert.ok(reach.dist.get(v) <= 250);
  assert.ok(reach.nodes.length >= 5);
});

test('both sides of a street are twins, the next block of it is not', () => {
  const els = [];
  for (let j = 0; j < 6; j++) {
    els.push({ type: 'node', id: 1 + j, lat: 55.75, lon: 37.6 + j * 0.0016 });
    els.push({ type: 'node', id: 101 + j, lat: 55.75009, lon: 37.6 + j * 0.0016 });
  }
  els.push({ type: 'way', id: 1, tags: { highway: 'footway' }, nodes: [1, 2, 3, 4, 5, 6] });
  els.push({ type: 'way', id: 2, tags: { highway: 'footway' }, nodes: [101, 102, 103, 104, 105, 106] });
  const g = Core.buildGraph(Core.parseNetwork({ elements: els }), {});
  Core.ensureTwins(g);
  const twins = (e) => [...g.twinEdge.slice(g.twinStart[e], g.twinStart[e + 1])];
  assert.equal(twins(0).length, 1);
  assert.ok(g.eF[twins(0)[0]] >= 6, 'twin lies on the other side');
});

test('route from home: approach within the limit, ring without repeats', () => {
  const g = Core.buildGraph(Core.parseNetwork(gridNetwork()), {});
  Core.applyContext(g, { parks: [], pois: [] });
  const home = Core.nearestNode(g, 55.758, 37.616, 200, 10).node;
  const gen = Core.createGenerator(g, {
    A: home, B: home, length: 5000, tol: 0.1, count: 3, seed: 11, maxAttempts: 200,
    exits: [home], approachMax: 300, noRepeat: true
  });
  while (!gen.run(50));
  const res = gen.results();
  assert.ok(res.routes.length > 0);
  for (const r of res.routes) {
    assert.ok(r.approach <= 300);
    assert.ok(r.repeat <= 100, 'repeat ' + r.repeat);
    const first = r.coords[0], last = r.coords[r.coords.length - 1];
    assert.deepEqual(first, last, 'returns home');
    if (r.approachCoords) assert.deepEqual(r.approachCoords[r.approachCoords.length - 1], r.ringCoords[0]);
  }
});

test('a gate the user marked open stops blocking the path', () => {
  const net = gridNetwork(4);
  const gate = net.elements.find((e) => e.type === 'node' && e.id === 6);
  gate.tags = { barrier: 'gate', access: 'private' };
  const closed = Core.buildGraph(Core.parseNetwork(net), {});
  const open = Core.buildGraph(Core.parseNetwork(net), { openGates: [{ lat: gate.lat, lon: gate.lon }] });
  assert.equal(closed.closedGates.length, 1);
  assert.equal(open.closedGates.length, 0);
  assert.ok(open.E > closed.E);
});

test('compass: the farthest point of every ring lies in the chosen sector', () => {
  const g = Core.buildGraph(Core.parseNetwork(gridNetwork(30)), {});
  Core.applyContext(g, { parks: [], pois: [] });
  const A = Core.nearestNode(g, 55.763, 37.624, 200, 10).node;
  const gen = Core.createGenerator(g, { A, B: A, length: 5000, tol: 0.12, count: 3, seed: 5, maxAttempts: 300, dir: { bearing: 90, spread: 30 } });
  while (!gen.run(50));
  const res = gen.results();
  assert.ok(res.routes.length > 0);
  for (const r of res.routes) {
    let far = r.coords[0], fd = 0;
    for (const p of r.coords) { const d = Core.hav(r.coords[0][0], r.coords[0][1], p[0], p[1]); if (d > fd) { fd = d; far = p; } }
    const b = Core.bearing(r.coords[0][0], r.coords[0][1], far[0], far[1]);
    assert.ok(Math.abs(((b - 90) % 360 + 540) % 360 - 180) <= 32, 'bearing ' + b);
    /* и всё кольцо — в секторе: вне его не больше нескольких процентов длины, назад за старт не уходит */
    const s = r.coords[0];
    let out = 0, tot = 0;
    for (let i = 1; i < r.coords.length; i++) {
      const p = r.coords[i], l = Core.hav(r.coords[i - 1][0], r.coords[i - 1][1], p[0], p[1]);
      tot += l;
      const d = Core.hav(s[0], s[1], p[0], p[1]);
      const off = Math.abs(((Core.bearing(s[0], s[1], p[0], p[1]) - 90) % 360 + 540) % 360 - 180);
      if (d > 250 && off > 40) out += l;
      assert.ok((p[1] - s[1]) * 111320 * Math.cos(s[0] * Math.PI / 180) > -150, 'behind the start');
    }
    assert.ok(out / tot < 0.06, 'outside the sector ' + Math.round(100 * out / tot) + '%');
  }
});

test('crossings: only signalised ones count, a crossing over an island counts once', () => {
  /* улица с запада на восток, дорожка с юга на север пересекает её по двум переходам через островок */
  const n = (id, lat, lon, tags) => ({ type: 'node', id, lat, lon, tags });
  const els = [
    n(1, 55.750, 37.600), n(2, 55.750, 37.601), n(3, 55.750, 37.602),
    n(10, 55.7495, 37.601), n(11, 55.7499, 37.601), n(13, 55.7501, 37.601), n(14, 55.7505, 37.601),
    n(20, 55.7495, 37.603), n(21, 55.750, 37.603, { highway: 'crossing', crossing: 'uncontrolled' }), n(22, 55.7505, 37.603),
    { type: 'way', id: 1, tags: { highway: 'primary' }, nodes: [1, 2, 3, 21] },
    { type: 'way', id: 2, tags: { highway: 'footway' }, nodes: [10, 11] },
    { type: 'way', id: 3, tags: { highway: 'footway', footway: 'crossing', crossing: 'traffic_signals' }, nodes: [11, 2] },
    { type: 'way', id: 4, tags: { highway: 'footway', footway: 'crossing', crossing: 'traffic_signals' }, nodes: [2, 13] },
    { type: 'way', id: 5, tags: { highway: 'footway' }, nodes: [13, 14] },
    /* нерегулируемый переход не считается */
    { type: 'way', id: 6, tags: { highway: 'footway', footway: 'crossing' }, nodes: [20, 21, 22] }
  ];
  const g = Core.buildGraph(Core.parseNetwork({ elements: els }), {});
  const path = (ids) => {
    const nodes = ids.map((id) => Core.nearestNode(g, els.find((e) => e.id === id).lat, els.find((e) => e.id === id).lon, 5).node);
    const edges = [];
    for (let i = 1; i < nodes.length; i++) {
      for (let k = g.adjStart[nodes[i]]; k < g.adjStart[nodes[i] + 1]; k++) {
        const e = g.adjEdge[k];
        if (Core.other(g, e, nodes[i]) === nodes[i - 1]) { edges.push(e); break; }
      }
    }
    return Core.analyzeRoute(g, nodes, edges, {});
  };
  assert.equal(path([10, 11, 2, 13, 14]).crossings, 1);
  assert.equal(path([20, 21, 22]).crossings, 0);
  /* светофор на узле дороги делает переход регулируемым и без тега на пути */
  els.find((e) => e.id === 21).tags = { highway: 'crossing', crossing: 'traffic_signals' };
  const g2 = Core.buildGraph(Core.parseNetwork({ elements: els }), {});
  assert.ok(g2.eSig.some((x) => x));
});

test('districts: one random district per variant, strict keeps the ring inside', () => {
  const g = Core.buildGraph(Core.parseNetwork(gridNetwork(30)), {});
  Core.applyContext(g, { parks: [], pois: [] });
  const A = Core.nearestNode(g, 55.763, 37.624, 200, 10).node;
  const box = (lat0, lon0, lat1, lon1) => [[[lat0, lon0], [lat0, lon1], [lat1, lon1], [lat1, lon0], [lat0, lon0]]];
  const list = [
    { n: 'Север', p: [box(55.7655, 37.6, 55.776, 37.648)] },
    { n: 'Юг', p: [box(55.75, 37.6, 55.7605, 37.648)] }
  ];
  const idx = Core.districtIndex(list);
  const zones = list.map((d, i) => ({ name: d.n, test: idx.tests[i] }));
  const gen = Core.createGenerator(g, { A, B: A, length: 4000, tol: 0.12, count: 4, seed: 3, maxAttempts: 300, districts: { zones, mode: 'one', strict: true } });
  while (!gen.run(50));
  const res = gen.results();
  assert.ok(res.routes.length > 0);
  for (const r of res.routes) assert.ok(['Север', 'Юг'].includes(r.district));
  assert.equal(new Set(res.routes.map((r) => r.district)).size, 2, 'both districts get a variant');
  assert.equal(idx.mainOf([[55.77, 37.62], [55.771, 37.621]]), 'Север');
  const away = { name: 'Далеко', test: Core.multiTest([box(55.9, 37.6, 55.91, 37.62)]) };
  const far = Core.createGenerator(g, { A, B: A, length: 4000, districts: { zones: [...zones, away], mode: 'all', strict: false } });
  assert.equal(far.state.error, 'districts');
  assert.deepEqual(far.state.unreachable.map((u) => u.name), ['Далеко']);
});

test('rope edit: the re-fitted ring goes through the pulled point and stays close to the old one', () => {
  const g = Core.buildGraph(Core.parseNetwork(gridNetwork()), {});
  Core.applyContext(g, { parks: [], pois: [] });
  const A = Core.nearestNode(g, 55.758, 37.616, 200, 10).node;
  const base = { A, B: A, length: 4000, tol: 0.1, count: 1, seed: 9, maxAttempts: 150 };
  const run = (o) => { const gen = Core.createGenerator(g, o); while (!gen.run(50)); return gen.results().routes[0]; };
  const first = run(base);
  const pull = first.nodes[Math.floor(first.nodes.length / 3)];
  const near = g.adjEdge[g.adjStart[pull]];
  const moved = g.eF[near] === pull ? g.eT[near] : g.eF[near];
  const next = run({ ...base, seed: 10, forced: [moved], prefer: first.edges });
  assert.ok(next.nodes.includes(moved), 'goes through the pulled point');
  assert.ok(next.similar > 0.3, 'similar ' + next.similar);
  assert.ok(Math.abs(next.length - 4000) / 4000 <= 0.35);
});

/* Синтетический файл района: две улицы по 200 м, объект и парк. */
function districtFile() {
  const o = [5575000, 3760000], Q = 1e5;
  const line = (a, b, c, d) => [Math.round(a * Q) - o[0], Math.round(b * Q) - o[1], Math.round((c - a) * Q), Math.round((d - b) * Q)];
  return {
    id: 1, n: 'Тест', v: 7, o,
    s: [
      { n: 'Широкая', t: 35, c: [line(55.751, 37.601, 55.751, 37.6042)] }, /* ≈200 м на восток */
      { c: [line(55.753, 37.601, 55.753, 37.6042)] }
    ],
    ob: [{ n: 'Памятник', c: 'monument', p: [Math.round(55.7512 * Q) - o[0], Math.round(37.6025 * Q) - o[1]], s: 'Широкая' }],
    pk: [{ n: 'Сквер', ha: 2, r: [[Math.round(55.7525 * Q) - o[0], Math.round(37.6015 * Q) - o[1], 100, 0, 0, 200, -100, 0, 0, -200]] }]
  };
}

test('coverage: segments count when the track runs within the street tolerance', () => {
  const dist = Core.decodeDistrict(districtFile());
  assert.equal(dist.streets.length, 2);
  assert.ok(Math.abs(dist.total - 400) < 10, 'total ' + dist.total);
  assert.equal(dist.segLen.length, 16, '25 m segments');
  /* по дальнему тротуару в 30 м от оси: широкая улица засчитана, безымянная — нет */
  const track = [[[55.75127, 37.6008], [55.75127, 37.6044]]];
  const r = Core.coverTrack(dist, track);
  const st = Core.districtStats(dist, r.segs);
  assert.ok(st.byStreet[0] > 190, 'wide street ' + st.byStreet[0]);
  assert.equal(st.byStreet[1], 0);
  assert.deepEqual(r.objs, [0]);
  assert.deepEqual(r.parks, []);
  /* вдвое дальше допуска — ничего */
  assert.equal(Core.coverTrack(dist, [[[55.7518, 37.6008], [55.7518, 37.6044]]]).segs.length, 0);
  /* половина улицы: засчитана только пройденная часть */
  const half = Core.coverTrack(dist, [[[55.753, 37.601], [55.753, 37.6026]]]);
  const hs = Core.districtStats(dist, half.segs);
  assert.ok(hs.byStreet[1] > 80 && hs.byStreet[1] < 120, 'half ' + hs.byStreet[1]);
  /* по своей улице, но дальше 40 м от памятника: он был виден */
  const east = Core.coverTrack(dist, [[[55.75127, 37.6033], [55.75127, 37.6042]]]);
  assert.deepEqual(east.objs, [0]);
  assert.deepEqual(Core.coverTrack(dist, [[[55.753, 37.601], [55.753, 37.6042]]]).objs, [], 'other street, 200 m away');
  /* через парк */
  assert.deepEqual(Core.coverTrack(dist, [[[55.7524, 37.6020], [55.7528, 37.6022]]]).parks, [0]);
  const idx = { d: [{ id: 1, b: [55.75, 37.6, 55.754, 37.605] }, { id: 2, b: [55.8, 37.6, 55.81, 37.61] }] };
  assert.deepEqual(Core.districtsTouched(idx, track), [1]);
});

test('monument names in the dative get «Памятник»', () => {
  assert.equal(Core.placeName({ name: 'Юрию Долгорукому', cat: 'monument' }), 'Памятник Юрию Долгорукому');
  assert.equal(Core.placeName({ name: 'Жертвам теракта 08.08.2000', cat: 'monument' }), 'Памятник Жертвам теракта 08.08.2000');
  assert.equal(Core.placeName({ name: 'Памятный камень на месте баррикады', cat: 'monument' }), 'Памятный камень на месте баррикады');
  assert.equal(Core.placeName({ name: 'Церковь Николая в Хамовниках', cat: 'worship' }), 'Церковь Николая в Хамовниках');
});

test('coverage: a track along the avenue does not count the first metres of cross streets', () => {
  const o = [5575000, 3760000], Q = 1e5;
  const line = (a, b, c, d) => [Math.round(a * Q) - o[0], Math.round(b * Q) - o[1], Math.round((c - a) * Q), Math.round((d - b) * Q)];
  const dist = Core.decodeDistrict({
    id: 2, n: 'Перекрёсток', v: 1, o,
    s: [
      { n: 'Проспект', t: 40, c: [line(55.751, 37.601, 55.751, 37.6042)] },
      { n: 'Поперечная', c: [line(55.751, 37.6025, 55.7535, 37.6025)] } /* на север от проспекта, ≈280 м */
    ]
  });
  const r = Core.coverTrack(dist, [[[55.75127, 37.6008], [55.75127, 37.6044]]]);
  const st = Core.districtStats(dist, r.segs);
  assert.ok(st.byStreet[0] > 190, 'avenue ' + st.byStreet[0]);
  assert.equal(st.byStreet[1], 0, 'cross street stub');
  /* а пробежка по самой поперечной засчитывается */
  const up = Core.districtStats(dist, Core.coverTrack(dist, [[[55.751, 37.60253], [55.7535, 37.60253]]]).segs);
  assert.ok(up.byStreet[1] > 250, 'cross street ' + up.byStreet[1]);
});

test('compact network and context survive a round trip, tiles dedupe shared ways', () => {
  const net = gridNetwork(6);
  net.elements.push({ type: 'node', id: 9001, lat: 55.7501, lon: 37.6001, tags: { barrier: 'gate', access: 'private', note: 'x' } });
  const c = JSON.parse(JSON.stringify(Core.packNetwork(net.elements)));
  const back = Core.unpackNetwork(c);
  const g1 = Core.buildGraph(Core.parseNetwork(net), {});
  const g2 = Core.buildGraph(Core.parseNetwork({ elements: Core.dedupeElements([...back, ...Core.unpackNetwork(c)]) }), {});
  assert.equal(g2.n, g1.n);
  assert.equal(g2.E, g1.E);
  assert.equal(g2.closedGates.length, 1);
  assert.deepEqual(back.find((e) => e.id === 9001).tags, { barrier: 'gate', access: 'private' });

  const ring = [[55.75, 37.6], [55.751, 37.6], [55.751, 37.602], [55.75, 37.602], [55.75, 37.6]];
  const ctx = Core.packContext(
    [{ type: 'way', id: 5, tags: { leisure: 'park', name: 'Сквер' }, rings: [ring] }],
    [{ type: 'node', id: 7, lat: 55.7505, lon: 37.601, tags: { tourism: 'viewpoint', name: 'Вид' } }]);
  const parsed = Core.parseContext({ elements: Core.unpackContext(JSON.parse(JSON.stringify(ctx))) });
  assert.equal(parsed.parks.length, 1);
  assert.deepEqual(parsed.pois.map((p) => p.cat).sort(), ['park', 'view']);
});

test('tilesInBox covers the box with grid tiles', () => {
  const box = [55.75, 37.6, 55.79, 37.66];
  const keys = Core.tilesInBox(box);
  const [x0, y0] = Core.tileOf(box[0], box[1]), [x1, y1] = Core.tileOf(box[2], box[3]);
  assert.equal(keys.length, (x1 - x0 + 1) * (y1 - y0 + 1));
  assert.ok(keys.length >= 4);
  assert.ok(keys.includes(Core.tileKey(...Core.tileOf(55.77, 37.63))));
});
