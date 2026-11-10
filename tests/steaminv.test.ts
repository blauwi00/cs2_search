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
  // 403 / success:false — «закрыт» только по публичной странице; вкладка CS2 есть → Steam просто не отдал (blocked).
  const pg = (json403: number | 'false', page: string | number) => (async (u: string) => {
    if (u.includes('/inventory/' + SID + '/730/2')) return json403 === 'false' ? json({ success: false }) : new Response('', { status: json403 });
    if (u.includes('/profiles/' + SID + '/inventory/')) return typeof page === 'number' ? new Response('', { status: page }) : new Response(page);
    return new Response('', { status: 404 });
  }) as unknown as typeof fetch;
  const OPEN = '<span class="games_list_tab_name">Counter-Strike 2</span> <span>Counter-Strike 2 (21)</span>';
  const PRIV = '<div class="profile_private_info">This user\'s inventory is currently private.</div>';
  assert.equal((await fetchInventory(pg(403, OPEN), SID, null)).status, 'blocked');
  assert.equal((await fetchInventory(pg('false', OPEN), SID, null)).status, 'blocked');
  assert.equal((await fetchInventory(pg(403, PRIV), SID, null)).status, 'private');
  assert.equal((await fetchInventory(pg('false', PRIV), SID, null)).status, 'private');
  assert.equal((await fetchInventory(pg(403, 500), SID, null)).status, 'error', 'страница не открылась — не понять');
  assert.equal((await fetchInventory(pg(403, '<html>что-то другое</html>'), SID, null)).status, 'error');
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

test('#33: отказ Steam не стирает инвентарь; «закрыт» — только после двух проверок через 6 ч; повторы с паузой', async () => {
  const d = migratedDb();
  const D = d as unknown as D1Database;
  d.db.prepare('INSERT INTO users (telegram_id, created_at, steam_id, inv_requested_at) VALUES (?, ?, ?, ?)').run(U, NOW, SID, NOW);
  await storeInventory(D, U, { status: 'ok', steamId: SID, items: [{ name: 'A', qty: 1, marketable: 1, tradable: 1, img: null }], partial: false }, NOW);
  const cnt = () => (d.db.prepare('SELECT COUNT(*) AS n FROM steam_inventory').get() as { n: number }).n;
  const user = () => d.db.prepare('SELECT inv_status AS s, inv_synced_at AS at FROM users').get() as { s: string; at: number };
  const retry = () => JSON.parse((d.db.prepare(`SELECT value FROM user_settings WHERE key = 'inv_retry'`).get() as { value: string } | undefined)?.value ?? 'null');
  // Steam не отдал JSON, а страница открыта.
  await storeInventory(D, U, { status: 'blocked', steamId: SID }, NOW + 3600);
  assert.equal(cnt(), 1, 'blocked — инвентарь на месте');
  assert.deepEqual([user().s, user().at], ['blocked', NOW], 'время последнего удачного обновления не трогаем');
  assert.deepEqual(retry(), { n: 1, at: NOW + 3600 + 15 * 60 }, 'повтор через 15 мин');
  await storeInventory(D, U, { status: 'blocked', steamId: SID }, NOW + 7200);
  assert.equal(retry().at, NOW + 7200 + 3600, 'дальше — через час');
  // Сбой страницы — ничего не меняем, кроме паузы.
  await storeInventory(D, U, { status: 'error', steamId: SID }, NOW + 9000);
  assert.equal(user().s, 'blocked');
  assert.equal(retry().at, NOW + 9000 + 6 * 3600);
  // «Закрыт»: первая проверка — без удаления; вторая через 2 ч — тоже; через 6+ ч — удаление.
  await storeInventory(D, U, { status: 'private', steamId: SID }, NOW + 10000);
  assert.deepEqual([cnt(), user().s], [1, 'private']);
  await storeInventory(D, U, { status: 'private', steamId: SID }, NOW + 10000 + 2 * 3600);
  assert.equal(cnt(), 1, 'меньше 6 ч — ещё не подтверждено');
  await storeInventory(D, U, { status: 'private', steamId: SID }, NOW + 10000 + 6 * 3600);
  assert.equal(cnt(), 0, 'подтверждено — удалено');
  // Снова открыт — счётчики сброшены.
  await storeInventory(D, U, { status: 'ok', steamId: SID, items: [{ name: 'A', qty: 1, marketable: 1, tradable: 1, img: null }], partial: false }, NOW + 50000);
  assert.equal(retry(), null);
  assert.equal(d.db.prepare(`SELECT 1 FROM user_settings WHERE key = 'inv_private_at'`).get(), undefined);
});

