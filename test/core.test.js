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
