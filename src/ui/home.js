/* Старт «от дома»: дом, выходы из него, ручной старт кольца и предел подводки. */
import L from 'leaflet';
import * as Core from '../core/index.js';
import { store, save } from '../storage/store.js';
import { divIcon } from '../map/map.js';
import { $, syncSeg, round5, toast } from './dom.js';

const plural = (n, one, few, many) => {
  const m10 = n % 10, m100 = n % 100;
  return m10 === 1 && m100 !== 11 ? one : (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20) ? few : many);
};

export function initHome(app) {
  const { map, layers, S } = app;
  const homeMode = () => store.prefs.startMode === 'home';

  /* Точка притягивается к ближайшему пешеходному пути, если улицы уже загружены. */
  function snapped(ll) {
    const g = S.graph;
    const s = g ? Core.nearestNode(g, ll.lat, ll.lng, 60, 30) : null;
    return s ? round5([g.lat[s.node], g.lon[s.node]]) : round5([ll.lat, ll.lng]);
  }

  function render() {
    layers.home.clearLayers();
    const on = homeMode();
    $('#homeBox').hidden = !on; $('#pointBox').hidden = on; $('#kmHint').hidden = !on;
    syncSeg($('#startSeg'), 'start', store.prefs.startMode);
    const h = store.home, n = store.exits.length;
    $('#homeInfo').textContent = h
      ? 'Дом · ' + (n ? n + ' ' + plural(n, 'выход', 'выхода', 'выходов') : 'выход у дома')
      : 'Дом не отмечен';
    $('#homeEdit').textContent = h ? 'Изменить' : 'Отметить';
    $('#ringInfo').textContent = store.ringStart ? 'Старт кольца задан вручную' : 'Старт кольца выбирает генератор';
    $('#ringInfo').classList.toggle('muted', !store.ringStart);
    $('#ringClear').hidden = !store.ringStart;
    $('#approachMax').value = store.prefs.approachMax;
    $('#outApproach').textContent = store.prefs.approachMax ? store.prefs.approachMax + ' м' : 'без подводки';
    $('#approachMax').closest('.slider').hidden = !!store.ringStart;
    if (!on) return;
    const editing = S.mode === 'home';
    if (h) {
      const m = L.marker(h, { icon: divIcon('mk-house', 18, 18), draggable: editing, title: 'Дом', keyboard: false });
      m.on('dragend', () => { const ll = m.getLatLng(); store.home = round5([ll.lat, ll.lng]); save(); render(); });
      layers.home.addLayer(m);
    }
    store.exits.forEach((p, i) => {
      const m = L.marker(p, { icon: divIcon('mk-exit', 10, 10), title: editing ? 'Убрать выход' : 'Выход', keyboard: false, interactive: editing });
      if (editing) m.on('click', (e) => { L.DomEvent.stop(e); store.exits.splice(i, 1); save(); render(); });
      layers.home.addLayer(m);
    });
    if (store.ringStart) layers.home.addLayer(L.marker(store.ringStart, { icon: divIcon('mk-ring', 14, 14), title: 'Старт кольца', interactive: false, keyboard: false }));
  }
  app.renderHome = render;

  $('#startSeg').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    store.prefs.startMode = b.dataset.start; save(); render(); app.emit('start');
  });

  /* режим «дом»: первый клик — дом, следующие — выходы; клик по выходу убирает его */
  app.registerMode('home', {
    click(ll) {
      if (!store.home) store.home = round5([ll.lat, ll.lng]);
      else store.exits.push(snapped(ll));
      save(); render();
      $('#bannerText').textContent = 'Отметьте выходы на улицу. Клик по выходу убирает его';
    },
    undo() {
      if (store.exits.length) store.exits.pop(); else store.home = null;
      save(); render();
    },
    ok() { app.setMode(null); },
    leave() { setTimeout(render); }
  });
  $('#homeEdit').addEventListener('click', () => {
    app.setMode('home', store.home
      ? 'Отметьте выходы на улицу. Клик по выходу убирает его'
      : 'Нажмите на карте, где дом');
    render();
    if (store.home) map.setView(store.home, Math.max(map.getZoom(), 16));
  });

  app.registerMode('ring', {
    click(ll) { store.ringStart = snapped(ll); save(); app.setMode(null); render(); }
  });
  $('#ringPick').addEventListener('click', () => {
    if (!store.home) { toast('Сначала отметьте дом.'); return; }
    app.setMode('ring', 'Нажмите, где начать кольцо. Подводка от дома может быть длиннее предела');
  });
  $('#ringClear').addEventListener('click', () => { store.ringStart = null; save(); render(); });

  $('#approachMax').addEventListener('input', (e) => { store.prefs.approachMax = parseInt(e.target.value, 10); save(); render(); });

  render();
}
