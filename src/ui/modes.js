/* Режимы клика по карте: указать старт или финиш, отметить пройденное вручную. */
import L from 'leaflet';
import { $ } from './dom.js';

export function initModes(app) {
  const handlers = {};

  function setMode(m, text) {
    const prev = app.S.mode;
    app.S.mode = m;
    $('#map').classList.toggle('picking', !!m);
    $('#pickA').setAttribute('aria-pressed', String(m === 'A'));
    $('#pickB').setAttribute('aria-pressed', String(m === 'B'));
    $('#banner').hidden = !m;
    $('#bannerText').textContent = text || '';
    $('#bannerOk').hidden = m !== 'draw';
    $('#bannerUndo').hidden = m !== 'draw';
    if (prev && prev !== m && handlers[prev] && handlers[prev].leave) handlers[prev].leave();
    if (m) app.sheet.peek();
  }

  $('#bannerCancel').addEventListener('click', () => setMode(null));
  $('#bannerOk').addEventListener('click', () => handlers[app.S.mode] && handlers[app.S.mode].ok && handlers[app.S.mode].ok());
  $('#bannerUndo').addEventListener('click', () => handlers[app.S.mode] && handlers[app.S.mode].undo && handlers[app.S.mode].undo());
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && app.S.mode) setMode(null); });
  L.DomEvent.disableClickPropagation($('#banner'));
  L.DomEvent.disableClickPropagation($('#maptools'));

  app.map.on('click', (e) => {
    const h = handlers[app.S.mode];
    if (h && h.click) h.click(e.latlng);
  });

  app.setMode = setMode;
  /* register('draw', {click, ok, undo, leave}) */
  app.registerMode = (name, h) => { handlers[name] = h; };
}
