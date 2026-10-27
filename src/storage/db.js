/* IndexedDB: треки и избранные маршруты. Геометрия большая, localStorage на ~5 МБ её не вместит.
   Наружу ничего не уходит: база живёт только в этом браузере. */

const DB_NAME = 'rundom';
const VERSION = 1;
export const STORES = ['tracks', 'favorites'];

let dbp = null;
function open() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const s of STORES) if (!db.objectStoreNames.contains(s)) db.createObjectStore(s, { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}

function tx(store, mode, fn) {
  return open().then((db) => new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const result = fn(t.objectStore(store));
    t.oncomplete = () => resolve(result && 'result' in result ? result.result : undefined);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  }));
}

export const all = (store) => tx(store, 'readonly', (s) => s.getAll());
export const put = (store, value) => tx(store, 'readwrite', (s) => s.put(value));
export const del = (store, id) => tx(store, 'readwrite', (s) => s.delete(id));
export const putMany = (store, values) => tx(store, 'readwrite', (s) => { for (const v of values) s.put(v); });

/* Коллекция: массив в памяти для синхронной отрисовки и запись в базу в фоне. */
export function collection(name, onError) {
  const items = [];
  const fail = (e) => onError && onError(e);
  return {
    items,
    async load() { items.splice(0, items.length, ...(await all(name))); items.sort((a, b) => (a.created || 0) - (b.created || 0)); },
    add(v) { items.push(v); return put(name, v).catch(fail); },
    update(v) { return put(name, v).catch(fail); },
    remove(id) {
      const i = items.findIndex((x) => x.id === id);
      if (i >= 0) items.splice(i, 1);
      return del(name, id).catch(fail);
    },
    get(id) { return items.find((x) => x.id === id); },
    merge(values) {
      const have = new Set(items.map((x) => x.id));
      const fresh = values.filter((v) => v && v.id && !have.has(v.id));
      items.push(...fresh);
      return putMany(name, fresh).catch(fail).then(() => fresh.length);
    }
  };
}
