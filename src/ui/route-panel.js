/* Вкладка «Маршрут»: старт и финиш, дистанция, предпочтения, генерация и варианты. */
import L from 'leaflet';
import * as Core from '../core/index.js';
import { store, save } from '../storage/store.js';
import { overpass } from '../data/overpass.js';
import { cssVar, divIcon } from '../map/map.js';
import { $, el, tick, fmt1, fmtKm, fmtNum, fmtTime, toast, download, syncSeg } from './dom.js';

export function initRoutePanel(app) {
  const { map, layers, S } = app;

  /* ---------- старт и финиш ---------- */
  const coordText = (p) => p.lat.toFixed(5) + ', ' + p.lon.toFixed(5);

  function renderAB() {
    layers.ab.clearLayers();
    for (const k of ['A', 'B']) {
      const p = store[k];
      const info = $('#info' + k);
      if (!p || (k === 'B' && store.prefs.loop)) {
        if (k === 'A' || !p) { info.textContent = 'не задан'; info.classList.remove('set'); }
        continue;
      }
      info.textContent = (p.label ? p.label + ' · ' : '') + coordText(p);
      info.classList.add('set');
      const m = L.marker([p.lat, p.lon], {
        icon: divIcon(k === 'A' ? 'mk-home' : 'mk-finish', 18, 18), draggable: true,
        title: k === 'A' ? 'Старт' : 'Финиш'
      });
      m.on('dragend', () => {
        const ll = m.getLatLng();
        store[k] = { lat: ll.lat, lon: ll.lng };
        $('#q' + k).value = '';
        renderAB(); save();
      });
      layers.ab.addLayer(m);
    }
  }
  function setPoint(k, lat, lon, label) {
    store[k] = { lat, lon, label: label || '' };
    $('#q' + k).value = label || coordText(store[k]);
    renderAB(); save();
  }

  function wireSearch(k) {
    const input = $('#q' + k), box = $('#sug' + k);
    let timer = null;
    const hide = () => { box.hidden = true; box.innerHTML = ''; };
    async function run() {
      const q = input.value.trim();
      if (q.length < 3) { hide(); return; }
      const m = /^\s*(-?\d{1,2}[.,]\d+)\s*[,; ]\s*(-?\d{1,3}[.,]\d+)\s*$/.exec(q);
      if (m) {
        setPoint(k, parseFloat(m[1].replace(',', '.')), parseFloat(m[2].replace(',', '.')));
        map.setView([store[k].lat, store[k].lon], Math.max(map.getZoom(), 15));
        hide(); return;
      }
      try {
        const url = 'https://nominatim.openstreetmap.org/search?format=jsonv2&limit=6&accept-language=ru&viewbox=36.7,56.1,38.2,55.2&q=' + encodeURIComponent(q);
        const list = await (await fetch(url)).json();
        box.innerHTML = '';
        if (!list.length) { box.appendChild(el('button', { type: 'button', disabled: true }, 'Ничего не найдено')); box.hidden = false; return; }
        for (const it of list) {
          const parts = (it.display_name || '').split(', ');
          box.appendChild(el('button', {
            type: 'button', onclick: () => {
              const lat = parseFloat(it.lat), lon = parseFloat(it.lon);
              setPoint(k, lat, lon, parts[0]);
              map.setView([lat, lon], Math.max(map.getZoom(), 15));
              hide();
            }
          }, parts[0], el('small', null, parts.slice(1, 4).join(', '))));
        }
        box.hidden = false;
      } catch (e) { toast('Поиск адреса недоступен. Укажите точку на карте.'); hide(); }
    }
    input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(run, 700); });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); clearTimeout(timer); run(); } });
    document.addEventListener('click', (e) => { if (!box.contains(e.target) && e.target !== input) hide(); });
  }
  wireSearch('A'); wireSearch('B');

  for (const k of ['A', 'B']) {
    const text = k === 'A' ? 'Нажмите на карте, где старт' : 'Нажмите на карте, где финиш';
    $('#pick' + k).addEventListener('click', () => app.setMode(S.mode === k ? null : k, text));
    app.registerMode(k, {
      click(ll) {
        setPoint(k, ll.lat, ll.lng);
        app.setMode(null);
        if (k === 'A' && !store.prefs.loop && !store.B) app.setMode('B', 'Нажмите на карте, где финиш');
      }
    });
  }
  $('#locA').addEventListener('click', () => {
    if (!navigator.geolocation) { toast('Браузер не умеет определять местоположение.'); return; }
    navigator.geolocation.getCurrentPosition((p) => {
      setPoint('A', p.coords.latitude, p.coords.longitude, 'Моё местоположение');
      map.setView([p.coords.latitude, p.coords.longitude], 15);
    }, () => toast('Не удалось определить местоположение.'), { enableHighAccuracy: true, timeout: 10000 });
  });

  /* ---------- дистанция: свои пресеты и своё значение ---------- */
  function renderKm() {
    const box = $('#kmChips');
    const p = store.prefs;
    box.innerHTML = '';
    for (const km of p.kmPresets) {
      const chip = el('button', {
        class: 'chip', type: 'button', 'aria-pressed': String(km === p.km),
        title: 'Правый клик или долгое нажатие — удалить', onclick: () => { p.km = km; renderKm(); save(); }
      }, fmtNum(km));
      let press = null;
      const remove = () => {
        if (p.kmPresets.length <= 1) return;
        p.kmPresets = p.kmPresets.filter((x) => x !== km);
        renderKm(); save(); toast('Дистанция ' + fmtNum(km) + ' км убрана из быстрых.');
      };
      chip.addEventListener('contextmenu', (e) => { e.preventDefault(); remove(); });
      chip.addEventListener('pointerdown', (e) => { if (e.pointerType !== 'mouse') press = setTimeout(remove, 600); });
      ['pointerup', 'pointerleave', 'pointercancel'].forEach((t) => chip.addEventListener(t, () => clearTimeout(press)));
      box.appendChild(chip);
    }
    const custom = !p.kmPresets.includes(p.km);
    const input = el('input', {
      id: 'km', type: 'text', inputmode: 'decimal', placeholder: 'своя', 'aria-label': 'Своя дистанция, км',
      value: custom ? fmtNum(p.km) : ''
    });
    const parse = () => {
      const v = parseFloat(input.value.replace(',', '.'));
      return v >= 1 && v <= 60 ? Math.round(v * 10) / 10 : null;
    };
    input.addEventListener('input', () => {
      const v = parse();
      if (v === null) return;
      p.km = v; save();
      box.querySelectorAll('.chip[aria-pressed]').forEach((c) => c.setAttribute('aria-pressed', 'false'));
    });
    const add = el('button', {
      class: 'chip add', type: 'button', 'aria-label': 'Сохранить дистанцию в быстрые', title: 'Сохранить в быстрые',
      onclick: () => {
        const v = parse();
        if (v === null) { toast('Введите дистанцию от 1 до 60 км.'); input.focus(); return; }
        if (!p.kmPresets.includes(v)) p.kmPresets = [...p.kmPresets, v].sort((a, b) => a - b);
        p.km = v; renderKm(); save();
      }
    }, '+');
    box.appendChild(el('label', { class: 'kmin' }, input, el('span', null, 'км')));
    box.appendChild(add);
  }

  /* ---------- предпочтения ---------- */
  function outputs() {
    const p = store.prefs;
    $('#outMain').textContent = p.main === 0 ? 'не важно' : p.main + '%';
    $('#outAppeal').textContent = p.appeal === 0 ? 'не важно' : p.appeal + '%';
    $('#outNovelty').textContent = p.novelty === 0 ? 'без разницы' : (p.novelty > 0 ? 'новые ' : 'знакомые ') + Math.abs(p.novelty) + '%';
    $('#outPoi').textContent = p.poi === 0 ? 'не важно' : p.poi + '%';
  }
  function syncPrefs() {
    const p = store.prefs;
    renderKm();
    syncSeg($('#tolSeg'), 'tol', p.tol);
    $('#loop').checked = p.loop; $('#fieldB').hidden = p.loop;
    $('#prefMain').value = p.main; $('#prefAppeal').value = p.appeal; $('#prefNovelty').value = p.novelty; $('#prefPoi').value = p.poi;
    $('#avoidSteps').checked = p.avoidSteps; $('#strictGates').checked = p.strictGates;
    $('#kmStep').value = String(p.kmStep); $('#pace').value = p.pace;
    outputs();
  }
  function bindPref(id, key, conv) {
    $(id).addEventListener('input', (e) => {
      const t = e.target;
      store.prefs[key] = conv ? conv(t) : (t.type === 'checkbox' ? t.checked : t.value);
      outputs(); save();
      if (key === 'loop') { $('#fieldB').hidden = t.checked; renderAB(); }
      if (key === 'kmStep' && S.sel >= 0) drawRoutes();
      if (key === 'pace') renderResults();
    });
  }
  const int = (t) => parseInt(t.value, 10);
  bindPref('#loop', 'loop');
  bindPref('#prefMain', 'main', int);
  bindPref('#prefAppeal', 'appeal', int);
  bindPref('#prefNovelty', 'novelty', int);
  bindPref('#prefPoi', 'poi', int);
  bindPref('#avoidSteps', 'avoidSteps');
  bindPref('#strictGates', 'strictGates');
  bindPref('#kmStep', 'kmStep', (t) => parseFloat(t.value));
  bindPref('#pace', 'pace');
  $('#tolSeg').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    store.prefs.tol = parseFloat(b.dataset.tol); syncSeg($('#tolSeg'), 'tol', store.prefs.tol); save();
  });

  function paceMin() {
    const m = /^\s*(\d{1,2})\s*[:.,]\s*(\d{1,2})\s*$/.exec(store.prefs.pace || '');
    if (m) return parseInt(m[1], 10) + parseInt(m[2], 10) / 60;
    const n = parseFloat(store.prefs.pace);
    return n > 0 ? n : 6;
  }

  /* ---------- «пройти через» ---------- */
  const isForced = (id) => S.forced.some((f) => f.id === id);
  function toggleForced(p) {
    if (isForced(p.id)) S.forced = S.forced.filter((f) => f.id !== p.id);
    else S.forced.push({ id: p.id, name: p.name || 'Без названия', lat: p.lat, lon: p.lon });
    renderForced(); app.emit('forced');
  }
  function renderForced() {
    const box = $('#forcedList');
    box.innerHTML = '';
    for (const f of S.forced) {
      box.appendChild(el('button', { class: 'chip target', type: 'button', 'aria-label': 'Убрать ' + f.name, onclick: () => toggleForced(f) }, f.name + ' ×'));
    }
    $('#forcedField').hidden = !S.forced.length;
  }
  app.isForced = isForced;
  app.toggleForced = toggleForced;

  /* ---------- генерация ---------- */
  const say = (msg, kind) => { const s = $('#status'); s.textContent = msg || ''; s.className = 'status' + (kind ? ' ' + kind : ''); };

  /* Плетение из двух нитей: длина = прогресс. */
  function braid(frac) {
    const end = 2 + 396 * Math.max(0.04, Math.min(1, frac));
    let a = 'M2 9', b = 'M2 9';
    for (let x = 2, up = true; x < end; x += 30, up = !up) {
      const x2 = Math.min(end, x + 30), mid = (x + x2) / 2;
      a += ` Q ${mid} ${up ? 1 : 17} ${x2} 9`;
      b += ` Q ${mid} ${up ? 17 : 1} ${x2} 9`;
    }
    $('#braidA').setAttribute('d', a);
    $('#braidB').setAttribute('d', b);
  }
  function setBusy(b) {
    S.busy = b;
    $('#go').hidden = b; $('#cancel').hidden = !b; $('#prog').hidden = !b;
    if (b) braid(0.05);
  }
  $('#cancel').addEventListener('click', () => { if (S.abort) S.abort.abort(); });

  function contextForGraph() {
    const ctx = S.net && S.net.ctx ? S.net.ctx : { parks: [], pois: [] };
    const pois = ctx.pois.slice();
    const have = new Set(pois.map((p) => p.id));
    for (const p of S.osmPois) if (!have.has(p.id)) pois.push({ id: p.id, lat: p.lat, lon: p.lon, name: p.name, cat: p.cat });
    return { parks: ctx.parks, pois };
  }

  function renderClosed() {
    layers.gates.clearLayers(); layers.closed.clearLayers();
    const g = S.graph; if (!g) return;
    const gray = cssVar('map-gate-osm');
    for (const ln of g.closedWays) layers.closed.addLayer(L.polyline(ln, { color: gray, weight: 2, dashArray: '4 5', opacity: 0.9, interactive: false }));
    for (const c of g.closedGates) {
      const m = L.marker([c.lat, c.lon], { icon: divIcon('mk-gate', 6, 18), keyboard: false, title: 'Закрыто для пешехода' });
      m.bindPopup('Закрытый проход: ' + c.barrier + (c.access ? ' (access=' + c.access + ')' : '') + (c.name ? ', ' + c.name : ''));
      layers.gates.addLayer(m);
    }
  }

  async function generate() {
    if (S.busy) return;
    const prefs = store.prefs, A = store.A;
    if (!A) { say('Сначала задайте старт: введите адрес или нажмите на прицел.', 'warn'); return; }
    const B = prefs.loop ? A : store.B;
    if (!B) { say('Задайте финиш или отметьте «Финиш там же».', 'warn'); return; }
    const Lm = prefs.km * 1000;
    const d = Core.hav(A.lat, A.lon, B.lat, B.lon);
    if (!prefs.loop && Lm < d * 1.02) { say('От старта до финиша по прямой уже ' + fmtKm(d) + ' км. Увеличьте дистанцию.', 'warn'); return; }

    const ac = new AbortController(); S.abort = ac;
    setBusy(true); say('Готовлюсь…');
    try {
      const R = Core.loadRadius(d, Lm, 5000);
      const need = { A: [A.lat, A.lon], B: [B.lat, B.lon], R };
      if (!S.net || !Core.regionContains(S.net.region, need)) {
        say('Загружаю улицы из OpenStreetMap в радиусе ' + fmt1(R / 1000) + ' км. Это может занять до минуты…');
        const area = Core.aroundStr(R, need.A, need.B);
        const parsed = Core.parseNetwork(await overpass(Core.networkQuery(area), ac.signal));
        if (!parsed.ways.length) throw new Error('В этой зоне не нашлось улиц.');
        S.net = { region: need, parsed, ctx: null };
        S.graph = null;
        braid(0.15);
        say('Загружаю парки и интересные места…');
        try { S.net.ctx = Core.parseContext(await overpass(Core.contextQuery(area), ac.signal)); }
        catch (e) { if (ac.signal.aborted) throw e; S.net.ctx = null; toast('Парки и места не загрузились. Маршрут строится без них.'); }
        if (R >= 5000 && Lm / 2.5 > 5000) toast('Для такой длины зона ограничена радиусом 5 км. Маршруты могут получиться короче.');
      }
      braid(0.25);
      const key = JSON.stringify([prefs.avoidSteps, prefs.strictGates]);
      if (!S.graph || S.graphKey !== key) {
        say('Строю граф улиц…'); await tick();
        S.graph = Core.buildGraph(S.net.parsed, { avoidSteps: prefs.avoidSteps, strictGates: prefs.strictGates });
        S.graphKey = key; S.router = null;
      }
      const g = S.graph;
      say('Учитываю парки, места и пройденные улицы…'); await tick();
      Core.applyContext(g, contextForGraph());
      Core.applyExplored(g, store.explored.flatMap((en) => en.lines));
      renderClosed();

      const comp = 30;
      const sA = Core.nearestNode(g, A.lat, A.lon, 400, comp);
      const sB = Core.nearestNode(g, B.lat, B.lon, 400, comp);
      if (!sA) throw new Error('Рядом со стартом нет проходимых улиц. Сдвиньте точку.');
      if (!sB) throw new Error('Рядом с финишем нет проходимых улиц. Сдвиньте точку.');
      if (g.comp[sA.node] !== g.comp[sB.node]) throw new Error('Между стартом и финишем нет пути без закрытых проходов. Включите слой «Закрытые проходы» и сдвиньте точки.');

      const forced = [];
      let skipped = 0;
      for (const f of S.forced) {
        const s = Core.nearestNode(g, f.lat, f.lon, 250, comp);
        if (s && g.comp[s.node] === g.comp[sA.node]) forced.push(s.node); else skipped++;
      }
      const attract = [];
      for (const p of g.pois.slice(0, 400)) {
        const s = Core.nearestNode(g, p.lat, p.lon, 120, comp);
        if (s) attract.push(s.node);
      }

      const gen = Core.createGenerator(g, {
        A: sA.node, B: sB.node, length: Lm, tol: prefs.tol, count: 4, seed: (Math.random() * 1e9) | 0,
        forced, attract, maxAttempts: 200,
        prefs: { appeal: prefs.appeal / 100, mainAvoid: prefs.main / 100, novelty: prefs.novelty / 100, poi: prefs.poi / 100 }
      });
      if (gen.state.error) throw new Error('В зоне слишком мало улиц для такой длины. Уменьшите дистанцию или сдвиньте старт.');
      while (!gen.run(35)) {
        const pr = gen.progress();
        braid(0.25 + 0.75 * pr.attempts / pr.max);
        say('Плету маршруты: ' + pr.attempts + ' из ' + pr.max + ', подходящих ' + pr.accepted);
        await tick();
        if (ac.signal.aborted) throw new DOMException('Отменено', 'AbortError');
      }
      const res = gen.results();
      S.routes = res.routes;
      S.sel = S.routes.length ? 0 : -1;
      if (!S.routes.length) {
        say('Не удалось подобрать маршрут нужной длины. Измените дистанцию, увеличьте допуск или сдвиньте точки.', 'warn');
      } else {
        let msg = 'Вариантов: ' + S.routes.length + '.';
        if (res.approx) msg += ' Точно в допуск не попали, показаны ближайшие по длине.';
        if (skipped) msg += ' Мест вне зоны или за закрытыми проходами пропущено: ' + skipped + '.';
        if (sA.dist > 100 || sB.dist > 100) msg += ' Старт или финиш сдвинуты к ближайшей улице.';
        say(msg);
      }
      renderResults(); drawRoutes(true);
    } catch (e) {
      if (e && e.name === 'AbortError') say('Построение отменено.');
      else say((e && e.message) || 'Не удалось построить маршрут.', 'warn');
    } finally {
      setBusy(false); S.abort = null;
    }
  }
  $('#go').addEventListener('click', generate);

  /* ---------- варианты ---------- */
  /* Название по содержанию: заметное место на пути и главная улица. */
  function routeName(r, i) {
    const m = r.metrics;
    const poi = m.pois.find((p) => p.name && p.cat === 'park') || m.pois.find((p) => p.name);
    const parts = [];
    if (poi) parts.push(poi.name);
    const street = m.streets.find((s) => !poi || s !== poi.name);
    if (street) parts.push(street);
    return parts.length ? parts.slice(0, 2).join(' · ') : 'Вариант ' + (i + 1);
  }

  function renderResults() {
    const box = $('#results');
    box.innerHTML = '';
    S.routes.forEach((r, i) => {
      const m = r.metrics, mins = (r.length / 1000) * paceMin();
      const notes = [];
      if (r.off) notes.push('Длина отличается от заданной на ' + Math.round(r.err * 100) + '%');
      if (m.stepsLen > 0) notes.push('Есть лестницы: ' + Math.round(m.stepsLen) + ' м');
      box.appendChild(el('article', { class: 'route', 'aria-current': String(i === S.sel), onclick: () => selectRoute(i) },
        el('h3', null, routeName(r, i)),
        el('div', { class: 'figs' }, el('span', { class: 'len' }, fmtKm(r.length) + ' км'), el('span', { class: 'muted' }, '≈ ' + fmtTime(mins))),
        el('div', { class: 'meta' }, [
          Math.round(m.newShare * 100) + '% новых улиц',
          Math.round(Math.max(m.pathShare, m.parkShare) * 100) + '% тропы и парки',
          'переходов ' + m.crossings
        ].join(' · ')),
        notes.length ? el('div', { class: 'note' }, notes.join('. ')) : null,
        i === S.sel ? el('div', { class: 'actions' },
          el('button', { class: 'btn small', type: 'button', onclick: (e) => { e.stopPropagation(); downloadGpx(i); } }, 'Скачать GPX'),
          el('button', { class: 'btn small', type: 'button', onclick: (e) => { e.stopPropagation(); markRoute(i); } }, 'Отметить пройденным')) : null));
    });
  }
  function selectRoute(i) {
    if (S.sel === i) return;
    S.sel = i; renderResults(); drawRoutes(false);
    const r = S.routes[i]; if (r) map.fitBounds(L.latLngBounds(r.coords), { padding: [40, 40] });
  }
  function drawRoutes(fit) {
    layers.routes.clearLayers(); layers.km.clearLayers();
    const route = cssVar('map-route'), paper = cssVar('paper'), muted = cssVar('ink-muted');
    S.routes.forEach((r, i) => {
      if (i === S.sel) return;
      layers.routes.addLayer(L.polyline(r.coords, { color: muted, weight: 3, opacity: 0.45 }).on('click', () => selectRoute(i)));
    });
    const r = S.routes[S.sel];
    if (!r) return;
    layers.routes.addLayer(L.polyline(r.coords, { color: paper, weight: 9, opacity: 1, interactive: false, lineCap: 'round', lineJoin: 'round' }));
    layers.routes.addLayer(L.polyline(r.coords, { color: route, weight: 5, opacity: 1, interactive: false, lineCap: 'round', lineJoin: 'round' }));
    for (const mk of Core.kmMarkers(r.coords, store.prefs.kmStep * 1000)) {
      layers.km.addLayer(L.marker([mk.lat, mk.lon], { icon: divIcon('mk-km', 24, 24, Core.fmtKm(mk.km)), interactive: false, keyboard: false }));
    }
    if (fit) map.fitBounds(L.latLngBounds(r.coords), { padding: [40, 40] });
  }

  function downloadGpx(i) {
    const r = S.routes[i]; if (!r) return;
    const loop = store.prefs.loop, name = routeName(r, i);
    const wps = [{ lat: r.coords[0][0], lon: r.coords[0][1], name: loop ? 'Старт и финиш' : 'Старт' }];
    for (const mk of Core.kmMarkers(r.coords, store.prefs.kmStep * 1000)) wps.push({ lat: mk.lat, lon: mk.lon, name: Core.fmtKm(mk.km) + ' км' });
    if (!loop) { const last = r.coords[r.coords.length - 1]; wps.push({ lat: last[0], lon: last[1], name: 'Финиш ' + fmtKm(r.length) + ' км' }); }
    const gpx = Core.toGPX({ name: name + ', ' + fmtKm(r.length) + ' км', desc: 'rundom. Метки каждые ' + Core.fmtKm(store.prefs.kmStep) + ' км.', coords: r.coords, waypoints: wps });
    download('rundom-' + fmtKm(r.length).replace(',', '_') + 'km-' + (i + 1) + '.gpx', gpx, 'application/gpx+xml');
    toast('GPX сохранён. Откройте его в Organic Maps или другом навигаторе.');
  }
  function markRoute(i) {
    const r = S.routes[i]; if (!r) return;
    if (app.addExplored(routeName(r, i) + ', ' + fmtKm(r.length) + ' км', 'route', [r.coords])) toast('Улицы маршрута отмечены пройденными.');
  }

  app.on('theme', () => { drawRoutes(false); renderClosed(); });

  syncPrefs(); renderAB(); renderForced();
  if (store.A) $('#qA').value = store.A.label || coordText(store.A);
  if (store.B) $('#qB').value = store.B.label || coordText(store.B);
  app.generate = generate;
}
