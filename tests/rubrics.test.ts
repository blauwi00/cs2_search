// Рубрики канала: «Окупается ли кейс», «Что отслеживают в Ценолове», «Истории CS2».
import test from 'node:test';
import assert from 'node:assert/strict';
import { migratedDb, testEnv, mockFetch, json, fixtureJson } from './helpers.ts';
import * as db from '../src/storage/db.ts';
import { runCycle } from '../src/core/runner.ts';
import { handleIngest } from '../src/ingest.ts';
import { setMetaStmt, dueSlot, composeChannelPost } from '../src/core/channel.ts';
import { rubricFor, caseEvPost, oneIn, trackedPost, storyPost, STORIES, pickCaseEV, type CaseEV } from '../src/core/rubrics.ts';
// @ts-expect-error — модуль сборщика на JS
import { computeCaseEV, wearOdds, variants, TIER_ODDS } from '../.github/scripts/caseev.mjs';

const USD = { base: 'USD' as const, rateMicro: 40_000_000, rateDate: '2026-11-04', source: 'nbu' };
const EUR = { base: 'EUR' as const, rateMicro: 45_000_000, rateDate: '2026-11-04', source: 'nbu' };
const fx = new Map([['USD', USD]]) as Map<any, any>;
const MON13 = Date.parse('2026-11-02T12:05:00Z') / 1000; // понедельник 13:05 по Варшаве
const SECRET = 'ingest_secret_test_123';

test('рубрика по дню недели; слот 13:00 в расписании', () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6].map(rubricFor), ['story', 'caseev', 'story', 'story', 'caseev', 'story', 'tracked']);
  assert.equal(dueSlot(MON13, {}), 'rubric');
});

test('сборщик: износ по диапазону float, StatTrak™, ножи и перчатки', () => {
  const w = Object.fromEntries(wearOdds(0.1, 0.7));
  assert.equal(w['Factory New'], undefined, 'у Redline нет Factory New');
  assert.ok(Math.abs(Object.values(w).reduce((s: number, x) => s + (x as number), 0) - 1) < 1e-9);
  assert.deepEqual(variants('★ Kukri Knife', { stattrak: true }), [['★ Kukri Knife', 0.9], ['★ StatTrak™ Kukri Knife', 0.1]]);
  assert.ok(variants('★ Sport Gloves | Vice', { stattrak: false, min_float: 0.06, max_float: 0.8 }).every(([n]: [string]) => !n.includes('StatTrak')));
  assert.ok(variants('AK-47 | Redline', { stattrak: true, min_float: 0.1, max_float: 0.7 }).some(([n]: [string]) => n === 'StatTrak™ AK-47 | Redline (Field-Tested)'));
  assert.ok(Math.abs(Object.values(TIER_ODDS).reduce((s: number, x) => s + (x as number), 0) - 1) < 1e-9, 'шансы Valve в сумме 100%');
});

