// Учёт продаж (двойные нажатия, «ждёт оплаты», дробное количество, прибыль по кошелькам) и воронка пользователей.
import test from 'node:test';
import assert from 'node:assert/strict';
import { migratedDb, testEnv } from './helpers.ts';
import * as T from '../src/storage/trades.ts';
import { signInitData } from '../src/webapp/auth.ts';
import { handleAppApi } from '../src/webapp/api.ts';

const NOW = Date.parse('2026-11-06T01:00:00Z') / 1000;
const U = 777;

function setup() {
  const d = migratedDb();
  d.db.exec("INSERT INTO items (id, market_hash_name, category, created_at) VALUES (1, 'AK-47 | Slate (Field-Tested)', 'skin', 0)");
  const db = d as unknown as D1Database;
  const lot = (quantity: number) => T.addTrade(db, { tid: U, itemId: 1, signalId: null, quantity, buyPriceKop: 1000, buyFeeKop: 0, platform: 'steam', buyDate: '2026-11-01', note: null, now: 1 });
  const row = (id: number) => d.db.prepare('SELECT quantity, sold_quantity, status FROM trades WHERE id = ?').get(id) as { quantity: number; sold_quantity: number; status: string };
  const salesN = () => (d.db.prepare('SELECT COUNT(*) AS n FROM trade_sales').get() as { n: number }).n;
  return { d, db, lot, row, salesN };
}
const sale = (tradeId: number, quantity: number) => ({ tradeId, quantity, sellPriceKop: 1500, receivedKop: 1300 * quantity, platform: 'skinport', sellDate: '2026-11-02', now: 2 });

test('двойное нажатие «Продал»: записывается одна продажа, не больше остатка', async () => {
  const { db, lot, row, salesN } = setup();
  const id = await lot(2);
  const r = await Promise.allSettled([T.addSale(db, U, sale(id, 2)), T.addSale(db, U, sale(id, 2))]);
  assert.deepEqual(r.map((x) => x.status).sort(), ['fulfilled', 'rejected']);
  assert.equal(row(id).sold_quantity, 2);
  assert.equal(row(id).status, 'closed');
  assert.equal(salesN(), 1);
});

test('частичные продажи подряд работают, сверх остатка — нет', async () => {
  const { db, lot, row, salesN } = setup();
  const id = await lot(3);
  await T.addSale(db, U, sale(id, 1));
  await T.addSale(db, U, sale(id, 2));
  await assert.rejects(T.addSale(db, U, sale(id, 1)));
  assert.equal(row(id).sold_quantity, 3);
  assert.equal(salesN(), 2);
});

test('нельзя продать штуки, которые «ждут оплаты»; двойная отметка «ждёт» не превышает остаток', async () => {
  const { d, db, lot, salesN } = setup();
  const id = await lot(2);
  const p = { tradeId: id, quantity: 2, sellPriceKop: 1500, receivedKop: 2600, platform: 'skinport', now: 2 };
  const r = await Promise.allSettled([T.addPending(db, U, p), T.addPending(db, U, p)]);
  assert.deepEqual(r.map((x) => x.status).sort(), ['fulfilled', 'rejected']);
  assert.equal((d.db.prepare('SELECT SUM(quantity) AS q FROM pending_sales').get() as { q: number }).q, 2);
  await assert.rejects(T.addSale(db, U, sale(id, 1)));
  assert.equal(salesN(), 0);
});

test('двойное подтверждение «деньги пришли»: одна продажа, ожидание удалено', async () => {
  const { d, db, lot, row, salesN } = setup();
  const id = await lot(3);
  await T.addPending(db, U, { tradeId: id, quantity: 1, sellPriceKop: 1500, receivedKop: 1300, platform: 'skinport', now: 2 });
  const pid = (d.db.prepare('SELECT id FROM pending_sales').get() as { id: number }).id;
  const r = await Promise.allSettled([T.confirmPending(db, U, pid, null, '2026-11-03', 3), T.confirmPending(db, U, pid, null, '2026-11-03', 3)]);
  assert.deepEqual(r.map((x) => x.status).sort(), ['fulfilled', 'rejected']);
  assert.equal(row(id).sold_quantity, 1);
  assert.equal(salesN(), 1);
  assert.equal((d.db.prepare('SELECT COUNT(*) AS n FROM pending_sales').get() as { n: number }).n, 0);
});

