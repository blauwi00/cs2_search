// #8: цель продажи для предметов инвентаря Steam.
import test from 'node:test';
import assert from 'node:assert/strict';
import { migratedDb, testEnv } from './helpers.ts';
import { handleAppApi } from '../src/webapp/api.ts';
import { signInitData } from '../src/webapp/auth.ts';
import { jobSellAlerts } from '../src/core/sellalerts.ts';
import * as db from '../src/storage/db.ts';

const NOW = Date.parse('2026-11-04T12:00:00Z') / 1000;

test('цель продажи: ставится только на свой предмет, срабатывает один раз, когда цена дошла', async () => {
  const d = migratedDb(); const D = d as unknown as D1Database;
  const env = testEnv(d);
  await db.storeFx(D, [{ base: 'USD', rateMicro: 40_000_000, rateDate: '2026-11-04', source: 'nbu' }], NOW);
  await db.ensureUser(D, 5, false, NOW);
  d.db.exec(`UPDATE users SET steam_id = '76561198000000001' WHERE telegram_id = 5`);
  d.db.exec(`INSERT INTO items (id, market_hash_name, category, created_at) VALUES (1, 'Revolution Case', 'case', 0), (2, 'Fever Case', 'case', 0)`);
  d.db.exec(`INSERT INTO steam_inventory (telegram_id, item_id, qty) VALUES (5, 1, 3)`);
  d.db.exec(`INSERT INTO steam_avg (item_id, d1, d7, d30, d90, updated_at) VALUES (1, 100, 100, 100, 100, ${NOW})`); // $1 = 40 грн
  const init = await signInitData({ auth_date: String(NOW), query_id: 'A', user: JSON.stringify({ id: 5, first_name: 'E' }) }, 'TEST_TOKEN');
  const call = async (path: string, body?: object) => (await handleAppApi(new Request('https://w/app/api/' + path, { method: body ? 'POST' : 'GET', headers: { 'X-Init-Data': init, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }), env, NOW)).json() as Promise<Record<string, any>>;
  assert.equal((await call('sellalert', { itemId: 2, kop: 5000 })).ok, false, 'не свой предмет');
  assert.equal((await call('sellalert', { itemId: 1, kop: 4400 })).targetKop, 4400);
  const st = await call('steam');
  assert.equal(st.items[0].targetKop, 4400);

  assert.equal((await jobSellAlerts({ db: D, now: NOW })).sent, 0, 'пока 40 грн < 44');
  d.db.exec(`UPDATE steam_avg SET d1 = 120, d7 = 115 WHERE item_id = 1`);   // средние прайса выросли до 46 грн —
  assert.equal((await jobSellAlerts({ db: D, now: NOW + 1800 })).sent, 0, 'по средним прайса (завышены) не уведомляем');
  d.db.exec(`INSERT INTO market_quotes (item_id, source, price_type, price_minor, currency, price_kop, fetched_at, quality) VALUES (1, 'steam', 'lowest_listing', 4600, 'UAH', 4600, ${NOW + 1700}, 'ok')`);
  assert.equal((await jobSellAlerts({ db: D, now: NOW + 1800 })).sent, 1, 'живая цена Steam дошла до цели');
  const row = d.db.prepare("SELECT text, keyboard FROM outbox WHERE kind = 'sell_target'").get() as { text: string; keyboard: string };
  assert.match(row.text, /Revolution Case/); assert.match(row.text, /⟦4600⟧/); assert.match(row.text, /цель ⟦4400⟧/);
  assert.equal((await jobSellAlerts({ db: D, now: NOW + 3600 })).sent, 0, 'второй раз — нет');
  assert.equal((await call('steam')).items[0].targetKop, null, 'выполненная цель снята');
  assert.equal((await call('sellalert', { itemId: 1, kop: null })).ok, true);
  // Живая цена устарела (старше нескольких часов) — не повод для уведомления.
  assert.equal((await call('sellalert', { itemId: 1, kop: 4400 })).targetKop, 4400);
  d.db.exec(`UPDATE steam_avg SET updated_at = ${NOW - 3 * 86400}`);
  assert.equal((await jobSellAlerts({ db: D, now: NOW + 7 * 86400 })).sent, 0);
  void call;
});
