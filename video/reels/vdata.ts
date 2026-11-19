// Данные для ролика «инвентарь»: живые цены Steam в долларах (work/prices_usd.tsv) → work/vdata.json. Выплата — настоящая формула бота.
import { readFileSync, writeFileSync, statSync } from 'node:fs';
import { steamSellerProceeds } from '../../src/core/fees.ts';
const DIR = new URL('./work/', import.meta.url).pathname;
const short = (n: string) => n.replace(/^★ /, '').replace(/ \(.*\)$/, '');
const items = readFileSync(DIR + 'prices_usd.tsv', 'utf8').trim().split('\n').map((l) => {
  const [name, j] = l.split('\t'); const o = JSON.parse(j);
  const cents = Math.round(Number(String(o.lowest_price).replace(/[^\d.]/g, '')) * 100);
  if (!o.success || !(cents > 0)) throw new Error('нет цены Steam: ' + name);
  return { name, short: short(name), cents, img: 'img/' + name.replace(/[^A-Za-z0-9]/g, '_') + '.png' };
}).sort((a, b) => b.cents - a.cents);
const total = items.reduce((s, x) => s + x.cents, 0);
const net = items.reduce((s, x) => s + (steamSellerProceeds(x.cents)?.sellerReceives ?? 0), 0);
const at = statSync(DIR + 'prices_usd.tsv').mtime;
const date = at.toISOString().slice(0, 10).split('-').reverse().join('.');
const V = { date, items, total, net };
writeFileSync(DIR + 'vdata.json', JSON.stringify(V, null, 1));
writeFileSync(DIR + 'vdata.js', 'window.V = ' + JSON.stringify(V) + ';\n');
console.log(date, total, net);
