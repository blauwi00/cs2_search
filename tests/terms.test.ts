// Условия использования: без согласия бот только показывает условия; согласие — один раз; удаление данных по команде.
import test from 'node:test';
import assert from 'node:assert/strict';
import { migratedDb, testEnv, mockFetch, json } from './helpers.ts';
import { handleWebhook } from '../src/telegram/webhook.ts';
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
  assert.match(last(), /Всё — в приложении/);
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
