// Условия использования: без согласия бот только показывает условия; согласие — один раз; удаление данных по команде.
import test from 'node:test';
import assert from 'node:assert/strict';
import { migratedDb, testEnv, mockFetch, json } from './helpers.ts';
import { handleWebhook } from '../src/telegram/webhook.ts';
import { handleIngest } from '../src/ingest.ts';
import { handleAppApi } from '../src/webapp/api.ts';
import { signInitData } from '../src/webapp/auth.ts';
import { termsText, privacyPolicyText, TERMS_VERSION } from '../src/core/terms.ts';
import * as db from '../src/storage/db.ts';

const NOW = Date.parse('2026-11-04T12:00:00Z') / 1000;

test('условия: тексты в лимите Telegram и содержат главное', () => {
  assert.ok(termsText().length < 4096 && privacyPolicyText().length < 4096);
  assert.match(termsText(), /на свой страх и риск/);
  assert.match(termsText(), /угон аккаунта/);
  assert.match(termsText(), /не являются представителями Valve/);
  assert.match(privacyPolicyText(), /\/deletemydata/);
});

test('бот: без согласия — только условия; «Принимаю» открывает бота; /deletemydata удаляет всё', async () => {
  const d = migratedDb({ termsAccepted: false });
  const D = d as unknown as D1Database;
  const env = testEnv(d);
  const sent: { method: string; body: Record<string, any> }[] = [];
  const { fetcher } = mockFetch([{ match: (u) => u.startsWith('https://api.telegram.org/'), respond: (u, init) => { sent.push({ method: u.split('/').pop()!, body: JSON.parse(String(init?.body)) }); return json({ ok: true, result: { message_id: 1 } }); } }]);
  const U = 9090;
  const upd = (body: object) => handleWebhook(new Request('https://x/telegram', { method: 'POST', headers: { 'X-Telegram-Bot-Api-Secret-Token': env.TELEGRAM_WEBHOOK_SECRET }, body: JSON.stringify({ update_id: 1, ...body }) }), env, NOW, fetcher);
  const msg = (text: string) => upd({ message: { message_id: 1, from: { id: U, language_code: 'uk' }, chat: { id: U, type: 'private' }, text } });
  const cb = (data: string) => upd({ callback_query: { id: 'q', from: { id: U }, data, message: { message_id: 5, chat: { id: U, type: 'private' } } } });
  const last = () => String(sent.filter((s) => s.method === 'sendMessage').at(-1)!.body.text);
  await msg('/start');
  assert.match(last(), /Перед началом/);
  await msg('/watch');
  assert.match(last(), /Перед началом/, 'без согласия остальное недоступно');
  await cb('m:set');
  assert.match(last(), /Перед началом/);
  await msg('/terms');
  assert.match(last(), /Условия использования/);
  await cb('terms:ok');
  assert.equal((await db.getSettings(D, U)).terms_ok, TERMS_VERSION);
  assert.match(last(), /Ценолов<\/b> — показывает, где скин CS2 дешевле/);
  await db.setSetting(D, U, 'min_profit_kop', '5000', NOW);
  await msg('/deletemydata');
  await cb('delme:yes');
  assert.match(last(), /Всё удалено/);
  assert.equal((d.db.prepare('SELECT COUNT(*) AS n FROM user_settings WHERE telegram_id = ?').get(U) as { n: number }).n, 0);
  assert.equal((d.db.prepare('SELECT COUNT(*) AS n FROM users WHERE telegram_id = ?').get(U) as { n: number }).n, 0);
});

test('приложение: статус согласия и принятие', async () => {
  const d = migratedDb({ termsAccepted: false });
  const env = testEnv(d);
  const init = await signInitData({ auth_date: String(NOW), query_id: 'A', user: JSON.stringify({ id: 7070, first_name: 'E' }) }, 'TEST_TOKEN');
  const call = async (method = 'GET') => (await handleAppApi(new Request('https://w/app/api/terms', { method, headers: { 'X-Init-Data': init } }), env, NOW)).json() as Promise<Record<string, any>>;
  const t = await call();
  assert.equal(t.accepted, false);
  assert.ok(t.terms.length >= 5 && t.privacy.length >= 4);
  await call('POST');
  assert.equal((await call()).accepted, true);
});

