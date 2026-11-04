// Бот для всех: у каждого свой список, уведомления по его настройкам, лимит предметов, свои скрытые сделки.
import test from 'node:test';
import assert from 'node:assert/strict';
import { migratedDb, testEnv, mockFetch, json, telegramRoute, fixture, fixtureJson, ADMIN } from './helpers.ts';
import * as db from '../src/storage/db.ts';
import { runCycle } from '../src/core/runner.ts';
import { deliverAt, nextAllowed, withDefaults, WATCH_LIMIT } from '../src/core/audience.ts';
import { signInitData } from '../src/webapp/auth.ts';
import { handleAppApi } from '../src/webapp/api.ts';
import { warsawHour } from '../src/utils/time.ts';
import { handleIngest } from '../src/ingest.ts';

const NOW = Date.parse('2026-11-04T12:00:00Z') / 1000; // 13:00 по Варшаве
const ALICE = 5001, BOB = 5002, CARL = 5003;

function routes(sent: { method: string; body: Record<string, unknown> }[], blocked = new Set<number>()) {
  const tg = telegramRoute(sent);
  return mockFetch([
    { match: (u) => u.startsWith('https://api.telegram.org/'), respond: (u, init) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { chat_id?: number };
      if (body.chat_id && blocked.has(body.chat_id)) return json({ ok: false, description: 'Forbidden: bot was blocked by the user' }, 403);
      return tg.respond(u, init);
    } },
    { match: (u) => u.startsWith('https://bank.gov.ua/'), respond: () => json(fixtureJson('nbu.json')) },
    { match: (u) => u.includes('/market/priceoverview/'), respond: () => json(fixtureJson('steam_priceoverview_uah.json')) },
    { match: (u) => u.includes('api.skinport.com/v1/items'), respond: () => new Response(fixture('skinport_items.json')) },
    { match: (u) => u.includes('api.skinport.com/v1/sales/history'), respond: () => json(fixtureJson('skinport_sales.json')) },
  ]);
}

test('рассылка: сделку получают все, кто следит за предметом, — каждый по своим настройкам', async () => {
  const d = migratedDb();
  const D = d as unknown as D1Database;
  const env = testEnv(d);
  const it = await db.upsertItem(D, 'AK-47 | Redline (Field-Tested)', NOW);
  for (const u of [ADMIN, ALICE, BOB, CARL]) await db.addWatch(D, u, it.id, NOW);
  await db.setSetting(D, BOB, 'notify_enabled', '0', NOW);              // Боб выключил уведомления
  await db.setSetting(D, CARL, 'min_profit_kop', '99999900', NOW);     // Карлу нужна прибыль от 999 999 грн
  const sent: { method: string; body: Record<string, unknown> }[] = [];
  const { fetcher } = routes(sent);
  for (let i = 0; i < 4; i++) await runCycle(env, { now: NOW + i * 60, fetcher });
  const got = sent.filter((s) => s.method === 'sendMessage' && String(s.body.text).includes('НАЙДЕНА ВОЗМОЖНОСТЬ')).map((s) => s.body.chat_id);
  assert.deepEqual([...got].sort(), [ADMIN, ALICE].sort(), 'админ и Алиса — да; Боб (выключил) и Карл (порог) — нет');
  // Повторные запуски не дублируют.
  for (let i = 4; i < 8; i++) await runCycle(env, { now: NOW + i * 60, fetcher });
  assert.equal(sent.filter((s) => s.method === 'sendMessage' && String(s.body.text).includes('НАЙДЕНА ВОЗМОЖНОСТЬ')).length, 2);
});

test('тихие часы: уведомление ждёт утра, а не теряется; лимит в час — у каждого свой', () => {
  const night = Date.parse('2026-11-04T23:30:00Z') / 1000; // 00:30 по Варшаве
  const s = withDefaults([]);                                   // тихие часы по умолчанию 23–8
  const at = deliverAt(s, { kind: 'arbitrage', ref: '1', signalId: 1, priority: 'high', spreadKop: 5000, roiBp: 2000, buyKop: 1000, text: 't', keyboard: [] }, night)!;
  assert.equal(warsawHour(at), 8, 'отправится в 8:00');
  assert.ok(at > night);
  assert.equal(nextAllowed(NOW, 23, 8), NOW, 'днём — сразу');
  assert.equal(deliverAt(s, { kind: 'arbitrage', ref: '1', signalId: 1, priority: 'low', spreadKop: 5000, roiBp: 2000, buyKop: 1000, text: 't', keyboard: [] }, NOW), null, 'низкий приоритет — по умолчанию не шлём');
});

