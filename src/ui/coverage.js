/* Покрытие улиц внутри МКАД. Данные районов лежат рядом с сайтом (./data), грузятся по требованию;
   расчёт идёт в браузере, результат хранится в записи трека (IndexedDB) вместе с версией данных. */
import * as Core from '../core/index.js';
import { $, toast } from './dom.js';

const BASE = './data/';
const fmtDate = (s) => new Date(s + 'T00:00:00').toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });

export function initCoverage(app) {
  const { tracks } = app;
  const dists = new Map(), running = new Map();
  const C = { index: null };
  app.coverage = C;

  C.ready = fetch(BASE + 'index.json')
    .then((r) => (r.ok ? r.json() : null))
    .then((j) => { C.index = j && j.v ? j : null; return C.index; })
    .catch(() => null);

  C.district = (id) => {
    if (!dists.has(id)) {
      const p = fetch(BASE + 'd/' + id + '.json')
        .then((r) => { if (!r.ok) throw new Error('data ' + r.status); return r.json(); })
        .then(Core.decodeDistrict);
      p.catch(() => dists.delete(id));
      dists.set(id, p);
    }
    return dists.get(id);
  };

  async function compute(t) {
    const idx = C.index, d = {}, o = [], p = [];
    const grid = Core.trackGrid(t.lines);
    for (const id of Core.districtsTouched(idx, t.lines)) {
      const r = Core.coverTrack(await C.district(id), t.lines, grid);
      if (r.segs.length) d[id] = r.segs;
      for (const i of r.objs) o.push(id + ':' + i);
      for (const i of r.parks) p.push(id + ':' + i);
    }
    return { v: ver(), d, o, p };
  }
  const ver = () => C.index.v + '.' + Core.COVER_VERSION;
  const fresh = (t) => t.cov && C.index && t.cov.v === ver();

  /* Покрытие трека: из записи, если версия данных та же, иначе пересчёт и сохранение. */
  C.ensure = (t) => {
    if (!C.index || fresh(t)) return Promise.resolve(t.cov || null);
    if (!running.has(t.id)) {
      running.set(t.id, compute(t).then((cov) => { t.cov = cov; tracks.update(t); return cov; })
        .finally(() => running.delete(t.id)));
    }
    return running.get(t.id);
  };

  /* Пройденные метры в районах ids по набору треков (участки объединяются). */
  async function doneIn(list, ids) {
    let sum = 0;
    for (const id of ids) {
      const dist = await C.district(id), masks = new Map();
      for (const t of list) Core.coveredMap((t.cov && t.cov.d[id]) || [], masks);
      for (const [s, m] of masks) sum += dist.segLen[s] * (dist.segTwo[s] ? ((m & 1) + ((m >> 1) & 1)) / 2 : 1);
    }
    return sum;
  }

  /* Итог загрузки: прирост покрытия МКАД и встреченные объекты (новые — впервые). */
  C.summary = async (added) => {
    if (!(await C.ready)) return null;
    for (const t of added) await C.ensure(t);
    const others = tracks.items.filter((t) => !added.includes(t));
    const ids = [...new Set(added.flatMap((t) => Object.keys(t.cov.d)))];
    const gain = (await doneIn(tracks.items, ids)) - (await doneIn(others, ids));
    const before = new Set(others.flatMap((t) => (t.cov ? [...t.cov.o, ...t.cov.p.map((k) => 'p' + k)] : [])));
    const met = [], seen = new Set();
    const push = async (key, park) => {
      const k = park ? 'p' + key : key;
      if (seen.has(k)) return;
      seen.add(k);
      const [id, i] = key.split(':');
      const dist = await C.district(id), item = park ? dist.parks[i] : dist.objects[i];
      if (item) met.push({ n: item.n, c: park ? 'park' : item.c, isNew: !before.has(k) });
    };
    for (const t of added) {
      for (const k of t.cov.p) await push(k, true);
      for (const k of t.cov.o) await push(k, false);
    }
    met.sort((a, b) => (b.isNew - a.isNew) || ((b.c === 'park') - (a.c === 'park')));
    return { gainShare: gain / (await C.networkM()), gainKm: gain / 1000, met };
  };

  /* Длина всех улиц внутри МКАД, м: считается по файлам районов один раз. */
  let networkP = null;
  C.networkM = () => networkP || (networkP = (async () => {
    let sum = 0;
    for (const d of C.index.d) { try { sum += (await C.district(d.id)).total; } catch (e) { sum += d.km * 1000; } }
    return sum;
  })());

  /* Участки района, пройденные хоть одним треком: участок → маска сторон. */
  C.covered = (id) => {
    const map = new Map();
    for (const t of tracks.items) Core.coveredMap((t.cov && t.cov.d[id]) || [], map);
    return map;
  };
  /* Встреченные объекты и парки: «район:номер» (парки с префиксом p). */
  C.met = () => {
    const set = new Set();
    for (const t of tracks.items) if (t.cov) { for (const k of t.cov.o) set.add(k); for (const k of t.cov.p) set.add('p' + k); }
    return set;
  };
  /* Ключ места, переживающий обновление данных. */
  C.placeKey = (id, cat, name) => id + '|' + cat + '|' + name;
  /* Сводка по району (нужен загруженный файл). */
  C.stats = async (id) => {
    const dist = await C.district(id);
    return { dist, ...Core.districtStats(dist, C.covered(id)) };
  };
  /* Районы, где есть хоть один пройденный участок. */
  C.touched = () => new Set(tracks.items.flatMap((t) => (t.cov ? Object.keys(t.cov.d).map(Number) : [])));

  /* Фоновый пересчёт треков без покрытия или со старой версией данных. */
  async function refreshAll() {
    if (!(await C.ready)) return;
    const todo = tracks.items.filter((t) => !fresh(t));
    if (!todo.length) return;
    const st = $('#covStatus');
    let n = 0;
    for (const t of todo) {
      if (todo.length > 3) { st.hidden = false; st.textContent = `Считаем покрытие улиц: ${n} из ${todo.length} треков`; }
      try { await C.ensure(t); } catch (e) { /* район не загрузился — посчитаем в другой раз */ }
      n++;
      await new Promise((r) => setTimeout(r, 0));
    }
    st.hidden = true;
    app.emit('coverage');
  }
  C.refreshAll = refreshAll;

  C.ready.then((idx) => {
    const box = $('#dataDate');
    box.textContent = idx
      ? 'Данные OpenStreetMap от ' + fmtDate(idx.date) + ': ' + idx.d.length + ' районов внутри МКАД, ' + Math.round(idx.km).toLocaleString('ru-RU') + ' км улиц и дорожек без коротких тупиков.'
      : 'Данные покрытия улиц не загрузились: проценты по МКАД появятся, когда сайт сможет их получить.';
    if (idx) setTimeout(() => refreshAll().catch(() => toast('Не удалось посчитать покрытие улиц.')), 1500);
  });
}
