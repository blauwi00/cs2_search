// Трейд-ссылка владельца для подарков скинами: видят все, сохраняет и убирает только владелец, чужие адреса не принимаются.
import test from 'node:test';
import assert from 'node:assert/strict';
import { migratedDb, testEnv, ADMIN } from './helpers.ts';
import { signInitData } from '../src/webapp/auth.ts';
import { handleAppApi } from '../src/webapp/api.ts';

const NOW = Date.parse('2026-11-12T12:00:00Z') / 1000;
async function call(env: ReturnType<typeof testEnv>, path: string, uid: number, body?: unknown) {
  const init = await signInitData({ auth_date: String(NOW), query_id: 'Q', user: JSON.stringify({ id: uid }) }, 'TEST_TOKEN');
  const res = await handleAppApi(new Request('https://w/app/api/' + path, { method: body === undefined ? 'GET' : 'POST', headers: { 'X-Init-Data': init }, body: body === undefined ? undefined : JSON.stringify(body) }), env, NOW);
  return { status: res.status, body: await res.json() as Record<string, any> };
}

test('трейд-ссылка: по умолчанию пусто; сохраняет только владелец; чужие адреса отклоняются; видят все; можно убрать', async () => {
  const env = testEnv(migratedDb());
  const good = 'https://steamcommunity.com/tradeoffer/new/?partner=123456789&token=AbCd_12-x';
  assert.equal((await call(env, 'tradeurl', 111)).body.url, null);
  assert.equal((await call(env, 'owner/tradeurl', 111, { url: good })).status, 403, 'обычный человек не может');
  for (const bad of ['http://steamcommunity.com/tradeoffer/new/?partner=1&token=abcd', 'https://evil.example/tradeoffer/new/?partner=1&token=abcd', 'https://steamcommunity.com/tradeoffer/new/?partner=1&token=abcd&x=1', 'просто текст'])
    assert.equal((await call(env, 'owner/tradeurl', ADMIN, { url: bad })).status, 400, bad);
  assert.equal((await call(env, 'owner/tradeurl', ADMIN, { url: ' ' + good + ' ' })).body.url, good);
  const seen = await call(env, 'tradeurl', 111);
  assert.equal(seen.body.url, good); assert.match(seen.body.getUrl, /tradeoffers\/privacy/);
  assert.equal((await call(env, 'owner/tradeurl', ADMIN, { url: '' })).body.url, null);
  assert.equal((await call(env, 'tradeurl', 111)).body.url, null);
});

test('«Я отправил обмен»: только при включённой ссылке, только raffle/gift, не чаще раза в 10 минут', async () => {
  const env = testEnv(migratedDb());
  assert.equal((await call(env, 'tradesent', 111, { kind: 'gift' })).status, 400, 'ссылки нет');
  await call(env, 'owner/tradeurl', ADMIN, { url: 'https://steamcommunity.com/tradeoffer/new/?partner=123456789&token=AbCd_12-x' });
  assert.equal((await call(env, 'tradesent', 111, { kind: 'x' })).status, 400);
  assert.equal((await call(env, 'tradesent', 111, { kind: 'raffle' })).body.ok, true);
  assert.equal((await call(env, 'tradesent', 111, { kind: 'raffle' })).status, 400, 'повтор сразу');
});
