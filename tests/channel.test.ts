// Автопостинг в канал, метки источников и статистика владельца.
import test from 'node:test';
import assert from 'node:assert/strict';
import { migratedDb, testEnv, mockFetch, json, fixtureJson, ADMIN } from './helpers.ts';
import { buildPost, dueSlot } from '../src/core/channel.ts';
import { runCycle } from '../src/core/runner.ts';
import { handleWebhook } from '../src/telegram/webhook.ts';
import { handleIngest } from '../src/ingest.ts';
import * as db from '../src/storage/db.ts';
import type { ScanEntry } from '../src/core/recs.ts';
import { renderMoney, UAH_CUR } from '../src/utils/money.ts';

const AT10 = Date.parse('2026-11-04T09:05:00Z') / 1000; // 10:05 по Варшаве
const EUR = { base: 'EUR' as const, rateMicro: 45_000_000, rateDate: '2026-11-04', source: 'nbu' };
const USD = { base: 'USD' as const, rateMicro: 40_000_000, rateDate: '2026-11-04', source: 'nbu' };
const FX = new Map([['EUR', EUR], ['USD', USD]] as const);
const deal: ScanEntry = { name: 'Revolution Case', offers: [{ m: 'skinport', cur: 'EUR', minor: 1000, qty: 50 }], s7: { median: 1300, volume: 300 }, s30: { median: 1250, volume: 1200 }, steam: null };
const kase = (n: string, d1: number, d30: number): ScanEntry => ({ name: n, offers: [], s7: null, s30: null, steam: null, sa: { d1, d7: d1, d30, d90: d30 } });

test('посты: «Рекомендации дня» с полной цепочкой и дисклеймером; пусто — поста нет', () => {
  const p = renderMoney(buildPost('ideas', [deal], FX, AT10)!, UAH_CUR);
  assert.match(p, /Рекомендации дня<\/b> · 4 ноября/);
  assert.match(p, /Купить: Skinport — <b>450,00 ₴<\/b>\n💰 Продать: Skinport — 585,00 ₴\n✅ Чистыми: <b>\+/);
  assert.match(p, /Не финансовый совет/);
  assert.equal(buildPost('ideas', [], FX, AT10), null);
  const c = buildPost('cases', [kase('Kilowatt Case', 120, 100), kase('Gallery Case', 80, 100), kase('Fever Case', 100, 100)], FX, AT10)!;
  assert.match(c, /Дорожают[\s\S]*Kilowatt Case — <b>\+20%<\/b>/);
  assert.match(c, /Дешевеют[\s\S]*Gallery Case — <b>−20%<\/b>/);
  assert.ok(!c.includes('Fever Case'), 'без изменений — не показываем');
});

test('расписание: каждый слот один раз в день, пропущенный — в пределах 3 часов', () => {
  const none = { ideas: null, trends: null, cases: null };
  assert.equal(dueSlot(AT10, none), 'ideas');
  assert.equal(dueSlot(AT10, { ...none, ideas: '2026-11-04' }), null);
  assert.equal(dueSlot(Date.parse('2026-11-04T06:00:00Z') / 1000, none), null, '07:00 — рано');
  assert.equal(dueSlot(Date.parse('2026-11-04T14:30:00Z') / 1000, { ...none, ideas: '2026-11-04' }), 'trends');
});

