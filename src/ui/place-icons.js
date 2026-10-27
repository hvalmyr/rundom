/* Значки мест по типу: памятник, храм, музей и т. д. Рисуются линией в цвет текста (currentColor). */
import { divIcon } from '../map/map.js';

const svg = (d) => `<svg viewBox="0 0 16 16" aria-hidden="true">${d}</svg>`;
export const PLACE_ICON = {
  park: svg('<circle cx="8" cy="6.5" r="4.5"/><path d="M8 11v3.5M6 14.5h4"/>'),
  worship: svg('<path d="M8 1.5v3M6.6 2.8h2.8"/><path d="M5 8.5a3 3 0 0 1 6 0"/><path d="M4 14.5V8.5h8v6zM7 14.5v-3h2v3"/>'),
  monument: svg('<path d="M6.8 12.5L7.4 3 8 1.5 8.6 3l.6 9.5"/><path d="M5 12.5h6v2H5z"/>'),
  museum: svg('<path d="M2 6L8 2.5 14 6z"/><path d="M4 7.5v5M8 7.5v5M12 7.5v5M2 14h12"/>'),
  view: svg('<path d="M1.5 8S4 4 8 4s6.5 4 6.5 4S12 12 8 12 1.5 8 1.5 8z"/><circle cx="8" cy="8" r="1.8"/>'),
  sight: svg('<path d="M8 2l1.8 3.8 4.2.5-3.1 2.8.8 4.1L8 11.2 4.3 13.2l.8-4.1L2 6.3l4.2-.5z"/>'),
  history: svg('<path d="M3 4h10M4 2.5h8M5 4v8.5M11 4v8.5M8 4v8.5M2.5 14h11"/>'),
  heritage: svg('<circle cx="8" cy="6" r="3.5"/><path d="M6 9l-1 5.5 3-1.5 3 1.5L10 9"/>'),
  water: svg('<path d="M8 2s4 4.6 4 7.5a4 4 0 0 1-8 0C4 6.6 8 2 8 2z"/>'),
  art: svg('<path d="M8 2a6 6 0 1 0 0 12c1 0 1.4-.8 1-1.6-.5-1 .2-1.9 1.3-1.9H12a2.5 2.5 0 0 0 2-2.5C14 4.6 11.3 2 8 2z"/><circle cx="5.3" cy="7" r=".8"/><circle cx="8" cy="5" r=".8"/><circle cx="10.8" cy="6.5" r=".8"/>'),
  other: svg('<circle cx="8" cy="8" r="3"/>')
};
export const placeSvg = (cat) => PLACE_ICON[cat] || PLACE_ICON.other;

/* Значок места на карте: спокойный кружок со значком; extra — st0/st1/st2 (не встречено / встречено /
   исследовал), via (маршрут пройдёт через место), on (место в фокусе — подсвечено). */
export const placeMarker = (cat, extra = '') => divIcon('mk-place ' + extra, 22, 22, placeSvg(cat));
