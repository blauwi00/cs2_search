import test from 'node:test';
import assert from 'node:assert/strict';
import { migratedDb, testEnv, ADMIN } from './helpers.ts';
import { verifyInitData, signInitData } from '../src/webapp/auth.ts';
import { handleAppApi } from '../src/webapp/api.ts';
import { handleIngest } from '../src/ingest.ts';
import { steamSellerProceeds } from '../src/core/fees.ts';

const NOW = Date.parse('2026-11-04T12:00:00Z') / 1000;
const TOKEN = 'TEST_TOKEN';

async function init(userId = ADMIN, authDate = NOW) {
  return signInitData({ auth_date: String(authDate), query_id: 'AAA', user: JSON.stringify({ id: userId, first_name: 'E' }) }, TOKEN);
}
async function call(env: ReturnType<typeof testEnv>, path: string, opt: { method?: string; body?: unknown; userId?: number } = {}) {
  const res = await handleAppApi(new Request('https://w/app/api/' + path, {
    method: opt.method ?? 'GET', headers: { 'X-Init-Data': await init(opt.userId) }, body: opt.body ? JSON.stringify(opt.body) : undefined,
  }), env, NOW);
  return { status: res.status, body: await res.json() as Record<string, unknown> };
}

test('Mini App: подпись Telegram проверяется; подделка и старые данные — отказ; технические экраны — только владельцу', async () => {
  const good = await init();
  assert.equal((await verifyInitData(good, TOKEN, NOW))?.id, ADMIN);
  assert.equal(await verifyInitData(good, 'OTHER_TOKEN', NOW), null, 'другой токен бота');
  assert.equal(await verifyInitData(good.replace('first_name', 'first_namE'), TOKEN, NOW), null, 'изменённые данные');
  assert.equal(await verifyInitData(await init(ADMIN, NOW - 3 * 86400), TOKEN, NOW), null, 'старше суток');
  const env = testEnv(migratedDb());
  assert.equal((await call(env, 'summary', { userId: 999 })).status, 200, 'приложение открыто для всех');
  assert.equal((await call(env, 'status', { userId: 999 })).status, 403, 'состояние системы — только владельцу');
  assert.equal((await call(env, 'status')).status, 200);
  const st = await call(env, 'settings', { userId: 999 });
  assert.ok(!(st.body.settings as { key: string }[]).some((x) => x.key === 'src_steam'), 'источники включает/выключает только владелец');
  assert.equal((await call(env, 'settings', { userId: 999, method: 'POST', body: { key: 'src_steam', value: false } })).status, 400);
  const noHeader = await handleAppApi(new Request('https://w/app/api/summary'), env, NOW);
  assert.equal(noHeader.status, 403);
});

test('Mini App: сводка, поиск по каталогу, наблюдение', async () => {
  const d = migratedDb();
  const env = testEnv(d, { INGEST_SECRET: 'ingest_secret_test_123' });
  const names = Array.from({ length: 30 }, (_, i) => `Filler ${i}`).concat(['Revolution Case', 'Kilowatt Case']);
  const ing = await handleIngest(new Request('https://w/ingest', { method: 'POST', headers: { 'X-Ingest-Secret': 'ingest_secret_test_123' }, body: JSON.stringify({ kind: 'catalog', fetchedAt: NOW, part: 0, parts: 1, items: names }) }), env, NOW);
  assert.equal(ing.status, 200);
  const s = await call(env, 'search?q=revol');
  assert.deepEqual(s.body.results, ['Revolution Case']);
  assert.equal((await call(env, 'watch', { method: 'POST', body: { names: ['Revolution Case', 'Kilowatt Case'] } })).status, 200);
  const w = await call(env, 'watch');
  assert.equal((w.body.items as unknown[]).length, 2);
  const sum = await call(env, 'summary');
  assert.equal(sum.status, 200);
  assert.equal(sum.body.watched, 2);
});

