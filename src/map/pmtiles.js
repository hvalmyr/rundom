/* Чтение PMTiles v3 по HTTP Range: тайлы подложки лежат одним файлом рядом с сайтом.
   Прочитанные куски хранятся в Cache Storage — карта, которую уже смотрели, открывается без сети.
   Новый файл (после ежемесячной сборки) узнаём по заголовку и сбрасываем старые куски. */

const CACHE = 'rd-tiles-v2';
const CACHE_LIMIT = 6000;
const HEADER_BYTES = 16384;

const files = new Map();
let puts = 0;

/* tile id по кривой Гильберта, как в спецификации PMTiles */
function tileId(z, x, y) {
  let acc = 0;
  for (let t = 0; t < z; t++) acc += 4 ** t;
  let d = 0;
  for (let s = 1 << (z - 1); s > 0; s >>= 1) {
    const rx = (x & s) > 0 ? 1 : 0, ry = (y & s) > 0 ? 1 : 0;
    d += s * s * ((3 * rx) ^ ry);
    if (ry === 0) {
      if (rx === 1) { x = s - 1 - x; y = s - 1 - y; }
      [x, y] = [y, x];
    }
  }
  return acc + d;
}

async function decompress(buf, kind) {
  if (kind === 1 || kind === 0) return buf;
  if (kind !== 2) throw new Error('pmtiles: unsupported compression ' + kind);
  const s = new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(s).arrayBuffer());
}

function readHeader(b) {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (String.fromCharCode(...b.subarray(0, 7)) !== 'PMTiles' || b[7] !== 3) throw new Error('pmtiles: not a v3 file');
  const u64 = (o) => v.getUint32(o, true) + v.getUint32(o + 4, true) * 2 ** 32;
  const deg = (o) => v.getInt32(o, true) / 1e7;
  return {
    rootOffset: u64(8), rootLength: u64(16),
    leafOffset: u64(40), tileOffset: u64(56),
    internal: b[97], compression: b[98],
    minzoom: b[100], maxzoom: b[101],
    bounds: [deg(102), deg(106), deg(110), deg(114)]
  };
}

function readDirectory(b) {
  let p = 0;
  const varint = () => {
    let n = 0, mul = 1, c;
    do { c = b[p++]; n += (c & 0x7f) * mul; mul *= 128; } while (c & 0x80);
    return n;
  };
  const count = varint(), entries = new Array(count);
  let last = 0;
  for (let i = 0; i < count; i++) { last += varint(); entries[i] = { id: last, run: 0, length: 0, offset: 0 }; }
  for (const e of entries) e.run = varint();
  for (const e of entries) e.length = varint();
  for (let i = 0; i < count; i++) {
    const o = varint();
    entries[i].offset = o === 0 && i > 0 ? entries[i - 1].offset + entries[i - 1].length : o - 1;
  }
  return entries;
}

function findEntry(entries, id) {
  let lo = 0, hi = entries.length - 1;
  while (lo <= hi) {
    const k = (lo + hi) >> 1, c = id - entries[k].id;
    if (c > 0) lo = k + 1; else if (c < 0) hi = k - 1; else return entries[k];
  }
  if (hi >= 0) {
    const e = entries[hi];
    if (e.run === 0 || id - e.id < e.run) return e;
  }
  return null;
}

const key = (url, from, len) => url + (url.includes('?') ? '&' : '?') + 'r=' + from + '-' + (from + len - 1);

async function openCache() {
  try { return await caches.open(CACHE); } catch { return null; }
}

async function fetchRange(url, from, len, signal) {
  const res = await fetch(url, { headers: { Range: `bytes=${from}-${from + len - 1}` }, signal });
  if (!res.ok) throw new Error('pmtiles: HTTP ' + res.status);
  const buf = new Uint8Array(await res.arrayBuffer());
  /* сервер без Range отдаст весь файл целиком */
  return res.status === 200 && buf.length > len ? buf.subarray(from, from + len) : buf;
}

async function cachedRange(f, from, len, signal) {
  const k = key(f.url, from, len);
  const hit = f.cache && await f.cache.match(k);
  if (hit) return new Uint8Array(await hit.arrayBuffer());
  const buf = await fetchRange(f.url, from, len, signal);
  if (f.cache) {
    f.cache.put(k, new Response(buf)).catch(() => {});
    if (++puts % 200 === 0) trim(f.cache);
  }
  return buf;
}

async function trim(cache) {
  const keys = await cache.keys();
  for (const k of keys.slice(0, Math.max(0, keys.length - CACHE_LIMIT))) await cache.delete(k);
}

/* Заголовок — всегда из сети, если она есть: по нему видно, что файл пересобран. */
async function open(url) {
  const cache = await openCache();
  const hk = url + (url.includes('?') ? '&' : '?') + 'r=header';
  let head;
  try {
    head = await fetchRange(url, 0, HEADER_BYTES);
    const old = cache && await cache.match(hk);
    const same = old && equal(new Uint8Array(await old.arrayBuffer()).subarray(0, 127), head.subarray(0, 127));
    if (cache && !same) {
      for (const k of await cache.keys()) if (k.url.startsWith(url)) await cache.delete(k);
      await cache.put(hk, new Response(head));
    }
  } catch (e) {
    const old = cache && await cache.match(hk);
    if (!old) throw e;
    head = new Uint8Array(await old.arrayBuffer());
  }
  const h = readHeader(head);
  const root = readDirectory(await decompress(head.slice(h.rootOffset, h.rootOffset + h.rootLength), h.internal));
  return { url, cache, h, root, leaves: new Map() };
}

function equal(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function file(url) {
  if (!files.has(url)) {
    const p = open(url);
    p.catch(() => files.delete(url));
    files.set(url, p);
  }
  return files.get(url);
}

async function leaf(f, from, len, signal) {
  const k = from + ':' + len;
  if (!f.leaves.has(k)) {
    const p = cachedRange(f, f.h.leafOffset + from, len, signal)
      .then((b) => decompress(b, f.h.internal)).then(readDirectory);
    p.catch(() => f.leaves.delete(k));
    f.leaves.set(k, p);
  }
  return f.leaves.get(k);
}

async function tile(url, z, x, y, signal) {
  const f = await file(url);
  if (z < f.h.minzoom || z > f.h.maxzoom) return null;
  const id = tileId(z, x, y);
  let dir = f.root;
  for (let depth = 0; depth < 4; depth++) {
    const e = findEntry(dir, id);
    if (!e) return null;
    if (e.run > 0) return decompress(await cachedRange(f, f.h.tileOffset + e.offset, e.length, signal), f.h.compression);
    dir = await leaf(f, e.offset, e.length, signal);
  }
  return null;
}

/* Источник для стиля: границы и масштабы берутся из заголовка файла. */
export async function pmtilesSource(url) {
  const f = await file(url);
  return {
    type: 'vector', tiles: ['pmtiles://' + url + '#{z}/{x}/{y}'],
    minzoom: f.h.minzoom, maxzoom: f.h.maxzoom, bounds: f.h.bounds
  };
}

/* Обработчик протокола pmtiles:// для maplibregl.addProtocol */
export async function pmtilesProtocol(params, abort) {
  const [url, zxy] = params.url.slice('pmtiles://'.length).split('#');
  const [z, x, y] = zxy.split('/').map(Number);
  const data = await tile(url, z, x, y, abort?.signal);
  return { data: data || new Uint8Array(0) };
}
