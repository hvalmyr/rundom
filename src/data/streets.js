/* Улицы, парки и места для генератора. Порядок источников:
   1) свой граф — тайлы из ежемесячной выгрузки OSM (public/data/g, scripts/data/graph.mjs), там, где он есть;
   2) кэш прежних ответов Overpass в IndexedDB, если зона уже загружалась;
   3) Overpass: улицы и парки двумя запросами параллельно, ответ уходит в кэш. */
import * as Core from '../core/index.js';
import { all, put, del } from '../storage/db.js';
import { overpass } from './overpass.js';

const BASE = './data/g/';
const AREAS = 'areas';
const MAX_AREAS = 8;
const MAX_AGE = 30 * 864e5;
/* версия записи кэша: с 2 в ней есть светофоры (подсчёт регулируемых переходов) */
const AREA_V = 2;

let indexP = null;
function tileIndex() {
  if (!indexP) {
    indexP = fetch(BASE + 'index.json')
      .then((r) => (r.ok ? r.json() : null))
      .then((ix) => (ix ? { ...ix, have: new Set(ix.tiles), cover: new Set(ix.cover) } : null))
      .catch(() => null);
  }
  return indexP;
}

/* прямоугольник вокруг отрезка A–B с запасом R */
function boxOf(need) {
  const dLat = need.R / 111320;
  const lat = (need.A[0] + need.B[0]) / 2;
  const dLon = need.R / (111320 * Math.cos(lat * Math.PI / 180));
  return [
    Math.min(need.A[0], need.B[0]) - dLat, Math.min(need.A[1], need.B[1]) - dLon,
    Math.max(need.A[0], need.B[0]) + dLat, Math.max(need.A[1], need.B[1]) + dLon
  ];
}
/* Разобранные тайлы держим в памяти: их читают и генератор, и слой закрытых проходов. */
const tileCache = new Map(), TILE_CACHE = 48;
function getTile(k, signal) {
  let p = tileCache.get(k);
  if (!p) {
    p = fetch(BASE + k + '.json', { signal }).then((r) => {
      if (!r.ok) throw new Error('Тайл улиц ' + k + ': HTTP ' + r.status);
      return r.json();
    });
    p.catch(() => tileCache.delete(k));
    tileCache.set(k, p);
    if (tileCache.size > TILE_CACHE) tileCache.delete(tileCache.keys().next().value);
  }
  return p;
}
async function fromTiles(ix, keys, signal) {
  keys = keys.filter((k) => ix.have.has(k));
  const tiles = await Promise.all(keys.map((k) => getTile(k, signal)));
  const net = [], ctx = [];
  for (const t of tiles) { Core.unpackNetwork(t.net, net); Core.unpackContext(t.ctx, ctx); }
  return {
    parsed: Core.parseNetwork({ elements: Core.dedupeElements(net) }),
    ctx: Core.parseContext({ elements: Core.dedupeElements(ctx) }),
    date: ix.date
  };
}

/* Тайлы графа в прямоугольнике [юг, запад, север, восток] для слоя закрытых проходов:
   {covered — область целиком в покрытии тайлов, tiles: [{key, net}]}. Без тайлов на сайте — null. */
export async function viewTiles(box) {
  const ix = await tileIndex();
  if (!ix) return null;
  const keys = Core.tilesInBox(box, ix.grid);
  if (keys.length > 16) return null;
  const tiles = [];
  for (const k of keys.filter((x) => ix.have.has(x))) {
    try { tiles.push({ key: k, net: (await getTile(k)).net }); } catch (e) { /* тайл не загрузился */ }
  }
  return { covered: keys.every((k) => ix.cover.has(k)), tiles };
}

/* ---------- кэш ответов Overpass ---------- */
async function cachedArea(need) {
  let list;
  try { list = await all(AREAS); } catch { return null; }
  const now = Date.now();
  const stale = (a) => now - a.created > MAX_AGE || (a.v || 1) < AREA_V;
  for (const a of list) if (stale(a)) del(AREAS, a.id).catch(() => {});
  return list.find((a) => !stale(a) && Core.regionContains(a.region, need)) || null;
}

async function saveArea(need, net, ctx) {
  try {
    const list = (await all(AREAS)).sort((a, b) => a.created - b.created);
    /* зона внутри новой больше не нужна */
    for (const a of list) if (Core.regionContains(need, a.region)) await del(AREAS, a.id);
    const left = list.filter((a) => !Core.regionContains(need, a.region));
    for (const a of left.slice(0, Math.max(0, left.length - MAX_AREAS + 1))) await del(AREAS, a.id);
    await put(AREAS, { id: Date.now().toString(36), v: AREA_V, region: need, created: Date.now(), net, ctx });
  } catch (e) { console.warn('кэш улиц', e); }
}

function fromPacked(a) {
  return {
    parsed: Core.parseNetwork({ elements: Core.unpackNetwork(a.net) }),
    ctx: a.ctx ? Core.parseContext({ elements: Core.unpackContext(a.ctx) }) : null
  };
}

/* say(text) — строка состояния. Возвращает {parsed, ctx, source: 'tiles'|'cache'|'overpass', ctxFailed}. */
export async function loadStreets(need, signal, say) {
  const box = boxOf(need);
  const ix = await tileIndex();
  const keys = ix ? Core.tilesInBox(box, ix.grid) : [];
  /* у края выгрузки (восток Москвы за МКАД) часть зоны без тайлов: если старт и финиш в покрытии
     и почти вся зона есть, берём тайлы — край просто без улиц, а не минута ожидания Overpass */
  const inCover = (p) => ix && ix.cover.has(Core.tileKey(...Core.tileOf(p[0], p[1], ix.grid)));
  if (ix && (keys.every((k) => ix.cover.has(k)) ||
    (inCover(need.A) && inCover(need.B) && keys.filter((k) => ix.have.has(k)).length >= 0.75 * keys.length))) {
    say('Загружаю улицы…');
    try {
      return { ...(await fromTiles(ix, keys, signal)), source: 'tiles' };
    } catch (e) {
      if (signal.aborted) throw e;
      console.warn('тайлы улиц', e);
    }
  }

  const hit = await cachedArea(need);
  if (hit) {
    say('Беру улицы из сохранённых на устройстве…');
    return { ...fromPacked(hit), source: 'cache', created: hit.created };
  }

  say('Загружаю улицы в радиусе ' + (need.R / 1000).toFixed(1).replace('.', ',') + ' км вокруг старта. Это может занять до минуты…');
  const area = Core.aroundStr(need.R, need.A, need.B);
  /* парки не обязательны: их ошибка не роняет загрузку; отмену ловит запрос улиц и проверка ниже */
  const ctxP = overpass(Core.contextQuery(area), signal).catch(() => null);
  const netJson = await overpass(Core.networkQuery(area), signal);
  const net = Core.packNetwork(netJson.elements || []);
  if (!net.w.length) throw new Error('В этой зоне не нашлось улиц.');
  say('Загружаю парки и интересные места…');
  const ctxJson = await ctxP;
  if (signal.aborted) throw new DOMException('Отменено', 'AbortError');
  let ctx = null;
  if (ctxJson) {
    const c = Core.contextFromOverpass(ctxJson.elements || []);
    ctx = Core.packContext(c.parks, c.pois);
  }
  saveArea(need, net, ctx);
  return { ...fromPacked({ net, ctx }), source: 'overpass', ctxFailed: !ctxJson };
}
