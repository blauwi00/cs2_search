// Баланс Steam и галочка «Подбирать идеи под баланс Steam» (задача #32).
import test from 'node:test';
import assert from 'node:assert/strict';
import { migratedDb, testEnv, mockFetch, json } from './helpers.ts';
import { signInitData } from '../src/webapp/auth.ts';
import { handleAppApi } from '../src/webapp/api.ts';
import { handleIngest } from '../src/ingest.ts';
import { handleWebhook } from '../src/telegram/webhook.ts';
import { jobHotRecs, pickRec, hotText } from '../src/core/hotrecs.ts';
import { steamBuyLimit, splitByBalance, type SteamBalance } from '../src/core/steambalance.ts';
import * as db from '../src/storage/db.ts';
import type { Rec } from '../src/core/recs.ts';

const NOW = Date.parse('2026-11-07T10:00:00Z') / 1000;
const U = 8801;
const SECRET = 'ingest_secret_test_123';

async function setup() {
  const d = migratedDb();
  const D = d as unknown as D1Database;
  const env = testEnv(d, { INGEST_SECRET: SECRET });
  await db.storeFx(D, [{ base: 'EUR', rateMicro: 45_000_000, rateDate: '2026-11-07', source: 'nbu' }, { base: 'USD', rateMicro: 40_000_000, rateDate: '2026-11-07', source: 'nbu' }], NOW);
  const call = async (path: string, method = 'GET', body?: unknown, at = NOW) => {
    const init = await signInitData({ auth_date: String(at), query_id: 'Q', user: JSON.stringify({ id: U }) }, 'TEST_TOKEN');
    return (await handleAppApi(new Request('https://w/app/api/' + path, { method, headers: { 'X-Init-Data': init }, body: body ? JSON.stringify(body) : undefined }), env, at)).json() as Promise<Record<string, any>>;
  };
  return { d, D, env, call };
}

test('баланс: продажа в Steam после ввода прибавляет, покупка в Steam вычитает, «ждёт оплаты» и продажа за деньги — нет; ниже нуля — «расходится»', async () => {
  const { call } = await setup();
  const lot = (await call('inventory', 'POST', { name: 'Revolution Case', qty: 4, priceKop: 1000, platform: 'skinport', date: '2026-11-01' })).id;
  await call(`inventory/${lot}/sell`, 'POST', { qty: 1, priceKop: 2000, receivedKop: 1700, platform: 'steam' }, NOW - 60); // до ввода — не считается
  assert.equal((await call('steam-balance')).steamBalance, null);
  assert.equal((await call('steam-balance', 'POST', { kop: -5 })).ok, false);
  const r = await call('steam-balance', 'POST', { kop: 50000 });
  assert.equal(r.steamBalance.kop, 50000);
  await call(`inventory/${lot}/sell`, 'POST', { qty: 1, priceKop: 2000, receivedKop: 1700, platform: 'steam' }, NOW + 10);
  await call(`inventory/${lot}/sell`, 'POST', { qty: 1, priceKop: 2000, receivedKop: 1900, platform: 'csgomarket' }, NOW + 20);
  await call(`inventory/${lot}/sell`, 'POST', { qty: 1, priceKop: 2000, receivedKop: 1700, platform: 'steam', pending: true }, NOW + 25);
  await call('inventory', 'POST', { name: 'Fever Case', qty: 2, priceKop: 3000, platform: 'steam', date: '2026-11-07' }, NOW + 30);
  const b = (await call('steam-balance', 'GET', undefined, NOW + 40)).steamBalance;
  assert.equal(b.kop, 50000 + 1700 - 6000, 'вписано + продажа в Steam − покупка в Steam');
  assert.deepEqual([b.sales, b.buys, b.mismatch, b.stale], [1, 1, false, false]);
  await call('inventory', 'POST', { name: 'Kilowatt Case', qty: 1, priceKop: 60000, platform: 'steam', date: '2026-11-07' }, NOW + 50);
  const neg = (await call('steam-balance', 'GET', undefined, NOW + 60)).steamBalance;
  assert.ok(neg.kop < 0 && neg.mismatch, 'ушёл ниже нуля — флаг расхождения, а не молчаливый 0');
  assert.equal((await call('steam-balance', 'GET', undefined, NOW + 15 * 86400)).steamBalance.stale, true, 'больше 14 дней — «проверь»');
  assert.equal((await call('steam-balance', 'POST', { kop: null })).steamBalance, null);
});

