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

/* Переключатель .seg: отмечает кнопку, у которой data-атрибут равен значению. */
export function syncSeg(root, attr, value) {
  root.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset[attr] === String(value))));
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
