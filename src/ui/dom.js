/* Мелкие помощники для DOM и форматирования. */

export const $ = (s) => document.querySelector(s);
export const $$ = (s) => Array.from(document.querySelectorAll(s));

export function el(tag, attrs, ...children) {
  const n = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') n.className = v;
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else if (k === 'html') n.innerHTML = v;
      else n.setAttribute(k, v === true ? '' : v);
    }
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return n;
}

/* Иконки для кнопок в строках списков. */
export const ICON = {
  show: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>',
  download: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v11M7 10l5 5 5-5M5 20h14"/></svg>',
  remove: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  star: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z"/></svg>',
  undo: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 14L4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/></svg>',
  reset: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/></svg>',
  trash: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg>',
  home: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 11l8-7 8 7"/><path d="M6 9.5V20h12V9.5"/><path d="M10 20v-5h4v5"/></svg>',
  target: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="2.5"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/></svg>'
};
/* Кнопка-иконка с подписью для экранного диктора и подсказкой. */
export const iconBtn = (icon, label, onclick, ghost) =>
  el('button', { class: 'iconbtn' + (ghost ? ' ghost' : ''), type: 'button', 'aria-label': label, title: label, html: ICON[icon], onclick });

/* Удаление в два нажатия: первое превращает крестик в «Удалить?», второе удаляет.
   Без второго нажатия за 4 секунды или при уходе фокуса кнопка возвращается. */
export function removeBtn(label, onConfirm) {
  const b = iconBtn('remove', label, null, true);
  let timer = null;
  const reset = () => {
    clearTimeout(timer); timer = null;
    b.classList.remove('confirm'); b.innerHTML = ICON.remove;
    b.setAttribute('aria-label', label); b.title = label;
  };
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    if (timer) { reset(); onConfirm(); return; }
    b.classList.add('confirm'); b.textContent = 'Удалить?';
    b.setAttribute('aria-label', 'Подтвердите: ' + label); b.title = 'Нажмите ещё раз, чтобы удалить';
    timer = setTimeout(reset, 4000);
  });
  b.addEventListener('blur', () => { if (timer) setTimeout(reset, 150); });
  return b;
}

/* Текст ошибки для человека: свои сообщения — как есть, технические (сеть, HTTP, сбои кода) — понятной фразой. */
export function userMessage(e, fallback) {
  const m = (e && e.message) || '';
  if (/[А-Яа-яё]/.test(m) && !/HTTP|Тайл/.test(m)) return m;
  if (/HTTP|fetch|network|Load failed|Тайл/i.test(m)) return 'Не удалось загрузить данные. Проверьте подключение к интернету и попробуйте ещё раз.';
  return fallback;
}
export const tick = () => new Promise((r) => setTimeout(r, 0));
export const fmt1 = (x) => (Math.round(x * 10) / 10).toFixed(1).replace('.', ',');
export const fmtKm = (m) => fmt1(m / 1000);
export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
export const round5 = (p) => [Math.round(p[0] * 1e5) / 1e5, Math.round(p[1] * 1e5) / 1e5];

/* 21.1 → «21,1», 10 → «10» */
export const fmtNum = (x) => String(Math.round(x * 10) / 10).replace('.', ',');

export function fmtTime(mins) {
  const t = Math.round(mins), h = Math.floor(t / 60), m = t % 60;
  return h ? `${h} ч ${m < 10 ? '0' : ''}${m} мин` : `${m} мин`;
}

let toastTimer = null;
export function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 5200);
}

export function download(name, text, type) {
  const blob = new Blob([text], { type: type || 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const a = el('a', { href: url, download: name });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/* Переключатель .seg: отмечает кнопку, у которой data-атрибут равен значению;
   подложка выделения (::before) едет к ней по --i из --n. */
export function syncSeg(root, attr, value) {
  const btns = Array.from(root.querySelectorAll('button'));
  let on = -1;
  btns.forEach((b, i) => {
    const hit = b.dataset[attr] === String(value);
    b.setAttribute('aria-pressed', String(hit));
    if (hit) on = i;
  });
  /* первая отметка — без анимации: подложка сразу на месте */
  if (!root.style.getPropertyValue('--i')) {
    root.classList.add('still');
    requestAnimationFrame(() => requestAnimationFrame(() => root.classList.remove('still')));
  }
  root.style.setProperty('--n', btns.length);
  root.style.setProperty('--i', Math.max(0, on));
  root.classList.toggle('none', on < 0);
}

/* Имя-кнопка: по нажатию превращается в поле, Enter или уход фокуса сохраняет, Esc отменяет.
   onRename(новое имя) вызывается, только если имя изменилось. */
export function renameable(name, onRename) {
  const btn = el('button', { class: 'rename', type: 'button', title: 'Переименовать' }, name);
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const input = el('input', { class: 'edit', type: 'text', value: name, 'aria-label': 'Новое название' });
    let done = false;
    const finish = (keep) => {
      if (done) return;
      done = true;
      const v = input.value.trim();
      const changed = keep && v && v !== name;
      if (changed) onRename(v);
      input.replaceWith(renameable(changed ? v : name, onRename));
    };
    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') { ev.preventDefault(); finish(true); }
      if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); finish(false); }
    });
    input.addEventListener('blur', () => finish(true));
    btn.replaceWith(input);
    input.focus(); input.select();
  });
  return btn;
}
