// Валюта на выбор: угадывание по языку, курсы (НБУ + через доллар), показ в валюте человека в боте, канале и приложении.
import test from 'node:test';
import assert from 'node:assert/strict';
import { migratedDb, testEnv, mockFetch, json, ADMIN } from './helpers.ts';
import { guessCurrency, mergeRates, curFor, parseNbuDisplay, moneyResolver } from '../src/currency/display.ts';
import { TelegramClient } from '../src/telegram/api.ts';
import { handleWebhook } from '../src/telegram/webhook.ts';
import { handleAppApi } from '../src/webapp/api.ts';
import { handleIngest } from '../src/ingest.ts';
import { signInitData } from '../src/webapp/auth.ts';
import { setMetaStmt } from '../src/core/channel.ts';
import * as db from '../src/storage/db.ts';

const NOW = Date.parse('2026-11-04T12:00:00Z') / 1000;
const NBU = { 'USD': 41.5, 'EUR': 45, 'PLN': 10.5, 'KZT': 0.08 };

test('валюта: язык Telegram → валюта; курсы НБУ, а RUB/BRL — через доллар', () => {
  assert.equal(guessCurrency('uk'), 'UAH');
  assert.equal(guessCurrency('pl'), 'PLN');
  assert.equal(guessCurrency('pt-br'), 'BRL');
  assert.equal(guessCurrency('de'), 'EUR');
  assert.equal(guessCurrency('ru'), 'USD', 'по русскому языку страну не угадать — доллар, человек сменит сам');
  assert.equal(guessCurrency(undefined), 'USD');
  assert.deepEqual(parseNbuDisplay([{ cc: 'USD', rate: 41.5 }, { cc: 'XDR', rate: 55 }, { cc: 'KZT', rate: -1 }]), { USD: 41.5 });
  const r = mergeRates(NBU, { RUB: 83, EUR: 0.5 }, null);
  assert.equal(r.EUR, 45, 'где есть курс НБУ — берём его');
  assert.equal(r.RUB, 41.5 / 83, 'RUB: гривен за доллар / рублей за доллар');
  assert.equal(r.UAH, 1);
  assert.equal(curFor('RUB', r).per, 0.5);
  assert.equal(curFor('BRL', r).code, 'UAH', 'нет курса — показываем в гривне, не выдумываем');
});

