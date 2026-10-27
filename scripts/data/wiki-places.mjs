/* Описания и фото мест из Википедии и Викиданных для build.mjs.
   Тексты — вступление статьи русской Википедии (CC BY-SA), фото — из Wikimedia Commons с автором
   и лицензией: свободная картинка из Викиданных (P18) или главная картинка статьи, если она лежит
   на Commons (местные несвободные файлы Википедии не берутся). Запросы пачками, ответы кэшируются. */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const UA = { 'User-Agent': 'rundom-data (github.com/hvalmyr/rundom)' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const strip = (html) => String(html || '').replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();

async function api(host, params) {
  const url = 'https://' + host + '/w/api.php?' + new URLSearchParams({ format: 'json', formatversion: '2', origin: '*', ...params });
  for (let attempt = 0; attempt < 5; attempt++) {
    await sleep(attempt ? 2000 * 2 ** attempt : 150);
    try {
      const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(30000) });
      if (res.ok) return await res.json();
      console.warn('wiki api', host, res.status);
    } catch (e) { console.warn('wiki api', host, e.message); }
  }
  return null;
}
const chunks = (arr, n) => { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; };

/* «ru:Название» → Название; статья на другом языке — null (возьмём из Викиданных) */
const ruTitle = (tag) => { const m = /^ru:(.+)$/.exec(tag || ''); return m ? m[1].trim() : null; };

function trim(s, max) {
  s = s.replace(/́/g, '').replace(/\s*\([^()]*\)/, (m) => (m.length > 60 ? '' : m)).replace(/\s+/g, ' ').trim();
  if (s.length <= max) return s;
  const cut = s.lastIndexOf('. ', max - 10);
  return cut > max / 3 ? s.slice(0, cut + 1) : s.slice(0, max).replace(/\s+\S*$/, '') + '…';
}

/* items: [{wiki, wd}] → Map(item → {t, u, i?: {s, a, l, f}}) */
export async function placeInfo(items, cachePath) {
  let cache = {};
  try { cache = JSON.parse(readFileSync(cachePath, 'utf8')); } catch { /* нет кэша */ }
  const save = () => { mkdirSync(dirname(cachePath), { recursive: true }); writeFileSync(cachePath, JSON.stringify(cache)); };

  /* 1. Викиданные: статья в русской Википедии и свободное фото */
  const qids = [...new Set(items.map((x) => x.wd).filter((q) => /^Q\d+$/.test(q) && !(('q:' + q) in cache)))];
  for (const part of chunks(qids, 50)) {
    const j = await api('www.wikidata.org', { action: 'wbgetentities', ids: part.join('|'), props: 'sitelinks|claims', sitefilter: 'ruwiki' });
    if (!j || !j.entities) continue;
    for (const q of part) {
      const e = j.entities[q];
      if (!e || e.missing !== undefined) { cache['q:' + q] = null; continue; }
      const p18 = e.claims && e.claims.P18 && e.claims.P18[0] && e.claims.P18[0].mainsnak.datavalue;
      cache['q:' + q] = { title: e.sitelinks && e.sitelinks.ruwiki ? e.sitelinks.ruwiki.title : null, img: p18 ? p18.value : null };
    }
  }
  const titleOf = (x) => ruTitle(x.wiki) || (cache['q:' + x.wd] && cache['q:' + x.wd].title) || null;

  /* 2. Википедия: вступление и главная картинка статьи */
  const titles = [...new Set(items.map(titleOf).filter((t) => t && !(('t:' + t) in cache)))];
  for (const part of chunks(titles, 20)) {
    const j = await api('ru.wikipedia.org', {
      action: 'query', prop: 'extracts|pageimages|info', exintro: '1', explaintext: '1', exsentences: '3', exlimit: '20',
      piprop: 'name', inprop: 'url', redirects: '1', titles: part.join('|')
    });
    if (!j || !j.query) continue;
    const back = new Map(part.map((t) => [t, t]));
    for (const n of j.query.normalized || []) back.set(n.to, n.from);
    for (const r of j.query.redirects || []) back.set(r.to, back.get(r.from) || r.from);
    for (const p of j.query.pages || []) {
      const src = back.get(p.title) || p.title;
      cache['t:' + src] = p.missing || !p.extract ? null : { t: trim(p.extract, 420), u: p.fullurl, img: p.pageimage || null };
    }
    for (const t of part) if (!(('t:' + t) in cache)) cache['t:' + t] = null;
  }
  save();

  /* 3. Commons: только файлы, которые там есть, с автором и лицензией */
  const fileOf = (x) => {
    const q = cache['q:' + x.wd], t = cache['t:' + titleOf(x)];
    return (q && q.img) || (t && t.img) || null;
  };
  const files = [...new Set(items.map(fileOf).filter((f) => f && !(('f:' + f) in cache)))];
  for (const part of chunks(files, 50)) {
    const j = await api('commons.wikimedia.org', {
      action: 'query', prop: 'imageinfo', iiprop: 'url|extmetadata', iiurlwidth: '480',
      iiextmetadatafilter: 'Artist|LicenseShortName|Credit', titles: part.map((f) => 'File:' + f).join('|')
    });
    if (!j || !j.query) continue;
    const back = new Map(part.map((f) => ['File:' + f, f]));
    for (const n of j.query.normalized || []) back.set(n.to, back.get(n.from) || n.from.replace(/^File:/, ''));
    for (const p of j.query.pages || []) {
      const f = back.get(p.title) || p.title.replace(/^File:/, '');
      const ii = p.imageinfo && p.imageinfo[0];
      const m = (ii && ii.extmetadata) || {};
      const lic = m.LicenseShortName && strip(m.LicenseShortName.value);
      cache['f:' + f] = !ii || p.missing || !lic ? null : {
        s: ii.thumburl || ii.url, f: ii.descriptionurl, l: lic,
        a: trim(strip((m.Artist && m.Artist.value) || (m.Credit && m.Credit.value) || 'автор не указан'), 80)
      };
    }
    for (const f of part) if (!(('f:' + f) in cache)) cache['f:' + f] = null;
  }
  save();

  const out = new Map();
  for (const x of items) {
    const t = cache['t:' + titleOf(x)];
    if (!t) continue;
    const f = fileOf(x), img = f ? cache['f:' + f] : null;
    /* ссылки короче: адрес статьи без %-кодов, превью без меток в запросе */
    const short = (u) => { try { return decodeURI(u); } catch { return u; } };
    out.set(x, { t: t.t, u: short(t.u), ...(img ? { i: { ...img, s: img.s.replace(/\?.*$/, ''), f: short(img.f) } } : {}) });
  }
  return out;
}
