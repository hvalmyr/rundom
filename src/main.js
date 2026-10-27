/* rundom: точка входа. Собирает карту, вкладки и панели вокруг общего состояния. */
import 'leaflet/dist/leaflet.css';
import './styles/tokens.css';
import './styles/app.css';

import { store, save } from './storage/store.js';
import { collection } from './storage/db.js';
import { createMap } from './map/map.js';
import { $, toast, uid, smoothDetails } from './ui/dom.js';
import { initModes } from './ui/modes.js';
import { initSheet } from './ui/sheet.js';
import { initRoutePanel } from './ui/route-panel.js';
import { initHome } from './ui/home.js';
import { initBlocks } from './ui/blocks.js';
import { initGates } from './ui/gates.js';
import { initDirection } from './ui/direction.js';
import { initRope } from './ui/rope.js';
import { initLibraryPanel } from './ui/library-panel.js';
import { initCoverage } from './ui/coverage.js';
import { initPlaces } from './ui/places.js';
import { initCoverageMap } from './ui/coverage-map.js';
import { initSettings } from './ui/settings.js';

/* офлайн-кэш: только в собранном сайте, в разработке он мешал бы перезагрузке модулей */
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch((e) => console.warn('service worker', e));
}

const { map, gl, layers, svg, svgTop, setTiles, toggleLayer } = createMap();

const dbError = () => toast('Браузер не даёт сохранить данные. Скачайте копию в настройках.');
const tracks = collection('tracks', dbError);
const favorites = collection('favorites', dbError);
try { await Promise.all([tracks.load(), favorites.load()]); }
catch (e) { toast('Хранилище браузера недоступно: треки и избранное не сохранятся после закрытия.'); }

/* перенос треков из localStorage (этап 1) в IndexedDB */
if (store.explored.length) {
  const moved = await tracks.merge(store.explored.map((x) => ({ created: Date.now(), ...x, id: x.id || uid() })));
  if (moved || tracks.items.length) { store.explored = []; save(); }
}

const listeners = {};
const app = {
  map, gl, layers, svg, svgTop, setTiles, tracks, favorites, tab: 'route',
  S: {
    mode: null, routes: [], sel: -1, net: null, graph: null, graphKey: '', router: null,
    osmPois: [], forced: [], busy: false, abort: null, lastGen: null, shown: {}
  },
  on(ev, fn) { (listeners[ev] = listeners[ev] || []).push(fn); },
  emit(ev) { (listeners[ev] || []).forEach((fn) => fn()); }
};

/* ---------- вкладки ---------- */
const TABS = ['route', 'library', 'progress'];
for (const t of TABS) {
  $('#tab-' + t).addEventListener('click', () => {
    for (const u of TABS) {
      $('#tab-' + u).setAttribute('aria-selected', String(u === t));
      $('#pane-' + u).hidden = u !== t;
    }
    $('#panel').scrollTop = 0;
    app.sheet.open();
    app.tab = t; app.emit('tab');
  });
}

/* ---------- слои на карте ---------- */
function syncLayers() {
  const ly = store.layers;
  $('#lyExplored').checked = ly.explored; $('#lyPlaces').checked = ly.osm; $('#lyGates').checked = ly.gates;
  gl.visible('explored', ly.explored);
  /* ворот во дворах тысячи: показываем их только вблизи */
  toggleLayer(layers.gates, ly.gates && map.getZoom() >= 15); toggleLayer(layers.closed, ly.gates && map.getZoom() >= 14);
  toggleLayer(layers.osm, ly.osm);
}
app.syncLayers = syncLayers;
map.on('zoomend', syncLayers);
for (const [id, key] of [['#lyExplored', 'explored'], ['#lyPlaces', 'osm'], ['#lyGates', 'gates']]) {
  $(id).addEventListener('change', (e) => { store.layers[key] = e.target.checked; syncLayers(); save(); app.emit('layers'); });
}
/* легенда слоёв свёрнута в кнопку и раскрывается по нажатию */
function syncLegend() {
  const open = !!store.layers.legendOpen;
  $('#mtToggle').setAttribute('aria-expanded', String(open));
  $('#mtBody').hidden = !open;
}
$('#mtToggle').addEventListener('click', () => { store.layers.legendOpen = !store.layers.legendOpen; save(); syncLegend(); });
syncLegend();

initSheet(app);
smoothDetails();
initModes(app);
initHome(app);
initBlocks(app);
initGates(app);
initDirection(app);
initRoutePanel(app);
initRope(app);
initCoverage(app);
initLibraryPanel(app);
initPlaces(app);
initCoverageMap(app);
initSettings(app);
syncLayers();

window.__rundom = app;
