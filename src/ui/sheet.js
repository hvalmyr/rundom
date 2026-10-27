/* Нижний лист на телефоне: три положения (свёрнут, половина, почти весь экран), тянется за ручку.
   Высота листа равна видимой части: так его содержимое прокручивается до конца в любом положении. */
import { $ } from './dom.js';
import { ui, saveUi } from '../storage/session.js';

const MOBILE = window.matchMedia('(max-width: 860px)');
const STOPS = { peek: 0.16, half: 0.5, full: 1 };

export function initSheet(app) {
  const panel = $('#panel'), handle = $('#sheetHandle');
  let state = STOPS[ui.sheet] ? ui.sheet : 'half';

  /* лист до шапки с небольшим зазором: карта под ним видна краем */
  const maxH = () => Math.max(200, window.innerHeight - ($('.top').getBoundingClientRect().height || 84) - 48);
  function visible(name) { return Math.max(88, STOPS[name] * maxH()); }
  function setVisible(v) { document.documentElement.style.setProperty('--sheet-visible', Math.round(v) + 'px'); }
  function set(name) {
    state = name;
    if (ui.sheet !== name) { ui.sheet = name; saveUi(); }
    setVisible(visible(name));
    setTimeout(() => app.map.invalidateSize(), 240);
  }

  /* тянуть можно за ручку и за полосу над содержимым; щелчок без движения переключает положение */
  let startY = 0, startVis = 0, dragging = false;
  handle.addEventListener('pointerdown', (e) => {
    if (!MOBILE.matches) return;
    dragging = true; startY = e.clientY; startVis = visible(state);
    panel.classList.add('dragging');
    handle.setPointerCapture(e.pointerId);
  });
  handle.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    setVisible(Math.min(maxH(), Math.max(60, startVis + (startY - e.clientY))));
  });
  const end = (e) => {
    if (!dragging) return;
    dragging = false;
    panel.classList.remove('dragging');
    const moved = startY - e.clientY;
    if (Math.abs(moved) < 6) { set(state === 'peek' ? 'half' : state === 'half' ? 'full' : 'peek'); return; }
    const v = startVis + moved, H = maxH();
    let best = 'half', bd = Infinity;
    for (const k of Object.keys(STOPS)) { const d = Math.abs(STOPS[k] * H - v); if (d < bd) { bd = d; best = k; } }
    set(best);
  };
  handle.addEventListener('pointerup', end);
  handle.addEventListener('pointercancel', end);

  set(state);
  window.addEventListener('resize', () => set(state));

  app.sheet = {
    peek() { if (MOBILE.matches) set('peek'); },
    open() { if (MOBILE.matches && state === 'peek') set('half'); },
    set(name) { if (MOBILE.matches && STOPS[name]) set(name); }
  };
}
