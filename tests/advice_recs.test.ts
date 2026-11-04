import test from 'node:test';
import assert from 'node:assert/strict';
import { advise, type AdviceInput } from '../src/core/advice.ts';
import { buildRecs, parseScan, mergeScan, type ScanEntry } from '../src/core/recs.ts';
import { steamSellerProceeds } from '../src/core/fees.ts';
import { migratedDb, testEnv, ADMIN } from './helpers.ts';
import { signInitData } from '../src/webapp/auth.ts';
import { handleAppApi } from '../src/webapp/api.ts';
import { handleIngest } from '../src/ingest.ts';
import { storeFx } from '../src/storage/db.ts';

const NOW = Date.parse('2026-11-04T12:00:00Z') / 1000;
const base: AdviceInput = { steamLowKop: 1000, avg7Kop: 1000, historyDays: 5, liquidity: 'high', uniquePriced: false, deal: null, lot: null, minRoiBp: 800, minProfitKop: 2000 };

test('подсказка: купить / продать / дорого / ждать / мало данных', () => {
  assert.equal(advise({ ...base, historyDays: 1 }).action, 'nodata');
  assert.equal(advise(base).action, 'hold');
  assert.equal(advise({ ...base, steamLowKop: 900 }).action, 'buy', '−10% к средней — дешевле обычного');
  assert.equal(advise({ ...base, steamLowKop: 900, liquidity: 'low' }).action, 'hold', 'неликвид не советуем');
  assert.equal(advise({ ...base, steamLowKop: 1100 }).action, 'avoid');
  assert.equal(advise({ ...base, deal: { spreadKop: 500, buyKop: 700, buySource: 'skinport', proceedsKop: 1200, priority: 'high' } }).action, 'buy');
  // Лот куплен за 500, Steam 1000 → после комиссии ~869 — продать.
  assert.equal(advise({ ...base, minProfitKop: 100, lot: { openQty: 1, costPerUnitKop: 500, targetKop: null } }).action, 'sell');
  assert.equal(advise({ ...base, lot: { openQty: 1, costPerUnitKop: 950, targetKop: null } }).action, 'hold', 'продажа в минус');
  assert.equal(advise({ ...base, lot: { openQty: 1, costPerUnitKop: 950, targetKop: 1000 } }).action, 'sell', 'цель достигнута');
});

test('подсказка без своей истории: по реальным продажам Skinport/Steam, а не «мало данных»', () => {
  const fresh = { ...base, historyDays: 0, avg7Kop: null };
  assert.equal(advise(fresh).action, 'nodata', 'совсем нет данных — честно «мало данных»');
  const sp = (cur: number) => advise({ ...fresh, alt: { curKop: cur, refKop: 1000, where: 'на Skinport', basis: 'средней цены продаж за месяц там (120 шт.)' } });
  const cheap = sp(880);
  assert.equal(cheap.action, 'buy');
  assert.match(cheap.reason, /на Skinport ниже средней цены продаж за месяц там \(120 шт\.\) на 12%/);
  assert.equal(sp(1100).action, 'avoid');
  const ok = sp(1020);
  assert.equal(ok.action, 'hold');
  assert.match(ok.reason, /обычная: \+2% относительно средней цены продаж/);
  // Своя история есть — она главнее запасного ориентира.
  assert.equal(advise({ ...base, steamLowKop: 1000, avg7Kop: 1000, alt: { curKop: 500, refKop: 1000, where: 'на Skinport', basis: 'x' } }).action, 'hold');
});

const EUR = { base: 'EUR' as const, rateMicro: 45_000_000, rateDate: '2026-11-04', source: 'nbu' };
const USD = { base: 'USD' as const, rateMicro: 40_000_000, rateDate: '2026-11-04', source: 'nbu' };
const FX = new Map([['EUR', EUR], ['USD', USD]] as const);
const S = { minProfitKop: 2000, minRoiBp: 800, depositFeeBp: 0, withdrawFeeBp: 0 };
const entry = (o: Partial<ScanEntry>): ScanEntry => ({ name: 'Revolution Case', offers: [{ m: 'skinport', cur: 'EUR', minor: 1000, qty: 50 }], s7: { median: 1300, volume: 300 }, s30: { median: 1250, volume: 1200 }, steam: null, ...o });

