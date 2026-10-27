/* Режимы клика по карте: указать старт или финиш, отметить пройденное вручную. */
import L from 'leaflet';
import { $ } from './dom.js';

export function initModes(app) {
  const handlers = {};

  let seq = 0;
  function setMode(m, text) {
    const prev = app.S.mode;
    app.S.mode = m; seq++;
    $('#map').classList.toggle('picking', !!m);
    $('#pickA').setAttribute('aria-pressed', String(m === 'A'));
    $('#pickB').setAttribute('aria-pressed', String(m === 'B'));
    $('#banner').hidden = !m;
    $('#bannerText').textContent = text || '';
    const h = handlers[m] || {};
    $('#bannerOk').hidden = !h.ok;
    $('#bannerUndo').hidden = !h.undo;
    if (prev && prev !== m && handlers[prev] && handlers[prev].leave) handlers[prev].leave();
    if (m) app.sheet.peek();
  }

  $('#bannerCancel').addEventListener('click', () => setMode(null));
  $('#bannerOk').addEventListener('click', () => handlers[app.S.mode] && handlers[app.S.mode].ok && handlers[app.S.mode].ok());
  $('#bannerUndo').addEventListener('click', () => handlers[app.S.mode] && handlers[app.S.mode].undo && handlers[app.S.mode].undo());
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && app.S.mode) setMode(null); });
  /* Баннер не держит пользователя: нажал что-то другое в панели или шапке — режим закрывается сам.
     Кнопки, которые сами включают или выключают режим, успевают это сделать: проверка после их обработчиков.
     keep — селектор области, работа в которой режим не прерывает (например, выбор районов). */
  const CONTROLS = 'button, input, select, textarea, summary, a, [role="button"], label';
  for (const root of [$('#panel'), $('.top')]) {
    root.addEventListener('click', (e) => {
      const m = app.S.mode;
      if (!m || !e.target.closest(CONTROLS) || e.target.closest('#sheetHandle')) return;
      const keep = handlers[m] && handlers[m].keep;
      if (keep && e.target.closest(keep)) return;
      const at = seq;
      setTimeout(() => { if (app.S.mode === m && seq === at) setMode(null); });
    }, true);
  }
  L.DomEvent.disableClickPropagation($('#banner'));
  L.DomEvent.disableClickPropagation($('#maptools'));

  app.map.on('click', (e) => {
    const h = handlers[app.S.mode];
    if (h && h.click) h.click(e.latlng);
  });

  app.setMode = setMode;
  /* register('draw', {click, ok, undo, leave, keep}) */
  app.registerMode = (name, h) => { handlers[name] = h; };
}