test('сборщик: средняя отдача кейса считается по шансам и ценам; без цен — кейс пропускается', () => {
  const crates = [{
    type: 'Case', name: 'Test Case', market_hash_name: 'Test Case', image: 'https://community.akamai.steamstatic.com/economy/image/x',
    contains: [
      { name: 'P250 | Blue', rarity: { name: 'Mil-Spec Grade' } }, { name: 'MP9 | Red', rarity: { name: 'Restricted' } },
      { name: 'AK-47 | Gold', rarity: { name: 'Classified' } }, { name: 'AWP | Star', rarity: { name: 'Covert' } },
    ],
    contains_rare: [{ name: '★ Karambit | Doppler', phase: 'Ruby' }, { name: '★ Karambit | Doppler', phase: 'Phase 1' }],
  }, { type: 'Case', name: 'No Prices Case', contains: [{ name: 'X | Y', rarity: { name: 'Covert' } }], contains_rare: [{ name: '★ Z' }] }];
  const skins = ['P250 | Blue', 'MP9 | Red', 'AK-47 | Gold', 'AWP | Star', '★ Karambit | Doppler'].map((name) => ({ name, stattrak: true, min_float: 0, max_float: 0.07 }));
  const price: Record<string, number> = { 'Test Case': 100, 'No Prices Case': 100 };
  const set = (n: string, v: number) => { price[`${n} (Factory New)`] = v; price[n.startsWith('★') ? `${n.replace('★ ', '★ StatTrak™ ')} (Factory New)` : `StatTrak™ ${n} (Factory New)`] = v; };
  set('P250 | Blue', 10); set('MP9 | Red', 100); set('AK-47 | Gold', 1000); set('AWP | Star', 10000); set('★ Karambit | Doppler', 100000);
  const [ev, ...rest] = computeCaseEV(crates, skins, (n: string) => price[n] ?? null);
  assert.equal(rest.length, 0, 'кейс без цен пропущен');
  const exp = 0.7992 * 10 + 0.1598 * 100 + 0.032 * 1000 + 0.0064 * 10000 + 0.0026 * 100000;
  assert.equal(ev.evCents, Math.round(exp));
  assert.equal(ev.evNetCents, Math.floor(Math.round(exp) / 1.15));
  assert.equal(ev.caseCents + ev.keyCents, 349);
  // дороже открытия (349 ц.) после комиссии: AK (1000→869), AWP, нож → 3,2% + 0,64% + 0,26%
  assert.ok(Math.abs(ev.pWin - 0.041) < 1e-9);
  assert.equal(ev.best.name, '★ Karambit | Doppler (Factory New)');
  assert.ok(Math.abs(ev.best.p - 0.0026 * 0.9) < 1e-12, 'фазы Doppler — один предмет');
});

const evItem: CaseEV = { name: 'Kilowatt Case', img: null, caseCents: 51, keyCents: 249, evCents: 180, evNetCents: 156, pWin: 0.041, best: { name: '★ Kukri Knife | Fade (Factory New)', cents: 50000, p: 0.0000234 } };

test('пост «Окупается ли кейс»: стоимость, отдача в %, шансы «1 из N», честный вывод', () => {
  const t = caseEvPost(evItem, fx, MON13);
  assert.match(t, /Окупается ли кейс/);
  assert.match(t, /Открыть: <b>⟦12000⟧<\/b> \(кейс ⟦2040⟧ \+ ключ ⟦9960⟧\)/);
  assert.match(t, /это <b>52%<\/b> от потраченного/);
  assert.match(t, /примерно <b>1 из 24<\/b>/);
  assert.match(t, /шанс 1 из 42 700/);
  assert.match(t, /🔴 В среднем открытие — минус/);
  assert.match(caseEvPost({ ...evItem, evNetCents: 320 }, fx, MON13), /✅ В среднем окупается/);
  assert.equal(oneIn(0.5), '1 из 2');
  assert.equal(pickCaseEV([evItem, { ...evItem, name: 'B' }], ['Kilowatt Case'])!.name, 'B');
});

test('«Что отслеживают»: только предметы, за которыми следят ≥3 человек, иначе — нет поста', () => {
  assert.equal(trackedPost([{ name: 'A', n: 5 }, { name: 'B', n: 3 }, { name: 'C', n: 2 }], 10, MON13), null);
  const t = trackedPost([{ name: 'A', n: 5 }, { name: 'B', n: 4 }, { name: 'C', n: 3 }, { name: 'D', n: 1 }], 12, MON13)!;
  assert.match(t, /1\. <b>A<\/b> — у 5 чел\.[\s\S]*3\. <b>C<\/b>/);
  assert.doesNotMatch(t, /<b>D<\/b>/);
  assert.match(t, /Всего следят за ценами: 12/);
});

test('«Истории CS2»: по кругу, без денежных сумм', () => {
  assert.ok(STORIES.length >= 12);
  assert.equal(storyPost(STORIES.length, MON13), storyPost(0, MON13));
  for (const s of STORIES) assert.doesNotMatch(s.text, /⟦|\$|₴/);
});

