// Инвентарь Steam прямо из Worker по кнопке «Обновить».
import test from 'node:test';
import assert from 'node:assert/strict';
import { migratedDb, testEnv, json } from './helpers.ts';
import { signInitData } from '../src/webapp/auth.ts';
import { handleAppApi } from '../src/webapp/api.ts';
import { fetchInventory, storeInventory } from '../src/core/steaminv.ts';

const NOW = Date.parse('2026-11-06T01:00:00Z') / 1000;
const U = 7101;
const SID = '76561198000000009';
const inv = (assets: [string, string, number][], desc: [string, string, string, number][], more = false) => ({
  success: 1, more_items: more ? 1 : 0,
  assets: assets.map(([classid, instanceid, amount]) => ({ classid, instanceid, amount: String(amount), assetid: classid + amount })),
  descriptions: desc.map(([classid, instanceid, market_hash_name, marketable]) => ({ classid, instanceid, market_hash_name, marketable, tradable: marketable, icon_url: 'abc' })),
});

async function api(env: ReturnType<typeof testEnv>, path: string, method = 'GET', now = NOW) {
  const init = await signInitData({ auth_date: String(now), query_id: 'Q', user: JSON.stringify({ id: U }) }, 'TEST_TOKEN');
  const r = await handleAppApi(new Request('https://w.dev/app/api/' + path, { method, headers: { 'X-Init-Data': init } }), env, now);
  return { status: r.status, body: await r.json() as Record<string, any> };
}

test('разбор инвентаря: количество по названиям, картинки, закрытый, 429, имя профиля → SteamID', async () => {
  const f = (status: number, body: unknown, xml?: string) => (async (u: string) => (u.includes('?xml=1') ? new Response(xml ?? '<steamID64>' + SID + '</steamID64>') : status === 200 ? json(body) : new Response('', { status }))) as unknown as typeof fetch;
  const ok = await fetchInventory(f(200, inv([['1', '0', 1], ['1', '0', 1], ['2', '0', 5]], [['1', '0', 'Kilowatt Case', 1], ['2', '0', 'Sticker | X', 0]])), null, 'shefdw');
  assert.equal(ok.status, 'ok');
  if (ok.status !== 'ok') return;
  assert.equal(ok.steamId, SID);
  assert.deepEqual(ok.items.map((x) => [x.name, x.qty, x.marketable]), [['Kilowatt Case', 2, 1], ['Sticker | X', 5, 0]]);
  assert.match(ok.items[0].img!, /^https:\/\/community\.akamai\.steamstatic\.com\/economy\/image\/abc$/);
  assert.equal((await fetchInventory(f(403, null), SID, null)).status, 'private');
  assert.equal((await fetchInventory(f(429, null), SID, null)).status, 'rate_limited');
  assert.equal((await fetchInventory(f(200, null, '<nope/>'), null, 'x')).status, 'not_found');
});

test('сохранение: обновляет состав, не трогает float/наклейки от сборщика; неполный ответ ничего не удаляет', async () => {
  const d = migratedDb();
  const D = d as unknown as D1Database;
  d.db.prepare('INSERT INTO users (telegram_id, created_at, steam_id) VALUES (?, ?, ?)').run(U, NOW, SID);
  await storeInventory(D, U, { status: 'ok', steamId: SID, items: [{ name: 'A', qty: 1, marketable: 1, tradable: 1, img: null }, { name: 'B', qty: 2, marketable: 1, tradable: 1, img: null }], partial: false }, NOW);
  d.db.prepare(`UPDATE steam_inventory SET details = '[{"float":0.1}]' WHERE item_id = (SELECT id FROM items WHERE market_hash_name = 'A')`).run();
  await storeInventory(D, U, { status: 'ok', steamId: SID, items: [{ name: 'A', qty: 3, marketable: 1, tradable: 1, img: null }, { name: 'C', qty: 1, marketable: 0, tradable: 0, img: null }], partial: false }, NOW + 60);
  const rows = d.db.prepare('SELECT i.market_hash_name AS n, s.qty, s.details FROM steam_inventory s JOIN items i ON i.id = s.item_id ORDER BY n').all() as { n: string; qty: number; details: string | null }[];
  assert.deepEqual(rows.map((r) => [r.n, r.qty]), [['A', 3], ['C', 1]], 'B продан — удалён');
  assert.equal(rows[0].details, '[{"float":0.1}]', 'подробности сборщика сохранены');
  await storeInventory(D, U, { status: 'ok', steamId: SID, items: [{ name: 'A', qty: 3, marketable: 1, tradable: 1, img: null }], partial: true }, NOW + 120);
  assert.equal((d.db.prepare('SELECT COUNT(*) AS n FROM steam_inventory').get() as { n: number }).n, 2, 'неполный ответ — без удаления');
  await storeInventory(D, U, { status: 'rate_limited', steamId: SID }, NOW + 180);
  assert.equal((d.db.prepare('SELECT inv_status FROM users').get() as { inv_status: string }).inv_status, 'ok', '429 — статус не портим');
});

test('кнопка «Обновить»: Worker загрузил сам — сразу «обновлён»; Steam ответил 429 — честно про очередь', async () => {
  const d = migratedDb();
  const env = testEnv(d);
  d.db.prepare('INSERT INTO users (telegram_id, created_at, steam_id, steam_verified) VALUES (?, ?, ?, 1)').run(U, NOW, SID);
  const g = globalThis as any; const orig = g.fetch;
  let status = 200;
  g.fetch = async (u: string) => (String(u).startsWith('https://steamcommunity.com/inventory/') ? (status === 200 ? json(inv([['1', '0', 1]], [['1', '0', 'Kilowatt Case', 1]])) : new Response('', { status })) : json({ ok: true }));
  try {
    const r = await api(env, 'steam/refresh', 'POST');
    assert.equal(r.body.updated, true);
    assert.match(r.body.msg, /обновлён: 1/);
    const st = await api(env, 'steam');
    assert.equal(st.body.items[0].name, 'Kilowatt Case');
    assert.equal(st.body.pending, false, 'сборщику больше не нужно');
    status = 429;
    const r2 = await api(env, 'steam/refresh', 'POST', NOW + 20 * 60);
    assert.equal(r2.body.updated, undefined);
    assert.match(r2.body.msg, /Обновлю|ограничил/);
    assert.equal((await api(env, 'steam', 'GET', NOW + 20 * 60)).body.pending, true, 'остаётся в очереди сборщика');
  } finally { g.fetch = orig; }
});
