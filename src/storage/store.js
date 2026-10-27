/* Всё личное хранится только в этом браузере (localStorage). */
import { toast } from '../ui/dom.js';

const STORE_KEY = 'rundom.v1';

const DEFAULTS = {
  explored: [], A: null, B: null,
  prefs: {
    km: 10, kmPresets: [5, 10, 15, 21.1], tol: 0.08, loop: true,
    main: 60, appeal: 40, novelty: 0, poi: 50, avoidSteps: true, strictGates: false, kmStep: 1, pace: '6:00'
  },
  layers: { explored: true, places: true, gates: true, osm: false },
  view: { lat: 55.7558, lon: 37.6173, z: 12 },
  theme: 'auto', tiles: 'carto'
};

const MERGED = ['prefs', 'layers', 'view'];

function load() {
  let s = null;
  try { s = JSON.parse(localStorage.getItem(STORE_KEY)); } catch (e) { s = null; }
  const d = structuredClone(DEFAULTS);
  if (!s || typeof s !== 'object') return d;
  for (const k of Object.keys(s)) {
    if (MERGED.includes(k)) Object.assign(d[k], s[k]);
    else if (k in d) d[k] = s[k];
  }
  return d;
}

export const store = load();

let saveTimer = null, warned = false;
export function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(store)); }
    catch (e) {
      if (!warned) { warned = true; toast('Браузер не даёт сохранить данные. Скачайте копию в настройках.'); }
    }
  }, 150);
}

export const BACKUP_APP = 'rundom';