test('канал: /channel проверяет права бота, публикует приветствие; по расписанию — пост с кнопкой на бота', async () => {
  const d = migratedDb();
  const D = d as unknown as D1Database;
  const env = testEnv(d, { INGEST_SECRET: 'ingest_secret_test_123' });
  const sent: { method: string; body: Record<string, any> }[] = [];
  let isAdminInChannel = false;
  const { fetcher } = mockFetch([
    { match: (u) => u.startsWith('https://api.telegram.org/'), respond: (u, init) => {
      const method = u.split('/').pop()!; const body = JSON.parse(String(init?.body ?? '{}'));
      sent.push({ method, body });
      if (method === 'getChat') return json({ ok: true, result: { id: -1001234, title: 'SkinRadar UA', type: 'channel' } });
      if (method === 'getMe') return json({ ok: true, result: { id: 42, username: 'cenolow_bot' } });
      if (method === 'getChatMember') return json({ ok: true, result: isAdminInChannel ? { status: 'administrator', can_post_messages: true } : { status: 'left' } });
      return json({ ok: true, result: { message_id: sent.length } });
    } },
    { match: (u) => u.startsWith('https://bank.gov.ua/'), respond: () => json(fixtureJson('nbu.json')) },
  ]);
  const msg = (text: string, from = ADMIN) => handleWebhook(new Request('https://x/telegram', {
    method: 'POST', headers: { 'X-Telegram-Bot-Api-Secret-Token': env.TELEGRAM_WEBHOOK_SECRET },
    body: JSON.stringify({ update_id: 1, message: { message_id: 1, from: { id: from }, chat: { id: from, type: 'private' }, text } }),
  }), env, AT10, fetcher);
  await msg('/channel @skinradar_ua');
  assert.match(String(sent.filter((s) => s.method === 'sendMessage').at(-1)!.body.text), /не администратор/);
  isAdminInChannel = true;
  await msg('/channel @skinradar_ua');
  const welcome = sent.find((s) => s.method === 'sendMessage' && s.body.chat_id === -1001234)!;
  assert.match(welcome.body.text, /Рынок скинов CS2 — каждый день/);
  assert.equal(welcome.body.reply_markup.inline_keyboard[0][0].url, 'https://t.me/cenolow_bot?start=ch');
  // Чужой не может подключить канал.
  const before = sent.length;
  await msg('/channel @other', 5555);
  assert.equal(sent.slice(before).filter((s) => s.method === 'getChat').length, 0);
  // Данные для поста и запуск по расписанию.
  await db.storeFx(D, [EUR, USD], AT10);
  // Два сканирования подряд: рекомендация попадает в канал, только если цена держится (#5).
  for (const t of [AT10 - 600, AT10]) await handleIngest(new Request('https://w/ingest', { method: 'POST', headers: { 'X-Ingest-Secret': 'ingest_secret_test_123' }, body: JSON.stringify({ kind: 'scan', fetchedAt: t, items: [
    { name: 'Revolution Case', offers: { skinport: { p: 10, q: 50 } }, s7: { median: 13, volume: 300 }, s30: { median: 12.5, volume: 1200 } },
  ] }) }), env, t);
  sent.length = 0;
  await runCycle(env, { now: AT10, fetcher });
  await runCycle(env, { now: AT10 + 400, fetcher });
  // Картинку никто не нарисовал (сборщика в тесте нет) — пост уходит без неё через 25 минут.
  await runCycle(env, { now: AT10 + 26 * 60, fetcher });
  await runCycle(env, { now: AT10 + 34 * 60, fetcher });
  const posts = sent.filter((s) => (s.method === 'sendMessage' || s.method === 'sendPhoto') && s.body.chat_id === -1001234);
  assert.equal(posts.length, 1, 'один пост за слот');
  assert.match(posts[0].body.text, /Рекомендации дня/);
});

