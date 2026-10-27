/* Запросы к Overpass API с перебором зеркал. */

const MIRRORS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter'
];

const aborted = () => new DOMException('Отменено', 'AbortError');

export async function overpass(query, signal) {
  let lastErr = null;
  for (const url of MIRRORS) {
    if (signal.aborted) throw aborted();
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 180000);
    const onAbort = () => ctrl.abort();
    signal.addEventListener('abort', onAbort);
    try {
      const resp = await fetch(url, {
        method: 'POST', body: 'data=' + encodeURIComponent(query),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, signal: ctrl.signal
      });
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      const json = await resp.json();
      if (json.remark && /runtime error|out of memory/i.test(json.remark) && !(json.elements && json.elements.length)) throw new Error(json.remark);
      return json;
    } catch (e) {
      if (signal.aborted) throw aborted();
      lastErr = e;
    } finally {
      clearTimeout(to);
      signal.removeEventListener('abort', onAbort);
    }
  }
  throw lastErr || new Error('Overpass недоступен');
}
