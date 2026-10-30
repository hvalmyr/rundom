import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildNetwork, streetWay } from '../scripts/data/net.mjs';
import { KX, KY, polyLength } from '../src/core/geo.js';

/* Сеть из путей в метрах от точки в центре Москвы: way(теги, [[x, y], ...]).
   Узлы с одинаковыми координатами — один узел OSM. */
function network(list, opt) {
  const ids = new Map();
  const nid = (x, y) => { const k = x + ',' + y; if (!ids.has(k)) ids.set(k, ids.size + 1); return ids.get(k); };
  const ways = list.map(([t, pts]) => ({ ...streetWay(t), ids: pts.map(([x, y]) => nid(x, y)), pts: pts.map(([x, y]) => [55.75 + y / KY, 37.6 + x / KX]) }));
  return buildNetwork(ways, opt);
}
const street = (name, extra) => ({ highway: 'residential', name, ...extra });
const path = { highway: 'footway' };
/* рамка улиц 300 × 200 м: всё, что к ней привязано, — часть связной сети */
const frame = [
  [street('Северная улица'), [[0, 200], [300, 200]]],
  [street('Южная улица'), [[0, 0], [300, 0]]],
  [street('Западный переулок'), [[0, 0], [0, 200]]],
  [street('Восточный переулок'), [[300, 0], [300, 200]]]
];
const lenOf = (r, f) => r.edges.filter(f).reduce((s, e) => s + polyLength(e.pts), 0);
const near = (e, x, y, d = 2) => e.pts.some((p) => Math.hypot((p[1] - 37.6) * KX - x, (p[0] - 55.75) * KY - y) < d);

test('network: a named street is never removed, even a short dead end', () => {
  const r = network([...frame, [street('Тупиковый переулок'), [[150, 0], [150, 20]]]]);
  assert.ok(Math.abs(lenOf(r, (e) => e.name === 'Тупиковый переулок') - 20) < 1);
  assert.deepEqual(r.metrics.lostNamed, []);
});

test('network: an unnamed dead end of 49 m goes, of 51 m stays', () => {
  const r = network([...frame, [path, [[100, 0], [100, 49]]], [path, [[200, 0], [200, 51]]]]);
  assert.equal(r.edges.filter((e) => !e.name && near(e, 100, 30)).length, 0);
  assert.ok(Math.abs(lenOf(r, (e) => !e.name && near(e, 200, 30)) - 51) < 1);
  assert.equal(r.metrics.deadShort, 0);
});

test('network: a loop shorter than 50 m collapses to one line', () => {
  /* проход с севера на юг; на нём островок: прямая (15 м) и обход через (106, 67) */
  const r = network([...frame,
    [path, [[100, 0], [100, 60]]], [path, [[100, 60], [100, 75]]], [path, [[100, 60], [106, 67], [100, 75]]], [path, [[100, 75], [100, 200]]]]);
  assert.equal(r.edges.filter((e) => near(e, 106, 67)).length, 0);
  assert.ok(Math.abs(lenOf(r, (e) => !e.name) - 200) < 1);
  assert.equal(r.metrics.loopsShort, 0);
});

test('network: the street and its sidewalks are one line, the graph stays connected', () => {
  const r = network([...frame,
    [{ highway: 'footway', footway: 'sidewalk' }, [[0, 8], [300, 8]]],
    [{ highway: 'footway', footway: 'sidewalk' }, [[0, -8], [300, -8]]],
    /* дорожка от тротуара во двор и дальше до северной улицы */
    [path, [[150, 8], [150, 200]]]]);
  assert.ok(lenOf(r, (e) => !e.name && near(e, 50, 8, 3)) < 1, 'тротуар слился с осью');
  assert.equal(r.metrics.parallel3, 0);
  assert.equal(r.metrics.components, 1);
  /* дорожка доведена до оси: связь не потерялась */
  assert.ok(r.edges.some((e) => !e.name && near(e, 150, 0, 1)));
});

test('network: two-sided — more than two lanes or separate carriageways; others are one line', () => {
  const wide = network([...frame, [street('Широкая улица', { lanes: '4' }), [[0, 100], [300, 100]]]]);
  assert.ok(wide.edges.filter((e) => e.name === 'Широкая улица').every((e) => e.two));
  assert.ok(wide.edges.filter((e) => e.name === 'Южная улица').every((e) => !e.two));
  const dual = network([...frame,
    [{ highway: 'secondary', name: 'Проспект', oneway: 'yes', lanes: '2' }, [[0, 90], [300, 90]]],
    [{ highway: 'secondary', name: 'Проспект', oneway: 'yes', lanes: '2' }, [[300, 110], [0, 110]]]]);
  const p = dual.edges.filter((e) => e.name === 'Проспект');
  assert.ok(p.every((e) => e.two));
  assert.ok(Math.abs(lenOf(dual, (e) => e.name === 'Проспект') - 300) < 30, 'одна линия вместо двух');
});

test('network: a yard on a short access goes with it; underground passages connect but are not covered', () => {
  const yard = [[120, 30], [180, 30], [180, 70], [120, 70], [120, 30]];
  const r = network([...frame, [{ highway: 'service' }, [[150, 0], [150, 30]]], [{ highway: 'service' }, yard]]);
  assert.equal(r.edges.filter((e) => !e.name).length, 0);
  assert.equal(streetWay({ highway: 'footway', tunnel: 'yes', layer: '-1' }).conn, true);
  const u = network([...frame, [{ highway: 'footway', tunnel: 'yes', layer: '-1' }, [[0, 100], [300, 100]]]]);
  assert.equal(u.edges.filter((e) => near(e, 150, 100)).length, 0);
});