test('#33: тексты — «Steam не отдаёт» не просит открыть настройки; «закрыт» — с обоими пунктами приватности', async () => {
  const html = (await import('node:fs')).readFileSync(new URL('../src/webapp/app.html', import.meta.url), 'utf8');
  const blocked = html.match(/blocked: '([^']+)'/)![1];
  assert.doesNotMatch(blocked, /Открой|Приватность/);
  assert.match(blocked, /настройки в порядке/);
  const priv = html.match(/var INV_ST = \{ private: '([^']+)'/)![1];
  assert.match(priv, /Мой профиль: Открытый/);
  assert.match(priv, /Инвентарь: Открытый/);
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

test('пропало из инвентаря: бот видит, что ушло, и записывает продажи пачкой (с покупкой, без неё, «не продавал»)', async () => {
  const d = migratedDb();
  const D = d as unknown as D1Database;
  const env = testEnv(d);
  d.db.prepare('INSERT INTO users (telegram_id, created_at, steam_id, steam_verified, inv_synced_at) VALUES (?, ?, ?, 1, ?)').run(U, NOW - 3600, SID, NOW - 3600);
  const it = (name: string, qty: number) => ({ name, qty, marketable: 1, tradable: 1, img: null });
  await storeInventory(D, U, { status: 'ok', steamId: SID, items: [it('Kilowatt Case', 5), it('AK-47 | Slate (Field-Tested)', 1), it('AWP | Atheris (Field-Tested)', 1), it('Sticker | Y', 2)], partial: false }, NOW - 3000);
  assert.equal((d.db.prepare('SELECT COUNT(*) AS n FROM inv_gone').get() as { n: number }).n, 0, 'первый раз — сравнивать не с чем');
  // Записанная раньше покупка AK — цена покупки возьмётся из неё.
  const init = await signInitData({ auth_date: String(NOW), query_id: 'Q', user: JSON.stringify({ id: U }) }, 'TEST_TOKEN');
  const call = async (path: string, method = 'GET', body?: unknown) => (await handleAppApi(new Request('https://w.dev/app/api/' + path, { method, headers: { 'X-Init-Data': init }, body: body ? JSON.stringify(body) : undefined }), env, NOW)).json() as Promise<Record<string, any>>;
  await call('inventory', 'POST', { name: 'AK-47 | Slate (Field-Tested)', qty: 1, priceKop: 10000, platform: 'steam', date: '2026-11-01' });
  // Продано 3 кейса (1 из них уже отмечен кнопкой «Я продал» до обновления), AK и AWP; наклейки на месте.
  const caseLot = (await call('inventory', 'POST', { name: 'Kilowatt Case', qty: 1, priceKop: 2000, platform: 'steam', date: '2026-11-01' })).id;
  await call(`inventory/${caseLot}/sell`, 'POST', { qty: 1, priceKop: 2500, receivedKop: 2400, platform: 'waxpeer', date: '2026-11-06' });
  await storeInventory(D, U, { status: 'ok', steamId: SID, items: [it('Kilowatt Case', 2), it('Sticker | Y', 2)], partial: false }, NOW);
  const gone = await call('inventory/gone');
  const by = Object.fromEntries(gone.items.map((x: any) => [x.name, x]));
  assert.deepEqual(Object.keys(by).sort(), ['AK-47 | Slate (Field-Tested)', 'AWP | Atheris (Field-Tested)', 'Kilowatt Case']);
  assert.equal(by['Kilowatt Case'].qty, 2, '3 ушло, 1 уже записан — осталось 2');
  assert.equal(by['AK-47 | Slate (Field-Tested)'].buyKop, 10000);
  assert.ok(gone.platforms.some((p: any) => p.v === 'csgomarket'), 'есть Market.CSGO');
  const st = await call('steam');
  assert.equal(st.goneCount, 3);
  assert.ok(st.fx && st.fx.UAH === 1, 'курсы для ввода в другой валюте');
  const res = await call('inventory/gone/save', 'POST', { rows: [
    { id: by['Kilowatt Case'].id, action: 'sold', platform: 'csgomarket', receivedKop: 3000, qty: 2, buyKop: 0 },
    { id: by['AK-47 | Slate (Field-Tested)'].id, action: 'sold', platform: 'csgomarket', receivedKop: 12000 },
    { id: by['AWP | Atheris (Field-Tested)'].id, action: 'skip' },
  ] });
  assert.equal(res.sold, 2);
  assert.equal(res.skipped, 1);
  assert.deepEqual(res.errors, []);
  assert.equal(res.resultKop, 2 * 3000 + (12000 - 10000), 'кейсы выпали (0), AK — из записи о покупке');
  assert.equal((await call('inventory/gone')).items.length, 0);
  assert.equal((await call('inventory')).realizedCashKop, 400 + 8000);
  // Повторно записать то же нельзя
  assert.equal((await call('inventory/gone/save', 'POST', { rows: [{ id: by['Kilowatt Case'].id, action: 'sold', platform: 'csgomarket', receivedKop: 3000, buyKop: 0 }] })).sold, 0);
});

test('пропало: без цены покупки и без записи — не записывает, просит указать', async () => {
  const d = migratedDb();
  const D = d as unknown as D1Database;
  const env = testEnv(d);
  d.db.prepare('INSERT INTO users (telegram_id, created_at, steam_id, steam_verified, inv_synced_at) VALUES (?, ?, ?, 1, ?)').run(U, NOW - 3600, SID, NOW - 3600);
  await storeInventory(D, U, { status: 'ok', steamId: SID, items: [{ name: 'X Case', qty: 1, marketable: 1, tradable: 1, img: null }], partial: false }, NOW - 100);
  await storeInventory(D, U, { status: 'ok', steamId: SID, items: [], partial: false }, NOW);
  const init = await signInitData({ auth_date: String(NOW), query_id: 'Q', user: JSON.stringify({ id: U }) }, 'TEST_TOKEN');
  const call = async (path: string, method = 'GET', body?: unknown) => (await handleAppApi(new Request('https://w.dev/app/api/' + path, { method, headers: { 'X-Init-Data': init }, body: body ? JSON.stringify(body) : undefined }), env, NOW)).json() as Promise<Record<string, any>>;
  const g = (await call('inventory/gone')).items[0];
  const r = await call('inventory/gone/save', 'POST', { rows: [{ id: g.id, action: 'sold', platform: 'steam', receivedKop: 1000 }] });
  assert.equal(r.sold, 0);
  assert.match(r.errors[0], /за сколько покупал/);
  const r2 = await call('inventory/gone/save', 'POST', { rows: [{ id: g.id, action: 'sold', platform: 'steam', receivedKop: 1000, buyKop: 500 }] });
  assert.equal(r2.sold, 1);
  const sale = d.db.prepare('SELECT sell_price_kop, received_kop, wallet FROM trade_sales').get() as { sell_price_kop: number; received_kop: number; wallet: string };
  assert.equal(sale.received_kop, 1000);
  assert.equal(sale.wallet, 'steam_wallet');
  assert.ok(sale.sell_price_kop >= 1149 && sale.sell_price_kop <= 1151, 'Steam: цена покупателя восстановлена из полученного (+15%)');
});

test('продажа «ждёт оплаты»: не в прибыли и не в покупках; «деньги пришли» → продажа; «не продалось» → обратно; удаление продажи', async () => {
  const d = migratedDb();
  const env = testEnv(d);
  const init = await signInitData({ auth_date: String(NOW), query_id: 'Q', user: JSON.stringify({ id: U }) }, 'TEST_TOKEN');
  const call = async (path: string, method = 'GET', body?: unknown) => (await handleAppApi(new Request('https://w.dev/app/api/' + path, { method, headers: { 'X-Init-Data': init }, body: body ? JSON.stringify(body) : undefined }), env, NOW)).json() as Promise<Record<string, any>>;
  const lot = (await call('inventory', 'POST', { name: 'AK-47 | Slate (Field-Tested)', qty: 2, priceKop: 10000, platform: 'steam', date: '2026-11-01' })).id;
  const p = await call(`inventory/${lot}/sell`, 'POST', { qty: 1, priceKop: 13000, receivedKop: 12000, platform: 'csgomarket', pending: true });
  assert.equal(p.pending, true);
  assert.equal(p.resultKop, 2000);
  let inv = await call('inventory');
  assert.equal(inv.realizedCashKop, 0, 'не в прибыли');
  assert.equal(inv.lots[0].openQty, 1, 'в покупках осталась 1');
  let tr = await call('trades');
  assert.equal(tr.pending.length, 1);
  assert.equal(tr.pending[0].resultKop, 2000);
  assert.equal(tr.pending[0].platform, 'Market.CSGO');
  // Нельзя «продать» больше, чем осталось с учётом ожидающих
  assert.equal((await call(`inventory/${lot}/sell`, 'POST', { qty: 2, priceKop: 13000, receivedKop: 24000, platform: 'csgomarket' })).ok, false);
  // Деньги пришли, но меньше
  const c = await call(`sales/pending/${tr.pending[0].id}/confirm`, 'POST', { receivedKop: 11500 });
  assert.equal(c.resultKop, 1500);
  inv = await call('inventory');
  assert.equal(inv.realizedCashKop, 1500);
  tr = await call('trades');
  assert.equal(tr.pending.length, 0);
  assert.equal(tr.sales.length, 1);
  // Вторая штука: «ждёт», потом «не продалось» — вернулась в покупки
  await call(`inventory/${lot}/sell`, 'POST', { qty: 1, priceKop: 13000, receivedKop: 12000, platform: 'waxpeer', pending: true });
  assert.equal((await call('inventory')).lots.length, 0, 'всё продано или ждёт оплаты');
  const pid = (await call('trades')).pending[0].id;
  assert.equal((await call(`sales/pending/${pid}/cancel`, 'POST')).ok, true);
  assert.equal((await call('inventory')).lots[0].openQty, 1);
  // Ошибочная продажа удаляется, штука возвращается
  assert.equal((await call(`sales/${tr.sales[0].id}`, 'DELETE')).ok, true);
  inv = await call('inventory');
  assert.equal(inv.realizedCashKop, 0);
  assert.equal(inv.lots[0].openQty, 2);
});

async function goneSetup(names: [string, number][]) {
  const d = migratedDb();
  const D = d as unknown as D1Database;
  const env = testEnv(d);
  d.db.prepare('INSERT INTO users (telegram_id, created_at, steam_id, steam_verified, inv_synced_at) VALUES (?, ?, ?, 1, ?)').run(U, NOW - 3600, SID, NOW - 3600);
  const it = (name: string, qty: number) => ({ name, qty, marketable: 1, tradable: 1, img: null });
  await storeInventory(D, U, { status: 'ok', steamId: SID, items: names.map(([n, q]) => it(n, q)), partial: false }, NOW - 3000);
  const init = await signInitData({ auth_date: String(NOW), query_id: 'Q', user: JSON.stringify({ id: U }) }, 'TEST_TOKEN');
  const call = async (path: string, method = 'GET', body?: unknown, at = NOW) => (await handleAppApi(new Request('https://w.dev/app/api/' + path, { method, headers: { 'X-Init-Data': init }, body: body ? JSON.stringify(body) : undefined }), env, at)).json() as Promise<Record<string, any>>;
  return { d, D, call, it };
}
const salesN = (d: ReturnType<typeof migratedDb>) => (d.db.prepare('SELECT COALESCE(SUM(quantity), 0) AS n FROM trade_sales').get() as { n: number }).n;

test('пропало: много строк за раз — не обрывается на лимите базы, честно «записано N из M», повтор без дублей', async () => {
  const names: [string, number][] = Array.from({ length: 14 }, (_, i) => [`Case ${i}`, 1]);
  const { d, D, call } = await goneSetup(names);
  await storeInventory(D, U, { status: 'ok', steamId: SID, items: [], partial: false }, NOW);
  const rows = () => call('inventory/gone').then((g) => g.items.map((x: any) => ({ id: x.id, action: 'sold', platform: 'csgomarket', receivedKop: 1000, buyKop: 500 })));
  const r1 = await call('inventory/gone/save', 'POST', { rows: await rows() });
  assert.equal(r1.ok, true, 'без ошибки сервера');
  assert.ok(r1.left > 0 && r1.sold === 14 - r1.left, `записано ${r1.sold}, осталось ${r1.left}`);
  assert.match(r1.errors.at(-1), /Записано \d+ из 14/);
  assert.equal(salesN(d), r1.sold, 'ничего лишнего не записано');
  for (let i = 0; i < 5 && (await call('inventory/gone')).items.length; i++) await call('inventory/gone/save', 'POST', { rows: await rows() });
  assert.equal(salesN(d), 14, 'после повторов — ровно 14 продаж, без дублей');
  assert.equal((await call('inventory/gone')).items.length, 0);
});

test('пропало: без цены покупки записана только часть — остаток остаётся в «Пропало»', async () => {
  const { d, D, call } = await goneSetup([['AK-47 | Slate (Field-Tested)', 2]]);
  await call('inventory', 'POST', { name: 'AK-47 | Slate (Field-Tested)', qty: 1, priceKop: 10000, platform: 'steam', date: '2026-11-01' });
  await storeInventory(D, U, { status: 'ok', steamId: SID, items: [], partial: false }, NOW);
  const g = (await call('inventory/gone')).items[0];
  assert.equal(g.qty, 2);
  const r = await call('inventory/gone/save', 'POST', { rows: [{ id: g.id, action: 'sold', platform: 'csgomarket', receivedKop: 12000, qty: 2 }] });
  assert.match(r.errors[0], /за сколько покупал/);
  assert.equal(salesN(d), 1, 'одна штука — из записанной покупки');
  const left = (await call('inventory/gone')).items;
  assert.equal(left.length, 1);
  assert.equal(left[0].qty, 1, 'в «Пропало» осталась незаписанная штука');
  await call('inventory/gone/save', 'POST', { rows: [{ id: left[0].id, action: 'sold', platform: 'csgomarket', receivedKop: 12000, qty: 1, buyKop: 0 }] });
  assert.equal(salesN(d), 2);
});

test('пропало: продажи, записанные через «Пропало», не вычитаются второй раз — новая пропажа видна', async () => {
  const { d, D, call } = await goneSetup([['Kilowatt Case', 5]]);
  await storeInventory(D, U, { status: 'ok', steamId: SID, items: [{ name: 'Kilowatt Case', qty: 3, marketable: 1, tradable: 1, img: null }], partial: false }, NOW);
  const g = (await call('inventory/gone')).items[0];
  assert.equal(g.qty, 2);
  await call('inventory/gone/save', 'POST', { rows: [{ id: g.id, action: 'sold', platform: 'csgomarket', receivedKop: 3000, buyKop: 0 }] }, NOW + 60);
  assert.equal(salesN(d), 2);
  // Следующее обновление: ушла ещё 1 штука.
  await storeInventory(D, U, { status: 'ok', steamId: SID, items: [{ name: 'Kilowatt Case', qty: 2, marketable: 1, tradable: 1, img: null }], partial: false }, NOW + 600);
  const g2 = (await call('inventory/gone', 'GET', undefined, NOW + 600)).items;
  assert.equal(g2.length, 1, 'новая пропажа появилась');
  assert.equal(g2[0].qty, 1);
});

test('пачка продаж: сервер говорит, сколько строк обработал, — приложение продолжает с нужной, без дублей', async () => {
  const { d, call } = await goneSetup([]);
  const rows = Array.from({ length: 12 }, (_, i) => ({ name: `Batch Case ${i}`, qty: 1, receivedKop: 1000, platform: 'csgomarket', buyKop: 500 }));
  let k = 0, guard = 0;
  while (k < rows.length && guard++ < 20) {
    const r = await call('sales/batch', 'POST', { rows: rows.slice(k, k + 5) });
    assert.equal(r.ok, true);
    assert.ok(r.done >= 1 && r.done <= 5);
    k += r.done;
  }
  assert.equal(salesN(d), 12);
});

test('#33: страница с вкладкой CS2 — «открыт», даже если на ней есть слова о приватности; проверка записывается', async () => {
  const { classifyInventoryPage } = await import('../src/core/steaminv.ts');
  assert.equal(classifyInventoryPage('<span class="games_list_tab_name">Counter-Strike 2</span> <div class="private_profile">x</div>'), 'open');
  const d = migratedDb();
  const D = d as unknown as D1Database;
  d.db.prepare('INSERT INTO users (telegram_id, created_at, steam_id, inv_requested_at) VALUES (?, ?, ?, ?)').run(U, NOW, SID, NOW);
  await storeInventory(D, U, { status: 'blocked', steamId: SID, diag: 'JSON: HTTP 403 · страница: открыт' }, NOW);
  const c = JSON.parse((d.db.prepare(`SELECT value FROM user_settings WHERE key = 'inv_check'`).get() as { value: string }).value);
  assert.deepEqual([c.src, c.status, c.diag], ['сервер бота', 'blocked', 'JSON: HTTP 403 · страница: открыт']);
});

test('#33: висит «закрыт» — открыл «Мои скины», бот сам перепроверил и вернул инвентарь (не чаще раза в 10 мин)', async () => {
  const d = migratedDb();
  const env = testEnv(d);
  d.db.prepare(`INSERT INTO users (telegram_id, created_at, steam_id, steam_verified, inv_status, inv_synced_at, inv_requested_at) VALUES (?, ?, ?, 1, 'private', ?, ?)`).run(U, NOW, SID, NOW - 60, NOW - 60);
  const g = globalThis as any; const orig = g.fetch;
  g.fetch = async (u: string) => (String(u).startsWith('https://steamcommunity.com/inventory/') ? json(inv([['1', '0', 1]], [['1', '0', 'Kilowatt Case', 1]])) : json({ ok: true }));
  const auto = async (now: number) => {
    const init = await signInitData({ auth_date: String(now), query_id: 'Q', user: JSON.stringify({ id: U }) }, 'TEST_TOKEN');
    const r = await handleAppApi(new Request('https://w.dev/app/api/steam/refresh', { method: 'POST', headers: { 'X-Init-Data': init, 'Content-Type': 'application/json' }, body: JSON.stringify({ auto: true }) }), env, now);
    return await r.json() as Record<string, any>;
  };
  try {
    const r = await auto(NOW);
    assert.equal(r.updated, true, 'обычные 15 минут не мешают сам-перепроверке');
    assert.equal((await api(env, 'steam')).body.status, 'ok');
    assert.equal((await auto(NOW + 60)).updated, false, 'статус в порядке — повторно не дёргаем Steam');
  } finally { g.fetch = orig; }
});