test('заблокировал бота → больше не пишем ему, остальным — пишем', async () => {
  const d = migratedDb();
  const D = d as unknown as D1Database;
  const env = testEnv(d);
  const it = await db.upsertItem(D, 'AK-47 | Redline (Field-Tested)', NOW);
  for (const u of [ALICE, BOB]) await db.addWatch(D, u, it.id, NOW);
  const sent: { method: string; body: Record<string, unknown> }[] = [];
  const { fetcher } = routes(sent, new Set([BOB]));
  for (let i = 0; i < 4; i++) await runCycle(env, { now: NOW + i * 60, fetcher });
  assert.ok(sent.some((s) => s.method === 'sendMessage' && s.body.chat_id === ALICE));
  assert.equal((await db.getSettings(D, BOB)).notify_enabled, '0');
});

async function api(env: ReturnType<typeof testEnv>, uid: number, path: string, method = 'GET', body?: unknown) {
  const init = await signInitData({ auth_date: String(NOW), query_id: 'Q', user: JSON.stringify({ id: uid }) }, 'TEST_TOKEN');
  const r = await handleAppApi(new Request('https://w/app/api/' + path, { method, headers: { 'X-Init-Data': init }, body: body ? JSON.stringify(body) : undefined }), env, NOW);
  return { status: r.status, body: await r.json() as Record<string, any> };
}

test(`лимит ${WATCH_LIMIT} предметов на человека; у владельца без лимита; списки не смешиваются`, async () => {
  const d = migratedDb();
  const env = testEnv(d);
  const names = (n: number, p: string) => Array.from({ length: n }, (_, i) => `${p} ${i} Case`);
  assert.equal((await api(env, ALICE, 'watch', 'POST', { names: names(WATCH_LIMIT, 'A') })).status, 200);
  const over = await api(env, ALICE, 'watch', 'POST', { name: 'One More Case' });
  assert.equal(over.status, 400);
  assert.match(over.body.error, /Лимит/);
  assert.equal((await api(env, BOB, 'watch', 'POST', { names: names(WATCH_LIMIT + 1, 'B') })).status, 400, 'сразу больше лимита — нельзя');
  assert.equal((await api(env, ADMIN, 'watch', 'POST', { names: names(45, 'X') })).status, 200, 'владельцу — можно');
  const a = await api(env, ALICE, 'watch');
  assert.equal(a.body.items.length, WATCH_LIMIT);
  assert.equal(a.body.limit, WATCH_LIMIT);
  assert.ok(a.body.items.every((x: { name: string }) => x.name.startsWith('A ')), 'Алиса видит только свой список');
  assert.equal((await api(env, ADMIN, 'watch')).body.limit, null);
});

test('скрытая сделка скрыта только у того, кто её скрыл; сделки — только по своему списку', async () => {
  const d = migratedDb();
  const D = d as unknown as D1Database;
  const env = testEnv(d);
  const it = await db.upsertItem(D, 'Revolution Case', NOW);
  const other = await db.upsertItem(D, 'Kilowatt Case', NOW);
  for (const u of [ALICE, BOB]) await db.addWatch(D, u, it.id, NOW);
  const sig = (item: number, k: string) => db.upsertSignal(D, { dedupKey: k, kind: 'arbitrage_steam', itemId: item, state: 'confirmed', priority: 'high', category: 'verified_spread',
    buySource: 'skinport', sellSource: 'steam', buyKop: 1000, sellKop: 6000, proceedsKop: 5200, spreadKop: 4200, roiBp: 42000, reason: '', snapshot: {}, now: NOW });
  const s1 = await sig(it.id, 'a');
  await sig(other.id, 'b');
  assert.deepEqual((await api(env, ALICE, 'deals')).body.deals.map((x: { name: string }) => x.name), ['Revolution Case'], 'Kilowatt не в её списке');
  await api(env, ALICE, `deals/${s1.id}/hide`, 'POST');
  assert.equal((await api(env, ALICE, 'deals')).body.deals.length, 0);
  assert.equal((await api(env, BOB, 'deals')).body.deals.length, 1, 'у Боба сделка осталась');
});

