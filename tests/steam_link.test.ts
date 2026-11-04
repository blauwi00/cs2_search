// Вход через Steam (только SteamID) и открытый инвентарь Steam.
import test from 'node:test';
import assert from 'node:assert/strict';
import { migratedDb, testEnv, mockFetch } from './helpers.ts';
import { parseSteamProfile, handleSteamCallback, steamLoginUrl } from '../src/steam_link.ts';
import { signInitData } from '../src/webapp/auth.ts';
import { handleAppApi } from '../src/webapp/api.ts';
import { handleIngest } from '../src/ingest.ts';
import * as db from '../src/storage/db.ts';

const NOW = Date.parse('2026-11-04T12:00:00Z') / 1000;
const U = 7001;
const SID = '76561198000000001';

async function api(env: ReturnType<typeof testEnv>, uid: number, path: string, method = 'GET', body?: unknown) {
  const init = await signInitData({ auth_date: String(NOW), query_id: 'Q', user: JSON.stringify({ id: uid }) }, 'TEST_TOKEN');
  const r = await handleAppApi(new Request('https://w.dev/app/api/' + path, { method, headers: { 'X-Init-Data': init }, body: body ? JSON.stringify(body) : undefined }), env, NOW);
  return { status: r.status, body: await r.json() as Record<string, any> };
}

test('ссылка на профиль: SteamID64, /profiles/, /id/имя; мусор — нет', () => {
  assert.deepEqual(parseSteamProfile(SID), { id: SID });
  assert.deepEqual(parseSteamProfile(`https://steamcommunity.com/profiles/${SID}/`), { id: SID });
  assert.deepEqual(parseSteamProfile('https://steamcommunity.com/id/shefdw/'), { vanity: 'shefdw' });
  assert.equal(parseSteamProfile('https://evil.com/?<script>'), null);
  const u = new URL(steamLoginUrl('https://w.dev', 'n'.repeat(36)));
  assert.equal(u.origin, 'https://steamcommunity.com');
  assert.equal(u.searchParams.get('openid.return_to'), 'https://w.dev/steam/callback?s=' + 'n'.repeat(36));
});

test('вход через Steam: подпись проверяется у Steam; подделка и чужая метка не проходят', async () => {
  const d = migratedDb();
  const env = testEnv(d);
  const start = await api(env, U, 'steam/login', 'POST');
  const nonce = new URL(start.body.url).searchParams.get('openid.return_to')!.split('s=')[1];
  const cb = (over: Record<string, string> = {}) => {
    const p = new URLSearchParams({
      s: nonce, 'openid.ns': 'http://specs.openid.net/auth/2.0', 'openid.mode': 'id_res',
      'openid.return_to': `https://w.dev/steam/callback?s=${nonce}`, 'openid.claimed_id': `https://steamcommunity.com/openid/id/${SID}`,
      'openid.identity': `https://steamcommunity.com/openid/id/${SID}`, 'openid.sig': 'x', 'openid.signed': 'signed', ...over,
    });
    return new Request(`https://w.dev/steam/callback?${p}`);
  };
  const bodies: string[] = [];
  const steamSays = (ok: boolean) => mockFetch([{ match: (u) => u === 'https://steamcommunity.com/openid/login', respond: (_u, init) => {
    bodies.push(String(init?.body)); return new Response(`ns:http://specs.openid.net/auth/2.0\nis_valid:${ok}\n`);
  } }]).fetcher;
  // Steam не подтвердил — не привязываем.
  assert.equal((await handleSteamCallback(cb(), env, NOW, steamSays(false))).status, 400);
  assert.equal((await api(env, U, 'steam')).body.linked, false);
  // Чужой return_to — отказ ещё до запроса к Steam.
  assert.equal((await handleSteamCallback(cb({ 'openid.return_to': 'https://evil.com/' }), env, NOW, steamSays(true))).status, 400);
  // Нормальный вход.
  const ok = await handleSteamCallback(cb(), env, NOW, steamSays(true));
  assert.equal(ok.status, 200);
  assert.match(bodies.at(-1)!, /openid\.mode=check_authentication/);
  const st = await api(env, U, 'steam');
  assert.equal(st.body.steamId, SID);
  assert.equal(st.body.verified, true);
  assert.equal(st.body.pending, true, 'сразу просим сборщик загрузить инвентарь');
  // Метка одноразовая.
  assert.equal((await handleSteamCallback(cb(), env, NOW, steamSays(true))).status, 400);
});