test('Mini App: покупка и продажа в Steam; комиссия считается на сервере; неверный ввод отклоняется', async () => {
  const d = migratedDb();
  const env = testEnv(d);
  assert.equal((await call(env, 'inventory', { method: 'POST', body: { name: 'Revolution Case', qty: 0, priceKop: 800, platform: 'skinport', date: '2026-11-01' } })).status, 400);
  assert.equal((await call(env, 'inventory', { method: 'POST', body: { name: 'Revolution Case', qty: 2, priceKop: 800, platform: 'skinport', date: '2099-01-01' } })).status, 400);
  const add = await call(env, 'inventory', { method: 'POST', body: { name: 'Revolution Case', qty: 2, priceKop: 800, feeKop: 0, platform: 'skinport', date: '2026-11-01' } });
  assert.equal(add.status, 200);
  const inv = await call(env, 'inventory');
  const lot = (inv.body.lots as { id: number; openQty: number }[])[0];
  assert.equal(lot.openQty, 2);
  const sell = await call(env, `inventory/${lot.id}/sell`, { method: 'POST', body: { qty: 1, priceKop: 1000, receivedKop: null, platform: 'steam', date: '2026-11-04' } });
  assert.equal(sell.status, 200);
  assert.equal(sell.body.receivedKop, steamSellerProceeds(1000)!.sellerReceives);
  assert.equal(sell.body.wallet, 'steam_wallet');
  assert.equal((await call(env, `inventory/${lot.id}/sell`, { method: 'POST', body: { qty: 5, priceKop: 1000, platform: 'steam' } })).status, 400, 'больше, чем осталось');
  const tr = await call(env, 'trades');
  assert.equal((tr.body.stats as { sales: number }).sales, 1);
});

test('Mini App: настройки проверяются так же, как в боте', async () => {
  const env = testEnv(migratedDb());
  assert.equal((await call(env, 'settings', { method: 'POST', body: { key: 'min_profit_kop', value: 'abc' } })).status, 400);
  const ok = await call(env, 'settings', { method: 'POST', body: { key: 'min_profit_kop', value: '35,5' } });
  assert.equal(ok.body.value, '3550');
  assert.equal((await call(env, 'settings', { method: 'POST', body: { key: 'notify_enabled', value: false } })).body.value, '0');
  assert.equal((await call(env, 'settings', { method: 'POST', body: { key: 'min_liquidity', value: 'hacker' } })).status, 400);
  assert.equal((await call(env, 'settings', { method: 'POST', body: { key: 'ADMIN_KEY', value: 'x' } })).status, 400);
  const g = await call(env, 'settings');
  assert.ok((g.body.settings as { key: string }[]).some((x) => x.key === 'min_profit_kop'));
});

test('каталог: части принимаются с проверкой, старые лишние части удаляются', async () => {
  const d = migratedDb();
  const env = testEnv(d, { INGEST_SECRET: 'ingest_secret_test_123' });
  const send = (body: unknown) => handleIngest(new Request('https://w/ingest', { method: 'POST', headers: { 'X-Ingest-Secret': 'ingest_secret_test_123' }, body: JSON.stringify({ kind: 'catalog', fetchedAt: NOW, ...body as object }) }), env, NOW);
  const many = (p: string) => Array.from({ length: 20 }, (_, i) => `${p} ${i}`);
  for (let p = 0; p < 3; p++) assert.equal((await send({ part: p, parts: 3, items: many('A' + p) })).status, 200);
  assert.equal((d.db.prepare('SELECT COUNT(*) AS n FROM catalog_chunks').get() as { n: number }).n, 3);
  await send({ part: 0, parts: 1, items: many('B') });
  assert.equal((d.db.prepare('SELECT COUNT(*) AS n FROM catalog_chunks').get() as { n: number }).n, 1);
  assert.equal((await send({ part: 0, parts: 1, items: ['x'] })).status, 400, 'слишком маленький каталог не принимается');
  assert.equal((await send({ part: 5, parts: 2, items: many('C') })).status, 400);
});

test('«Цены»: карточка скина по названию из каталога; чужое название — ошибка, без мусора в базе', async () => {
  const { migratedDb, testEnv } = await import('./helpers.ts');
  const { signInitData } = await import('../src/webapp/auth.ts');
  const { handleAppApi } = await import('../src/webapp/api.ts');
  const d = migratedDb();
  const env = testEnv(d);
  const NOW2 = Date.parse('2026-11-07T10:00:00Z') / 1000;
  const { catalogLines } = await import('../src/catalog.ts');
  d.db.prepare('INSERT INTO catalog_chunks (chunk, names, updated_at) VALUES (0, ?, 0)').run(catalogLines(['AK-47 | Redline (Field-Tested)', 'AWP | Asiimov (Field-Tested)']));
  const init = await signInitData({ auth_date: String(NOW2), query_id: 'Q', user: JSON.stringify({ id: 4242 }) }, 'TEST_TOKEN');
  const call = async (path: string) => (await handleAppApi(new Request('https://w/app/api/' + path, { headers: { 'X-Init-Data': init } }), env, NOW2)).json() as Promise<Record<string, any>>;
  const r = await call('item-id?name=' + encodeURIComponent('AWP | Asiimov (Field-Tested)'));
  assert.equal(r.ok, true);
  assert.equal((await call('item-id?name=' + encodeURIComponent('AWP | Asiimov (Field-Tested)'))).id, r.id, 'второй раз — тот же предмет');
  const bad = await call('item-id?name=' + encodeURIComponent('Totally Fake Item'));
  assert.equal(bad.ok, false);
  assert.equal((d.db.prepare(`SELECT COUNT(*) AS n FROM items WHERE market_hash_name = 'Totally Fake Item'`).get() as { n: number }).n, 0);
  assert.equal((await call('item/' + r.id)).ok, true, 'карточка открывается');
});

