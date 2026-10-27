/* Выбор из списка в одном поле (районы маршрута и мест): выбранное — пилюли с крестиком, рядом поиск.
   Пустой запрос показывает весь список, щелчок по строке ставит и снимает выбор; стрелки и Enter выбирают,
   Backspace в пустом поле снимает последнее, Escape закрывает список. */
import { el, ICON } from './dom.js';

const norm = (s) => s.toLowerCase().replace(/ё/g, 'е');

/* root — .pillselect с .ps-pills, input и .sug внутри.
   options() → [{id, n}] (можно промис), selected() → [id], name(id) → подпись пилюли,
   toggle(id, adding, option), placeholder: [пусто, уже что-то выбрано]. */
export function pillSelect(root, { options, selected, name, toggle, placeholder }) {
  const search = root.querySelector('input'), sug = root.querySelector('.sug'), pills = root.querySelector('.ps-pills');
  const pre = root.id + '-opt';
  let list = [], act = -1;

  async function openList() {
    const all = await options();
    const q = norm(search.value.trim());
    list = all.filter((d) => !q || norm(d.n).includes(q)).sort((a, b) => a.n.localeCompare(b.n, 'ru'));
    act = q && list.length ? 0 : -1;
    paintList();
    sug.hidden = false;
    search.setAttribute('aria-expanded', 'true');
  }
  function paintList() {
    const sel = new Set(selected());
    sug.replaceChildren(...list.map((d, i) =>
      el('button', {
        type: 'button', role: 'option', id: pre + i, class: i === act ? 'act' : '', 'aria-selected': String(sel.has(d.id)), tabindex: '-1',
        onmousedown: (e) => e.preventDefault(), onclick: () => choose(d)
      }, el('span', { class: 'tick', 'aria-hidden': 'true' }), d.n)));
    if (!list.length) sug.appendChild(el('div', { class: 'none' }, 'Ничего не нашлось'));
    if (act >= 0) { search.setAttribute('aria-activedescendant', pre + act); sug.children[act].scrollIntoView({ block: 'nearest' }); }
    else search.removeAttribute('aria-activedescendant');
  }
  function closeList() { sug.hidden = true; search.setAttribute('aria-expanded', 'false'); act = -1; }
  function choose(d) {
    toggle(d.id, !selected().includes(d.id), d);
    if (search.value) { search.value = ''; openList(); } else paintList();
  }
  search.addEventListener('focus', openList);
  search.addEventListener('input', openList);
  search.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (sug.hidden) { openList(); return; }
      if (list.length) { act = (act + (e.key === 'ArrowDown' ? 1 : -1) + list.length) % list.length; paintList(); }
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (list[act]) choose(list[act]);
    } else if (e.key === 'Escape') {
      if (!sug.hidden) { e.stopPropagation(); closeList(); }
    } else if (e.key === 'Backspace' && !search.value && selected().length) {
      const ids = selected();
      toggle(ids[ids.length - 1], false, null);
      if (!sug.hidden) paintList();
    }
  });
  search.addEventListener('blur', () => setTimeout(() => { if (!root.contains(document.activeElement)) closeList(); }, 120));
  /* щелчок по пустому месту поля — в поиск */
  root.querySelector('.ps-box').addEventListener('click', (e) => { if (!e.target.closest('button, input')) search.focus(); });

  function render() {
    const ids = selected();
    pills.replaceChildren(...ids.map((id) => [id, name(id)]).filter(([, n]) => n).map(([id, n]) =>
      el('span', { class: 'pill' }, n,
        el('button', { type: 'button', 'aria-label': 'Убрать ' + n, html: ICON.remove, onclick: (e) => { e.stopPropagation(); toggle(id, false, null); } }))));
    search.placeholder = placeholder[ids.length ? 1 : 0];
    if (!sug.hidden) paintList();
  }
  return { render };
}