test('инвентарь: сборщик забирает открытый инвентарь, бот оценивает и подсказывает; чужие ответы не принимаются', async () => {
  const d = migratedDb();
  const D = d as unknown as D1Database;
  const env = testEnv(d, { INGEST_SECRET: 'ingest_secret_test_123' });
  await db.storeFx(D, [{ base: 'USD', rateMicro: 40_000_000, rateDate: '2026-11-04', source: 'nbu' }], NOW);
  assert.equal((await api(env, U, 'steam/profile', 'POST', { text: 'https://steamcommunity.com/id/shefdw' })).status, 200);
  const hdr = { 'X-Ingest-Secret': 'ingest_secret_test_123' };
  const q = await (await handleIngest(new Request('https://w/ingest/items', { headers: hdr }), env, NOW)).json() as { inventorySync: { tid: number; vanity: string }[] };
  assert.deepEqual(q.inventorySync, [{ tid: U, steamId: null, vanity: 'shefdw' }]);
  const send = (b: object) => handleIngest(new Request('https://w/ingest', { method: 'POST', headers: hdr, body: JSON.stringify({ kind: 'steam_inventory', fetchedAt: NOW, ...b }) }), env, NOW);
  assert.equal((await send({ tid: U, vanity: 'someone_else', steamId: '76561198999999999', status: 'ok', items: [{ name: 'X', qty: 1 }] })).status, 409, 'не тот аккаунт');
  const r = await send({ tid: U, vanity: 'shefdw', steamId: SID, status: 'ok', items: [
    { name: 'Revolution Case', qty: 3, marketable: true, tradable: true, img: 'https://community.akamai.steamstatic.com/economy/image/abc' },
    { name: 'Revolution Case', qty: 2, marketable: true, tradable: true },
    { name: 'Service Medal', qty: 1, marketable: false, tradable: false },
  ] });
  assert.equal(r.status, 200);
  await handleIngest(new Request('https://w/ingest', { method: 'POST', headers: hdr, body: JSON.stringify({ kind: 'steam_avg', fetchedAt: NOW, items: [{ name: 'Revolution Case', d1: 0.44, d7: 0.40, d30: 0.40, d90: 0.40 }] }) }), env, NOW);
  const st = await api(env, U, 'steam');
  assert.equal(st.body.steamId, SID, 'короткое имя превратилось в SteamID64');
  assert.equal(st.body.pending, false);
  const rc = st.body.items.find((x: { name: string }) => x.name === 'Revolution Case');
  assert.equal(rc.qty, 5);
  assert.equal(rc.priceKop, 1600, '≈ 0,40 $ × 40');
  assert.equal(rc.advice.action, 'sell', 'за сутки на 10% дороже месяца — хороший момент продать');
  assert.match(rc.img, /steamstatic/);
  assert.equal(st.body.items.find((x: { name: string }) => x.name === 'Service Medal').advice, null, 'нельзя продать — без подсказки');
  // Обновлять — не чаще раза в 15 минут.
  assert.equal((await api(env, U, 'steam/refresh', 'POST')).status, 400);
  // Закрытый инвентарь.
  d.db.prepare('UPDATE users SET inv_requested_at = ?, inv_synced_at = ? WHERE telegram_id = ?').run(NOW, NOW - 10, U);
  await send({ tid: U, steamId: SID, status: 'private' });
  const pr = await api(env, U, 'steam');
  assert.equal(pr.body.status, 'private');
  assert.equal(pr.body.items.length, 0);
  // Отключение.
  await api(env, U, 'steam/unlink', 'POST');
  assert.equal((await api(env, U, 'steam')).body.linked, false);
});
