/* Справка о месте — общая для всех вкладок: фото с Commons, вступление Википедии, факты из OSM.
   Всё, что в данных по-английски (часы работы, даты, лицензии, подписи авторов), выводится по-русски. */
import { el } from './dom.js';

const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
const MONTH1 = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'];
const EN_MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const EN_MONTH = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const RU_MON = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
const DAYS = { Mo: 'пн', Tu: 'вт', We: 'ср', Th: 'чт', Fr: 'пт', Sa: 'сб', Su: 'вс' };

/* даты OSM: 2005-05-09 → 9 мая 2005, 1895-06 → июнь 1895, 1820s → 1820-е, C18 → 18 век */
export const fmtDate = (v) => String(v)
  .replace(/\b(\d{4})-(\d{2})-(\d{2})\b/g, (m, y, mo, d) => MONTHS[mo - 1] ? Number(d) + ' ' + MONTHS[mo - 1] + ' ' + y : m)
  .replace(/\b(\d{4})-(\d{2})\b/g, (m, y, mo) => MONTH1[mo - 1] ? MONTH1[mo - 1] + ' ' + y : m)
  .replace(new RegExp('\\b(' + EN_MONTH.join('|') + ') (\\d{1,2}), (\\d{4})\\b', 'g'), (m, mo, d, y) => d + ' ' + MONTHS[EN_MONTH.indexOf(mo)] + ' ' + y)
  .replace(/\b(\d{3,4})s\b/g, '$1-е').replace(/\bC(\d{1,2})\b/g, '$1 век').replace(/(\d)-(\d)/g, '$1–$2');

/* часы работы OSM → строки по-русски: «Mo-Fr 10:00-18:00; Sa,Su off» → «пн–пт 10:00–18:00», «сб, вс выходной».
   Пояснения в кавычках — обычно уже по-русски — остаются в скобках. */
export function fmtHours(s) {
  const code = (t) => t
    .replace(/24\/7/g, 'круглосуточно')
    .replace(/\b(Mo|Tu|We|Th|Fr|Sa|Su)\[(-?\d)(?:-(\d))?\]/g, (m, d, a, b) =>
      (a === '-1' ? 'последний ' : a + (b ? '–' + b : '') + '\u2011й ') + DAYS[d])
    .replace(/\b(Mo|Tu|We|Th|Fr|Sa|Su)\b/g, (m) => DAYS[m])
    .replace(new RegExp('\\b(' + EN_MON.join('|') + ')\\b', 'g'), (m) => RU_MON[EN_MON.indexOf(m)])
    .replace(/\bPH\b/g, 'праздники').replace(/\bSH\b/g, 'каникулы')
    .replace(/\b(off|closed)\b/g, 'выходной').replace(/\bopen\b/g, 'открыто').replace(/\bunknown\b/g, 'уточняйте')
    .replace(/\bsunrise\b/g, 'рассвет').replace(/\bsunset\b/g, 'закат').replace(/\bdawn\b/g, 'рассвет').replace(/\bdusk\b/g, 'закат')
    .replace(/\bweek\b/g, 'неделя')
    .replace(/-/g, '–').replace(/,(?=\S)/g, ', ').replace(/\s*(;|\|\|)\s*/g, '\n');
  return String(s).split('"').map((t, i) => (i % 2 ? '(' + t.trim() + ')' : code(t))).join('')
    .split('\n').map((l) => l.trim()).filter(Boolean).join('\n');
}

/* автор фото: без «User:» и «from Moscow, Russia» */
export function fmtCredit(a) {
  const s = String(a || '').replace(/\bUser:/gi, '').replace(/\s+from [^,()]+(, [^,()]+)?$/, '').trim();
  return !s || /^(unknown|anonymous|автор не указан)/i.test(s) ? 'автор неизвестен' : s;
}
const LIC = { 'public domain': 'общественное достояние', fal: 'лицензия свободного искусства', attribution: 'с указанием автора',
  'no restrictions': 'без ограничений', 'copyrighted free use': 'свободное использование' };
export const fmtLicense = (l) => LIC[String(l || '').toLowerCase()] || String(l || '').replace(/^OGL v/, 'OGL ');

/* фото с Commons: автор и лицензия под ним, ссылка на страницу файла */
export function photo(i) {
  return el('figure', { class: 'photo' },
    el('img', { src: i.s, alt: '', loading: 'lazy', decoding: 'async' }),
    el('figcaption', null, el('a', { href: i.f, target: '_blank', rel: 'noopener' }, 'Фото: ' + fmtCredit(i.a) + ' · ' + fmtLicense(i.l))));
}

