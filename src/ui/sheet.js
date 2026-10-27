/* Нижний лист на телефоне: три положения (свёрнут, половина, почти весь экран), тянется за ручку. */
import { $ } from './dom.js';

const MOBILE = window.matchMedia('(max-width: 860px)');
const STOPS = { peek: 0.16, half: 0.5, full: 1 };

export function initSheet(app) {
  const panel = $('#panel'), handle = $('#sheetHandle');
  let state = 'half';

  const maxH = () => panel.getBoundingClientRect().height || window.innerHeight * 0.85;
  function visible(name) { return Math.max(88, STOPS[name] * maxH()); }
  function set(name) {
    state = name;
    document.documentElement.style.setProperty('--sheet-visible', visible(name) + 'px');
    setTimeout(() => app.map.invalidateSize(), 240);
  }

  let startY = 0, startVis = 0, dragging = false;
  handle.addEventListener('pointerdown', (e) => {
    if (!MOBILE.matches) return;
    dragging = true; startY = e.clientY; startVis = visible(state);
    panel.classList.add('dragging');
    handle.setPointerCapture(e.pointerId);
  });
  handle.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const v = Math.min(maxH(), Math.max(60, startVis + (startY - e.clientY)));
    document.documentElement.style.setProperty('--sheet-visible', v + 'px');
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
    open() { if (MOBILE.matches && state === 'peek') set('half'); }
  };
}
