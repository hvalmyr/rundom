/* Названия маршрутов и треков по содержанию, а не «Вариант N». */

const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];

function partOfDay(h) {
  if (h >= 5 && h < 12) return 'утро';
  if (h >= 12 && h < 17) return 'день';
  if (h >= 17 && h < 23) return 'вечер';
  return 'ночь';
}

const km1 = (m) => (Math.round(m / 100) / 10).toFixed(1).replace('.', ',');

const RANK = { park: 0, view: 1, sight: 2, water: 3, art: 4, history: 5 };

/* Самое заметное место из списка: парк, видовая, достопримечательность, потом остальное. */
export function notablePlace(pois) {
  const named = (pois || []).filter((p) => p && p.name);
  named.sort((a, b) => (RANK[a.cat] ?? 9) - (RANK[b.cat] ?? 9));
  return named[0] || null;
}

/* Мемориалы в OSM часто названы в дательном падеже («В. И. Ленину»): добавляем «Памятник». */
export function placeName(p) {
  if (p.cat === 'history' && !/памятник|мемориал|монумент|обелиск/i.test(p.name) && /[а-яё]у$|[а-яё]ым$|[а-яё]ам$/i.test(p.name.split(' ').pop())) {
    return 'Памятник ' + p.name;
  }
  return p.name;
}

/* «Сквер Мигеля Идальго · Сивцев Вражек» */
export function routeTitle(metrics, fallback) {
  const poi = notablePlace(metrics.pois);
  const parts = [];
  if (poi) parts.push(placeName(poi));
  const street = (metrics.streets || []).find((s) => !poi || s !== poi.name);
  if (street) parts.push(street);
  return parts.length ? parts.slice(0, 2).join(' · ') : fallback;
}

/* «26 октября, утро · Нескучный сад · 11,3 км»; date — время пробежки из GPX или момент импорта. */
export function trackTitle(date, meters, place) {
  const d = new Date(date);
  const head = d.getDate() + ' ' + MONTHS[d.getMonth()] + ', ' + partOfDay(d.getHours());
  return [head, place, km1(meters) + ' км'].filter(Boolean).join(' · ');
}