test('рекомендации: перепродажа на Skinport с комиссией 8%', () => {
  const r = buildRecs([entry({})], FX, S);
  assert.equal(r.deals.length, 1);
  const d = r.deals[0];
  assert.equal(d.buyAt, 'skinport'); assert.equal(d.sellAt, 'skinport');
  assert.equal(d.payKop, 45000);                     // 10,00 € × 45
  assert.equal(d.sellKop, 58500);                    // 13,00 € × 45
  assert.equal(d.getKop, Math.floor(58500 * 0.92));
  assert.equal(d.profitKop, Math.floor(58500 * 0.92) - 45000);
  assert.equal(d.wallet, 'cash');
  assert.match(d.reason, /^Купи на Skinport за 450,00 ₴ → продай на Skinport за 585,00 ₴ → получишь/);
  assert.equal(buildRecs([entry({ s7: { median: 1300, volume: 3 } })], FX, S).deals.length, 0, 'мало продаж');
  assert.equal(buildRecs([entry({})], new Map(), S).deals.length, 0, 'без курса не считаем');
});

test('рекомендации: комиссии оплаты и вывода уменьшают прибыль', () => {
  const base = buildRecs([entry({})], FX, S).deals[0];
  const withFees = buildRecs([entry({})], FX, { ...S, depositFeeBp: 200, withdrawFeeBp: 300 }).deals[0];
  assert.equal(withFees.payKop, Math.ceil(45000 * 1.02));
  assert.equal(withFees.getKop, Math.floor(Math.floor(58500 * 0.92) * 0.97));
  assert.ok(withFees.profitKop! < base.profitKop!);
  assert.deepEqual(withFees.fees, ['оплата 2%', 'Skinport 8%', 'вывод 3%']);
});

test('рекомендации: между сайтами — купить на Waxpeer, продать на Market.CSGO', () => {
  const r = buildRecs([entry({
    offers: [{ m: 'waxpeer', cur: 'USD', minor: 1000, qty: 20 }, { m: 'csgomarket', cur: 'USD', minor: 1300, qty: 30 }, { m: 'lisskins', cur: 'USD', minor: 1250, qty: 2 }],
    s7: { median: 1100, volume: 50 }, s30: null, // реальные продажи ≈ 11 € = 495 грн; продать за 515 грн — в пределах +15%
  })], FX, S);
  const d = r.deals[0];
  assert.equal(d.buyAt, 'waxpeer'); assert.equal(d.sellAt, 'csgomarket');
  assert.equal(d.payKop, 40000);
  assert.equal(d.sellKop, Math.floor(52000 * 0.99));
  assert.equal(d.getKop, Math.floor(Math.floor(52000 * 0.99) * 0.95));
  // Одинокая завышенная цена не считается ориентиром.
  assert.equal(buildRecs([entry({ offers: [{ m: 'waxpeer', cur: 'USD', minor: 1000, qty: 20 }, { m: 'lisskins', cur: 'USD', minor: 1020, qty: 20 }, { m: 'csgomarket', cur: 'USD', minor: 3000, qty: 30 }], s7: null })], FX, S).deals.length, 0);
});