test('партнёрские ссылки: /ref только владельцу, только https на домен площадки; на главной помечены', async () => {
  const { checkRefUrl, sitesFor } = await import('../src/core/sites.ts');
  assert.equal(checkRefUrl('waxpeer', 'https://waxpeer.com/?ref=abc'), 'https://waxpeer.com/?ref=abc');
  assert.equal(checkRefUrl('waxpeer', 'https://waxpeer.com.evil.io/?ref=abc'), null, 'чужой домен');
  assert.equal(checkRefUrl('waxpeer', 'http://waxpeer.com/'), null, 'только https');
  assert.equal(checkRefUrl('lisskins', 'https://lis-skins.com/ru/?rf=1'), 'https://lis-skins.com/ru/?rf=1');
  const sites = sitesFor({ lisskins: 'https://lis-skins.com/ru/?rf=1' });
  assert.equal(sites.find((x) => x.key === 'lisskins')!.ref, true);
  assert.equal(sites.find((x) => x.key === 'skinport')!.url, 'https://skinport.com/');
  const { ADMIN } = await import('./helpers.ts');
  const d = migratedDb();
  const env = testEnv(d);
  const sent: { body: Record<string, any> }[] = [];
  const { fetcher } = mockFetch([{ match: (u) => u.startsWith('https://api.telegram.org/'), respond: (_u, init) => { sent.push({ body: JSON.parse(String(init?.body)) }); return json({ ok: true, result: { message_id: 1 } }); } }]);
  const msg = (text: string, from: number) => handleWebhook(new Request('https://x/telegram', { method: 'POST', headers: { 'X-Telegram-Bot-Api-Secret-Token': env.TELEGRAM_WEBHOOK_SECRET }, body: JSON.stringify({ update_id: 1, message: { message_id: 1, from: { id: from }, chat: { id: from, type: 'private' }, text } }) }), env, NOW, fetcher);
  await msg('/ref waxpeer https://waxpeer.com/?ref=me', 4242);
  assert.equal((d.db.prepare("SELECT COUNT(*) AS n FROM meta WHERE key = 'ref_links'").get() as { n: number }).n, 0, 'чужой не может');
  await msg('/ref waxpeer https://evil.io/x', ADMIN);
  assert.match(String(sent.at(-1)!.body.text), /должна быть https/);
  await msg('/ref waxpeer https://waxpeer.com/?ref=me', ADMIN);
  assert.match(String(sent.at(-1)!.body.text), /✅ <b>Waxpeer<\/b>/);
});

test('цены на всех площадках: сборщик присылает раз в 6 ч, приложение показывает по возрастанию, Steam отдельно', async () => {
  const d = migratedDb();
  const D = d as unknown as D1Database;
  const SECRET = 'ingest_secret_test_123';
  const env = testEnv(d, { INGEST_SECRET: SECRET });
  const hdr = { 'X-Ingest-Secret': SECRET };
  await db.storeFx(D, [{ base: 'USD', rateMicro: 40_000_000, rateDate: '2026-11-04', source: 'nbu' }], NOW);
  const item = await db.upsertItem(D, 'Kilowatt Case', NOW);
  await db.addWatch(D, 4242, item.id, NOW);
  const items = async (t: number) => (await (await handleIngest(new Request('https://w/ingest/items', { headers: hdr }), env, t)).json()) as { sitePriceNames: string[] };
  assert.deepEqual((await items(NOW)).sitePriceNames, ['Kilowatt Case']);
  const up = await handleIngest(new Request('https://w/ingest', { method: 'POST', headers: hdr, body: JSON.stringify({ kind: 'site_prices', fetchedAt: NOW, done: true,
    items: [{ name: 'Kilowatt Case', p: { skinport: 120, buff163: 95, waxpeer: 110, evil: 1, csmoney: -5 } }] }) }), env, NOW);
  assert.equal(up.status, 200);
  assert.deepEqual((await items(NOW + 3600)).sitePriceNames, [], 'следующий раз — через 6 часов');
  assert.equal((await items(NOW + 7 * 3600)).sitePriceNames.length, 1);
  const init = await signInitData({ auth_date: String(NOW), query_id: 'A', user: JSON.stringify({ id: 4242, first_name: 'E', language_code: 'uk' }) }, 'TEST_TOKEN');
  const r = await (await handleAppApi(new Request('https://w/app/api/prices?name=' + encodeURIComponent('Kilowatt Case'), { headers: { 'X-Init-Data': init } }), env, NOW)).json() as { sites: { key: string; kop: number; group: string }[] };
  assert.deepEqual(r.sites.map((x) => [x.key, x.kop]), [['buff163', 3800], ['waxpeer', 4400], ['skinport', 4800]], 'по возрастанию, мусор отброшен');
  assert.equal(r.sites[0].group, 'china');
});

