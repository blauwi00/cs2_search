// Рубрики канала: «Где дешевле», «Совет», «Опрос» с итогом по фактической цене.
import test from 'node:test';
import assert from 'node:assert/strict';
import { migratedDb, testEnv, mockFetch, json, fixtureJson } from './helpers.ts';
import * as db from '../src/storage/db.ts';
import { runCycle } from '../src/core/runner.ts';
import { setMetaStmt, dueSlot } from '../src/core/channel.ts';
import { rubricFor, cheapestPost, tipPost, TIPS, pickPollCase, pollResultText, POLL_OPTIONS } from '../src/core/rubrics.ts';
import type { ScanEntry } from '../src/core/recs.ts';

const EUR = { base: 'EUR' as const, rateMicro: 45_000_000, rateDate: '2026-11-04', source: 'nbu' };
const USD = { base: 'USD' as const, rateMicro: 40_000_000, rateDate: '2026-11-04', source: 'nbu' };
const fx = new Map([['EUR', EUR], ['USD', USD]]) as Map<any, any>;
const WED13 = Date.parse('2026-11-04T12:05:00Z') / 1000; // среда 13:05 по Варшаве
const SAT13 = Date.parse('2026-11-07T12:05:00Z') / 1000;
const MON13 = Date.parse('2026-11-02T12:05:00Z') / 1000;

const entry = (name: string, vol: number, offers: [string, number][], steamKop: number | null): ScanEntry => ({
  name, offers: offers.map(([m, c]) => ({ m: m as any, cur: 'USD', minor: c, qty: 5 })), s7: { median: null, volume: vol }, s30: null,
  steam: steamKop ? { lowestKop: steamKop, medianKop: null, volume24h: 100, at: 0 } : null,
});

test('рубрика по дню недели; слот 13:00 в расписании', () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6].map(rubricFor), ['tip', 'cheapest', 'tip', 'poll', 'cheapest', 'tip', 'poll']);
  assert.equal(dueSlot(WED13, {}), 'rubric');
});

test('«Где дешевле»: только предметы с ≥3 площадками и ценой Steam, самый продаваемый, без повторов; цены по возрастанию', () => {
  const es = [
    entry('AK-47 | Redline (Field-Tested)', 900, [['skinport', 1000], ['csgomarket', 950], ['waxpeer', 1100]], 60_000),
    entry('Мало площадок', 5000, [['skinport', 1000], ['csgomarket', 950]], 60_000),
    entry('Без Steam', 5000, [['skinport', 1000], ['csgomarket', 950], ['waxpeer', 900]], null),
    entry('AWP | Asiimov (Field-Tested)', 100, [['skinport', 5000], ['csgomarket', 5200], ['lisskins', 4900]], 250_000),
  ];
  const p = cheapestPost(es, fx, [], MON13)!;
  assert.equal(p.name, 'AK-47 | Redline (Field-Tested)');
  const order = [...p.text.matchAll(/^(?:🟢|▫️|🔴) (\S+)/gm)].map((m) => m[1]);
  assert.deepEqual(order, ['Market.CSGO', 'Skinport', 'Waxpeer', 'Steam']);
  assert.match(p.text, /🟢 Market\.CSGO — <b>⟦38000⟧<\/b>/);
  assert.match(p.text, /🔴 Steam — <b>⟦60000⟧<\/b> \(баланс Steam\)/);
  assert.match(p.text, /баланс Steam — нет/);
  assert.equal(cheapestPost(es, fx, ['AK-47 | Redline (Field-Tested)'], MON13)!.name, 'AWP | Asiimov (Field-Tested)', 'без повторов');
  // Самая низкая цена — у Waxpeer → предупреждение
  const w = cheapestPost([entry('M4A4 | Desolate Space (Field-Tested)', 1, [['skinport', 1000], ['csgomarket', 950], ['waxpeer', 800]], 60_000)], fx, [], MON13)!;
  assert.match(w.text, /Waxpeer низкая оценка/);
  assert.equal(cheapestPost([es[1], es[2]], fx, [], MON13), null, 'нет подходящих — null, без выдумок');
});

test('«Совет»: идут по кругу, без денежных маркеров и устаревающих цифр цен', () => {
  assert.ok(TIPS.length >= 12);
  assert.match(tipPost(0, MON13), /Совет[\s\S]*115 ₴/);
  assert.equal(tipPost(TIPS.length, MON13), tipPost(0, MON13));
  for (const t of TIPS) assert.doesNotMatch(t.text, /⟦/);
});