test('рекомендации: «скам»-сделки отсекаются — нет продаж, цена выше реальной, +сотни процентов', () => {
  // Наклейка: 0 продаж за неделю, на одном сайте 4,6 $, на другом — 48 $. Раньше выходило «+890%».
  const sticker = entry({ name: 'Sticker | iM (Gold) | Austin 2025', offers: [{ m: 'lisskins', cur: 'USD', minor: 460, qty: 3 }, { m: 'waxpeer', cur: 'USD', minor: 4800, qty: 6 }], s7: { median: 900, volume: 0 }, s30: null });
  assert.equal(buildRecs([sticker], FX, S).deals.length, 0, 'нет продаж — нет сделки');
  // Продажи есть, но продать на сайте предлагается вдвое дороже реальной цены продаж.
  const pricey = entry({ offers: [{ m: 'waxpeer', cur: 'USD', minor: 1000, qty: 20 }, { m: 'csgomarket', cur: 'USD', minor: 2200, qty: 30 }], s7: { median: 1100, volume: 50 }, s30: null });
  assert.ok(buildRecs([pricey], FX, S).deals.every((x) => x.sellAt !== 'csgomarket'), 'дороже реальной цены продаж — не ориентир (остаётся честная продажа на Skinport)');
  // Объявление подозрительно дешёвое (меньше половины реальной цены).
  const tooCheap = entry({ offers: [{ m: 'skinport', cur: 'EUR', minor: 300, qty: 5 }], s7: { median: 1300, volume: 300 } });
  assert.equal(buildRecs([tooCheap], FX, S).deals.length, 0);
  // Доходность > 60% — не показываем.
  const steam = { lowestKop: 200000, medianKop: 200000, volume24h: 100, at: NOW };
  assert.equal(buildRecs([entry({ offers: [{ m: 'skinport', cur: 'EUR', minor: 1000, qty: 50 }], s7: { median: 1000, volume: 300 }, steam })], FX, S).deals.length, 0);
});

test('рекомендации: Skinport → Steam считает комиссию Steam; уникальные паттерны пропускаются', () => {
  const steam = { lowestKop: 60000, medianKop: 60000, volume24h: 100, at: NOW };
  const r = buildRecs([entry({ s7: { median: 1000, volume: 300 }, steam })], FX, S);
  const d = r.deals[0];
  assert.equal(d.sellAt, 'steam');
  assert.equal(d.getKop, steamSellerProceeds(59999)!.sellerReceives);
  assert.equal(d.wallet, 'steam_wallet');
  assert.equal(buildRecs([entry({ name: '★ Karambit | Doppler (Factory New)', steam })], FX, S).deals.length, 0);
});

test('рекомендации: рост цены только при частых продажах и честная пометка', () => {
  const r = buildRecs([entry({ offers: [{ m: 'skinport', cur: 'EUR', minor: 1400, qty: 9 }], s7: { median: 1500, volume: 200 }, s30: { median: 1200, volume: 900 } })], FX, S);
  assert.equal(r.trends.length, 1);
  assert.equal(r.trends[0].trendBp, 2500);
  assert.match(r.trends[0].risk, /не гарантия/i);
  assert.equal(buildRecs([entry({ s7: { median: 1500, volume: 5 }, s30: { median: 1200, volume: 900 } })], FX, S).trends.length, 0);
});

test('сканирование: мусор отбрасывается, Steam и картинка из прошлого скана сохраняются', () => {
  const img = 'https://community.akamai.steamstatic.com/economy/image/abc';
  const p = parseScan([{ name: 'A', img, offers: { skinport: { p: 1.5, q: 3 }, waxpeer: { p: 'x' } }, s7: { median: 2, volume: 10 }, steam: { lowest_price: '70,00₴', volume: '12' } }, { name: 5 }, null], NOW);
  assert.equal(p.length, 1);
  assert.deepEqual(p[0].offers, [{ m: 'skinport', cur: 'EUR', minor: 150, qty: 3 }]);
  assert.equal(p[0].steam?.lowestKop, 7000);
  assert.equal(parseScan([{ name: 'B', img: 'https://evil.example/x.png' }], NOW)[0].img, null, 'чужие картинки не принимаем');
  const m = mergeScan(parseScan([{ name: 'A', offers: { skinport: { p: 1.4 } } }], NOW + 600), p, NOW + 600);
  assert.equal(m[0].steam?.lowestKop, 7000);
  assert.equal(m[0].img, img);
  assert.equal(mergeScan(parseScan([{ name: 'A' }], NOW), p, NOW + 4 * 3600)[0].steam, null);
});

