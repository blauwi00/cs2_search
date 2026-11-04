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

const EUR = { base: 'EUR' as const, rateMicro: 45_000_000, rateDate: '2026-11-04', source: 'nbu' };
const S = { minProfitKop: 2000, minRoiBp: 800 };
const entry = (o: Partial<ScanEntry>): ScanEntry => ({ name: 'Revolution Case', minEur: 1000, qty: 50, s7: { median: 1300, volume: 300 }, s30: { median: 1250, volume: 1200 }, steam: null, ...o });

test('рекомендации: перепродажа на Skinport с комиссией 8%', () => {
  const r = buildRecs([entry({})], EUR, S);
  assert.equal(r.deals.length, 1);
  const d = r.deals[0];
  assert.equal(d.kind, 'sp_flip');
  assert.equal(d.buyKop, 45000);                     // 10,00 € × 45
  assert.equal(d.proceedsKop, 1196 * 45);            // floor(13,00 € × 0,92) = 11,96 €
  assert.equal(d.profitKop, 1196 * 45 - 45000);
  assert.equal(d.wallet, 'cash');
  // Мало продаж — не советуем.
  assert.equal(buildRecs([entry({ s7: { median: 1300, volume: 3 } })], EUR, S).deals.length, 0);
  // Без курса — ничего не считаем (нельзя перевести в гривны).
  assert.equal(buildRecs([entry({})], null, S).deals.length, 0);
});

test('рекомендации: Skinport → Steam считает комиссию Steam; уникальные паттерны пропускаются', () => {
  const steam = { lowestKop: 90000, medianKop: 90000, volume24h: 100, at: NOW };
  const r = buildRecs([entry({ s7: { median: 1000, volume: 300 }, steam })], EUR, S);
  const d = r.deals[0];
  assert.equal(d.kind, 'sp_to_steam');
  assert.equal(d.proceedsKop, steamSellerProceeds(89999)!.sellerReceives);
  assert.equal(d.wallet, 'steam_wallet');
  assert.equal(buildRecs([entry({ name: '★ Karambit | Doppler (Factory New)', steam })], EUR, S).deals.length, 0);
});

test('рекомендации: рост цены только при частых продажах и честная пометка', () => {
  const r = buildRecs([entry({ minEur: 1400, s7: { median: 1500, volume: 200 }, s30: { median: 1200, volume: 900 } })], EUR, S);
  assert.equal(r.trends.length, 1);
  assert.equal(r.trends[0].trendBp, 2500);
  assert.match(r.trends[0].risk, /не гарантия/i);
  assert.equal(buildRecs([entry({ s7: { median: 1500, volume: 5 }, s30: { median: 1200, volume: 900 } })], EUR, S).trends.length, 0);
});

test('сканирование: мусор отбрасывается, цены Steam из прошлого скана сохраняются 3 часа', () => {
  const p = parseScan([{ name: 'A', minEur: 1.5, qty: 3, s7: { median: 2, volume: 10 }, steam: { lowest_price: '70,00₴', volume: '12' } }, { name: 5 }, null], NOW);
  assert.equal(p.length, 1);
  assert.equal(p[0].minEur, 150);
  assert.equal(p[0].steam?.lowestKop, 7000);
  const m = mergeScan(parseScan([{ name: 'A', minEur: 1.4 }], NOW + 600), p, NOW + 600);
  assert.equal(m[0].steam?.lowestKop, 7000);
  assert.equal(mergeScan(parseScan([{ name: 'A', minEur: 1.4 }], NOW), p, NOW + 4 * 3600)[0].steam, null);
});

test('сканирование → /app/api/recs и блок на главной', async () => {
  const d = migratedDb();
  const env = testEnv(d, { INGEST_SECRET: 'ingest_secret_test_123' });
  await storeFx(env.DB, [EUR], NOW);
  const ing = await handleIngest(new Request('https://w/ingest', { method: 'POST', headers: { 'X-Ingest-Secret': 'ingest_secret_test_123' }, body: JSON.stringify({ kind: 'scan', fetchedAt: NOW, items: [
    { name: 'Revolution Case', minEur: 10, qty: 50, s7: { median: 13, volume: 300 }, s30: { median: 12.5, volume: 1200 } },
  ] }) }), env, NOW);
  assert.equal(ing.status, 200);
  const init = await signInitData({ auth_date: String(NOW), query_id: 'A', user: JSON.stringify({ id: ADMIN }) }, 'TEST_TOKEN');
  const get = async (p: string) => (await (await handleAppApi(new Request('https://w/app/api/' + p, { headers: { 'X-Init-Data': init } }), env, NOW)).json()) as Record<string, any>;
  const r = await get('recs');
  assert.equal(r.scanned, 1);
  assert.equal(r.deals[0].kind, 'sp_flip');
  assert.match(r.deals[0].buyUrl, /^https:\/\/skinport\.com\/market\?search=Revolution%20Case/);
  const s = await get('summary');
  assert.equal(s.recs.deals.length, 1);
});
