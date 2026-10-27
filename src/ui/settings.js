/* Настройки: тема, обозначения и резервная копия. */
import { store, save, BACKUP_APP } from '../storage/store.js';
import { $, el, toast, download, syncSeg } from './dom.js';

const LEGEND = [
  ['<path d="M2 10H38" style="stroke:var(--paper);stroke-width:9;stroke-linecap:round"/><path d="M2 10H38" style="stroke:var(--map-route);stroke-width:5;stroke-linecap:round"/>', 'Маршрут'],
  ['<path d="M2 10H38" style="stroke:var(--ink-muted);stroke-width:3;opacity:.45;stroke-linecap:round"/>', 'Другие варианты: нажмите, чтобы выбрать'],
  ['<path d="M2 10H38" style="stroke:var(--map-explored);stroke-width:2.5;stroke-linecap:round"/>', 'Пройденные улицы'],
  ['<circle cx="20" cy="10" r="7" style="fill:var(--paper);stroke:var(--petrol);stroke-width:3.5"/>', 'Старт'],
  ['<circle cx="20" cy="10" r="7" style="fill:var(--paper);stroke:var(--carmine);stroke-width:3.5"/>', 'Финиш'],
  ['<circle cx="12" cy="10" r="8" style="fill:var(--petrol)"/><circle cx="12" cy="10" r="3" style="fill:var(--paper)"/><rect x="24" y="3" width="14" height="14" rx="3.5" style="fill:var(--petrol)"/><path d="M29 6.5H27V13.5H29M30.5 10H35M33 8L35 10L33 12" style="fill:none;stroke:var(--on-petrol);stroke-width:1.5;stroke-linecap:round;stroke-linejoin:round"/>', 'Дом и выходы из него'],
  ['<path d="M3 10H37" style="stroke:var(--carmine);stroke-width:3.5;stroke-dasharray:.1 7;stroke-linecap:round"/>', 'Подводка: от выхода до кольца и обратно'],
  ['<circle cx="20" cy="10" r="7" style="fill:var(--surface);stroke:var(--carmine);stroke-width:2"/><path d="M17 7l6 6M23 7l-6 6" style="stroke:var(--carmine);stroke-width:2;stroke-linecap:round"/>', 'Тупик: калитка, отмеченная вами'],
  ['<path d="M6 10H34" style="stroke:var(--carmine);stroke-width:2.5"/><path d="M6 3V17M34 3V17" style="stroke:var(--carmine);stroke-width:3;stroke-linecap:round"/>', 'Тупик: закрытый вами отрезок'],
  ['<rect x="4" y="3" width="32" height="14" style="fill:url(#rd-hatch);stroke:var(--carmine);stroke-width:1.6;stroke-dasharray:5 3"/>', 'Запретная зона (серый пунктир — выключена)'],
  ['<circle cx="20" cy="10" r="10" style="fill:var(--surface);stroke:var(--carmine);stroke-width:2"/><text x="20" y="14" text-anchor="middle" style="font:600 10px var(--font-sans);fill:var(--ink)">5</text>', 'Километровые метки'],
  ['<path d="M2 10H38" style="stroke:var(--map-gate-osm);stroke-width:2;stroke-dasharray:4 5"/>', 'Пути, закрытые для пешехода'],
  ['<path d="M2 10H38" style="stroke:var(--map-street);stroke-width:5"/><rect x="18" y="3" width="4" height="14" rx="1" style="fill:var(--map-gate-osm)"/>', 'Закрытые ворота'],
  ['<circle cx="13" cy="10" r="5" style="fill:var(--surface);stroke:var(--petrol);stroke-width:2.5"/><circle cx="29" cy="10" r="5" style="fill:var(--carmine)"/>', 'Место / маршрут пройдёт через него']
];

/* дом, выходы, тупики и зоны: тоже в копии (версия 3) */
const PLACES = ['home', 'exits', 'ringStart', 'blocks', 'zones', 'openGates', 'visited'];

export function initSettings(app) {
  const dlg = $('#settings');
  $('#settingsBtn').addEventListener('click', () => dlg.showModal());

  function applyTheme() {
    const t = store.theme;
    if (t === 'auto') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', t);
    syncSeg($('#themeSeg'), 'theme', t);
    app.emit('theme');
  }
  $('#themeSeg').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    store.theme = b.dataset.theme; applyTheme(); save();
  });
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { if (store.theme === 'auto') app.emit('theme'); });

  app.on('theme', () => app.setTiles());

  const legend = $('#legend');
  for (const [svg, text] of LEGEND) {
    legend.appendChild(el('span', { html: `<svg viewBox="0 0 40 20" aria-hidden="true">${svg}</svg>` }));
    legend.appendChild(el('span', null, text));
  }

  $('#exportData').addEventListener('click', () => {
    download('rundom-kopiya.json', JSON.stringify({
      app: BACKUP_APP, version: 3, prefs: store.prefs, tracks: app.tracks.items, favorites: app.favorites.items,
      ...Object.fromEntries(PLACES.map((k) => [k, store[k]]))
    }), 'application/json');
  });
  $('#importData').addEventListener('click', () => $('#dataFile').click());
  $('#dataFile').addEventListener('change', async (e) => {
    const f = e.target.files && e.target.files[0]; if (!f) return;
    try {
      const d = JSON.parse(await f.text());
      if (d.app !== BACKUP_APP && d.app !== 'begovoj-atlas') throw new Error('bad');
      /* version 1 и прототип хранили треки в explored */
      const tracks = (d.tracks || d.explored || []).filter((x) => x && x.id && Array.isArray(x.lines))
        .map((x) => ({ created: Date.now(), ...x }));
      const nT = await app.tracks.merge(tracks);
      const nF = await app.favorites.merge((d.favorites || []).filter((x) => x && Array.isArray(x.coords)));
      if (d.prefs) Object.assign(store.prefs, d.prefs);
      for (const k of PLACES) if (d[k] !== undefined) store[k] = d[k];
      save();
      app.renderLibrary(); app.renderHome(); app.renderBlocks();
      app.coverage.refreshAll();
      toast('Копия загружена: треков ' + nT + ', маршрутов ' + nF + '.');
    } catch (err) { toast('Это не копия rundom.'); }
    e.target.value = '';
  });

  applyTheme();
}