test('сканирование → /app/api/recs, блок на главной; картинки и удаление списком', async () => {
  const d = migratedDb();
  const env = testEnv(d, { INGEST_SECRET: 'ingest_secret_test_123' });
  await storeFx(env.DB, [EUR, USD], NOW);
  const ingest = (body: unknown) => handleIngest(new Request('https://w/ingest', { method: 'POST', headers: { 'X-Ingest-Secret': 'ingest_secret_test_123' }, body: JSON.stringify({ fetchedAt: NOW, ...body as object }) }), env, NOW);
  assert.equal((await ingest({ kind: 'scan', items: [
    { name: 'Revolution Case', offers: { skinport: { p: 10, q: 50 } }, s7: { median: 13, volume: 300 }, s30: { median: 12.5, volume: 1200 } },
  ] })).status, 200);
  const init = await signInitData({ auth_date: String(NOW), query_id: 'A', user: JSON.stringify({ id: ADMIN }) }, 'TEST_TOKEN');
  const call = async (p: string, method = 'GET', body?: unknown) => (await (await handleAppApi(new Request('https://w/app/api/' + p, { method, headers: { 'X-Init-Data': init }, body: body ? JSON.stringify(body) : undefined }), env, NOW)).json()) as Record<string, any>;
  const r = await call('recs');
  assert.equal(r.scanned, 1);
  assert.equal(r.deals[0].buyName, 'Skinport');
  assert.match(r.deals[0].buyUrl, /^https:\/\/skinport\.com\/market\?search=Revolution%20Case/);
  assert.equal((await call('summary')).recs.deals.length, 1);
  // Сборщику: курсы и предметы без картинок.
  await call('watch', 'POST', { names: ['Kilowatt Case', 'Recoil Case'] });
  const items = await (await handleIngest(new Request('https://w/ingest/items', { headers: { 'X-Ingest-Secret': 'ingest_secret_test_123' } }), env, NOW)).json() as Record<string, any>;
  assert.equal(items.fx.USD, 40);
  assert.deepEqual([...items.missingImages].sort(), ['Kilowatt Case', 'Recoil Case']);
  await ingest({ kind: 'images', items: [{ name: 'Kilowatt Case', url: 'https://community.akamai.steamstatic.com/economy/image/k' }, { name: 'Recoil Case', url: 'javascript:alert(1)' }] });
  const w = await call('watch');
  const kw = w.items.find((x: { name: string }) => x.name === 'Kilowatt Case');
  assert.match(kw.img, /steamstatic/);
  assert.equal(w.items.find((x: { name: string }) => x.name === 'Recoil Case').img, null);
  // Удаление нескольких сразу.
  assert.equal((await call('watch/delete', 'POST', { ids: w.items.map((x: { watchId: number }) => x.watchId) })).removed, 2);
  assert.equal((await call('watch')).items.length, 0);
});

test('больше 90 предметов: цены и подсказки приходят для всех', async () => {
  const d = migratedDb();
  const env = testEnv(d);
  const init = await signInitData({ auth_date: String(NOW), query_id: 'A', user: JSON.stringify({ id: ADMIN }) }, 'TEST_TOKEN');
  const call = async (p: string, method = 'GET', body?: unknown) => (await (await handleAppApi(new Request('https://w/app/api/' + p, { method, headers: { 'X-Init-Data': init }, body: body ? JSON.stringify(body) : undefined }), env, NOW)).json()) as Record<string, any>;
  for (let i = 0; i < 2; i++) await call('watch', 'POST', { names: Array.from({ length: 60 }, (_, k) => `Item ${i * 60 + k} Case`) });
  const ids = (d.db.prepare('SELECT id FROM items').all() as { id: number }[]).map((x) => x.id);
  const ins = d.db.prepare(`INSERT INTO market_quotes (item_id, source, price_type, price_minor, currency, price_kop, fetched_at, quality) VALUES (?, 'steam', 'lowest_listing', 1000, 'UAH', 1000, ?, 'ok')`);
  for (const id of ids) ins.run(id, NOW);
  const w = await call('watch');
  assert.equal(w.items.length, 120);
  assert.ok(w.items.every((x: { steamLowKop: number; advice: unknown }) => x.steamLowKop === 1000 && x.advice), 'у всех 120 есть цена и подсказка');
});