test('рассылка: /broadcast только владельцу, с предпросмотром и подтверждением; уходит через очередь со ссылкой на канал', async () => {
  const { ADMIN } = await import('./helpers.ts');
  const { runCycle } = await import('../src/core/runner.ts');
  const { setMetaStmt } = await import('../src/core/channel.ts');
  const d = migratedDb();
  const D = d as unknown as D1Database;
  const env = testEnv(d);
  const T = Date.parse('2026-11-04T15:00:00Z') / 1000; // 16:00 по Варшаве — не тихие часы
  for (const u of [ADMIN, 501, 502]) await db.ensureUser(D, u, u === ADMIN, T);
  await setMetaStmt(D, 'channel_id', '-1001234').run();
  const sent: { method: string; body: Record<string, any> }[] = [];
  const { fetcher } = mockFetch([{ match: (u) => u.startsWith('https://api.telegram.org/'), respond: (u, init) => {
    const method = u.split('/').pop()!; const body = JSON.parse(String(init?.body ?? '{}')); sent.push({ method, body });
    if (method === 'getChat') return json({ ok: true, result: { id: -1001234, username: 'cenolow_cs2' } });
    return json({ ok: true, result: { message_id: sent.length } });
  } }]);
  const upd = (b: object) => handleWebhook(new Request('https://x/telegram', { method: 'POST', headers: { 'X-Telegram-Bot-Api-Secret-Token': env.TELEGRAM_WEBHOOK_SECRET }, body: JSON.stringify({ update_id: 1, ...b }) }), env, T, fetcher);
  const msg = (text: string, from: number) => upd({ message: { message_id: 1, from: { id: from }, chat: { id: from, type: 'private' }, text } });
  await msg('/broadcast', 501);
  assert.equal(sent.length, 0, 'чужой не может');
  await msg('/broadcast', ADMIN);
  const preview = sent.find((s) => s.method === 'sendMessage' && /появился канал/.test(s.body.text))!;
  assert.equal(preview.body.reply_markup.inline_keyboard[0][0].url, 'https://t.me/cenolow_cs2');
  assert.equal((d.db.prepare('SELECT COUNT(*) AS n FROM outbox').get() as { n: number }).n, 0, 'без подтверждения ничего не уходит');
  await upd({ callback_query: { id: 'q', from: { id: ADMIN }, data: 'bc:send', message: { message_id: 5, chat: { id: ADMIN, type: 'private' } } } });
  assert.equal((d.db.prepare("SELECT COUNT(*) AS n FROM outbox WHERE kind = 'broadcast'").get() as { n: number }).n, 3);
  sent.length = 0;
  await runCycle(env, { now: T + 60, fetcher });
  const got = sent.filter((s) => s.method === 'sendMessage' && /появился канал/.test(s.body.text)).map((s) => s.body.chat_id).sort();
  assert.deepEqual(got, [501, 502, ADMIN].sort());
});