test('канал: в понедельник — «Окупается ли кейс» из данных сборщика; без данных — история; очередь без повторов', async () => {
  const d = migratedDb();
  const D = d as unknown as D1Database;
  const env = testEnv(d, { INGEST_SECRET: SECRET });
  await db.storeFx(D, [EUR, USD], MON13 - 3600);
  const items = await (await handleIngest(new Request('https://w/ingest/items', { headers: { 'X-Ingest-Secret': SECRET } }), env, MON13 - 3600)).json() as { needCaseEv: boolean };
  assert.equal(items.needCaseEv, true);
  // Без данных — история
  const p0 = (await composeChannelPost(D, 'rubric', MON13))!;
  assert.match(p0.text, /Истории CS2/);
  const bad = { ...evItem, name: '<b>x</b>'.repeat(30) };
  const r = await handleIngest(new Request('https://w/ingest', { method: 'POST', headers: { 'X-Ingest-Secret': SECRET }, body: JSON.stringify({ kind: 'case_ev', fetchedAt: MON13 - 3000, items: [evItem, { ...evItem, name: 'Revolution Case' }, bad, { name: 'x' }] }) }), env, MON13 - 3000);
  assert.equal(((await r.json()) as { stored: number }).stored, 2, 'мусор отброшен');
  const again = await (await handleIngest(new Request('https://w/ingest/items', { headers: { 'X-Ingest-Secret': SECRET } }), env, MON13 - 2000)).json() as { needCaseEv: boolean };
  assert.equal(again.needCaseEv, false, 'раз в сутки');
  await D.batch([setMetaStmt(D, 'channel_id', '-1001234'), setMetaStmt(D, 'bot_username', 'cenolow_bot')]);
  for (const s of ['ideas', 'trends', 'cases', 'weekly']) await setMetaStmt(D, `channel_done_${s}`, '2099-01-01').run();
  const sent: { method: string; body: Record<string, any> }[] = [];
  const { fetcher } = mockFetch([
    { match: (u) => u.startsWith('https://api.telegram.org/'), respond: (u, init) => { sent.push({ method: u.split('/').pop()!, body: JSON.parse(String(init?.body)) }); return json({ ok: true, result: { message_id: 1 } }); } },
    { match: (u) => u.startsWith('https://bank.gov.ua/'), respond: () => json(fixtureJson('nbu.json')) },
  ]);
  const cycle = async (t: number) => { await d.db.exec(`UPDATE scheduler_jobs SET next_run_at = 0 WHERE name = 'channel'`); await runCycle(env, { now: t, fetcher }); };
  await runCycle(env, { now: MON13 - 1000, fetcher });
  await cycle(MON13);
  await cycle(MON13 + 600);
  const posts = sent.filter((s) => s.method === 'sendMessage' && s.body.chat_id === -1001234);
  assert.equal(posts.length, 1, 'один раз в день');
  assert.match(posts[0].body.text, /Окупается ли кейс[\s\S]*Kilowatt Case[\s\S]*\$/);
  // Четверг: свежие данные — следующий кейс, без повтора
  const THU = MON13 + 3 * 86400;
  await handleIngest(new Request('https://w/ingest', { method: 'POST', headers: { 'X-Ingest-Secret': SECRET }, body: JSON.stringify({ kind: 'case_ev', fetchedAt: THU - 600, items: [evItem, { ...evItem, name: 'Revolution Case' }] }) }), env, THU - 600);
  await cycle(THU);
  const p2 = sent.filter((s) => s.method === 'sendMessage' && s.body.chat_id === -1001234);
  assert.equal(p2.length, 2);
  assert.match(p2[1].body.text, /Revolution Case/);
  // Следующий понедельник: данные старше 2 суток — история вместо устаревших цифр
  await cycle(MON13 + 7 * 86400);
  const p3 = sent.filter((s) => s.method === 'sendMessage' && s.body.chat_id === -1001234);
  assert.match(p3[2].body.text, /Истории CS2/);
});
