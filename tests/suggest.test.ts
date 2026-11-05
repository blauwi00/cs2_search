// Предложка канала: подписчик → владелец → канал.
import test from 'node:test';
import assert from 'node:assert/strict';
import { migratedDb, testEnv, mockFetch, json } from './helpers.ts';
import { handleWebhook } from '../src/telegram/webhook.ts';
import { handleAppApi } from '../src/webapp/api.ts';
import { signInitData } from '../src/webapp/auth.ts';
import { setMetaStmt } from '../src/core/channel.ts';
import { cleanSuggestion } from '../src/telegram/suggest.ts';

const NOW = Date.parse('2026-11-05T12:00:00Z') / 1000;
const CH = -1001234;

async function setup(channel = true) {
  const d = migratedDb();
  const D = d as unknown as D1Database;
  const env = testEnv(d);
  if (channel) await D.batch([setMetaStmt(D, 'channel_id', String(CH)), setMetaStmt(D, 'bot_username', 'cenolow_bot')]);
  const sent: { method: string; body: Record<string, any> }[] = [];
  const { fetcher } = mockFetch([{ match: (u) => u.startsWith('https://api.telegram.org/'), respond: (u, init) => {
    sent.push({ method: u.split('/').pop()!, body: JSON.parse(String(init?.body)) });
    return json({ ok: true, result: { message_id: 1 } });
  } }]);
  const upd = (body: object, now = NOW) => handleWebhook(new Request('https://x/telegram', { method: 'POST', headers: { 'X-Telegram-Bot-Api-Secret-Token': env.TELEGRAM_WEBHOOK_SECRET }, body: JSON.stringify({ update_id: 1, ...body }) }), env, now, fetcher);
  const ADMIN = Number(env.ADMIN_TELEGRAM_ID);
  const msg = (from: number, text: string, now = NOW) => upd({ message: { message_id: 1, from: { id: from }, chat: { id: from, type: 'private' }, text } }, now);
  const cb = (from: number, data: string) => upd({ callback_query: { id: 'c', from: { id: from }, data, message: { message_id: 5, chat: { id: from, type: 'private' } } } });
  return { d, D, env, sent, fetcher, upd, msg, cb, ADMIN };
}

test('текст подписчика очищается от служебных символов и маркеров денег', () => {
  assert.equal(cleanSuggestion('  при​вет ⟦100⟧\n\n\n\nмир '), 'привет 100\n\nмир');
  assert.equal(cleanSuggestion(42), '');
});