test('бот: новому — валюта по языку, старым — гривна; /currency меняет; канал — в долларах', async () => {
  const d = migratedDb();
  const D = d as unknown as D1Database;
  const env = testEnv(d, { INGEST_SECRET: 'ingest_secret_test_123' });
  await D.batch([setMetaStmt(D, 'fx_display', JSON.stringify(NBU))]);
  await db.ensureUser(D, ADMIN, true, NOW - 86400); // старый пользователь, без валюты
  const sent: { method: string; body: Record<string, any> }[] = [];
  const { fetcher } = mockFetch([{ match: (u) => u.startsWith('https://api.telegram.org/'), respond: (u, init) => { sent.push({ method: u.split('/').pop()!, body: JSON.parse(String(init?.body)) }); return json({ ok: true, result: { message_id: 1 } }); } }]);
  const msg = (text: string, from: number, lang?: string) => handleWebhook(new Request('https://x/telegram', {
    method: 'POST', headers: { 'X-Telegram-Bot-Api-Secret-Token': env.TELEGRAM_WEBHOOK_SECRET },
    body: JSON.stringify({ update_id: 1, message: { message_id: 1, from: { id: from, language_code: lang }, chat: { id: from, type: 'private' }, text } }),
  }), env, NOW, fetcher);
  const cb = (data: string, from: number) => handleWebhook(new Request('https://x/telegram', {
    method: 'POST', headers: { 'X-Telegram-Bot-Api-Secret-Token': env.TELEGRAM_WEBHOOK_SECRET },
    body: JSON.stringify({ update_id: 2, callback_query: { id: 'q', from: { id: from }, data, message: { message_id: 5, chat: { id: from, type: 'private' } } } }),
  }), env, NOW, fetcher);
  await msg('/start', 777, 'pl');
  assert.equal((await db.getSettings(D, 777)).currency, 'PLN');
  assert.match(String(sent.at(-1)!.body.text), /Валюта: <b>PLN<\/b>/);
  await msg('/start', ADMIN, 'ru');
  assert.equal((await db.getSettings(D, ADMIN)).currency, '', 'у старых пользователей ничего не меняется');
  await msg('/currency', 777);
  const kb = sent.at(-1)!.body.reply_markup.inline_keyboard.flat().map((b: { callback_data: string }) => b.callback_data);
  assert.ok(kb.includes('cur:USD') && kb.includes('cur:KZT') && !kb.includes('cur:RUB'), 'только валюты с курсом');
  await cb('cur:USD', 777);
  assert.equal((await db.getSettings(D, 777)).currency, 'USD');
  await cb('cur:XXX', 777);
  assert.equal((await db.getSettings(D, 777)).currency, 'USD', 'чужой код не принимается');
  // Целевая цена вводится в своей валюте: 10 $ = 415 ₴.
  const item = await db.upsertItem(D, 'Revolution Case', NOW);
  await db.addWatch(D, 777, item.id, NOW);
  const wid = (d.db.prepare('SELECT id FROM watchlist WHERE telegram_id = 777').get() as { id: number }).id;
  await cb(`wt:${wid}`, 777);
  assert.match(String(sent.at(-1)!.body.text), /в USD \(\$\)/);
  await msg('10', 777);
  assert.equal((d.db.prepare('SELECT target_buy_kop AS t FROM watchlist WHERE telegram_id = 777').get() as { t: number }).t, 41500);
  assert.ok(sent.slice(-3).some((s) => /Целевая цена 10,00 \$ сохранена/.test(String(s.body.text))));
  // Одно и то же сообщение: человеку — в его валюте, каналу — в долларах, без резолвера — в гривне.
  const tg = new TelegramClient('T', fetcher);
  tg.money = moneyResolver(D);
  await tg.sendMessage(777, 'цена ⟦41500⟧');
  await tg.sendMessage(-100123, 'цена ⟦41500⟧');
  await tg.sendMessage(ADMIN, 'цена ⟦41500⟧');
  assert.deepEqual(sent.slice(-3).map((s) => s.body.text), ['цена 10,00 $', 'цена 10,00 $', 'цена 415,00 ₴']);
  // Курсы к доллару от сборщика — появляется RUB.
  const ing = await handleIngest(new Request('https://w/ingest', { method: 'POST', headers: { 'X-Ingest-Secret': 'ingest_secret_test_123' },
    body: JSON.stringify({ kind: 'fx_usd', fetchedAt: NOW, rates: { USD: 1, EUR: 0.9, RUB: 83, GBP: 0.8, BRL: 5.5, CNY: 7.1, EVIL: 1 } }) }), env, NOW);
  assert.equal(ing.status, 200);
  await cb('cur:RUB', 777);
  assert.equal((await db.getSettings(D, 777)).currency, 'RUB');
});

test('приложение: суммы в валюте человека, валюта в каждом ответе, смена валюты в настройках', async () => {
  const d = migratedDb();
  const D = d as unknown as D1Database;
  const env = testEnv(d);
  await D.batch([setMetaStmt(D, 'fx_display', JSON.stringify(NBU))]);
  const call = async (path: string, opt: { method?: string; body?: unknown } = {}, lang = 'pl') => {
    const initData = await signInitData({ auth_date: String(NOW), query_id: 'A', user: JSON.stringify({ id: 4242, first_name: 'E', language_code: lang }) }, 'TEST_TOKEN');
    const res = await handleAppApi(new Request('https://w/app/api/' + path, { method: opt.method ?? 'GET', headers: { 'X-Init-Data': initData }, body: opt.body ? JSON.stringify(opt.body) : undefined }), env, NOW);
    return await res.json() as Record<string, any>;
  };
  const s1 = await call('settings');
  assert.equal(s1.cur.code, 'PLN', 'первый вход — валюта по языку');
  assert.ok(s1.currencies.some((c: { code: string }) => c.code === 'KZT'));
  assert.equal((await call('settings', { method: 'POST', body: { key: 'currency', value: 'BRL' } })).ok, false, 'без курса — нельзя');
  const r = await call('settings', { method: 'POST', body: { key: 'currency', value: 'USD' } });
  assert.equal(r.cur.code, 'USD');
  // Сумма в настройках вводится в долларах: 5 $ = 207,50 ₴.
  await call('settings', { method: 'POST', body: { key: 'min_profit_kop', value: '5' } });
  assert.equal((await db.getSettings(D, 4242)).min_profit_kop, '20750');
  const st = await call('settings');
  assert.equal(st.settings.find((x: { key: string }) => x.key === 'min_profit_kop').display, '5,00 $');
});