test('кошелёк не в гривне: сумма хранится в валюте кошелька и пересчитывается по курсу', async () => {
  const { d, call } = await setup();
  d.db.exec(`INSERT INTO meta (key, value) VALUES ('fx_display', '{"USD":40,"EUR":45}') ON CONFLICT(key) DO UPDATE SET value = excluded.value`);
  await db.setSetting(d as unknown as D1Database, U, 'currency', 'USD', NOW);
  await call('steam-balance', 'POST', { kop: 400000 }); // 4000 ₴ = 100 $
  const row = (k: string) => (d.db.prepare('SELECT value FROM user_settings WHERE telegram_id = ? AND key = ?').get(U, k) as { value: string }).value;
  assert.equal(row('steam_balance_cur'), 'USD');
  assert.equal(row('steam_balance_kop'), '10000', '100,00 $ в центах');
  d.db.exec(`UPDATE meta SET value = '{"USD":42,"EUR":45}' WHERE key = 'fx_display'`);
  assert.equal((await call('steam-balance')).steamBalance.kop, 420000, 'те же 100 $ по новому курсу');
});

test('предел: галочка выкл или без баланса — как раньше; вкл — меньшее из баланса и «Макс. цены покупки»', () => {
  const bal = { kop: 5000 } as SteamBalance;
  const st = (by: string, maxBuy = '0') => ({ recs_by_balance: by, max_buy_kop: maxBuy }) as db.Settings;
  assert.equal(steamBuyLimit(bal, st('0')), null);
  assert.equal(steamBuyLimit(null, st('1')), null, 'вкл без баланса — как выкл');
  assert.equal(steamBuyLimit(bal, st('1')), 5000);
  assert.equal(steamBuyLimit(bal, st('1', '3000')), 3000, 'макс. цена покупки меньше — действует она');
  assert.equal(steamBuyLimit({ kop: -100 } as SteamBalance, st('1')), 0, 'расходится — в Steam ничего не предлагаем');
  const rec = (name: string, buyAt: Rec['buyAt'], payKop: number) => ({ name, buyAt, sellAt: 'skinport', payKop, buyKop: payKop, sellKop: payKop * 2, profitKop: 100, roiBp: 3000, wallet: 'cash' }) as unknown as Rec;
  const list = [rec('A', 'skinport', 500), rec('Big Steam', 'steam', 90000), rec('Small Steam', 'steam', 2000)];
  assert.deepEqual(splitByBalance(list, null).shown.map((x) => x.name), ['A', 'Big Steam', 'Small Steam']);
  const sp = splitByBalance(list, 5000);
  assert.deepEqual(sp.shown.map((x) => x.name), ['Small Steam', 'A'], 'подходящие покупки в Steam — первыми, сайты — остаются');
  assert.deepEqual(sp.hidden.map((x) => x.name), ['Big Steam']);
  assert.equal(pickRec(list, null, () => true)!.name, 'A');
  assert.equal(pickRec(list, 5000, () => true)!.name, 'Small Steam');
  assert.match(hotText(rec('Small Steam', 'steam', 2000), 5000), /Хватает твоего баланса Steam/);
});

