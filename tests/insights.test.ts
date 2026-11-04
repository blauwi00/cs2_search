// История идей (итог через сутки), итог недели, обновления CS2.
import test from 'node:test';
import assert from 'node:assert/strict';
import { migratedDb, testEnv, mockFetch, json, fixtureJson, ADMIN } from './helpers.ts';
import { handleIngest } from '../src/ingest.ts';
import { runCycle } from '../src/core/runner.ts';
import { composePost, dueSlot, setMetaStmt } from '../src/core/channel.ts';
import { cleanSnippet, weeklyPost, yesterdayLine, type IdeaRow } from '../src/core/insights.ts';
import * as db from '../src/storage/db.ts';

const DAY1 = Date.parse('2026-11-04T09:30:00Z') / 1000; // ср 10:30 Варшава
const DAY2 = DAY1 + 86400;
const SECRET = 'ingest_secret_test_123';
const EUR = { base: 'EUR' as const, rateMicro: 45_000_000, rateDate: '2026-11-04', source: 'nbu' };
const USD = { base: 'USD' as const, rateMicro: 40_000_000, rateDate: '2026-11-04', source: 'nbu' };
const hdr = { 'X-Ingest-Secret': SECRET };
const ingest = (env: ReturnType<typeof testEnv>, body: object, now: number) =>
  handleIngest(new Request('https://w/ingest', { method: 'POST', headers: hdr, body: JSON.stringify({ fetchedAt: now, ...body }) }), env, now);
const scanItem = (median: number) => ({ name: 'Revolution Case', offers: { skinport: { p: 10, q: 50 } }, s7: { median, volume: 300 }, s30: { median: 12.5, volume: 1200 } });

test('история идей: записываются один раз за день, через сутки проверяются по свежим ценам, итог — в посте', async () => {
  const d = migratedDb();
  const D = d as unknown as D1Database;
  const env = testEnv(d, { INGEST_SECRET: SECRET });
  await db.storeFx(D, [EUR, USD], DAY1);
  await ingest(env, { kind: 'scan', items: [scanItem(13)] }, DAY1);
  const p1 = (await composePost(D, 'ideas', DAY1))!;
  assert.match(p1, /Идеи дня · 04\.11/);
  assert.match(p1, /Завтра здесь будет честный итог/);
  assert.ok(!/Вчерашние идеи/.test(p1));
  await composePost(D, 'ideas', DAY1 + 600);
  assert.equal((d.db.prepare('SELECT COUNT(*) AS n FROM idea_log').get() as { n: number }).n, 1, 'одна запись на идею, без повторов');
  // Сборщик обязан включить идею в сканирование для проверки.
  const items = await (await handleIngest(new Request('https://w/ingest/items', { headers: hdr }), env, DAY2 - 3600)).json() as { trackNames: string[] };
  assert.deepEqual(items.trackNames, ['Revolution Case']);
  // Через сутки цена продаж упала: 13 € → 10,5 € — продать с прибылью уже нельзя.
  await ingest(env, { kind: 'scan', items: [scanItem(10.5)] }, DAY2);
  const r = d.db.prepare('SELECT outcome, profit_kop, profit_kop_24 FROM idea_log').get() as { outcome: string; profit_kop: number; profit_kop_24: number };
  assert.equal(r.outcome, 'minus');
  assert.equal(r.profit_kop_24, Math.floor(1050 * 0.92) * 45 - 45000);
  const p2 = (await composePost(D, 'ideas', DAY2))!;
  assert.match(p2, /Вчерашние идеи через сутки:<\/b> 0 из 1 всё ещё в плюсе/);
});

