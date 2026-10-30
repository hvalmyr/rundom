/* Проверка собранных данных перед публикацией: бюджеты размеров и сравнение с прошлым релизом.
   node scripts/data/check.mjs <stats.json> [prev-stats.json]; отчёт в stdout (markdown), код 1 — не публиковать. */
import { readFileSync, existsSync } from 'node:fs';

const [, , cur, prev] = process.argv;
const s = JSON.parse(readFileSync(cur, 'utf8'));
const p = prev && existsSync(prev) ? JSON.parse(readFileSync(prev, 'utf8')) : null;
const KB = 1024;
const rows = [], fails = [];
const check = (name, ok, text) => { rows.push(`| ${ok ? '✅' : '❌'} | ${name} | ${text} |`); if (!ok) fails.push(name); };

check('Районов внутри МКАД', s.districts >= 95, String(s.districts));
check('Справка «О районе»', s.about >= s.districts * 0.8, `${s.about} из ${s.districts}`);
check('Индекс', s.indexGz <= 300 * KB, Math.round(s.indexGz / KB) + ' КБ gzip (бюджет 300)');
/* центральные районы плотнее остальных: бюджет 80 КБ вместо 40 */
check('Самый крупный район', s.maxDistrictGz <= 80 * KB, Math.round(s.maxDistrictGz / KB) + ' КБ gzip (бюджет 80)');
check('Самый мелкий район', s.minDistrictGz >= 3 * KB, Math.round(s.minDistrictGz / KB) + ' КБ gzip');
/* сеть улиц: одна связная компонента (отдельно — только куски с названными улицами), без коротких тупиков и петель,
   все названные улицы на месте */
if (s.net) {
  const n = s.net;
  /* отдельные куски — за железными дорогами и у МКАД, без связи в OSM ближе 30 м: допустимы, если их доля мала */
  check('Связность сети', n.mainShare >= 99.5, `в главной компоненте ${n.mainShare}% длины; отдельных кусков ${n.components - 1}, из них с названными улицами ${n.otherNamed}`);
  check('Тупики короче 50 м', n.deadShort === 0, String(n.deadShort));
  check('Петли короче 50 м', n.loopsShort === 0, String(n.loopsShort));
  check('Потеряно названных улиц', n.lostNamed === 0, String(n.lostNamed));
  check('Три параллельные линии у улицы', n.parallel3 <= 2, n.parallel3 + '% длины названных улиц');
}
for (const k of ['km', 'districts', 'streets', 'objects', 'parks']) {
  if (!p) { check(k, true, `${s[k]} (прошлого релиза нет)`); continue; }
  const d = (s[k] - p[k]) / p[k];
  check(k, Math.abs(d) <= 0.1, `${p[k]} → ${s[k]} (${d >= 0 ? '+' : ''}${(d * 100).toFixed(1)}%, допустимо ±10%)`);
}

console.log(`Данные OpenStreetMap от ${s.date}\n\n| | Проверка | Значение |\n|---|---|---|\n${rows.join('\n')}\n`);
if (fails.length) {
  console.log(`Не прошло: ${fails.join(', ')}. Релиз не опубликован.`);
  process.exit(1);
}
