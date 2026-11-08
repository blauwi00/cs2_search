// Защита обмена Steam: когда можно продавать, одно напоминание, предметы под защитой в «Моих скинах».
import test from 'node:test';
import assert from 'node:assert/strict';
import { migratedDb } from './helpers.ts';
import * as db from '../src/storage/db.ts';
import * as T from '../src/storage/trades.ts';
import { unlockAt, jobTradeUnlock, TRADE_LOCK_SEC } from '../src/core/tradelock.ts';
import { TERMS_VERSION } from '../src/core/terms.ts';

const BUY = Date.parse('2026-11-01T10:00:00Z') / 1000;

test('защита обмена: записал в день покупки — +7 дней от записи; дата раньше — от конца того дня', () => {
  assert.equal(unlockAt('2026-11-01', BUY), BUY + TRADE_LOCK_SEC);
  assert.equal(unlockAt('2026-10-30', BUY), Date.parse('2026-10-30T23:59:59Z') / 1000 + TRADE_LOCK_SEC);
});

test('«Можно продавать»: одно напоминание после 7 дней, с ценами Steam и площадок', async () => {
  const d = migratedDb();
  const D = d as unknown as D1Database;
  const it = await db.upsertItem(D, 'Kilowatt Case', BUY);
  await db.ensureUser(D, 7, false, BUY);
  for (const [k, v] of [['terms_ok', TERMS_VERSION], ['notify_enabled', '1']]) await db.setSetting(D, 7, k, v, BUY);
  await db.storeFx(D, [{ base: 'USD', rateMicro: 40_000_000, rateDate: '2026-11-01', source: 'nbu' }], BUY);
  const lot = await T.addTrade(D, { tid: 7, itemId: it.id, signalId: null, quantity: 2, buyPriceKop: 500, buyFeeKop: 0, platform: 'steam', buyDate: '2026-11-01', note: null, now: BUY });
  const after = BUY + TRADE_LOCK_SEC + 3600;
  d.db.prepare('INSERT INTO site_prices (name, json, updated_at) VALUES (?, ?, ?)').run('Kilowatt Case', JSON.stringify({ skinport: 15, csfloat: 16, csmoney: 1 }), after - 600);
  d.db.prepare('INSERT INTO steam_avg (item_id, d1, d7, d30, d90, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(it.id, 18, 18, 18, 18, after - 600);

  assert.equal((await jobTradeUnlock({ db: D, now: BUY + 6 * 86400 })).sent, 0, 'через 6 дней — рано');
  assert.equal((await jobTradeUnlock({ db: D, now: after })).sent, 1);
  assert.equal((await jobTradeUnlock({ db: D, now: after + 1800 })).sent, 0, 'второй раз не шлём');
  const m = d.db.prepare(`SELECT text, ref FROM outbox WHERE kind = 'trade_unlock'`).get() as { text: string; ref: string };
  assert.equal(m.ref, `unlock:${lot}`);
  assert.match(m.text, /Можно продавать/);
  assert.match(m.text, /Kilowatt Case<\/b> ×2/);
  assert.match(m.text, /Steam: ≈ ⟦720⟧/, '0,18 $ × 40 = 7,20 ₴');
  assert.match(m.text, /Площадки: ≈ ⟦620⟧/, 'медиана площадок 0,155 $ (CS.MONEY-ориентир не берём)');
  assert.equal((await jobTradeUnlock({ db: D, now: BUY + TRADE_LOCK_SEC + 3 * 86400 })).sent, 0, 'спустя 3 дня — уже не актуально');
});

test('«Мои скины»: записанная покупка видна с замком до конца защиты', async () => {
  const { testEnv } = await import('./helpers.ts');
  const { handleAppApi } = await import('../src/webapp/api.ts');
  const { signInitData } = await import('../src/webapp/auth.ts');
  const d = migratedDb();
  const D = d as unknown as D1Database;
  const NOW = BUY + 2 * 86400;
  const it = await db.upsertItem(D, 'Gallery Case', BUY);
  await db.ensureUser(D, 8, false, BUY);
  d.db.prepare(`UPDATE users SET steam_id = '76561198000000000' WHERE telegram_id = 8`).run();
  await T.addTrade(D, { tid: 8, itemId: it.id, signalId: null, quantity: 3, buyPriceKop: 3600, buyFeeKop: 0, platform: 'steam', buyDate: '2026-11-01', note: null, now: BUY });
  const init = await signInitData({ auth_date: String(NOW), query_id: 'A', user: JSON.stringify({ id: 8, first_name: 'E', language_code: 'uk' }) }, 'TEST_TOKEN');
  const r = await (await handleAppApi(new Request('https://w/app/api/steam', { headers: { 'X-Init-Data': init } }), testEnv(d), NOW)).json() as { locked: { name: string; qty: number; unlockAt: number }[] };
  assert.deepEqual(r.locked.map((x) => [x.name, x.qty, x.unlockAt]), [['Gallery Case', 3, BUY + TRADE_LOCK_SEC]]);
});

test('открытия кейсов на сайтах: отдельный итог, площадку можно поменять у записанной покупки', async () => {
  const { testEnv } = await import('./helpers.ts');
  const { handleAppApi } = await import('../src/webapp/api.ts');
  const { signInitData } = await import('../src/webapp/auth.ts');
  const d = migratedDb();
  const D = d as unknown as D1Database;
  const NOW = BUY + 86400;
  const it = await db.upsertItem(D, 'M4A1-S | Electrum (Field-Tested)', BUY);
  await db.ensureUser(D, 9, false, BUY);
  const id = await T.addTrade(D, { tid: 9, itemId: it.id, signalId: null, quantity: 1, buyPriceKop: 28813, buyFeeKop: 0, platform: 'other', buyDate: '2026-11-01', note: null, now: BUY });
  const init = await signInitData({ auth_date: String(NOW), query_id: 'A', user: JSON.stringify({ id: 9, first_name: 'E', language_code: 'uk' }) }, 'TEST_TOKEN');
  const call = async (path: string, body?: unknown) => (await handleAppApi(new Request('https://w/app/api/' + path, body ? { method: 'POST', body: JSON.stringify(body), headers: { 'X-Init-Data': init, 'Content-Type': 'application/json' } } : { headers: { 'X-Init-Data': init } }), testEnv(d), NOW)).json() as Promise<Record<string, unknown>>;
  assert.equal((await call('inventory')).caseOpen, null);
  assert.equal((await call(`inventory/${id}/platform`, { platform: 'caseopen' })).ok, true);
  const r = await call('inventory') as { caseOpen: { count: number; spentKop: number; valueKop: number }; platforms: { v: string }[] };
  assert.deepEqual([r.caseOpen.count, r.caseOpen.spentKop, r.caseOpen.valueKop], [1, 28813, 0]);
  assert.ok(r.platforms.some((p) => p.v === 'caseopen'));
  assert.equal((await call(`inventory/${id}/platform`, { platform: 'nope' })).ok, false);
});