test('итог недели: индекс кейсов, лидеры, идеи; без данных — пусто', () => {
  const cases = ['A', 'B', 'C', 'D', 'E'].map((x, i) => ({ name: `${x} Case`, d1: 100, d7: 100 + i * 10 - 20, d30: 100 }));
  const idea = (o: Partial<IdeaRow>): IdeaRow => ({ id: 1, day: '2026-11-01', name: 'Revolution Case', buy_at: 'skinport', sell_at: 'steam', pay_kop: 1000, sell_kop: 1400, get_kop: 1200, profit_kop: 200, roi_bp: 2000, wallet: 'steam_wallet', created_at: 0, checked_at: 1, get_kop_24: 1150, profit_kop_24: 150, outcome: 'plus', ...o });
  const p = weeklyPost(cases, [idea({}), idea({ id: 2, name: 'Kilowatt Case', profit_kop_24: -50, outcome: 'minus' })], { total: 120, week: 15 }, DAY1)!;
  assert.match(p, /Индекс кейсов Steam:<\/b> \+0% — так в среднем изменились 5 кейсов/);
  assert.match(p, /Сильнее всех выросли[\s\S]*E Case — \+20%/);
  assert.match(p, /Сильнее всех упали[\s\S]*A Case — −20%/);
  assert.match(p, /2 проверено, 1 через сутки были в плюсе \(50%\)/);
  assert.match(p, /Ботом пользуются 120 человек, за неделю \+15/);
  assert.equal(weeklyPost([], [], { total: 3, week: 1 }, DAY1), null);
  assert.equal(yesterdayLine([idea({ outcome: 'gone' })]), null, 'нет данных — не выдумываем итог');
});

test('расписание: итог недели — только в воскресенье в 19:00', () => {
  const sun19 = Date.parse('2026-11-08T18:10:00Z') / 1000;
  assert.equal(dueSlot(sun19, { ideas: '2026-11-08', trends: '2026-11-08' }), 'weekly');
  assert.equal(dueSlot(sun19 - 86400, { ideas: '2026-11-07', trends: '2026-11-07' }), null, 'в субботу нет');
});

test('обновления CS2: первые новости только запоминаются, новые публикуются в канал один раз со ссылкой', async () => {
  assert.equal(cleanSnippet('[p]Release notes for 11/3/2026:[/p] {STEAM_CLAN_IMAGE}/a.png <b>MAPS</b> Fixed a bug'), 'Release notes for 11/3/2026: MAPS Fixed a bug');
  const d = migratedDb();
  const D = d as unknown as D1Database;
  const env = testEnv(d, { INGEST_SECRET: SECRET });
  const news = (gid: string, date: number) => ({ gid, title: `Counter-Strike 2 Update ${gid}`, url: `https://store.steampowered.com/news/app/730/view/${gid}`, date, contents: '[p]Fixed things[/p]' });
  await ingest(env, { kind: 'news', items: [news('1', DAY1 - 86400), { ...news('2', DAY1), url: 'https://evil.example/x' }] }, DAY1);
  assert.deepEqual(d.db.prepare('SELECT gid, posted_at IS NOT NULL AS seeded FROM news').all().map((r: any) => [r.gid, r.seeded]), [['1', 1]], 'чужая ссылка отброшена, первое — без публикации');
  await ingest(env, { kind: 'news', items: [news('3', DAY1)] }, DAY1);
  await D.batch([setMetaStmt(D, 'channel_id', '-1001234'), setMetaStmt(D, 'bot_username', 'cenolow_bot')]);
  await db.storeFx(D, [EUR, USD], DAY1);
  const sent: { method: string; body: Record<string, any> }[] = [];
  const { fetcher } = mockFetch([
    { match: (u) => u.startsWith('https://api.telegram.org/'), respond: (u, init) => { sent.push({ method: u.split('/').pop()!, body: JSON.parse(String(init?.body)) }); return json({ ok: true, result: { message_id: 1 } }); } },
    { match: (u) => u.startsWith('https://bank.gov.ua/'), respond: () => json(fixtureJson('nbu.json')) },
  ]);
  await runCycle(env, { now: DAY1, fetcher });
  await runCycle(env, { now: DAY1 + 400, fetcher });
  await runCycle(env, { now: DAY1 + 800, fetcher });
  const posts = sent.filter((s) => s.method === 'sendMessage' && s.body.chat_id === -1001234);
  const newsPosts = posts.filter((p) => /Обновление CS2/.test(p.body.text));
  assert.equal(newsPosts.length, 1, 'новость — один раз');
  assert.match(newsPosts[0].body.text, /Counter-Strike 2 Update 3/);
  assert.equal(newsPosts[0].body.reply_markup.inline_keyboard[0][0].url, 'https://store.steampowered.com/news/app/730/view/3');
  void ADMIN;
});