test('автозапуск сборщика: Worker раз в 10 минут запускает GitHub workflow, если данные не приходят', async () => {
  const d = migratedDb();
  const env = testEnv(d, { COLLECTOR: 'github', GH_DISPATCH_TOKEN: 'ghp_test', GH_REPO: 'blauwi00/cs2_search' });
  const calls: { url: string; body: string; auth: string }[] = [];
  const sent: { method: string; body: Record<string, unknown> }[] = [];
  const { fetcher } = mockFetch([
    telegramRoute(sent),
    { match: (u) => u.startsWith('https://bank.gov.ua/'), respond: () => json(fixtureJson('nbu.json')) },
    { match: (u) => u.startsWith('https://api.github.com/'), respond: (u, init) => {
      calls.push({ url: u, body: String(init?.body), auth: String((init?.headers as Record<string, string>).Authorization) });
      return new Response(null, { status: 204 });
    } },
  ]);
  await runCycle(env, { now: NOW, fetcher });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.github.com/repos/blauwi00/cs2_search/actions/workflows/collect.yml/dispatches');
  assert.equal(calls[0].auth, 'Bearer ghp_test');
  assert.deepEqual(JSON.parse(calls[0].body), { ref: 'main' });
  await runCycle(env, { now: NOW + 60, fetcher });
  assert.equal(calls.length, 1, 'не чаще раза в 10 минут');
  // Сборщик только что прислал данные — не дёргаем.
  d.db.prepare(`INSERT INTO source_status (source, status, last_ok_at) VALUES ('collector', 'ok', ?) ON CONFLICT(source) DO UPDATE SET last_ok_at = excluded.last_ok_at`).run(NOW + 600);
  await runCycle(env, { now: NOW + 660, fetcher });
  assert.equal(calls.length, 1);
  // Без токена — ничего не делает.
  const env2 = testEnv(migratedDb(), { COLLECTOR: 'github' });
  const before = calls.length;
  await runCycle(env2, { now: NOW, fetcher });
  assert.equal(calls.length, before);
});

test('прайс Steam (CSGO Trader): сохраняется для предметов наблюдения, подсказка без своей истории — по нему', async () => {
  const d = migratedDb();
  const D = d as unknown as D1Database;
  const env = testEnv(d, { INGEST_SECRET: 'ingest_secret_test_123' });
  await db.storeFx(D, [{ base: 'USD', rateMicro: 40_000_000, rateDate: '2026-11-04', source: 'nbu' }], NOW);
  await api(env, ALICE, 'watch', 'POST', { names: ['Revolution Case', 'Kilowatt Case'] });
  const hdr = { 'X-Ingest-Secret': 'ingest_secret_test_123' };
  const items = await (await handleIngest(new Request('https://w/ingest/items', { headers: hdr }), env, NOW)).json() as { needSteamAvg: string[] };
  assert.deepEqual([...items.needSteamAvg].sort(), ['Kilowatt Case', 'Revolution Case']);
  const r = await handleIngest(new Request('https://w/ingest', { method: 'POST', headers: hdr, body: JSON.stringify({ kind: 'steam_avg', fetchedAt: NOW, items: [
    { name: 'Revolution Case', d1: 0.34, d7: 0.38, d30: 0.40, d90: 0.43 },  // продажи за сутки на 15% ниже месяца
    { name: 'Kilowatt Case', d1: null, d7: null, d30: null, d90: null },   // нет в прайсе — пустая запись, чтобы не спрашивать снова
    { name: 'Not Watched', d1: 1, d7: 1, d30: 1, d90: 1 },
  ] }) }), env, NOW);
  assert.equal(((await r.json()) as { stored: number }).stored, 2);
  const again = await (await handleIngest(new Request('https://w/ingest/items', { headers: hdr }), env, NOW + 60)).json() as { needSteamAvg: string[] };
  assert.deepEqual(again.needSteamAvg, [], 'до завтра не спрашиваем');
  const w = await api(env, ALICE, 'watch');
  const rev = w.body.items.find((x: { name: string }) => x.name === 'Revolution Case');
  assert.equal(rev.advice.action, 'buy');
  assert.match(rev.advice.reason, /в Steam \(продажи за сутки\) ниже средней цены продаж в Steam за месяц на 15%/);
  assert.equal(w.body.items.find((x: { name: string }) => x.name === 'Kilowatt Case').advice.action, 'nodata');
  const item = await api(env, ALICE, `item/${rev.itemId}`);
  assert.equal(item.body.steamAvg.d30, 1600, '0,40 $ × 40 = 16,00 грн');
});