test('«Пригласить друга»: сводка отдаёт имя бота для ссылки ?start=fr', async () => {
  const { migratedDb, testEnv } = await import('./helpers.ts');
  const { signInitData } = await import('../src/webapp/auth.ts');
  const { handleAppApi } = await import('../src/webapp/api.ts');
  const d = migratedDb();
  const env = testEnv(d);
  const T0 = Date.parse('2026-11-07T10:00:00Z') / 1000;
  d.db.exec(`INSERT INTO meta (key, value) VALUES ('bot_username', 'cenolov_bot')`);
  const init = await signInitData({ auth_date: String(T0), query_id: 'Q', user: JSON.stringify({ id: 4343 }) }, 'TEST_TOKEN');
  const r = await (await handleAppApi(new Request('https://w/app/api/summary', { headers: { 'X-Init-Data': init } }), env, T0)).json() as Record<string, any>;
  assert.equal(r.botUser, 'cenolov_bot');
});

test('покупка в другой валюте: курс НБУ на дату покупки (кэш на день); нет курса на дату — сегодняшний с пометкой', async () => {
  const { migratedDb, testEnv } = await import('./helpers.ts');
  const { signInitData } = await import('../src/webapp/auth.ts');
  const { handleAppApi } = await import('../src/webapp/api.ts');
  const d = migratedDb();
  const env = testEnv(d);
  const T0 = Date.parse('2026-11-07T10:00:00Z') / 1000;
  d.db.exec(`INSERT INTO meta (key, value) VALUES ('fx_display', '{"USD":42,"EUR":48,"RUB":0.5}') ON CONFLICT(key) DO UPDATE SET value = excluded.value`);
  const g = globalThis as { fetch: typeof fetch }, orig = g.fetch;
  let calls = 0;
  g.fetch = (async (u: string) => { calls++; assert.match(String(u), /date=20260901/); return new Response(JSON.stringify([{ cc: 'USD', rate: 41.5 }, { cc: 'EUR', rate: 45 }]), { status: 200 }); }) as typeof fetch;
  try {
    const init = await signInitData({ auth_date: String(T0), query_id: 'Q', user: JSON.stringify({ id: 4545 }) }, 'TEST_TOKEN');
    const call = async (body: object) => (await handleAppApi(new Request('https://w/app/api/inventory', { method: 'POST', headers: { 'X-Init-Data': init }, body: JSON.stringify(body) }), env, T0)).json() as Promise<Record<string, any>>;
    const lot = (id: number) => d.db.prepare('SELECT buy_price_kop, buy_fee_kop FROM trades WHERE id = ?').get(id) as { buy_price_kop: number; buy_fee_kop: number };
    const base = { name: 'AK-47 | Slate (Field-Tested)', qty: 1, platform: 'skinport', priceKop: 1, feeKop: 0 };
    const a = await call({ ...base, cur: 'USD', priceMinor: 1000, feeMinor: 50, date: '2026-09-01' });
    assert.equal(a.rateExact, true);
    assert.deepEqual({ ...lot(a.id) }, { buy_price_kop: 41500, buy_fee_kop: 2075 }, '10 $ по курсу 1 сентября (41,5), а не сегодняшнему (42)');
    await call({ ...base, cur: 'EUR', priceMinor: 100, date: '2026-09-01' });
    assert.equal(calls, 1, 'курс на этот день — из кэша, НБУ второй раз не спрашиваем');
    const b = await call({ ...base, cur: 'USD', priceMinor: 1000, date: '2026-11-07' });
    assert.equal(lot(b.id).buy_price_kop, 42000, 'сегодня — текущий курс');
    const c = await call({ ...base, cur: 'RUB', priceMinor: 10000, date: '2026-09-01' });
    assert.equal(c.rateExact, false, 'рубля в НБУ нет — сегодняшний курс с пометкой');
    assert.equal(lot(c.id).buy_price_kop, 5000);
  } finally { g.fetch = orig; }
});