test('метки источников: /start tt сохраняется один раз; /stats видит только владелец', async () => {
  const d = migratedDb();
  const env = testEnv(d);
  const sent: { method: string; body: Record<string, any> }[] = [];
  const { fetcher } = mockFetch([{ match: (u) => u.startsWith('https://api.telegram.org/'), respond: (u, init) => {
    const method = u.split('/').pop()!; sent.push({ method, body: JSON.parse(String(init?.body ?? '{}')) });
    return json({ ok: true, result: method === 'getMe' ? { id: 42, username: 'cenolow_bot' } : { message_id: 1 } });
  } }]);
  const msg = (text: string, from: number) => handleWebhook(new Request('https://x/telegram', {
    method: 'POST', headers: { 'X-Telegram-Bot-Api-Secret-Token': env.TELEGRAM_WEBHOOK_SECRET },
    body: JSON.stringify({ update_id: 1, message: { message_id: 1, from: { id: from }, chat: { id: from, type: 'private' }, text } }),
  }), env, AT10, fetcher);
  await msg('/start tt', 9001);
  await msg('/start ch', 9001);
  await msg('/start ch', 9002);
  await msg('/start <script>', 9003);
  const refs = d.db.prepare(`SELECT telegram_id, value FROM user_settings WHERE key = 'ref' ORDER BY telegram_id`).all();
  assert.deepEqual(refs.map((r: any) => [r.telegram_id, r.value]), [[9001, 'tt'], [9002, 'ch']]);
  sent.length = 0;
  await msg('/stats', 9001);
  assert.equal(sent.filter((s) => s.method === 'sendMessage').length, 0, 'не владельцу — молчим');
  await msg('/stats', ADMIN);
  const st = String(sent.filter((s) => s.method === 'sendMessage').at(-1)!.body.text);
  assert.match(st, /Пользователей: <b>4<\/b>/);
  assert.match(st, /tt: 1/);
  assert.match(st, /start=tt/);
});

test('картинка поста: Worker заказывает её у сборщика, ждёт, публикует с ней; не пришла за 25 мин — без неё', async () => {
  const { handleCard } = await import('../src/card.ts');
  const { setMetaStmt } = await import('../src/core/channel.ts');
  const d = migratedDb();
  const D = d as unknown as D1Database;
  const SECRET = 'ingest_secret_test_123';
  const env = testEnv(d, { INGEST_SECRET: SECRET });
  await db.storeFx(D, [EUR, USD], AT10);
  const hdr = { 'X-Ingest-Secret': SECRET };
  const scan = { name: 'Revolution Case', offers: { skinport: { p: 10, q: 50 } }, s7: { median: 13, volume: 300 }, s30: { median: 12.5, volume: 1200 } };
  for (const t of [AT10 - 600, AT10]) await handleIngest(new Request('https://w/ingest', { method: 'POST', headers: hdr, body: JSON.stringify({ kind: 'scan', fetchedAt: t, items: [scan] }) }), env, t);
  await D.batch([setMetaStmt(D, 'channel_id', '-1001234'), setMetaStmt(D, 'bot_username', 'cenolow_bot')]);
  const sent: { method: string; body: Record<string, any> }[] = [];
  const { fetcher } = mockFetch([
    { match: (u) => u.startsWith('https://api.telegram.org/'), respond: (u, init) => { sent.push({ method: u.split('/').pop()!, body: (() => { const b = JSON.parse(String(init?.body)); if (b.caption !== undefined && b.text === undefined) b.text = b.caption; return b; })() }); return json({ ok: true, result: { message_id: 1 } }); } },
    { match: (u) => u.startsWith('https://bank.gov.ua/'), respond: () => json(fixtureJson('nbu.json')) },
  ]);
  const posts = () => sent.filter((s) => (s.method === 'sendMessage' || s.method === 'sendPhoto') && s.body.chat_id === -1001234);
  await runCycle(env, { now: AT10, fetcher });
  await runCycle(env, { now: AT10 + 120, fetcher });
  assert.equal(posts().length, 0, 'ждём картинку');
  const items = await (await handleIngest(new Request('https://cs2.example.dev/ingest/items', { headers: hdr }), env, AT10 + 150)).json() as { card: { id: string; slot: string; deals: { buyPrice: string }[] } };
  assert.equal(items.card.id, 'ideas-2026-11-04');
  assert.match(items.card.deals[0].buyPrice, /\$$/, 'суммы на картинке — в долларах');
  const jpg = '/9j/' + Buffer.from('fake-jpeg').toString('base64');
  const up = await handleIngest(new Request('https://cs2.example.dev/ingest', { method: 'POST', headers: hdr, body: JSON.stringify({ kind: 'card', fetchedAt: AT10, id: items.card.id, jpg }) }), env, AT10 + 300);
  assert.equal(up.status, 200);
  await runCycle(env, { now: AT10 + 450, fetcher });
  assert.equal(posts().length, 1);
  assert.equal(posts()[0].method, 'sendPhoto', 'картинка — настоящее фото, а не ссылка с превью');
  assert.equal(posts()[0].body.photo, `https://cs2.example.dev/card/ideas-2026-11-04.jpg?v=${AT10 + 300}`);
  const img = await handleCard(new URL('https://cs2.example.dev/card/ideas-2026-11-04.jpg'), env);
  assert.equal(img.headers.get('Content-Type'), 'image/jpeg');
  assert.equal((await handleCard(new URL('https://x/card/../../etc.jpg'), env)).status, 404);
  const again = await (await handleIngest(new Request('https://cs2.example.dev/ingest/items', { headers: hdr }), env, AT10 + 500)).json() as { card: unknown };
  assert.equal(again.card, null, 'заказ закрыт');
  // Тренды в 15:00: картинку никто не прислал — через 25 минут пост уходит без неё.
  const AT15 = AT10 + 5 * 3600;
  await runCycle(env, { now: AT15, fetcher });
  await runCycle(env, { now: AT15 + 120, fetcher });
  await runCycle(env, { now: AT15 + 28 * 60, fetcher });
  await runCycle(env, { now: AT15 + 34 * 60, fetcher });
  const tr = posts().find((p) => /Растут в цене/.test(p.body.text));
  if (tr) assert.notEqual(String(tr.body.photo ?? tr.body.link_preview_options?.url ?? '').includes('/card/'), true);
});