test('галочка вкл: дорогая покупка в Steam не приходит ни в уведомлении, ни в списке «Рекомендации» (там — «Ещё N»); покупка на сайте приходит', async () => {
  const { d, D, env, call } = await setup();
  await db.ensureUser(D, U, false, NOW);
  // Steam: 1400 ₴ → Skinport продают за 40 € (1800 ₴): выгодно, но дороже баланса. Skinport: 24 € → медиана 30 € — выгодно.
  const items = [
    { name: 'Expensive Steam Item', offers: {}, steam: { lowest_price: '1400₴', volume: '50' }, s7: { median: 40, volume: 300 }, s30: { median: 40, volume: 1200 } },
    { name: 'Cheap Site Item', offers: { skinport: { p: 24, q: 50 } }, s7: { median: 30, volume: 300 }, s30: { median: 30, volume: 1200 } },
  ];
  const scan = (at: number) => handleIngest(new Request('https://w/ingest', { method: 'POST', headers: { 'X-Ingest-Secret': SECRET }, body: JSON.stringify({ kind: 'scan', fetchedAt: at, items }) }), env, at);
  await scan(NOW - 600); await scan(NOW);
  const before = await call('recs');
  assert.ok(before.deals.some((x: any) => x.name === 'Expensive Steam Item' && x.buyAt === 'steam'), 'без галочки — дорогая Steam-покупка видна');
  await call('steam-balance', 'POST', { kop: 10000 });
  assert.ok((await call('recs')).deals.some((x: any) => x.name === 'Expensive Steam Item'), 'баланс вписан, галочка выкл — как раньше');
  const s1 = await call('settings');
  assert.equal(s1.hasBalance, true);
  await call('steam-balance', 'POST', { byBalance: true });
  const after = await call('recs');
  assert.ok(!after.deals.some((x: any) => x.name === 'Expensive Steam Item' && x.buyAt === 'steam'), 'дороже баланса — не в списке');
  assert.ok(after.hidden.some((x: any) => x.name === 'Expensive Steam Item'), '…но не потеряна: «Ещё N — показать»');
  assert.ok(after.deals.some((x: any) => x.name === 'Cheap Site Item'), 'покупка на сайте — как раньше');
  assert.equal((await call('summary')).recs.hidden, after.hidden.length, 'сводка на главной считает так же');
  await jobHotRecs({ db: D, now: NOW + 60 });
  const pushed = (d.db.prepare(`SELECT text FROM outbox WHERE kind = 'recs' AND telegram_id = ?`).all(U) as { text: string }[]).map((r) => r.text).join('\n');
  assert.doesNotMatch(pushed, /Expensive Steam Item/, 'и в уведомлении нет');
  assert.match(pushed, /Cheap Site Item/);
});

test('/deletemydata удаляет баланс и галочку; /start показывает баланс', async () => {
  const { d, env, call } = await setup();
  await call('steam-balance', 'POST', { kop: 12345 });
  await call('steam-balance', 'POST', { byBalance: true });
  const sent: { method: string; body: Record<string, any> }[] = [];
  const { fetcher } = mockFetch([{ match: (u) => u.startsWith('https://api.telegram.org/'), respond: (u, init) => { sent.push({ method: u.split('/').pop()!, body: JSON.parse(String(init?.body)) }); return json({ ok: true, result: { message_id: 1 } }); } }]);
  const upd = (body: object) => handleWebhook(new Request('https://x/telegram', { method: 'POST', headers: { 'X-Telegram-Bot-Api-Secret-Token': env.TELEGRAM_WEBHOOK_SECRET }, body: JSON.stringify({ update_id: 1, ...body }) }), env, NOW, fetcher);
  await upd({ message: { message_id: 1, from: { id: U }, chat: { id: U, type: 'private' }, text: '/start' } });
  assert.match(String(sent.filter((s) => s.method === 'sendMessage').at(-1)!.body.text), /Баланс Steam/);
  await upd({ message: { message_id: 1, from: { id: U }, chat: { id: U, type: 'private' }, text: '/deletemydata' } });
  await upd({ callback_query: { id: 'q', from: { id: U }, data: 'delme:yes', message: { message_id: 5, chat: { id: U, type: 'private' } } } });
  assert.equal((d.db.prepare(`SELECT COUNT(*) AS n FROM user_settings WHERE telegram_id = ? AND key IN ('steam_balance_kop','steam_balance_at','steam_balance_cur','recs_by_balance')`).get(U) as { n: number }).n, 0);
});
