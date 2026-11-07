import test from 'node:test';
import assert from 'node:assert/strict';
import { steamSellPrice } from '../src/core/sellprice.ts';
import { steamSellerProceeds } from '../src/core/fees.ts';

test('цена продажи в Steam: растёт — чуть выше рынка (не больше +5%), падает/ровно — на 1 коп. ниже самого дешёвого', () => {
  const up = steamSellPrice({ liveLowKop: 10000, d1Kop: 10600, d7Kop: 10000, d30Kop: 9800 })!;
  assert.equal(up.mode, 'up');
  assert.equal(up.priceKop, 10300, '+6% за сутки → половина роста, +3%');
  assert.equal(up.quickKop, 9999);
  assert.equal(up.receiveKop, steamSellerProceeds(10300)!.sellerReceives);
  const rocket = steamSellPrice({ liveLowKop: 10000, d1Kop: 13000, d7Kop: 10000, d30Kop: 9000 })!;
  assert.equal(rocket.priceKop, 10500, 'надбавка не больше 5%');
  const down = steamSellPrice({ liveLowKop: 10000, d1Kop: 9000, d7Kop: 10000, d30Kop: 10000 })!;
  assert.equal(down.mode, 'down');
  assert.equal(down.priceKop, 9999);
  const flat = steamSellPrice({ liveLowKop: 10000, d1Kop: 10100, d7Kop: 10000, d30Kop: 10000 })!;
  assert.equal(flat.mode, 'flat');
  assert.equal(flat.priceKop, 9999);
  const fallDuringMonth = steamSellPrice({ liveLowKop: 10000, d1Kop: 10600, d7Kop: 10000, d30Kop: 12000 })!;
  assert.equal(fallDuringMonth.mode, 'flat', 'короткий отскок на фоне падения за месяц — не накручиваем');
  const avgOnly = steamSellPrice({ liveLowKop: null, d1Kop: 5000, d7Kop: 5000, d30Kop: 5000 })!;
  assert.equal(avgOnly.basis, 'avg');
  assert.equal(avgOnly.priceKop, 4900);
  assert.equal(steamSellPrice({ liveLowKop: 10000, d1Kop: 10000, d7Kop: 10000, d30Kop: 10000, uniquePriced: true }), null, 'паттерн — общей цене не верим');
  assert.equal(steamSellPrice({ liveLowKop: null, d1Kop: null, d7Kop: null, d30Kop: null }), null);
  const loss = steamSellPrice({ liveLowKop: 10000, d1Kop: 10000, d7Kop: 10000, d30Kop: 10000, costKop: 9500 })!;
  assert.equal(loss.belowCost, true, 'купил за 95 — после 15% за 99,99 будет убыток');
  assert.ok(loss.breakEvenKop! > 10000);
});

test('приложение: /sellprice — без живого объявления Steam совет не даём (средняя может отставать), даём ссылку на Steam', async () => {
  const { migratedDb, testEnv } = await import('./helpers.ts');
  const { handleAppApi } = await import('../src/webapp/api.ts');
  const { signInitData } = await import('../src/webapp/auth.ts');
  const db = await import('../src/storage/db.ts');
  const NOW = Date.parse('2026-11-04T12:00:00Z') / 1000;
  const d = migratedDb();
  const D = d as unknown as D1Database;
  const env = testEnv(d);
  await db.storeFx(D, [{ base: 'USD', rateMicro: 40_000_000, rateDate: '2026-11-04', source: 'nbu' }], NOW);
  const item = await db.upsertItem(D, 'Kilowatt Case', NOW);
  d.db.prepare('INSERT INTO steam_avg (item_id, d1, d7, d30, d90, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(item.id, 106, 100, 98, 95, NOW);
  const init = await signInitData({ auth_date: String(NOW), query_id: 'A', user: JSON.stringify({ id: 6161, first_name: 'E', language_code: 'uk' }) }, 'TEST_TOKEN');
  const r = await (await handleAppApi(new Request(`https://w/app/api/sellprice/${item.id}?cost=5000`, { headers: { 'X-Init-Data': init } }), env, NOW)).json() as { rec: unknown; status: string; url: string };
  assert.equal(r.rec, null);
  assert.equal(r.status, 'history');
  assert.match(r.url, /steamcommunity\.com\/market\/listings\/730\/Kilowatt%20Case/);
});

test('оценка: средней Steam не верим, если на площадках вдвое дешевле (резкое падение цены)', async () => {
  const { marketValue, siteMedianKop } = await import('../src/core/evidence.ts');
  const ev = { listing: null, buyOrder: null, median24h: null, avg: { d1: 5393, d7: 5700, d30: 7200, d90: null, at: 0 }, status: 'history' as const, stale: [] };
  assert.deepEqual(marketValue(ev), { kop: 5393, basis: 'avg' });
  assert.deepEqual(marketValue(ev, 1200), { kop: 1200, basis: 'site' }, 'Sealed Dead Hand Terminal: средняя 53,93 ₴, на площадках ~12 ₴');
  assert.deepEqual(marketValue(ev, 4000), { kop: 5393, basis: 'avg' }, 'обычная наценка Steam — средней верим');
  assert.deepEqual(marketValue({ ...ev, listing: { kop: 1400, at: 0 } }, 1200), { kop: 1400, basis: 'listing' });
  assert.equal(siteMedianKop([1200, 1100, 90000]), 1200, 'одна площадка с ошибкой не сбивает');
  assert.equal(siteMedianKop([]), null);
});
