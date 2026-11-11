// Вкладка владельца «Люди»: ник сохраняется только при изменении, список и карточка, доступ только владельцу. В тестах — выдуманные id и ники.
import test from 'node:test';
import assert from 'node:assert/strict';
import { migratedDb, testEnv, ADMIN } from './helpers.ts';
import { signInitData } from '../src/webapp/auth.ts';
import { handleAppApi } from '../src/webapp/api.ts';
import { saveNameStmts, normalizeName, peopleList, personCard } from '../src/webapp/people.ts';

const NOW = Date.parse('2026-11-10T12:00:00Z') / 1000;
async function call(env: ReturnType<typeof testEnv>, path: string, uid: number, user: Record<string, unknown> = {}) {
  const init = await signInitData({ auth_date: String(NOW), query_id: 'Q', user: JSON.stringify({ id: uid, ...user }) }, 'TEST_TOKEN');
  const res = await handleAppApi(new Request('https://w/app/api/' + path, { headers: { 'X-Init-Data': init } }), env, NOW);
  return { status: res.status, body: await res.json() as Record<string, any> };
}

test('ник и имя: чистятся, пишутся только при изменении', async () => {
  assert.deepEqual(normalizeName('test_user', '  Тест<b>  '), { username: 'test_user', name: 'Тестb' });
  assert.deepEqual(normalizeName('x', ''), { username: null, name: null });
  const d = migratedDb(); const D = d as unknown as D1Database;
  const run = (u: string, n: string, t: number) => D.batch(saveNameStmts(D, 111, u, n, t));
  d.db.exec(`INSERT INTO users (telegram_id, is_admin, created_at) VALUES (111, 0, ${NOW})`);
  await run('testuser', 'Тест', NOW);
  await run('testuser', 'Тест', NOW + 100);
  const row = () => d.db.prepare("SELECT key, value, updated_at FROM user_settings WHERE telegram_id = 111 AND key LIKE 'tg_%' ORDER BY key").all() as { key: string; value: string; updated_at: number }[];
  assert.deepEqual(row().map((r) => [r.key, r.value, r.updated_at]), [['tg_name', 'Тест', NOW], ['tg_username', 'testuser', NOW]], 'второй раз то же значение — записи нет');
  await run('newname', 'Тест', NOW + 200);
  assert.equal(row().find((r) => r.key === 'tg_username')!.value, 'newname');
});

test('список и карточка: сводка, фильтры, владелец не виден, события и инвентарь', async () => {
  const d = migratedDb(); const D = d as unknown as D1Database;
  d.db.exec(`INSERT INTO users (telegram_id, is_admin, created_at, steam_id) VALUES (${ADMIN}, 1, ${NOW - 9 * 86400}, NULL), (111, 0, ${NOW - 9 * 86400}, '7656'), (222, 0, ${NOW - 3600}, NULL)`);
  d.db.exec(`INSERT INTO user_settings (telegram_id, key, value, updated_at) VALUES (111, 'seen', '1', ${NOW - 7200}), (111, 'tg_username', 'testuser', ${NOW}), (111, 'ref', 'tt', ${NOW}), (222, 'seen', '1', ${NOW - 600})`);
  d.db.exec(`INSERT INTO items (id, market_hash_name, category, created_at) VALUES (1, 'Revolution Case', 'case', 0), (2, 'AK-47 | Redline (Field-Tested)', 'weapon', 0)`);
  d.db.exec(`INSERT INTO steam_inventory (telegram_id, item_id, qty, marketable) VALUES (111, 1, 10, 1), (111, 2, 1, 1)`);
  d.db.exec(`INSERT INTO steam_avg (item_id, d1, d7, d30, d90, updated_at) VALUES (1, 100, 100, 100, 100, ${NOW}), (2, 2000, 2000, 2000, 2000, ${NOW})`);
  d.db.exec(`INSERT INTO watchlist (telegram_id, item_id, created_at) VALUES (111, 1, ${NOW - 5000})`);
  d.db.exec(`INSERT INTO trades (telegram_id, item_id, quantity, buy_price_kop, buy_platform, buy_date, created_at, updated_at) VALUES (111, 2, 1, 5000, 'steam', '2026-11-09', ${NOW - 4000}, ${NOW - 4000})`);
  const all = await peopleList(D, NOW, 'all', 0);
  assert.deepEqual([all.summary.total, all.summary.today, all.summary.newToday, all.summary.back, all.summary.steam, all.summary.list], [2, 2, 1, 1, 1, 1]);
  assert.deepEqual(all.people.map((p) => p.id), [222, 111], 'сначала кто был недавно; владельца в списке нет');
  assert.equal(all.people[1]!.username, 'testuser'); assert.equal(all.people[1]!.watch, 1); assert.equal(all.people[1]!.trades, 1);
  assert.deepEqual((await peopleList(D, NOW, 'new', 0)).people.map((p) => p.id), [222]);
  assert.deepEqual((await peopleList(D, NOW, 'steam', 0)).people.map((p) => p.id), [111]);
  assert.deepEqual((await peopleList(D, NOW, 'list', 0)).people.map((p) => p.id), [111]);
  const usd = { id: 1, base: 'USD', rateMicro: 40_000_000, rateDate: '2026-11-10', source: 'nbu' } as never;
  const c = await personCard(D, NOW, 111, usd);
  assert.equal(c!.inventory.totalKop, 120000, '10×$1 + $20 = $30 × 40 грн');
  assert.deepEqual(c!.inventory.items.map((x) => x.name), ['AK-47 | Redline (Field-Tested)', 'Revolution Case'], 'дорогое выше');
  assert.deepEqual(c!.trades, { total: 1, open: 1, sold: 0 });
  assert.deepEqual(c!.events.map((e) => e.k), ['buy', 'watch']);
  assert.equal(await personCard(D, NOW, ADMIN, usd), null, 'карточка владельца не отдаётся');
});

test('people и people/:id — только владельцу; ник приходит из Telegram при открытии приложения', async () => {
  const d = migratedDb(); const env = testEnv(d);
  assert.equal((await call(env, 'people', 111)).status, 403);
  assert.equal((await call(env, 'people/111', 111)).status, 403);
  await call(env, 'summary', 111, { username: 'testuser', first_name: 'Тест' });
  const r = await call(env, 'people', ADMIN);
  assert.equal(r.status, 200);
  assert.equal(r.body.people[0].username, 'testuser');
  assert.equal(r.body.people[0].name, 'Тест');
});
