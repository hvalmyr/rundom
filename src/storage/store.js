/* Всё личное хранится только в этом браузере (localStorage). */
import { toast } from '../ui/dom.js';

const STORE_KEY = 'rundom.v1';

/* explored — треки до этапа 2; при запуске переезжают в IndexedDB. */
const DEFAULTS = {
  explored: [], A: null, B: null,
  /* дом и выходы, ручной старт кольца; закрытия, зоны и открытые на деле ворота OSM */
  home: null, exits: [], ringStart: null, blocks: [], zones: [], openGates: [],
  /* места, отмеченные «исследовал»: ключ «район|тип|название» → время отметки */
  visited: {},
  prefs: {
    km: 10, kmPresets: [5, 10, 15, 21.1], tol: 0.08, tolSign: 'both', loop: true,
    startMode: 'home', approachMax: 1000, allowRepeats: false,
    dirMode: 'any', dirBearing: 0, dirSpread: 30, districts: [], distStrict: false, distMulti: 'one',
    main: 60, appeal: 40, novelty: 0, poi: 50, avoidSteps: true, strictGates: false, kmStep: 1, pace: '6:00'
  },
  /* v — версия набора слоёв: со 2-й закрытые проходы по умолчанию выключены */
  layers: { explored: true, places: true, gates: false, osm: false, covPlaces: true, legendOpen: false, v: 2 },
  view: { lat: 55.7558, lon: 37.6173, z: 12 },
  theme: 'auto'
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
  /* сохранённые до 2-й версии слоёв: закрытые проходы выключаются один раз, дальше — как выберет человек */
  if (!s.layers || !(s.layers.v >= 2)) { d.layers.gates = false; d.layers.v = 2; }
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
