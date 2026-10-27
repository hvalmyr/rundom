/* rundom: точка входа. Собирает карту, вкладки и панели вокруг общего состояния. */
import 'leaflet/dist/leaflet.css';
import './styles/tokens.css';
import './styles/app.css';

import { store, save } from './storage/store.js';
import { collection } from './storage/db.js';
import { createMap } from './map/map.js';
import { $, toast, uid } from './ui/dom.js';
import { initModes } from './ui/modes.js';
import { initSheet } from './ui/sheet.js';
import { initRoutePanel } from './ui/route-panel.js';
import { initHome } from './ui/home.js';
import { initBlocks } from './ui/blocks.js';
import { initDirection } from './ui/direction.js';
import { initRope } from './ui/rope.js';
import { initLibraryPanel } from './ui/library-panel.js';
import { initProgressPanel } from './ui/progress-panel.js';
import { initSettings } from './ui/settings.js';

const { map, layers, svg, svgTop, setTiles, toggleLayer } = createMap();

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
  map, layers, svg, svgTop, setTiles, tracks, favorites,
  S: {
    mode: null, routes: [], sel: -1, net: null, graph: null, graphKey: '', router: null,
    osmPois: [], forced: [], busy: false, abort: null, lastGen: null
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
  });
}

/* ---------- слои на карте ---------- */
function syncLayers() {
  const ly = store.layers;
  $('#lyExplored').checked = ly.explored; $('#lyPlaces').checked = ly.osm; $('#lyGates').checked = ly.gates;
  $('#showOsm').checked = ly.osm;
  toggleLayer(layers.explored, ly.explored);
  /* ворот во дворах тысячи: показываем их только вблизи */
  toggleLayer(layers.gates, ly.gates && map.getZoom() >= 16); toggleLayer(layers.closed, ly.gates);
  toggleLayer(layers.osm, ly.osm);
}
app.syncLayers = syncLayers;
map.on('zoomend', syncLayers);
for (const [id, key] of [['#lyExplored', 'explored'], ['#lyPlaces', 'osm'], ['#lyGates', 'gates']]) {
  $(id).addEventListener('change', (e) => { store.layers[key] = e.target.checked; syncLayers(); });
}

initSheet(app);
initModes(app);
initHome(app);
initBlocks(app);
initDirection(app);
initRoutePanel(app);
initRope(app);
initLibraryPanel(app);
initProgressPanel(app);
initSettings(app);
syncLayers();

window.__rundom = app;
