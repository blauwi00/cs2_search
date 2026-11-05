import test from 'node:test';
import assert from 'node:assert/strict';
import { migratedDb, testEnv, mockFetch, json, telegramRoute, fixtureJson, ADMIN } from './helpers.ts';
import { handleIngest } from '../src/ingest.ts';
import { runCycle } from '../src/core/runner.ts';
import * as db from '../src/storage/db.ts';

const NOW = Date.parse('2026-11-04T12:00:00Z') / 1000;
type Sent = { method: string; body: Record<string, unknown> };
const SECRET = 'ingest_secret_test_123';

function env(d: ReturnType<typeof migratedDb>) { return testEnv(d, { INGEST_SECRET: SECRET, COLLECTOR: 'github' }); }
const post = (body: unknown, secret = SECRET) => new Request('https://w/ingest', {
  method: 'POST', headers: { 'X-Ingest-Secret': secret, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

async function seed(d: ReturnType<typeof migratedDb>, name: string) {
  const D = d as unknown as D1Database;
  const it = await db.upsertItem(D, name, NOW);
  await db.addWatch(D, ADMIN, it.id, NOW);
  return it;
}

test('ingest: без верного секрета — 403; список предметов отдаётся сборщику', async () => {
  const d = migratedDb();
  const e = env(d);
  await seed(d, 'Revolution Case');
  assert.equal((await handleIngest(post({ kind: 'steam', items: [] }, 'wrong_secret_xxxx'), e, NOW)).status, 403);
  assert.equal((await handleIngest(new Request('https://w/ingest/items'), e, NOW)).status, 403);
  const r = await handleIngest(new Request('https://w/ingest/items', { headers: { 'X-Ingest-Secret': SECRET } }), e, NOW);
  assert.deepEqual((await r.json() as { items: string[] }).items, ['Revolution Case']);
  assert.equal((await handleIngest(post({ kind: 'nope', fetchedAt: NOW }), e, NOW)).status, 400);
  assert.equal((await handleIngest(post({ kind: 'steam', fetchedAt: NOW - 7200, items: [] }), e, NOW)).status, 400, 'старые данные не принимаются');
  const noSecret = testEnv(d, { COLLECTOR: 'github' });
  assert.equal((await handleIngest(post({ kind: 'steam' }), noSecret, NOW)).status, 403, 'без INGEST_SECRET приём закрыт');
});

test('ingest: ответы Steam проверяются теми же разборщиками; чужие предметы и ошибки не пишутся', async () => {
  const d = migratedDb();
  const e = env(d);
  const it = await seed(d, 'Revolution Case');
  const r = await handleIngest(post({ kind: 'steam', fetchedAt: NOW, items: [
    { name: 'Revolution Case', ok: true, body: { success: true, lowest_price: '10₴', median_price: '9,20₴', volume: '66,133' } },
    { name: 'Not Watched', ok: true, body: { success: true, lowest_price: '1₴' } },
    { name: 'Revolution Case', ok: false, status: 429 },
  ] }), e, NOW);
  const res = await r.json() as { stored: number; unknown: number; errors: number };
  assert.equal(res.stored, 2);
  assert.equal(res.unknown, 1);
  assert.equal(res.errors, 1);
  const q = await db.getQuotes(d as unknown as D1Database, it.id);
  assert.equal(q.find((x) => x.price_type === 'lowest_listing')!.price_kop, 1000);
  assert.equal(q.find((x) => x.price_type === 'median_24h')!.volume, 66133);
  const flag = d.db.prepare('SELECT needs_eval FROM items WHERE id = ?').get(it.id) as { needs_eval: number };
  assert.equal(flag.needs_eval, 2, 'цена Steam изменилась → проверить события Steam');
  const st = (await db.listSourceStatus(d as unknown as D1Database)).find((s) => s.source === 'collector');
  assert.equal(st?.status, 'ok');
});

test('режим сборщика: Worker не ходит в Steam/Skinport сам; сигнал приходит после данных сборщика', async () => {
  const d = migratedDb();
  const e = env(d);
  await seed(d, 'AK-47 | Redline (Field-Tested)');
  const sent: Sent[] = [];
  const { fetcher, calls } = mockFetch([
    telegramRoute(sent),
    { match: (u) => u.startsWith('https://bank.gov.ua/'), respond: () => json(fixtureJson('nbu.json')) },
  ]);
  await runCycle(e, { now: NOW, fetcher });
  assert.ok(!calls.some((c) => /steamcommunity|skinport/.test(c.url)), 'сам Worker к площадкам не обращается');

  await handleIngest(post({ kind: 'skinport_items', fetchedAt: NOW, items: (fixtureJson('skinport_items.json') as unknown[]) }), e, NOW);
  await handleIngest(post({ kind: 'steam', fetchedAt: NOW, items: [{ name: 'AK-47 | Redline (Field-Tested)', ok: true, body: fixtureJson('steam_priceoverview_uah.json') }] }), e, NOW);
  await runCycle(e, { now: NOW + 60, fetcher });
  const arb = sent.filter((s) => s.method === 'sendMessage' && String(s.body.text).includes('НАЙДЕНА ВОЗМОЖНОСТЬ'));
  assert.equal(arb.length, 1);
  assert.ok(String(arb[0].body.text).includes('382,50 ₴'), '8,50 EUR × 45 (тестовый курс) = 382,50 грн');
});

test('сборщик молчит дольше 45 минут — одно техническое предупреждение', async () => {
  const d = migratedDb();
  const e = env(d);
  await seed(d, 'Revolution Case');
  await handleIngest(post({ kind: 'steam', fetchedAt: NOW, items: [{ name: 'Revolution Case', ok: true, body: { success: true, lowest_price: '10₴' } }] }), e, NOW);
  const sent: Sent[] = [];
  const { fetcher } = mockFetch([telegramRoute(sent), { match: (u) => u.startsWith('https://bank.gov.ua/'), respond: () => json(fixtureJson('nbu.json')) }]);
  await d.db.exec(`INSERT OR IGNORE INTO scheduler_jobs (name, interval_sec, next_run_at) VALUES ('health', 300, 0)`);
  await runCycle(e, { now: NOW + 3600, fetcher, force: ['health'] });
  await runCycle(e, { now: NOW + 4000, fetcher, force: ['health'] });
  assert.equal(sent.filter((s) => String(s.body.text ?? '').includes('Сборщик цен')).length, 1);
});

test('картинки всего каталога: пачкой до 1000, курсор прохода сохраняется', async () => {
  const { migratedDb, testEnv } = await import('./helpers.ts');
  const { handleIngest } = await import('../src/ingest.ts');
  const d = migratedDb(); const env = testEnv(d, { INGEST_SECRET: 'ingest_secret_test_123' });
  const T = 1_793_000_000;
  const post = (body: object) => handleIngest(new Request('https://w.dev/ingest', { method: 'POST', headers: { 'X-Ingest-Secret': 'ingest_secret_test_123' }, body: JSON.stringify(body) }), env, T);
  const items = [{ name: '★ Karambit | Doppler (Factory New)', url: 'https://community.akamai.steamstatic.com/economy/image/abc' }, { name: 'Bad', url: 'https://evil.example/x.png' }];
  const r = await (await post({ kind: 'images', fetchedAt: T, cursor: 1000, items })).json() as { stored: number };
  assert.equal(r.stored, 1);
  const g = await (await handleIngest(new Request('https://w.dev/ingest/items', { headers: { 'X-Ingest-Secret': 'ingest_secret_test_123' } }), env, T)).json() as { imgCursor: number };
  assert.equal(g.imgCursor, 1000);
  await post({ kind: 'images', fetchedAt: T, cursor: -1, items: [] });
  const g2 = await (await handleIngest(new Request('https://w.dev/ingest/items', { headers: { 'X-Ingest-Secret': 'ingest_secret_test_123' } }), env, T + 8 * 86400)).json() as { imgCursor: number };
  assert.equal(g2.imgCursor, 0, 'через неделю — новый проход');
});

test('бережём Steam: после 429 — пауза, растущая при повторах; спокойный запуск — сброс', async () => {
  const { migratedDb, testEnv } = await import('./helpers.ts');
  const { handleIngest } = await import('../src/ingest.ts');
  const d = migratedDb(); const env = testEnv(d, { INGEST_SECRET: 'ingest_secret_test_123' });
  const T = 1_793_000_000;
  const post = (limited: boolean, at: number) => handleIngest(new Request('https://w.dev/ingest', { method: 'POST', headers: { 'X-Ingest-Secret': 'ingest_secret_test_123' }, body: JSON.stringify({ kind: 'steam_limit', fetchedAt: at, limited, requests: 5 }) }), env, at);
  const pause = async (at: number) => ((await (await handleIngest(new Request('https://w.dev/ingest/items', { headers: { 'X-Ingest-Secret': 'ingest_secret_test_123' } }), env, at)).json()) as any).steamPauseUntil;
  await post(true, T); assert.equal(await pause(T), T + 30 * 60);
  await post(true, T + 1800); assert.equal(await pause(T + 1800), T + 1800 + 60 * 60);
  await post(false, T + 7200); assert.equal(await pause(T + 7200), 0);
});