test('пост с картинкой: фото с подписью; длинный текст — фото и затем текст; фото не скачалось — прежний вариант с превью', async () => {
  const calls: { method: string; body: Record<string, any> }[] = [];
  let failPhoto = false;
  const fetcher = (async (url: string, init?: RequestInit) => {
    const method = String(url).split('/').pop()!; const body = JSON.parse(String(init?.body ?? '{}'));
    calls.push({ method, body });
    if (method === 'sendPhoto' && failPhoto) return new Response(JSON.stringify({ ok: false, description: 'Bad Request: wrong type of the web page content' }), { status: 400 });
    return new Response(JSON.stringify({ ok: true, result: { message_id: 7 } }));
  }) as unknown as typeof fetch;
  const { TelegramClient } = await import('../src/telegram/api.ts');
  const tg = new TelegramClient('T', fetcher);
  await tg.sendPost(1, 'коротко', [[{ text: 'Открыть', url: 'https://t.me/x' }]], 'https://i/x.jpg');
  assert.deepEqual(calls.map((c) => c.method), ['sendPhoto']);
  assert.equal(calls[0]!.body.caption, 'коротко'); assert.ok(calls[0]!.body.reply_markup);
  calls.length = 0;
  await tg.sendPost(1, 'я'.repeat(1500), undefined, 'https://i/x.jpg');
  assert.deepEqual(calls.map((c) => c.method), ['sendPhoto', 'sendMessage'], 'длиннее 1024 — фото, потом текст');
  assert.equal(calls[0]!.body.caption, undefined);
  calls.length = 0; failPhoto = true;
  await tg.sendPost(1, 'коротко', undefined, 'https://i/x.jpg');
  assert.deepEqual(calls.map((c) => c.method), ['sendPhoto', 'sendMessage']);
  assert.equal(calls[1]!.body.link_preview_options.url, 'https://i/x.jpg');
  calls.length = 0;
  await tg.sendPost(1, 'без картинки', undefined, null);
  assert.deepEqual(calls.map((c) => c.method), ['sendMessage']);
});