const FACTS = [['y', 'Год'], ['ar', 'Архитектор'], ['au', 'Автор'], ['sb', 'Посвящён'], ['de', 'Конфессия'],
  ['he', 'Объект наследия'], ['oh', 'Часы работы'], ['in', 'Надпись']];
const FMT = { y: fmtDate, oh: fmtHours };
const host = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return u; } };

/* p: { w?: {t, u, i}, f?: факты, park?, ha? } → справка или null */
export function about(p) {
  const f = p.f || {}, w = p.w || {};
  const rows = FACTS.filter(([k]) => f[k]).map(([k, t]) => [t, FMT[k] ? FMT[k](f[k]) : f[k], k]);
  if (p.park && p.ha) rows.unshift(['Площадь', String(p.ha).replace('.', ',') + ' га', 'ha']);
  const nodes = [
    w.t ? el('p', { class: 'desc' }, w.t, ' ', el('a', { href: w.u, target: '_blank', rel: 'noopener' }, 'Википедия')) : null,
    !w.t && f.ds ? el('p', { class: 'desc' }, f.ds) : null,
    rows.length ? el('dl', { class: 'facts' }, rows.flatMap(([t, v, k]) => [el('dt', null, t), el('dd', { class: 'f-' + k }, v)])) : null,
    f.ws ? el('a', { class: 'site', href: f.ws, target: '_blank', rel: 'noopener' }, host(f.ws)) : null
  ].filter(Boolean);
  return nodes.length ? el('div', { class: 'about-place' }, nodes) : null;
}

/* карточка места для панели: фото, название, подзаголовок, справка, кнопки */
export function placeCard({ p, title, sub, buttons }) {
  return el('div', { class: 'pcard' },
    p.w && p.w.i ? photo(p.w.i) : null,
    title ? el('h3', { class: 'pc-title' }, title) : null,
    sub ? el('div', { class: 'muted pc-sub' }, sub) : null,
    about(p) || el('p', { class: 'hint' }, 'Справки об этом месте пока нет.'),
    buttons && buttons.length ? el('div', { class: 'btns' }, buttons) : null);
}

const CLOSE = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';
export const phone = window.matchMedia('(max-width: 860px)');

/* шапка панели: название и крестик; back — подпись кнопки «назад» над названием */
export function panelHead(title, onClose, back) {
  return el('div', { class: 'dp-headwrap' },
    back ? el('button', { class: 'dp-back', type: 'button', onclick: back.on }, el('span', { class: 'chev', 'aria-hidden': 'true' }), back.t) : null,
    el('div', { class: 'dp-head' },
      el('h2', null, title),
      el('button', { class: 'iconbtn ghost', type: 'button', 'aria-label': 'Закрыть', onclick: onClose, html: CLOSE })));
}

/* панель места, как панель района в «Прогрессе»: на компьютере справа над картой, на телефоне — в листе */
export function placePanel(app, slot) {
  const panel = el('div', { class: 'dpanel placepanel', hidden: true, role: 'region', 'aria-label': 'Место' });
  const mount = () => (phone.matches ? slot : app.map.getContainer().parentElement).appendChild(panel);
  phone.addEventListener('change', mount);
  mount();
  let onHide = null;
  function hide() {
    if (panel.hidden) return;
    panel.hidden = true; panel.replaceChildren();
    const f = onHide; onHide = null;
    if (f) f();
  }
  /* показать место и сдвинуть карту так, чтобы оно не пряталось под панелью или листом */
  function show(title, body, latlng, hidden) {
    const again = !panel.hidden;
    if (again) { const f = onHide; onHide = null; if (f) f(); }
    onHide = hidden;
    panel.replaceChildren(panelHead(title, hide), body);
    panel.hidden = false;
    panel.scrollTop = 0;
    if (phone.matches) { app.sheet.open(); scrollToPanel(panel); }
    if (latlng) setTimeout(() => reveal(app.map, latlng), phone.matches ? 260 : 0);
  }
  return { show, hide, get open() { return !panel.hidden; } };
}
/* место — в середину видимой части карты: на телефоне над листом, на компьютере левее панели */
export function reveal(map, latlng) {
  const sheet = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--sheet-visible')) || 0;
  map.invalidateSize();
  const size = map.getSize(), at = map.latLngToContainerPoint(latlng);
  const cx = phone.matches ? size.x / 2 : (size.x - 380) / 2, cy = phone.matches ? (size.y - sheet) / 2 : size.y / 2;
  map.panBy([at.x - cx, at.y - cy], { animate: false });
}
/* на телефоне лист прокручивается к началу панели, не пряча её под ручкой */
export function scrollToPanel(el) {
  const sc = document.getElementById('panel');
  sc.scrollTop += el.getBoundingClientRect().top - sc.getBoundingClientRect().top - 28;
}
