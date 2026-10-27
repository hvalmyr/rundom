/* Настройки: тема, подложка, обозначения и резервная копия. */
import { store, save, BACKUP_APP } from '../storage/store.js';
import { TILES } from '../map/map.js';
import { $, el, toast, download, syncSeg } from './dom.js';

const LEGEND = [
  ['<path d="M2 10H38" style="stroke:var(--paper);stroke-width:9;stroke-linecap:round"/><path d="M2 10H38" style="stroke:var(--map-route);stroke-width:5;stroke-linecap:round"/>', 'Маршрут'],
  ['<path d="M2 10H38" style="stroke:var(--ink-muted);stroke-width:3;opacity:.45;stroke-linecap:round"/>', 'Другие варианты: нажмите, чтобы выбрать'],
  ['<path d="M2 10H38" style="stroke:var(--map-explored);stroke-width:2.5;stroke-linecap:round"/>', 'Пройденные улицы'],
  ['<circle cx="20" cy="10" r="7" style="fill:var(--paper);stroke:var(--petrol);stroke-width:3.5"/>', 'Старт'],
  ['<circle cx="20" cy="10" r="7" style="fill:var(--paper);stroke:var(--carmine);stroke-width:3.5"/>', 'Финиш'],
  ['<circle cx="20" cy="10" r="10" style="fill:var(--surface);stroke:var(--carmine);stroke-width:2"/><text x="20" y="14" text-anchor="middle" style="font:600 10px var(--font-sans);fill:var(--ink)">5</text>', 'Километровые метки'],
  ['<path d="M2 10H38" style="stroke:var(--map-gate-osm);stroke-width:2;stroke-dasharray:4 5"/>', 'Пути, закрытые для пешехода (OSM)'],
  ['<path d="M2 10H38" style="stroke:var(--map-street);stroke-width:5"/><rect x="18" y="3" width="4" height="14" rx="1" style="fill:var(--map-gate-osm)"/>', 'Закрытые ворота (OSM)'],
  ['<circle cx="13" cy="10" r="5" style="fill:var(--surface);stroke:var(--petrol);stroke-width:2.5"/><circle cx="29" cy="10" r="5" style="fill:var(--carmine)"/>', 'Место / маршрут пройдёт через него']
];

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

  const tsel = $('#tileSel');
  for (const [k, t] of Object.entries(TILES)) tsel.appendChild(el('option', { value: k }, t.name));
  tsel.value = TILES[store.tiles] ? store.tiles : 'carto';
  tsel.addEventListener('change', () => { store.tiles = tsel.value; app.setTiles(tsel.value); save(); });
  app.on('theme', () => app.setTiles(store.tiles));

  const legend = $('#legend');
  for (const [svg, text] of LEGEND) {
    legend.appendChild(el('span', { html: `<svg viewBox="0 0 40 20" aria-hidden="true">${svg}</svg>` }));
    legend.appendChild(el('span', null, text));
  }

  $('#exportData').addEventListener('click', () => {
    download('rundom-kopiya.json', JSON.stringify({ app: BACKUP_APP, version: 1, explored: store.explored, prefs: store.prefs }), 'application/json');
  });
  $('#importData').addEventListener('click', () => $('#dataFile').click());
  $('#dataFile').addEventListener('change', async (e) => {
    const f = e.target.files && e.target.files[0]; if (!f) return;
    try {
      const d = JSON.parse(await f.text());
      if (d.app !== BACKUP_APP && d.app !== 'begovoj-atlas') throw new Error('bad');
      const have = new Set(store.explored.map((x) => x.id));
      for (const x of d.explored || []) if (x && x.id && Array.isArray(x.lines) && !have.has(x.id)) store.explored.push(x);
      if (d.prefs) Object.assign(store.prefs, d.prefs);
      save();
      toast('Копия загружена. Обновляю страницу…');
      setTimeout(() => location.reload(), 800);
    } catch (err) { toast('Это не копия rundom.'); }
    e.target.value = '';
  });

  applyTheme();
}
