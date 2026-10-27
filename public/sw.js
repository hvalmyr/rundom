/* Офлайн-кэш rundom: приложение, данные покрытия и шрифты. Куски файла тайлов, которые уже
   смотрели, кэширует сама карта (src/map/pmtiles.js, кэш rd-tiles-v2): здесь его только не удаляем.
   На пробежке со слабой связью карта и приложение открываются из кэша.
   Запросы Overpass и Википедии не кэшируются: это живые данные. */
const SHELL = 'rd-shell-v2';
const DATA = 'rd-data-v1';
const TILES = 'rd-tiles-v2';

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(['./', './index.html'])).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  const keep = new Set([SHELL, DATA, TILES]);
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k.startsWith('rd-') && !keep.has(k)).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

const isFont = (u) => u.hostname === 'fonts.googleapis.com' || u.hostname === 'fonts.gstatic.com';

self.addEventListener('fetch', (e) => {
  const req = e.request;
  /* запросы кусков файла (Range) кэш браузера не хранит: их кэширует карта */
  if (req.method !== 'GET' || req.headers.has('range')) return;
  const u = new URL(req.url);
  const local = u.origin === self.location.origin;
  if (req.mode === 'navigate') e.respondWith(networkFirst(req, SHELL));
  else if (local && u.pathname.includes('/assets/')) e.respondWith(cacheFirst(req, SHELL));
  else if (local && u.pathname.includes('/data/')) e.respondWith(networkFirst(req, DATA));
  else if (isFont(u)) e.respondWith(cacheFirst(req, SHELL));
});

async function networkFirst(req, name) {
  const cache = await caches.open(name);
  try {
    const res = await fetch(req);
    if (res.ok) cache.put(req, res.clone());
    return res;
  } catch (err) {
    const hit = await cache.match(req, { ignoreSearch: req.mode === 'navigate' });
    if (hit) return hit;
    if (req.mode === 'navigate') {
      const shell = await cache.match('./index.html');
      if (shell) return shell;
    }
    throw err;
  }
}

async function cacheFirst(req, name) {
  const cache = await caches.open(name);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  /* стили Google Fonts приходят без CORS (opaque): их тоже храним, иначе офлайн нет шрифта */
  if (res.ok || res.type === 'opaque') await cache.put(req, res.clone());
  return res;
}
