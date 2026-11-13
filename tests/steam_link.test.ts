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
  assert.equal(rc.priceKop, null, 'нет живой цены Steam и площадок — суммы нет (средние прайса завышены)');
  assert.equal(rc.advice.action, 'sell', 'за сутки на 10% дороже месяца — хороший момент продать');
  assert.match(rc.img, /steamstatic/);
  assert.equal(st.body.items.find((x: { name: string }) => x.name === 'Service Medal').advice, null, 'нельзя продать — без подсказки');
  // Обновлять — не чаще раза в 15 минут.
  assert.equal((await api(env, U, 'steam/refresh', 'POST')).status, 400);
  // Закрытый инвентарь.
  d.db.prepare('UPDATE users SET inv_requested_at = ?, inv_synced_at = ? WHERE telegram_id = ?').run(NOW, NOW - 10, U);
  // Закрыт: первая проверка только запоминается — инвентарь не стираем (Steam мог ошибиться).
  await send({ tid: U, steamId: SID, status: 'private' });
  const pr = await api(env, U, 'steam');
  assert.equal(pr.body.status, 'private');
  assert.ok(pr.body.items.length > 0, 'одна проверка — сохранённый инвентарь на месте');
  // Подтверждено через 6+ ч — теперь удаляем.
  d.db.prepare(`UPDATE user_settings SET value = ? WHERE telegram_id = ? AND key = 'inv_private_at'`).run(String(NOW - 7 * 3600), U);
  await send({ tid: U, steamId: SID, status: 'private' });
  assert.equal((await api(env, U, 'steam')).body.items.length, 0);
  // Отключение.
  await api(env, U, 'steam/unlink', 'POST');
  assert.equal((await api(env, U, 'steam')).body.linked, false);
});

test('сертификат предмета Steam: float, паттерн, номер скина — как показывает Steam', async () => {
  const { decodeCertificate } = await import('../.github/scripts/inspect.mjs') as { decodeCertificate: (h: string) => { defindex: number; paintindex: number; float: number; seed: number; stickers: unknown[] } | null };
  // Реальный сертификат из открытого инвентаря; Steam показывает для него Wear Rating 0.154219642281532288 и Pattern Template 579.
  const c = decodeCertificate('F4E45D70574E44F5ECD3D452F3DCF5C4F0CC35230304F7B437F09CE084E33B1CED8C')!;
  assert.equal(c.defindex, 39);
  assert.equal(c.paintindex, 934);
  assert.equal(c.seed, 579);
  assert.ok(Math.abs(c.float - 0.154219642281532288) < 1e-9);
  assert.deepEqual(c.stickers, []);
  assert.equal(decodeCertificate('zz'), null);
  assert.equal(decodeCertificate('<script>'), null);
});

test('подробности экземпляров: проверка входных данных, float-пометки, фаза, наклейки в гривнах', async () => {
  const { sanitizeAssets, floatNote } = await import('../src/core/inspect.ts');
  const a = sanitizeAssets([
    { id: '123', float: 0.004, seed: 661, phase: 'Ruby', phaseUsd: 900, stickers: [{ name: 'Sticker | Crown (Foil)', wear: 0, usd: 800 }, { name: '' }], charms: [{ name: 'Charm | Hot Wurst', pattern: 7, usd: 3 }] },
    { id: 'x', float: 5 }, { id: '5', phase: 'Phase 9', float: 2 },
  ]);
  assert.equal(a.length, 2);
  assert.equal(a[0].phase, 'Ruby');
  assert.equal(a[0].stickers.length, 1);
  assert.equal(a[1].phase, null, 'неизвестная фаза отброшена');
  assert.equal(a[1].float, null, 'float вне 0..1 отброшен');
  assert.match(floatNote('AK-47 | Redline (Factory New)', 0.004)!, /очень низкий/);
  assert.match(floatNote('AK-47 | Redline (Field-Tested)', 0.16)!, /низкий float/);
  assert.match(floatNote('AK-47 | Redline (Field-Tested)', 0.375)!, /границе/);
  assert.equal(floatNote('AK-47 | Redline (Field-Tested)', 0.25), null);

  const d = migratedDb();
  const D = d as unknown as D1Database;
  const env = testEnv(d, { INGEST_SECRET: 'ingest_secret_test_123' });
  await db.storeFx(D, [{ base: 'USD', rateMicro: 40_000_000, rateDate: '2026-11-04', source: 'nbu' }], NOW);
  await api(env, U, 'steam/profile', 'POST', { text: SID });
  const hdr = { 'X-Ingest-Secret': 'ingest_secret_test_123' };
  await handleIngest(new Request('https://w/ingest', { method: 'POST', headers: hdr, body: JSON.stringify({ kind: 'steam_inventory', fetchedAt: NOW, tid: U, steamId: SID, status: 'ok', items: [
    { name: '★ Karambit | Doppler (Factory New)', qty: 1, marketable: true, tradable: true, assets: [{ id: '1', float: 0.004, seed: 661, phase: 'Ruby', phaseUsd: 900, stickers: [], charms: [] }] },
    { name: 'AK-47 | Redline (Field-Tested)', qty: 1, marketable: true, tradable: true, assets: [{ id: '2', float: 0.16, seed: 12, phase: null, stickers: [{ name: 'Sticker | Crown (Foil)', wear: 0.3, usd: 800 }], charms: [] }] },
  ] }) }), env, NOW);
  const st = await api(env, U, 'steam');
  const kar = st.body.items.find((x: { name: string }) => x.name.includes('Karambit'));
  assert.equal(kar.details[0].phase, 'Ruby');
  assert.equal(kar.details[0].phaseKop, 3600000, '900 $ × 40 = 36 000 грн');
  assert.ok(kar.flags.includes('фаза Ruby'));
  assert.equal(kar.pattern, true, 'Doppler — цена зависит от паттерна');
  const ak = st.body.items.find((x: { name: string }) => x.name.includes('Redline'));
  assert.equal(ak.details[0].stickersKop, 3200000);
  assert.ok(ak.flags.includes('есть наклейки/брелки') && ak.flags.includes('низкий float'));
});
