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
