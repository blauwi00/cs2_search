// Сообщения об ошибках и пожертвования звёздами.
import test from 'node:test';
import assert from 'node:assert/strict';
import { migratedDb, testEnv, mockFetch, json } from './helpers.ts';
import { handleWebhook } from '../src/telegram/webhook.ts';
import { handleAppApi } from '../src/webapp/api.ts';
import { signInitData } from '../src/webapp/auth.ts';
import { parseDonatePayload } from '../src/core/support.ts';

const NOW = Date.parse('2026-11-05T12:00:00Z') / 1000;

function setup() {
  const d = migratedDb();
  const D = d as unknown as D1Database;
  const env = testEnv(d);
  const sent: { method: string; body: Record<string, any> }[] = [];
  const { fetcher } = mockFetch([{ match: (u) => u.startsWith('https://api.telegram.org/'), respond: (u, init) => {
    const method = u.split('/').pop()!; sent.push({ method, body: JSON.parse(String(init?.body)) });
    return json({ ok: true, result: method === 'createInvoiceLink' ? 'https://t.me/$inv123' : { message_id: 1 } });
  } }]);
  const upd = (body: object) => handleWebhook(new Request('https://x/telegram', { method: 'POST', headers: { 'X-Telegram-Bot-Api-Secret-Token': env.TELEGRAM_WEBHOOK_SECRET }, body: JSON.stringify({ update_id: 1, ...body }) }), env, NOW, fetcher);
  return { d, D, env, sent, fetcher, upd };
}

test('payload пожертвования разбирается строго', () => {
  assert.equal(parseDonatePayload('donate:100'), 100);
  assert.equal(parseDonatePayload('donate:0'), null);
  assert.equal(parseDonatePayload('donate:abc'), null);
  assert.equal(parseDonatePayload(42), null);
});

test('звёзды: /donate → счёт XTR, pre_checkout подтверждается, оплата записывается один раз', async () => {
  const { D, env, sent, upd } = setup();
  const U = 5151;
  const msg = (text: string) => upd({ message: { message_id: 1, from: { id: U }, chat: { id: U, type: 'private' }, text } });
  await msg('/donate');
  const kb = sent.at(-1)!.body.reply_markup.inline_keyboard.flat();
  assert.ok(kb.some((b: any) => b.callback_data === 'don:100'));
  await upd({ callback_query: { id: 'c1', from: { id: U }, data: 'don:100', message: { message_id: 1, chat: { id: U, type: 'private' } } } });
  const inv = sent.find((x) => x.method === 'createInvoiceLink')!;
  assert.equal(inv.body.currency, 'XTR');
  assert.equal(inv.body.prices[0].amount, 100);
  assert.equal(inv.body.provider_token, undefined);
  // Подтверждение перед списанием.
  await upd({ pre_checkout_query: { id: 'q1', from: { id: U }, currency: 'XTR', total_amount: 100, invoice_payload: 'donate:100' } });
  assert.deepEqual(sent.at(-1), { method: 'answerPreCheckoutQuery', body: { pre_checkout_query_id: 'q1', ok: true } });
  await upd({ pre_checkout_query: { id: 'q2', from: { id: U }, currency: 'XTR', total_amount: 5, invoice_payload: 'donate:100' } });
  assert.equal(sent.at(-1)!.body.ok, false);
  // Оплата (повтор того же платежа не дублируется).
  const paid = { message: { message_id: 2, from: { id: U }, chat: { id: U, type: 'private' }, successful_payment: { currency: 'XTR', total_amount: 100, invoice_payload: 'donate:100', telegram_payment_charge_id: 'ch_1' } } };
  await upd(paid); await upd(paid);
  const row = await D.prepare('SELECT COUNT(*) AS n, SUM(stars) AS s FROM donations').first<{ n: number; s: number }>();
  assert.deepEqual({ ...row }, { n: 1, s: 100 });
  assert.ok(sent.some((x) => x.body.chat_id === Number(env.ADMIN_TELEGRAM_ID) && /100 ⭐/.test(x.body.text)));
  sent.length = 0;
  await upd({ message: { message_id: 3, from: { id: Number(env.ADMIN_TELEGRAM_ID) }, chat: { id: Number(env.ADMIN_TELEGRAM_ID), type: 'private' }, text: '/stats' } });
  assert.match(sent.at(-1)!.body.text, /Пожертвования: <b>100 ⭐<\/b>/);
});

