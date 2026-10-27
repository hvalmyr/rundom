/* Запросы к Overpass API: зеркала вперегонки.
   Первым идёт зеркало в России. Если оно не начало отвечать за HEDGE мс или упало, запускается
   следующее; побеждает первый полный ответ, остальные отменяются. Сразу во все зеркала не шлём:
   это публичные серверы, тяжёлый запрос дублируем только когда первое зеркало молчит. */

const MIRRORS = [
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter'
];
const HEDGE = 8000;
const TIMEOUT = 180000;

const aborted = () => new DOMException('Отменено', 'AbortError');

export function overpass(query, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(aborted()); return; }
    const ctrls = [];
    let next = 0, running = 0, settled = false, lastErr = null, hedgeTimer = null;

    const finish = (fn, v) => {
      if (settled) return;
      settled = true;
      clearTimeout(hedgeTimer);
      signal.removeEventListener('abort', onAbort);
      for (const c of ctrls) c.abort();
      fn(v);
    };
    const onAbort = () => finish(reject, aborted());
    signal.addEventListener('abort', onAbort);

    function launch() {
      if (settled || next >= MIRRORS.length) return;
      const url = MIRRORS[next++];
      const ctrl = new AbortController();
      ctrls.push(ctrl);
      running++;
      const to = setTimeout(() => ctrl.abort(), TIMEOUT);
      let answered = false;
      clearTimeout(hedgeTimer);
      hedgeTimer = setTimeout(() => { if (!answered) launch(); }, HEDGE);
      (async () => {
        const resp = await fetch(url, {
          method: 'POST', body: 'data=' + encodeURIComponent(query),
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, signal: ctrl.signal
        });
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        /* сервер начал отдавать результат: дальше только скачивание, второе зеркало не нужно */
        answered = true;
        const json = await resp.json();
        if (json.remark && /runtime error|out of memory/i.test(json.remark) && !(json.elements && json.elements.length)) throw new Error(json.remark);
        return json;
      })().then((json) => finish(resolve, json), (e) => {
        if (settled) return;
        lastErr = e;
        running--;
        if (next < MIRRORS.length) launch();
        else if (!running) finish(reject, lastErr || new Error('Не удалось загрузить улицы: сервер карты не отвечает. Попробуйте ещё раз через минуту.'));
      }).finally(() => clearTimeout(to));
    }
    launch();
  });
}