test('защита авторства: копия запоминает свой домен и сообщает официальному боту; официальный — записывает и показывает в /stats', async () => {
  const { rememberSelfHost, reportCopy, recordCopy, listCopies, OFFICIAL_HOST, FINGERPRINT } = await import('../src/core/origin.ts');
  const d = migratedDb(); const D = d as unknown as D1Database;
  await rememberSelfHost(D, OFFICIAL_HOST);
  const calls: string[] = [];
  await reportCopy(D, async (u) => { calls.push(u); });
  assert.equal(calls.length, 0, 'официальный бот о себе не сообщает');
  await rememberSelfHost(D, 'stolen-bot.thief.workers.dev');
  await reportCopy(D, async (u) => { calls.push(u); });
  assert.equal(calls[0], `https://${OFFICIAL_HOST}/beacon?h=stolen-bot.thief.workers.dev&fp=${FINGERPRINT}`);
  assert.equal(await recordCopy(D, 'stolen-bot.thief.workers.dev', NOW), true);
  assert.equal(await recordCopy(D, 'stolen-bot.thief.workers.dev', NOW + 60), false, 'повтор — не новая');
  assert.equal(await recordCopy(D, '<script>', NOW), false);
  assert.deepEqual((await listCopies(D)).map((x) => x[0]), ['stolen-bot.thief.workers.dev']);
});

test('текстовое меню: без повторов приложения — сделки, рынок, инвентарь, история и настройки только в приложении', async () => {
  const M = await import('../src/telegram/menus.ts');
  const { migratedDb } = await import('./helpers.ts');
  const D = migratedDb() as unknown as D1Database;
  const cbs = (v: { keyboard: { callback_data?: string; web_app?: unknown }[][] }) => v.keyboard.flat().map((b) => b.callback_data ?? 'app');
  const withApp = cbs(await M.mainMenu(D, 0, 'https://w.dev/app', false));
  assert.deepEqual(withApp, ['app', 'm:cases', 'm:an', 'sg:go']);
  assert.ok(cbs(await M.mainMenu(D, 0, 'https://w.dev/app', true)).includes('m:status'), 'владельцу — состояние системы');
  assert.ok(cbs(await M.mainMenu(D, 0, undefined, false)).includes('m:deals'), 'без приложения — полное меню');
});

test('метка из ссылки (?start=ch, ?start=suggest) не теряется, если человек сначала принимает условия', async () => {
  const d = migratedDb({ termsAccepted: false });
  const env = testEnv(d);
  const sent: { method: string; body: Record<string, any> }[] = [];
  const { fetcher } = mockFetch([{ match: (u) => u.startsWith('https://api.telegram.org/'), respond: (u, init) => { sent.push({ method: u.split('/').pop()!, body: JSON.parse(String(init?.body)) }); return json({ ok: true, result: { message_id: 1 } }); } }]);
  const upd = (body: object) => handleWebhook(new Request('https://x/telegram', { method: 'POST', headers: { 'X-Telegram-Bot-Api-Secret-Token': env.TELEGRAM_WEBHOOK_SECRET }, body: JSON.stringify({ update_id: 1, ...body }) }), env, NOW, fetcher);
  const msg = (u: number, text: string) => upd({ message: { message_id: 1, from: { id: u }, chat: { id: u, type: 'private' }, text } });
  const cb = (u: number, data: string) => upd({ callback_query: { id: 'q', from: { id: u }, data, message: { message_id: 5, chat: { id: u, type: 'private' } } } });
  const ref = (u: number) => (d.db.prepare(`SELECT value FROM user_settings WHERE telegram_id = ? AND key = 'ref'`).get(u) as { value: string } | undefined)?.value;
  await msg(501, '/start ch');
  assert.equal(ref(501), undefined, 'до согласия ничего не пишем, кроме отложенной метки');
  await cb(501, 'terms:ok');
  assert.equal(ref(501), 'ch', 'после «Принимаю» метка канала записана');
  assert.equal((d.db.prepare(`SELECT COUNT(*) AS n FROM user_settings WHERE telegram_id = 501 AND key = 'start_param'`).get() as { n: number }).n, 0);
  await msg(502, '/start suggest');
  await cb(502, 'terms:ok');
  assert.match(String(sent.filter((s) => s.method === 'sendMessage').at(-1)!.body.text), /предлож/i, 'после согласия — сразу «Предложить пост»');
  await msg(503, '/start');
  await cb(503, 'terms:ok');
  assert.equal(ref(503), undefined);
});

