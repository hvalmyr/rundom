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
check('Индекс', s.indexGz <= 300 * KB, Math.round(s.indexGz / KB) + ' КБ gzip (бюджет 300)');
/* центральные районы плотнее остальных: бюджет 80 КБ вместо 40 */
check('Самый крупный район', s.maxDistrictGz <= 80 * KB, Math.round(s.maxDistrictGz / KB) + ' КБ gzip (бюджет 80)');
check('Самый мелкий район', s.minDistrictGz >= 3 * KB, Math.round(s.minDistrictGz / KB) + ' КБ gzip');
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
