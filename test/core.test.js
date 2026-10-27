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
  }
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