test('ошибка в цене: из приложения уходит владельцу, лимит 5 в час; /feedback в боте', async () => {
  const { D, env, sent, fetcher, upd } = setup();
  const init = await signInitData({ auth_date: String(NOW), query_id: 'A', user: JSON.stringify({ id: 6262, first_name: 'E' }) }, 'TEST_TOKEN');
  const g = globalThis as any; const orig = g.fetch; g.fetch = fetcher;
  try {
    const post = async (body: object) => (await handleAppApi(new Request('https://w/app/api/feedback', { method: 'POST', headers: { 'X-Init-Data': init, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), env, NOW)).json() as Promise<Record<string, any>>;
    assert.equal((await post({ item: 'Revolution Case', comment: 'x' })).ok, false); // без причины
    const r = await post({ item: 'Revolution Case', reason: 'price', comment: 'на сайте 2.10 $', context: 'карточка' });
    assert.equal(r.ok, true);
    const m = sent.find((x) => x.body.chat_id === Number(env.ADMIN_TELEGRAM_ID))!;
    assert.match(m.body.text, /Revolution Case/); assert.match(m.body.text, /Цена неверная/); assert.match(m.body.text, /6262/);
    for (let i = 0; i < 4; i++) assert.equal((await post({ reason: 'other' })).ok, true);
    const over = await post({ reason: 'other' });
    assert.equal(over.ok, false); assert.match(over.error, /Слишком много/);
  } finally { g.fetch = orig; }
  await upd({ message: { message_id: 1, from: { id: 7373 }, chat: { id: 7373, type: 'private' }, text: '/feedback цена не та' } });
  assert.match(sent.at(-1)!.body.text, /Спасибо/);
  assert.equal((await D.prepare('SELECT COUNT(*) AS n FROM feedback').first<{ n: number }>())!.n, 6);
});

test('топ поддержки: имя из Telegram, сумма по человеку, скрытие кнопкой, /deletemydata убирает имя', async () => {
  const { D, env, sent, upd } = setup();
  const pay = (u: number, first: string, stars: number, ch: string) => upd({ message: { message_id: 2, from: { id: u, first_name: first }, chat: { id: u, type: 'private' }, successful_payment: { currency: 'XTR', total_amount: stars, invoice_payload: `donate:${stars}`, telegram_payment_charge_id: ch } } });
  await pay(11, 'Оля <b>', 50, 'a'); await pay(11, 'Оля', 100, 'b'); await pay(22, 'Max https://spam.io', 250, 'c'); await pay(33, 'Тихий', 25, 'd');
  const { topDonors } = await import('../src/core/support.ts');
  assert.deepEqual(await topDonors(D), [{ name: 'Max', stars: 250 }, { name: 'Оля b', stars: 150 }, { name: 'Тихий', stars: 25 }]);
  assert.ok(JSON.stringify(sent.find((x) => x.body.chat_id === 33)!.body.reply_markup).includes('dt:off'));
  await upd({ callback_query: { id: 'c', from: { id: 33 }, data: 'dt:off', message: { message_id: 1, chat: { id: 33, type: 'private' } } } });
  assert.equal((await topDonors(D)).length, 2);
  const init = await signInitData({ auth_date: String(NOW), query_id: 'A', user: JSON.stringify({ id: 11, first_name: 'Оля' }) }, 'TEST_TOKEN');
  const s = await (await handleAppApi(new Request('https://w/app/api/summary', { headers: { 'X-Init-Data': init } }), env, NOW)).json() as any;
  assert.equal(s.donors[0].name, 'Max');
  await upd({ message: { message_id: 1, from: { id: 22 }, chat: { id: 22, type: 'private' }, text: '/deletemydata' } });
  const btn = JSON.stringify(sent.at(-1)!.body.reply_markup ?? {}).match(/"(delme:[^"]+)"/);
  if (btn) await upd({ callback_query: { id: 'c2', from: { id: 22 }, data: btn[1], message: { message_id: 1, chat: { id: 22, type: 'private' } } } });
  assert.equal((await topDonors(D))[0].name, 'Аноним');
});

test('картинка инвентаря: принимаем только JPEG, одна на человека, ссылка /card/inv-….jpg отдаётся', async () => {
  const { D, env } = setup();
  const init = await signInitData({ auth_date: String(NOW), query_id: 'A', user: JSON.stringify({ id: 8181, first_name: 'E' }) }, 'TEST_TOKEN');
  await D.prepare("INSERT INTO meta (key, value) VALUES ('bot_username', 'cenolow_bot')").run();
  const post = async (jpg: string, now = NOW) => (await handleAppApi(new Request('https://w.dev/app/api/sharecard', { method: 'POST', headers: { 'X-Init-Data': init, 'Content-Type': 'application/json' }, body: JSON.stringify({ jpg }) }), env, now)).json() as Promise<Record<string, any>>;
  assert.equal((await post('iVBORw0KGgo=')).ok, false, 'не JPEG');
  const a = await post('/9j/4AAQSkZJRgABAQ==');
  assert.equal(a.ok, true); assert.match(a.url, /^https:\/\/w\.dev\/card\/inv-[a-f0-9]{16}\.jpg$/); assert.equal(a.bot, 'https://t.me/cenolow_bot?start=story');
  assert.equal((await post('/9j/4AAQSkZJRgABAQ==', NOW + 5)).ok, false, 'слишком часто');
  const b = await post('/9j/4AAQSkZJRgABAg==', NOW + 60);
  assert.equal((await D.prepare("SELECT COUNT(*) AS n FROM cards WHERE id LIKE 'inv-%'").first<{ n: number }>())!.n, 1, 'старая удалена');
  const { handleCard } = await import('../src/card.ts');
  const res = await handleCard(new URL(b.url), env);
  assert.equal(res.status, 200); assert.equal(res.headers.get('Content-Type'), 'image/jpeg');
});

test('#18 панель владельца: только владельцу; сводка, действия с паузой Steam и проверкой разгона', async () => {
  const { D, env } = setup();
  const { ADMIN } = await import('./helpers.ts');
  const sign = (id: number) => signInitData({ auth_date: String(NOW), query_id: 'A', user: JSON.stringify({ id, first_name: 'E' }) }, 'TEST_TOKEN');
  const call = async (id: number, path: string, body?: object) => (await handleAppApi(new Request('https://w/app/api/' + path, { method: body ? 'POST' : 'GET', headers: { 'X-Init-Data': await sign(id), 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }), env, NOW)).json() as Promise<Record<string, any>>;
  const user = await call(5555, 'owner');
  assert.equal(user.ok, false); assert.equal(user.admin, undefined, 'обычному пользователю — без признака владельца');
  await D.prepare("INSERT INTO meta (key, value) VALUES ('steam_pause_until', ?), ('agent_at', ?)").bind(String(NOW + 1800), JSON.stringify({ at: NOW - 120, requests: 12, limited: false })).run();
  const o = await call(ADMIN, 'owner');
  assert.equal(o.ok, true); assert.equal(o.admin, true);
  assert.equal(o.steam.pauseUntil, NOW + 1800); assert.equal(o.steam.agent.requests, 12);
  assert.equal(o.rally.on, true); assert.equal(o.rally.need, 10);
  assert.equal((await call(ADMIN, 'owner/action', { action: 'steam_unpause' })).ok, true);
  assert.equal((await call(ADMIN, 'owner')).steam.pauseUntil, 0);
  await call(ADMIN, 'owner/action', { action: 'rally_bot_off' });
  assert.equal((await call(ADMIN, 'owner')).rally.on, false);
});
