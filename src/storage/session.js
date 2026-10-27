/* Последнее состояние экрана: вкладка, раскрытые разделы, лист, прокрутка, построенные варианты,
   выбранный район и открытое место. Отдельно от личных данных: это не жалко потерять. */
const KEY = 'rundom.ui';

function load() {
  try { const s = JSON.parse(localStorage.getItem(KEY)); return s && typeof s === 'object' ? s : {}; } catch (e) { return {}; }
}

export const ui = load();

function write() {
  try { localStorage.setItem(KEY, JSON.stringify(ui)); }
  catch (e) {
    /* не влезло — без вариантов маршрута, они самые объёмные */
    try { localStorage.setItem(KEY, JSON.stringify({ ...ui, routes: null })); } catch (e2) { /* не сохраняем */ }
  }
}
let timer = null;
export function saveUi() { clearTimeout(timer); timer = setTimeout(write, 300); }
/* перед закрытием или перезагрузкой страницы — без задержки */
window.addEventListener('pagehide', () => { clearTimeout(timer); write(); });