test('кнопка «📣 Канал»: в /start и в сводке приложения — по ссылке из памяти бота, без запроса к Telegram', async () => {
  const { channelUrlOf } = await import('../src/core/channel.ts');
  assert.equal(channelUrlOf({ username: 'cenolov_cs2' }), 'https://t.me/cenolov_cs2');
  assert.equal(channelUrlOf({ invite_link: 'https://t.me/+AbCd123' }), 'https://t.me/+AbCd123');
  assert.equal(channelUrlOf({ invite_link: 'javascript:alert(1)' }), null);
  const d = migratedDb();
  const env = testEnv(d);
  const sent: { method: string; body: Record<string, any> }[] = [];
  const { fetcher } = mockFetch([{ match: (u) => u.startsWith('https://api.telegram.org/'), respond: (u, init) => { sent.push({ method: u.split('/').pop()!, body: JSON.parse(String(init?.body)) }); return json({ ok: true, result: { message_id: 1 } }); } }]);
  const start = async () => {
    await handleWebhook(new Request('https://x/telegram', { method: 'POST', headers: { 'X-Telegram-Bot-Api-Secret-Token': env.TELEGRAM_WEBHOOK_SECRET }, body: JSON.stringify({ update_id: 1, message: { message_id: 1, from: { id: 601 }, chat: { id: 601, type: 'private' }, text: '/start' } }) }), env, NOW, fetcher);
    return JSON.stringify(sent.filter((s) => s.method === 'sendMessage').at(-1)!.body.reply_markup);
  };
  assert.ok(!(await start()).includes('📣'), 'канал не подключён — кнопки нет');
  d.db.exec(`INSERT INTO meta (key, value) VALUES ('channel_url', 'https://t.me/cenolov_cs2')`);
  const kb = await start();
  assert.ok(kb.includes('📣 Канал') && kb.includes('https://t.me/cenolov_cs2'));
  assert.ok(!sent.some((s) => s.method === 'getChat'), 'getChat на /start не вызывается');
  const init = await signInitData({ auth_date: String(NOW), query_id: 'A', user: JSON.stringify({ id: 601 }) }, 'TEST_TOKEN');
  const sum = await (await handleAppApi(new Request('https://w/app/api/summary', { headers: { 'X-Init-Data': init } }), env, NOW)).json() as Record<string, any>;
  assert.equal(sum.channelUrl, 'https://t.me/cenolov_cs2');
});

test('приветствие: живой пример — лучшая идея прямо сейчас (нет свежего скана — без строки)', async () => {
  const { migratedDb } = await import('./helpers.ts');
  const { bestIdeaLine } = await import('../src/telegram/webhook.ts');
  const db = await import('../src/storage/db.ts');
  const d = migratedDb(); const D = d as unknown as D1Database;
  const NOW = Date.parse('2026-11-10T12:00:00Z') / 1000;
  const h = { d: D, uid: 77, now: NOW } as never;
  assert.equal(await bestIdeaLine(h), '');
  await db.storeFx(D, [{ base: 'USD', rateMicro: 41_400_000, rateDate: '2026-11-10', source: 'nbu' }, { base: 'EUR', rateMicro: 48_200_000, rateDate: '2026-11-10', source: 'nbu' }], NOW);
  const e = { name: 'AK-47 | Slate (Field-Tested)', at: NOW - 600, offers: [{ m: 'csgomarket', cur: 'USD', minor: 409, qty: 40, since: NOW - 7200 }],
    s7: { median: 450, volume: 180 }, s30: { median: 440, volume: 700 }, steam: null };
  d.db.prepare('INSERT INTO market_scan (id, data, fetched_at) VALUES (1, ?, ?)').run(JSON.stringify([e]), NOW - 600);
  const line = await bestIdeaLine(h);
  assert.match(line, /Лучшая идея сейчас:<\/b> AK-47 \| Slate/);
  assert.match(line, /купи на Market\.CSGO за .* → продай на Skinport → получишь/);
});
