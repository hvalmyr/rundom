/* Вкладка «Маршрут»: старт и финиш, дистанция, предпочтения, генерация и варианты. */
import L from 'leaflet';
import * as Core from '../core/index.js';
import { store, save } from '../storage/store.js';
import { loadStreets } from '../data/streets.js';
import { divIcon } from '../map/map.js';
import { $, el, tick, fmtKm, fmtNum, fmtTime, toast, download, syncSeg, uid, ICON, userMessage } from './dom.js';

export function initRoutePanel(app) {
  const { map, layers, S } = app;

  /* ---------- старт и финиш ---------- */
  const coordText = (p) => p.lat.toFixed(5) + ', ' + p.lon.toFixed(5);

  function renderAB() {
    layers.ab.clearLayers();
    app.emit('origin');
    if (store.prefs.startMode === 'home') return;
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

  /* ---------- дистанция: быстрые пресеты; «+» превращается в поле, Enter сохраняет ---------- */
  function renderKm() {
    const box = $('#kmChips');
    const p = store.prefs;
    if (!p.kmPresets.includes(p.km)) p.kmPresets = [...p.kmPresets, p.km].sort((a, b) => a - b);
    box.innerHTML = '';
    for (const km of p.kmPresets) {
      const chip = el('button', {
        class: 'chip', type: 'button', 'aria-pressed': String(km === p.km),
        title: 'Правый клик или долгое нажатие — удалить', onclick: () => { p.km = km; renderKm(); save(); app.emit('km'); }
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
    const add = el('button', {
      class: 'chip add', type: 'button', 'aria-label': 'Добавить дистанцию', title: 'Добавить дистанцию',
      onclick: () => {
        const input = el('input', { id: 'km', type: 'text', inputmode: 'decimal', placeholder: 'км', 'aria-label': 'Новая дистанция, км, Enter — сохранить' });
        let done = false;
        const finish = (keep) => {
          if (done) return;
          done = true;
          const v = parseFloat(input.value.replace(',', '.'));
          if (keep && input.value.trim()) {
            if (!(v >= 1 && v <= 60)) { toast('Введите дистанцию от 1 до 60 км.'); done = false; input.select(); return; }
            const km = Math.round(v * 10) / 10;
            if (!p.kmPresets.includes(km)) p.kmPresets = [...p.kmPresets, km].sort((a, b) => a - b);
            p.km = km; save(); app.emit('km');
          }
          renderKm();
          if (keep) $('#kmChips .chip.add').focus();
        };
        input.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') { e.preventDefault(); finish(true); }
          if (e.key === 'Escape') { e.preventDefault(); finish(false); }
        });
        input.addEventListener('blur', () => finish(false));
        add.replaceWith(el('label', { class: 'kmin' }, input));
        input.focus();
      }
    }, '+');
    box.appendChild(add);
  }

  /* ---------- допуск: в какую сторону и насколько ---------- */
  const TOLS = [0.03, 0.05, 0.08], SIGN = { plus: '+', minus: '−', both: '±' };
  function syncTol() {
    const p = store.prefs;
    if (!TOLS.includes(p.tol)) p.tol = 0.08;
    if (!SIGN[p.tolSign]) p.tolSign = 'both';
    syncSeg($('#tolSignSeg'), 'sign', p.tolSign);
    syncSeg($('#tolSeg'), 'tol', p.tol);
    $('#tolSeg').querySelectorAll('button').forEach((b) => { b.textContent = SIGN[p.tolSign] + Math.round(b.dataset.tol * 100) + '%'; });
  }
  /* Генератор ищет длину в окне ±tol вокруг цели: односторонний допуск сдвигает цель
     в середину окна [L, L(1+t)] или [L(1−t), L] и вдвое сужает окно. */
  function lengthWindow(Lm, t, sign) {
    if (sign === 'both') return { length: Lm, tol: t };
    const k = sign === 'plus' ? 1 : -1, mid = Lm * (1 + k * t / 2);
    return { length: mid, tol: (Lm * t / 2) / mid };
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
    syncTol();
    $('#loop').checked = p.loop; $('#fieldB').hidden = p.loop;
    $('#prefMain').value = p.main; $('#prefAppeal').value = p.appeal; $('#prefNovelty').value = p.novelty; $('#prefPoi').value = p.poi;
    $('#avoidSteps').checked = p.avoidSteps; $('#allowRepeats').checked = p.allowRepeats; $('#strictGates').checked = p.strictGates;
    $('#kmStep').value = String(Math.round(p.kmStep * 1000)); $('#pace').value = fmtPace(paceSec());
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
  /* метки: метры в поле, километры в настройках; неверное значение откатывается при уходе с поля */
  $('#kmStep').addEventListener('change', (e) => {
    const m = Math.round(parseFloat(String(e.target.value).replace(',', '.')));
    if (m >= 100 && m <= 10000) { store.prefs.kmStep = m / 1000; save(); if (S.sel >= 0) drawRoutes(); }
    else toast('Метки — от 100 до 10 000 м.');
    e.target.value = String(Math.round(store.prefs.kmStep * 1000));
  });
  /* темп «м:сс»: цифры без двоеточия тоже понимаются (530 → 5:30), стрелки и кнопки — по 5 секунд */
  const setPace = (sec) => {
    store.prefs.pace = fmtPace(Math.max(150, Math.min(1200, Math.round(sec / 5) * 5)));
    $('#pace').value = store.prefs.pace; save(); renderResults();
  };
  $('#pace').addEventListener('change', (e) => {
    const sec = parsePace(e.target.value);
    if (sec) setPace(sec); else { toast('Темп — минуты и секунды на километр, например 5:30.'); e.target.value = store.prefs.pace; }
  });
  $('#pace').addEventListener('keydown', (e) => {
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') { e.preventDefault(); setPace(paceSec() + (e.key === 'ArrowUp' ? 5 : -5)); }
  });
  $('#paceDown').addEventListener('click', () => setPace(paceSec() - 5));
  $('#paceUp').addEventListener('click', () => setPace(paceSec() + 5));
  const int = (t) => parseInt(t.value, 10);
  bindPref('#loop', 'loop');
  bindPref('#prefMain', 'main', int);
  bindPref('#prefAppeal', 'appeal', int);
  bindPref('#prefNovelty', 'novelty', int);
  bindPref('#prefPoi', 'poi', int);
  bindPref('#avoidSteps', 'avoidSteps');
  bindPref('#allowRepeats', 'allowRepeats');
  bindPref('#strictGates', 'strictGates');
  $('#tolSeg').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    store.prefs.tol = parseFloat(b.dataset.tol); syncTol(); save();
  });
  $('#tolSignSeg').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    store.prefs.tolSign = b.dataset.sign; syncTol(); save();
  });

  /* «5:30», «5.30», «5,5» (минуты с долей), «530» → секунды на километр; null — не темп */
  function parsePace(v) {
    v = String(v || '').trim();
    let m = /^(\d{1,2})\s*[:.]\s*(\d{1,2})$/.exec(v);
    if (m && +m[2] < 60) return +m[1] * 60 + +m[2];
    m = /^(\d{1,2}),(\d)$/.exec(v);
    if (m) return Math.round((+m[1] + +m[2] / 10) * 60);
    m = /^(\d{1,2})(\d\d)$/.exec(v);
    if (m && +m[2] < 60) return +m[1] * 60 + +m[2];
    m = /^(\d{1,2})$/.exec(v);
    return m && +m[1] > 0 ? +m[1] * 60 : null;
  }
  const fmtPace = (sec) => Math.floor(sec / 60) + ':' + String(sec % 60).padStart(2, '0');
  const paceSec = () => parsePace(store.prefs.pace) || 360;
  const paceMin = () => paceSec() / 60;

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

  /* Полоса прогресса: длина — доля работы. Пока ждём сеть (wait), полоса не стоит: по дорожке бежит блик. */
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

  async function generate() {
    if (S.busy) return;
    const prefs = store.prefs, fromHome = prefs.startMode === 'home';
    const loop = fromHome || prefs.loop;
    const ll = (p) => p && { lat: p[0], lon: p[1] };
    let A, B;
    if (fromHome) {
      if (!store.home) { say('Отметьте дом: кнопка «Отметить» в разделе «Старт».', 'warn'); return; }
      A = ll(store.home); B = ll(store.ringStart) || A;
    } else {
      A = store.A;
      if (!A) { say('Сначала задайте старт: введите адрес или нажмите на прицел.', 'warn'); return; }
      B = loop ? A : store.B;
      if (!B) { say('Задайте финиш или отметьте «Финиш там же».', 'warn'); return; }
    }
    const Lm = prefs.km * 1000;
    const d = Core.hav(A.lat, A.lon, B.lat, B.lon);
    if (!loop && Lm < d * 1.02) { say('От старта до финиша по прямой уже ' + fmtKm(d) + ' км. Увеличьте дистанцию.', 'warn'); return; }

    const ac = new AbortController(); S.abort = ac;
    setBusy(true); say('Готовлюсь…');
    try {
      const R = Core.loadRadius(d, Lm, 5000);
      const need = { A: [A.lat, A.lon], B: [B.lat, B.lon], R };
      if (!S.net || !Core.regionContains(S.net.region, need)) {
        braid(0.08);
        const got = await loadStreets(need, ac.signal, say);
        if (!got.parsed.ways.length) throw new Error('В этой зоне не нашлось улиц.');
        S.net = { region: need, parsed: got.parsed, ctx: got.ctx };
        S.graph = null;
        braid(0.15);
        if (got.ctxFailed) toast('Парки и места не загрузились. Маршрут строится без них.');
        if (R >= 5000 && Lm / 2.5 > 5000) toast('Для такой длины зона ограничена радиусом 5 км. Маршруты могут получиться короче.');
      }
      braid(0.25);
      const key = JSON.stringify([prefs.avoidSteps, prefs.strictGates, store.openGates.map((o) => [o.lat, o.lon])]);
      if (!S.graph || S.graphKey !== key) {
        say('Готовлю карту улиц…'); await tick();
        S.graph = Core.buildGraph(S.net.parsed, { avoidSteps: prefs.avoidSteps, strictGates: prefs.strictGates, openGates: store.openGates });
        S.graphKey = key; S.router = null;
      }
      const g = S.graph;
      say('Учитываю парки, места и пройденные улицы…'); await tick();
      Core.applyContext(g, contextForGraph());
      Core.applyExplored(g, app.tracks.items.flatMap((t) => t.lines));
      const spec = app.blocksSpec();
      const nBlocked = Core.applyBlocks(g, spec);
      app.snapBlocks();
      app.emit('graph');

      const comp = 30;
      let sA, sB, exits = null, ringNode = null, lostExits = 0;
      if (fromHome) {
        const sh = Core.nearestNode(g, A.lat, A.lon, 400, comp);
        if (!sh) throw new Error('Рядом с домом нет проходимых улиц. Проверьте отметку дома и запретные зоны.');
        exits = [];
        for (const p of store.exits) {
          const s = Core.nearestNode(g, p[0], p[1], 150, comp);
          if (s) exits.push(s.node); else lostExits++;
        }
        if (!exits.length) exits.push(sh.node);
        const main = g.comp[exits[0]];
        lostExits += exits.filter((v) => g.comp[v] !== main).length;
        exits = exits.filter((v) => g.comp[v] === main);
        if (store.ringStart) {
          const s = Core.nearestNode(g, B.lat, B.lon, 200, comp);
          if (!s || g.comp[s.node] !== main) throw new Error('От дома до старта кольца нет пути в обход тупиков и зон. Сдвиньте старт кольца или выключите зону.');
          ringNode = s.node;
        }
        sA = sB = { node: ringNode === null ? exits[0] : ringNode, dist: 0 };
      } else {
        sA = Core.nearestNode(g, A.lat, A.lon, 400, comp);
        sB = Core.nearestNode(g, B.lat, B.lon, 400, comp);
        if (!sA) throw new Error('Рядом со стартом нет проходимых улиц. Сдвиньте точку.');
        if (!sB) throw new Error('Рядом с финишем нет проходимых улиц. Сдвиньте точку.');
        if (g.comp[sA.node] !== g.comp[sB.node]) throw new Error('Между стартом и финишем нет пути без закрытых проходов. Включите слой «Закрытые проходы» и сдвиньте точки.');
      }

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

      const direction = await app.directionSpec();
      S.lastGen = {
        dir: direction && direction.dir, districts: direction && direction.districts, dirLabel: direction && direction.label,
        g, A: sA.node, B: sB.node, ...lengthWindow(Lm, prefs.tol, prefs.tolSign), target: Lm, forced, attract, loop,
        exits, ringStart: ringNode, approachMax: prefs.approachMax, noRepeat: !prefs.allowRepeats,
        prefs: { appeal: prefs.appeal / 100, mainAvoid: prefs.main / 100, novelty: prefs.novelty / 100, poi: prefs.poi / 100 }
      };
      const res = await runGenerator(S.lastGen, 4, ac, 0.25);
      S.routes = res.routes;
      S.sel = S.routes.length ? 0 : -1;
      const limits = [nBlocked ? 'тупиков и зон' : '', prefs.allowRepeats ? '' : 'правила без повторов'].filter(Boolean).join(' и ');
      if (!S.routes.length) {
        if (direction && res.dirRejects > res.attempts / 3) {
          say(direction.dir
            ? 'В направлении ' + direction.label + ' кольцо ' + fmtNum(prefs.km) + ' км не получилось. Расширьте точность направления или измените дистанцию.'
            : (prefs.distStrict
              ? 'Строго внутри районов (' + direction.label + ') кольцо ' + fmtNum(prefs.km) + ' км не помещается. Попробуйте «Примерно» или уменьшите дистанцию.'
              : 'Кольцо ' + fmtNum(prefs.km) + ' км не дотягивается дальней точкой до районов: ' + direction.label + '. Измените дистанцию или районы.'), 'warn');
        } else {
          say('Не удалось подобрать маршрут нужной длины' + (limits ? ' с учётом ' + limits : '') + '. Измените дистанцию, увеличьте допуск' +
            (prefs.allowRepeats ? '' : ', разрешите повторы улиц') + ' или сдвиньте точки.', 'warn');
        }
      } else {
        let msg = 'Вариантов: ' + S.routes.length + '.';
        if (res.approx) {
          const best = S.routes.reduce((a, r) => (r.err < a.err ? r : a));
          if (S.routes.every((r) => !r.off)) msg += ' Совсем без повторов улиц не получилось: показаны варианты с наименьшими повторами.';
          else msg += ' Точно в допуск' + (limits ? ' с учётом ' + limits : '') + ' не попали: ближайший вариант ' + fmtKm(best.length) + ' км.';
        }
        if (lostExits) msg += ' Выходов без пути к улицам: ' + lostExits + '.';
        if (res.unreachable.length) msg += ' ' + unreachableText(res.unreachable, Lm) + ' Эти районы пропущены.';
        if (skipped) msg += ' Мест вне зоны или за закрытыми проходами пропущено: ' + skipped + '.';
        if (sA.dist > 100 || sB.dist > 100) msg += ' Старт или финиш сдвинуты к ближайшей улице.';
        say(msg);
      }
      renderResults(); drawRoutes(true);
    } catch (e) {
      if (e && e.name === 'AbortError') say('Построение отменено.');
      else say(userMessage(e, 'Не удалось построить маршрут.'), 'warn');
    } finally {
      setBusy(false); S.abort = null;
    }
  }
  $('#go').addEventListener('click', generate);

  async function runGenerator(o, count, ac, from) {
    const gen = Core.createGenerator(o.g, { ...o, count, seed: (Math.random() * 1e9) | 0, maxAttempts: o.maxAttempts || 200 });
    if (gen.state.error === 'dir') throw new Error('В направлении ' + o.dirLabel + ' от старта нет улиц в загруженной зоне. Поверните стрелку или расширьте точность.');
    if (gen.state.error === 'districts') {
      throw new Error(gen.state.unreachable.length
        ? unreachableText(gen.state.unreachable, o.target || o.length) + ' Измените дистанцию или районы.'
        : 'В выбранных районах нет улиц в зоне загрузки. Выберите районы ближе к старту.');
    }
    if (gen.state.error === 'exits') throw new Error('От выходов из дома некуда начать кольцо. Увеличьте предел подводки или проверьте зоны рядом с домом.');
    if (gen.state.error) throw new Error('В зоне слишком мало улиц для такой длины. Уменьшите дистанцию или сдвиньте старт.');
    while (!gen.run(35)) {
      const pr = gen.progress();
      braid(from + (1 - from) * pr.attempts / pr.max);
      say('Плету маршруты: ' + pr.attempts + ' из ' + pr.max + ', подходящих ' + pr.accepted);
      await tick();
      if (ac.signal.aborted) throw new DOMException('Отменено', 'AbortError');
    }
    const res = gen.results();
    res.dirRejects = gen.progress().dirRejects;
    res.unreachable = gen.state.unreachable || [];
    for (const r of res.routes) {
      r.id = uid(); r.loop = o.loop;
      const title = Core.routeTitle(r.metrics, 'Маршрут ' + fmtKm(r.length) + ' км');
      const district = r.district || app.districtName(r.ringCoords || r.coords);
      r.name = district && !title.includes(district) ? district + ' · ' + title : title;
    }
    return res;
  }

  /* «Якиманка дальше 4,6 км — кольцо 9 км до неё не дотянется.» */
  function unreachableText(list, Lm) {
    const one = list.length === 1;
    return list.map((u) => u.name + (isFinite(u.dist) ? ' дальше ' + fmtKm(u.dist) + ' км' : ' вне зоны загрузки')).join(', ') +
      ': кольцо ' + fmtKm(Lm) + ' км до ' + (one ? 'него' : 'них') + ' не дотянется.';
  }


  /* ---------- избранное ---------- */
  const favOf = (r) => app.favorites.items.find((f) => f.id === r.id);
  function toggleFavorite(r) {
    const f = favOf(r);
    if (f) { app.favorites.remove(f.id); toast('Маршрут убран из избранного.'); }
    else {
      app.favorites.add({
        id: r.id, name: r.name, coords: r.coords, ringCoords: r.ringCoords, approachCoords: r.approachCoords, length: r.length, loop: r.loop,
        newShare: r.metrics.newShare, created: Date.now()
      });
      toast('Маршрут сохранён в библиотеке.');
    }
    app.emit('favorites');
    renderResults();
  }

  /* ---------- варианты ---------- */
  function renderResults() {
    const box = $('#results');
    box.innerHTML = '';
    S.routes.forEach((r, i) => {
      const m = r.metrics, mins = (r.length / 1000) * paceMin();
      const notes = [];
      if (r.off) notes.push('Длина отличается от заданной на ' + Math.round(r.err * 100) + '%');
      if (m.stepsLen > 0) notes.push('Есть лестницы: ' + Math.round(m.stepsLen) + ' м');
      if (r.dirOut) notes.push('Вне выбранного направления ' + Math.round(r.dirOut * 100) + '% пути: целиком в секторе кольцо не складывается');
      if (S.lastGen && S.lastGen.noRepeat && r.repeat > 60) notes.push('Повтор улиц: ' + Math.round(r.repeat / 10) * 10 + ' м');
      const fav = !!favOf(r), on = i === S.sel, edited = !!(r.history && r.history.length);
      /* действия карточки — иконки; у невыбранной видна только звезда избранного */
      const act = (icon, label, fn, extra = {}) => el('button', {
        class: 'iconbtn', type: 'button', 'aria-label': label, title: label, html: ICON[icon],
        onclick: (e) => { e.stopPropagation(); fn(); }, ...extra
      });
      box.appendChild(el('article', { class: 'route', 'aria-current': String(on), onclick: () => selectRoute(i) },
        el('h3', null, r.name),
        fav && !on ? el('span', { class: 'star-mark', title: 'В избранном', html: ICON.star }) : null,
        el('div', { class: 'figs' }, el('span', { class: 'len' }, fmtKm(r.length) + ' км'), el('span', { class: 'muted' }, '≈ ' + fmtTime(mins))),
        el('div', { class: 'meta' }, [
          Math.round(m.newShare * 100) + '% новых улиц',
          Math.round(Math.max(m.pathShare, m.parkShare) * 100) + '% тропы и парки',
          m.crossings ? 'светофоров ' + m.crossings : 'без светофоров',
          r.approach > 0 ? 'подводка 2 × ' + Math.round(r.approach / 10) * 10 + ' м' : ''
        ].filter(Boolean).join(' · ')),
        notes.length ? el('div', { class: 'note' }, notes.join('. ')) : null,
        editsLine(r),
        on ? el('div', { class: 'actions' },
          act('star', fav ? 'Убрать из избранного' : 'В избранное', () => toggleFavorite(r), { class: 'iconbtn star', 'aria-pressed': String(fav) }),
          act('download', 'Скачать GPX', () => downloadRoute(r.name, r.coords, r.length, r.loop)),
          edited ? act('undo', 'Отменить шаг', () => app.ropeUndo()) : null,
          edited ? act('reset', 'Сбросить правки', () => app.ropeReset()) : null) : null));
    });
  }
  /* «Изменён вручную: 2 притяжения, 1 отталкивание» */
  function editsLine(r) {
    const e = r.edits;
    if (!e || (!e.pulls.length && !e.repels.length)) return null;
    const pl = (n, a, b, c) => n + ' ' + (n % 10 === 1 && n % 100 !== 11 ? a : (n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? b : c));
    const parts = [];
    if (e.pulls.length) parts.push(pl(e.pulls.length, 'притяжение', 'притяжения', 'притяжений'));
    if (e.repels.length) parts.push(pl(e.repels.length, 'отталкивание', 'отталкивания', 'отталкиваний'));
    return el('div', { class: 'edited' }, 'Изменён вручную: ' + parts.join(', '));
  }

  function selectRoute(i) {
    if (S.sel === i) return;
    S.sel = i; renderResults(); drawRoutes(false);
    const r = S.routes[i]; if (r) map.fitBounds(L.latLngBounds(r.coords), { padding: [40, 40] });
  }
  /* Варианты, кроме выбранного, — серые линии в векторной карте; клик рядом выбирает вариант. */
  const altIdx = [];
  map.on('click', (e) => {
    if (S.mode || !altIdx.length) return;
    const k = app.gl.pick('alt', e.latlng, 8);
    if (k !== null) selectRoute(altIdx[k]);
  });
  map.on('mousemove', (e) => {
    if (!altIdx.length) return;
    map.getContainer().classList.toggle('pick-alt', !S.mode && app.gl.pick('alt', e.latlng, 8) !== null);
  });
  function drawRoutes(fit) {
    clearLines();
    altIdx.length = 0;
    S.routes.forEach((r, i) => { if (i !== S.sel) altIdx.push(i); });
    app.gl.lines('alt', altIdx.map((i) => S.routes[i].coords));
    const r = S.routes[S.sel];
    S.routeLayers = r ? drawLine(r, fit) : null;
    if (S.lineId) { S.lineId = null; app.emit('lineShown'); }
    app.emit('routeDrawn');
  }
  /* r: {coords, ringCoords?, approachCoords?} — кольцо сплошной линией, подводка пунктиром из точек */
  function clearLines() {
    for (const id of ['alt', 'approach', 'route']) app.gl.lines(id, []);
    layers.km.clearLayers();
  }
  /* Ручка линии в векторной карте: setStyle({weight, opacity}), как у L.Polyline, — её меняет «верёвка». */
  const glLine = (layerId) => ({
    setStyle(o) {
      if (o.weight !== undefined) app.gl.paint(layerId, 'line-width', o.weight);
      if (o.opacity !== undefined) app.gl.paint(layerId, 'line-opacity', o.opacity);
    }
  });
  /* r.lines — несколько линий без меток (пробежка из библиотеки) */
  function drawLine(r, fit) {
    if (r.lines) {
      app.gl.lines('route', r.lines);
      if (fit) map.fitBounds(L.latLngBounds(r.lines.flat()), { padding: [40, 40] });
      return { halo: glLine('route-halo'), line: glLine('route') };
    }
    const coords = r.coords, ring = r.ringCoords || coords;
    app.gl.lines('approach', r.approachCoords ? [r.approachCoords] : []);
    app.gl.lines('route', [ring]);
    const out = { halo: glLine('route-halo'), line: glLine('route') };
    out.halo.setStyle({ opacity: 1 }); out.line.setStyle({ weight: 5, opacity: 1 });
    for (const mk of Core.kmMarkers(coords, store.prefs.kmStep * 1000)) {
      layers.km.addLayer(L.marker([mk.lat, mk.lon], { icon: divIcon('mk-km', 24, 24, Core.fmtKm(mk.km)), interactive: false, keyboard: false }));
    }
    if (fit) map.fitBounds(L.latLngBounds(coords), { padding: [40, 40] });
    return out;
  }
  /* Показать сохранённый маршрут: снимает выбор с текущих вариантов. id запоминается в S.lineId. */
  app.showLine = (r, id = null) => {
    S.sel = -1; renderResults();
    clearLines();
    altIdx.length = 0;
    drawLine(Array.isArray(r) ? { coords: r } : r, true);
    S.lineId = id;
    S.routeLayers = null; app.emit('routeDrawn');
  };
  app.hideLine = () => {
    clearLines();
    altIdx.length = 0;
    S.lineId = null;
    S.routeLayers = null; app.emit('routeDrawn');
  };

  function downloadRoute(name, coords, length, loop) {
    const wps = [{ lat: coords[0][0], lon: coords[0][1], name: loop ? 'Старт и финиш' : 'Старт' }];
    for (const mk of Core.kmMarkers(coords, store.prefs.kmStep * 1000)) wps.push({ lat: mk.lat, lon: mk.lon, name: Core.fmtKm(mk.km) + ' км' });
    if (!loop) { const last = coords[coords.length - 1]; wps.push({ lat: last[0], lon: last[1], name: 'Финиш ' + fmtKm(length) + ' км' }); }
    const gpx = Core.toGPX({ name: name + ', ' + fmtKm(length) + ' км', desc: 'rundom. Метки каждые ' + Core.fmtKm(store.prefs.kmStep) + ' км.', coords, waypoints: wps });
    download('rundom-' + fmtKm(length).replace(',', '_') + 'km.gpx', gpx, 'application/gpx+xml');
    toast('GPX сохранён. Откройте его в Organic Maps или другом навигаторе.');
  }
  app.downloadRoute = downloadRoute;

  app.on('theme', () => drawRoutes(false));
  app.on('start', renderAB);

  syncPrefs(); renderAB(); renderForced();
  if (store.A) $('#qA').value = store.A.label || coordText(store.A);
  if (store.B) $('#qB').value = store.B.label || coordText(store.B);
  app.generate = generate;
  Object.assign(app, { say, setBusy, braid, runGenerator, renderResults, drawRoutes, fmtKm });
}