test('подтверждение ожидания не теряет его, если лот изменился другой продажей', async () => {
  const { d, db, lot, row, salesN } = setup();
  const id = await lot(3);
  await T.addPending(db, U, { tradeId: id, quantity: 1, sellPriceKop: 1500, receivedKop: 1300, platform: 'skinport', now: 2 });
  const pid = (d.db.prepare('SELECT id FROM pending_sales').get() as { id: number }).id;
  const [c] = await Promise.allSettled([T.confirmPending(db, U, pid, null, '2026-11-03', 3), T.addSale(db, U, sale(id, 1))]);
  const pendingLeft = (d.db.prepare('SELECT COUNT(*) AS n FROM pending_sales').get() as { n: number }).n;
  assert.equal(row(id).sold_quantity, salesN(), 'в лоте ровно столько, сколько записано продаж');
  // Подтверждение не прошло (лот изменился) — ожидание осталось, его можно подтвердить снова.
  assert.equal(pendingLeft, c.status === 'fulfilled' ? 0 : 1, 'ожидание не пропало молча');
  if (pendingLeft) await T.confirmPending(db, U, pid, null, '2026-11-03', 4);
  assert.equal((d.db.prepare('SELECT COUNT(*) AS n FROM pending_sales').get() as { n: number }).n, 0);
});

test('дробное количество не записывается', async () => {
  const { db, lot, row, salesN } = setup();
  const id = await lot(2);
  await assert.rejects(T.addSale(db, U, sale(id, 1.5)));
  await assert.rejects(T.addPending(db, U, { tradeId: id, quantity: 0.5, sellPriceKop: 1500, receivedKop: 650, platform: 'skinport', now: 2 }));
  assert.equal(row(id).sold_quantity, 0);
  assert.equal(salesN(), 0);
});

test('API: дробное и пустое количество — ошибка; прибыль Steam и живых денег раздельно', async () => {
  const { d } = setup();
  const env = testEnv(d);
  const init = await signInitData({ auth_date: String(NOW), query_id: 'Q', user: JSON.stringify({ id: U }) }, 'TEST_TOKEN');
  const call = async (path: string, method = 'GET', body?: unknown) => (await handleAppApi(new Request('https://w.dev/app/api/' + path, { method, headers: { 'X-Init-Data': init }, body: body ? JSON.stringify(body) : undefined }), env, NOW)).json() as Promise<Record<string, any>>;
  const lot = (await call('inventory', 'POST', { name: 'AK-47 | Slate (Field-Tested)', qty: 3, priceKop: 10000, platform: 'steam', date: '2026-11-01' })).id;
  assert.equal((await call(`inventory/${lot}/sell`, 'POST', { qty: 1.5, priceKop: 13000, receivedKop: 12000, platform: 'csgomarket' })).ok, false);
  assert.equal((await call(`inventory/${lot}/sell`, 'POST', { priceKop: 13000, receivedKop: 12000, platform: 'csgomarket' })).ok, false);
  assert.equal((await call(`inventory/${lot}/sell`, 'POST', { qty: 1, priceKop: 13000, receivedKop: 12000, platform: 'csgomarket' })).ok, true);
  assert.equal((await call(`inventory/${lot}/sell`, 'POST', { qty: 1, priceKop: 13000, receivedKop: 11000, platform: 'steam' })).ok, true);
  const inv = await call('inventory');
  assert.equal(inv.realizedCashKop, 2000);
  assert.equal(inv.realizedSteamKop, 1000);
  assert.equal(inv.salesCount, 2);
  assert.equal(inv.realizedKop, undefined, 'общей суммы по разным кошелькам нет');
});

test('воронка: пришёл из канала → открыл приложение → получил уведомление → вернулся через 7 дней', async () => {
  const { d } = setup();
  const D = d as unknown as D1Database;
  const T0 = NOW - 10 * 86400;
  const { ensureUser, touchActiveStmts, logNotification, funnel } = await import('../src/storage/db.ts');
  for (const id of [1, 2, 3]) await ensureUser(D, id, false, T0);
  d.db.exec(`INSERT INTO user_settings (telegram_id, key, value, updated_at) VALUES (1, 'ref', 'ch', 0), (2, 'ref', 'ch', 0)`);
  await D.batch(touchActiveStmts(D, 1, T0, true));
  await D.batch(touchActiveStmts(D, 2, T0, false));
  await logNotification(D, 1, 'arb', 'x', T0 + 100);
  await logNotification(D, 1, 'arb', 'y', T0 + 200);
  await D.batch(touchActiveStmts(D, 1, T0 + 3600, true));
  assert.equal((d.db.prepare(`SELECT updated_at FROM user_settings WHERE telegram_id = 1 AND key = 'seen'`).get() as { updated_at: number }).updated_at, T0, 'чаще раза в 12 ч не пишем');
  await D.batch(touchActiveStmts(D, 1, T0 + 8 * 86400, true));
  const ch = await funnel(D, NOW, 'ch');
  assert.deepEqual(ch, { came: 2, app: 1, notified: 1, returned7: 1, mature: 2 });
  assert.equal((await funnel(D, NOW, null)).came, 3);
});