test('опрос: кейс с продажами, по очереди; итог по фактической цене и голосам', () => {
  const cases = [{ name: 'A Case', d1: 300, d7: 290, d30: 280 }, { name: 'B Case', d1: 100, d7: 90, d30: 80 }, { name: 'C Case', d1: 5, d7: 5, d30: 5 }, { name: 'D Case', d1: 200, d7: null, d30: 100 }];
  assert.equal(pickPollCase(cases, [])!.name, 'A Case');
  assert.equal(pickPollCase(cases, ['A Case'])!.name, 'B Case');
  assert.equal(pickPollCase(cases, ['A Case', 'B Case']), null, 'копеечные и без истории не берём');
  const up = pollResultText({ name: 'A Case', d1: 300, at: 0 }, 330, fx, [6, 3, 1], SAT13);
  assert.match(up, /было ⟦12000⟧ → стало <b>⟦13200⟧<\/b> \(\+10%\)/);
  assert.match(up, new RegExp(`Правильный ответ: <b>${POLL_OPTIONS[0]}`));
  assert.match(up, /Угадали 60% из 10/);
  assert.match(pollResultText({ name: 'A Case', d1: 300, at: 0 }, 305, fx, null, SAT13), new RegExp(POLL_OPTIONS[2].replace(/[()±]/g, '.')));
});

test('канал: среда 13:00 — опрос; суббота — итог прошлого (закрываем опрос, считаем голоса) и новый опрос; понедельник без сканирования — совет', async () => {
  const d = migratedDb();
  const D = d as unknown as D1Database;
  const env = testEnv(d);
  await db.storeFx(D, [EUR, USD], WED13 - 3600);
  const cases = (a: number) => JSON.stringify([{ name: 'Kilowatt Case', d1: a, d7: 300, d30: 290 }, { name: 'Revolution Case', d1: 250, d7: 240, d30: 230 }]);
  await D.batch([setMetaStmt(D, 'channel_id', '-1001234'), setMetaStmt(D, 'bot_username', 'cenolow_bot'), setMetaStmt(D, 'cases_stats', cases(300))]);
  for (const s of ['ideas', 'trends', 'cases', 'weekly']) await setMetaStmt(D, `channel_done_${s}`, '2099-01-01').run();
  const sent: { method: string; body: Record<string, any> }[] = [];
  let id = 100;
  const { fetcher } = mockFetch([
    { match: (u) => u.startsWith('https://api.telegram.org/'), respond: (u, init) => {
      const method = u.split('/').pop()!;
      sent.push({ method, body: JSON.parse(String(init?.body)) });
      if (method === 'stopPoll') return json({ ok: true, result: { options: [{ text: 'a', voter_count: 1 }, { text: 'b', voter_count: 1 }, { text: 'c', voter_count: 2 }] } });
      return json({ ok: true, result: { message_id: id++ } });
    } },
    { match: (u) => u.startsWith('https://bank.gov.ua/'), respond: () => json(fixtureJson('nbu.json')) },
  ]);
  const cycle = async (t: number) => { await d.db.exec(`UPDATE scheduler_jobs SET next_run_at = 0 WHERE name = 'channel'`); await runCycle(env, { now: t, fetcher }); };
  await runCycle(env, { now: WED13 - 7200, fetcher });
  await cycle(WED13);
  const p1 = sent.filter((s) => s.method === 'sendPoll');
  assert.equal(p1.length, 1);
  assert.equal(p1[0].body.chat_id, -1001234);
  assert.match(p1[0].body.question, /^🗳 Kilowatt Case сейчас ≈ [\d,]+ \$ в Steam/, 'цена в долларах для канала');
  assert.equal(p1[0].body.is_anonymous, true);
  assert.equal(p1[0].body.options.length, 3);
  await cycle(WED13 + 600);
  assert.equal(sent.filter((s) => s.method === 'sendPoll').length, 1, 'один раз в день');
  // Суббота: цена выросла на 10%
  await setMetaStmt(D, 'cases_stats', cases(330)).run();
  await cycle(SAT13);
  const stop = sent.find((s) => s.method === 'stopPoll')!;
  assert.ok(stop && stop.body.message_id >= 100, 'закрыт прошлый опрос');
  const res = sent.find((s) => s.method === 'sendMessage' && /Итог опроса/.test(s.body.text))!;
  assert.match(res.body.text, /Kilowatt Case[\s\S]*\+10%[\s\S]*Подорожает[\s\S]*Угадали 25% из 4/);
  const p2 = sent.filter((s) => s.method === 'sendPoll');
  assert.equal(p2.length, 2);
  assert.match(p2[1].body.question, /Revolution Case/, 'другой кейс');
  // Понедельник, сканирования нет — выходит совет
  await cycle(MON13 + 7 * 86400);
  const tip = sent.find((s) => s.method === 'sendMessage' && /Совет/.test(s.body.text));
  assert.ok(tip, 'совет вместо «Где дешевле»');
});