test('предложка: /suggest → текст → владелец получает с кнопками → «В канал» → пост в канале, автор узнаёт', async () => {
  const { D, sent, msg, cb, ADMIN } = await setup();
  const U = 7001;
  await msg(U, '/suggest');
  assert.match(sent.at(-1)!.body.text, /Предложка канала/);
  await msg(U, 'Скидки на кейсы <b>Kilowatt</b> на Skinport до пятницы');
  const toAdmin = sent.find((x) => x.body.chat_id === ADMIN && /Предложка #1/.test(x.body.text))!;
  assert.ok(toAdmin, 'владелец получил');
  assert.match(toAdmin.body.text, /&lt;b&gt;Kilowatt/, 'HTML подписчика экранирован');
  const kb = toAdmin.body.reply_markup.inline_keyboard.flat().map((b: any) => b.callback_data);
  assert.deepEqual(kb, ['sg:pub:1', 'sg:no:1', 'sg:ban:1']);
  assert.match(sent.at(-1)!.body.text, /Спасибо/);
  // посторонний не может опубликовать
  sent.length = 0;
  await cb(U, 'sg:pub:1');
  assert.equal(sent.filter((x) => x.body.chat_id === CH).length, 0);
  await cb(ADMIN, 'sg:pub:1');
  const post = sent.find((x) => x.body.chat_id === CH)!;
  assert.match(post.body.text, /Из предложки[\s\S]*Kilowatt[\s\S]*подписчик/);
  assert.doesNotMatch(post.body.text, /7001/, 'автор не раскрывается');
  assert.ok(JSON.stringify(post.body.reply_markup).includes('start=suggest'));
  assert.ok(sent.some((x) => x.body.chat_id === U && /опубликовано/.test(x.body.text)));
  // повторное нажатие — без второго поста
  await cb(ADMIN, 'sg:pub:1');
  assert.equal(sent.filter((x) => x.body.chat_id === CH).length, 1);
  assert.equal((await D.prepare('SELECT status FROM suggestions WHERE id = 1').first<{ status: string }>())!.status, 'posted');
});

test('предложка: отклонить, закрыть автору, лимит 3 в сутки, слишком коротко', async () => {
  const { sent, msg, cb, ADMIN } = await setup();
  const U = 7002;
  await msg(U, '/suggest');
  await msg(U, 'коротко');
  assert.match(sent.at(-1)!.body.text, /Слишком коротко/);
  await msg(U, 'Нормальное предложение про рынок кейсов');
  await cb(ADMIN, 'sg:no:1');
  assert.ok(sent.some((x) => x.body.chat_id === U && /публиковать не будем/.test(x.body.text)));
  for (let i = 0; i < 3; i++) { await msg(U, '/suggest'); await msg(U, `Ещё одно предложение номер ${i}`); }
  assert.match(sent.at(-1)!.body.text, /не больше 3/);
  await cb(ADMIN, 'sg:ban:2');
  await msg(U, '/suggest', NOW + 2 * 86400);
  assert.match(sent.at(-1)!.body.text, /закрыта/);
});

test('предложка с картинкой: фото уходит владельцу и в канал по file_id; без режима предложки фото не принимается', async () => {
  const { sent, msg, upd, cb, ADMIN } = await setup();
  const U = 7003;
  const photo = (caption?: string) => upd({ message: { message_id: 2, from: { id: U }, chat: { id: U, type: 'private' }, caption, photo: [{ file_id: 'small', width: 90 }, { file_id: 'BIG', width: 1280 }] } });
  await photo('просто так');
  assert.match(sent.at(-1)!.body.text, /только в предложке/);
  await msg(U, '/suggest');
  await photo('Скрин: AK-47 упал в цене');
  const a = sent.find((x) => x.method === 'sendPhoto' && x.body.chat_id === ADMIN)!;
  assert.equal(a.body.photo, 'BIG');
  await cb(ADMIN, 'sg:pub:1');
  const p = sent.find((x) => x.method === 'sendPhoto' && x.body.chat_id === CH)!;
  assert.equal(p.body.photo, 'BIG');
  assert.match(p.body.caption, /AK-47 упал/);
});

test('предложка из приложения и из ссылки канала (?start=suggest); без канала — честно говорит', async () => {
  const { sent, msg, fetcher, env, ADMIN } = await setup();
  await msg(7004, '/start suggest');
  assert.match(sent.at(-1)!.body.text, /Предложка канала/);
  const init = await signInitData({ auth_date: String(NOW), query_id: 'A', user: JSON.stringify({ id: 7005, first_name: 'E' }) }, 'TEST_TOKEN');
  const g = globalThis as any; const orig = g.fetch; g.fetch = fetcher;
  try {
    const post = async (body: object) => (await handleAppApi(new Request('https://w/app/api/suggest', { method: 'POST', headers: { 'X-Init-Data': init, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), env, NOW)).json() as Promise<Record<string, any>>;
    assert.equal((await post({ text: 'x' })).ok, false);
    assert.equal((await post({ text: 'Предложение прямо из приложения' })).ok, true);
    assert.ok(sent.some((x) => x.body.chat_id === ADMIN && /из приложения/.test(x.body.text)));
  } finally { g.fetch = orig; }
  const s2 = await setup(false);
  await s2.msg(7006, '/suggest');
  assert.match(s2.sent.at(-1)!.body.text, /Канал пока не подключён/);
});
