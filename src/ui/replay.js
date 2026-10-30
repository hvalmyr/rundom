/* Показ пробега: по маршруту или пробежке движется точка, пройденная часть закрашивается, над точкой — километры.
   Внизу — плеер: пауза и продолжение, полоса положения, за которую можно потянуть, чтобы перемотать.
   Идёт примерно 2 секунды на километр (не меньше 8 и не больше 60 секунд всего). */
import L from 'leaflet';
import * as Core from '../core/index.js';
import { cssVar, divIcon } from '../map/map.js';
import { fmtKm, el, ICON } from './dom.js';

export function initReplay(app) {
  const { map } = app;
  const group = L.layerGroup().addTo(map);
  let raf = 0, run = null, bar = null;

  function stop() {
    cancelAnimationFrame(raf); raf = 0;
    if (!run) return;
    run = null;
    group.clearLayers();
    if (bar) { bar.remove(); bar = null; }
    app.emit('replay');
  }

  /* lines — линии [[lat, lon], ...]; key — чей это показ (id маршрута или пробежки) */
  function play(lines, key) {
    stop();
    const segs = lines.filter((l) => l.length > 1);
    if (!segs.length) return;
    const cums = segs.map((l) => { const c = [0]; for (let i = 1; i < l.length; i++) c.push(c[i - 1] + Core.hav(l[i - 1][0], l[i - 1][1], l[i][0], l[i][1])); return c; });
    const starts = []; let total = 0;
    cums.forEach((c) => { starts.push(total); total += c[c.length - 1]; });
    if (!(total > 0)) return;
    const dur = Math.min(60, Math.max(8, total / 1000 * 2)) * 1000;
    const trail = L.polyline([segs[0][0]], { color: cssVar('petrol'), weight: 6, opacity: 0.95, interactive: false, lineCap: 'round' });
    const label = el('span', { class: 'km' }, '0');
    const mk = L.marker(segs[0][0], { icon: divIcon('mk-runner', 18, 18), interactive: false, keyboard: false, zIndexOffset: 2000 });
    group.addLayer(trail); group.addLayer(mk);
    run = { key, pos: 0, playing: true, scrub: false, last: performance.now() };

    /* плеер */
    const btn = el('button', { class: 'rp-btn', type: 'button', 'aria-label': 'Пауза', title: 'Пауза' });
    const range = el('input', { class: 'rp-range', type: 'range', min: '0', max: '1000', step: '1', value: '0', 'aria-label': 'Положение на треке' });
    const time = el('span', { class: 'rp-time' }, '0,0 из ' + fmtKm(total) + ' км');
    const close = el('button', { class: 'rp-btn rp-close', type: 'button', 'aria-label': 'Закрыть плеер', title: 'Закрыть', html: ICON.remove });
    bar = el('div', { class: 'replaybar', role: 'group', 'aria-label': 'Показ пробега' }, btn, range, time, close);
    L.DomEvent.disableClickPropagation(bar); L.DomEvent.disableScrollPropagation(bar);
    map.getContainer().parentElement.appendChild(bar);
    const icons = () => {
      const atEnd = run.pos >= total;
      btn.innerHTML = run.playing ? ICON.pause : ICON.play;
      const t = run.playing ? 'Пауза' : atEnd ? 'Сначала' : 'Продолжить';
      btn.setAttribute('aria-label', t); btn.title = t;
    };
    icons();

    function render() {
      const d = Math.min(total, Math.max(0, run.pos));
      let k = segs.length - 1;
      while (k > 0 && starts[k] > d) k--;
      const c = cums[k], local = d - starts[k];
      let lo = 0, hi = c.length - 1;
      while (lo < hi - 1) { const m = (lo + hi) >> 1; if (c[m] <= local) lo = m; else hi = m; }
      const a = segs[k][lo], b = segs[k][hi], span = c[hi] - c[lo] || 1, f = Math.min(1, Math.max(0, (local - c[lo]) / span));
      const pos = [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
      mk.setLatLng(pos);
      trail.setLatLngs([...segs.slice(0, k), [...segs[k].slice(0, lo + 1), pos]]);
      const h = mk.getElement() && mk.getElement().firstChild;
      if (h) { if (!h.contains(label)) h.appendChild(label); label.textContent = fmtKm(d) + ' км'; }
      time.textContent = fmtKm(d) + ' из ' + fmtKm(total) + ' км';
      if (!run.scrub) range.value = String(Math.round(d / total * 1000));
      range.style.setProperty('--rp-fill', (d / total * 100) + '%');
      map.panInside(pos, { padding: [90, 90], animate: false });
    }
    const frame = (now) => {
      if (!run) return;
      if (run.playing && !run.scrub) {
        run.pos += (now - run.last) / dur * total;
        if (run.pos >= total) { run.pos = total; run.playing = false; icons(); }
      }
      run.last = now;
      render();
      raf = requestAnimationFrame(frame);
    };
    btn.addEventListener('click', () => {
      if (run.pos >= total) run.pos = 0;
      run.playing = !run.playing; run.last = performance.now(); icons();
    });
    /* перемотка: пока тянут, точка идёт за ползунком; после — играет как играла */
    range.addEventListener('pointerdown', () => { run.scrub = true; });
    const release = () => { if (run) { run.scrub = false; run.last = performance.now(); icons(); } };
    range.addEventListener('pointerup', release);
    range.addEventListener('change', release);
    range.addEventListener('input', () => { run.pos = range.value / 1000 * total; render(); icons(); });
    close.addEventListener('click', stop);
    raf = requestAnimationFrame(frame);
    app.emit('replay');
  }

  app.replay = play;
  app.replayStop = stop;
  app.replayKey = () => (run ? run.key : null);
  app.on('routeDrawn', stop);
  app.on('tab', stop);
}
