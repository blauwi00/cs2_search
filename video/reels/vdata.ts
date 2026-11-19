// Данные для ролика «инвентарь»: живые цены Steam в долларах (work/prices_usd.tsv) → work/vdata.json. Выплата — настоящая формула бота.
import { readFileSync, writeFileSync, statSync } from 'node:fs';
import { steamSellerProceeds } from '../../src/core/fees.ts';
// node vdata.ts [--out work/<ролик>] — по умолчанию work/ (ролик «инвентарь»).
const oi = process.argv.indexOf('--out');
const DIR = oi > 0 ? new URL(process.argv[oi + 1].replace(/\/?$/, '/'), 'file://' + process.cwd() + '/').pathname : new URL('./work/', import.meta.url).pathname;
const WEAR: Record<string, string> = { 'Factory New': 'FN', 'Minimal Wear': 'MW', 'Field-Tested': 'FT', 'Well-Worn': 'WW', 'Battle-Scarred': 'BS' };
const short = (n: string) => n.replace(/^★ /, '').replace(/ \(.*\)$/, '');
const items = readFileSync(DIR + 'prices_usd.tsv', 'utf8').trim().split('\n').map((l) => {
  const [name, j] = l.split('\t'); const o = JSON.parse(j);
  const cents = Math.round(Number(String(o.lowest_price).replace(/[^\d.]/g, '')) * 100);
  if (!o.success || !(cents > 0)) throw new Error('нет цены Steam: ' + name);
  const volume = o.volume ? Number(String(o.volume).replace(/\D/g, '')) : 0;
  const wear = WEAR[(name.match(/\(([^)]+)\)$/) || [])[1] ?? ''] ?? null;
  return { name, short: short(name), cents, volume, wear, img: 'img/' + name.replace(/[^A-Za-z0-9]/g, '_') + '.png' };
}).sort((a, b) => b.cents - a.cents);
const total = items.reduce((s, x) => s + x.cents, 0);
const net = items.reduce((s, x) => s + (steamSellerProceeds(x.cents)?.sellerReceives ?? 0), 0);
const at = statSync(DIR + 'prices_usd.tsv').mtime;
const date = at.toISOString().slice(0, 10).split('-').reverse().join('.');
const tints = JSON.parse(readFileSync(DIR + 'tints.json', 'utf8'));
const V = { date, items: items.map((x) => ({ ...x, tint: tints[x.img] ?? [65, 224, 138] })), total, net };
writeFileSync(DIR + 'vdata.json', JSON.stringify(V, null, 1));
writeFileSync(DIR + 'vdata.js', 'window.V = ' + JSON.stringify(V) + ';\n');
console.log(date, total, net);
