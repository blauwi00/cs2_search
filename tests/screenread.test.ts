// Импорт выставленных на Skinport предметов: сопоставление с инвентарём, только для владельца, запись пачкой «ждёт оплаты».
import test from 'node:test';
import assert from 'node:assert/strict';
import { migratedDb, testEnv } from './helpers.ts';
import { signInitData } from '../src/webapp/auth.ts';
import { handleAppApi } from '../src/webapp/api.ts';
import { storeInventory } from '../src/core/steaminv.ts';
import { matchName } from '../src/core/screenread.ts';
import { SKINPORT_LISTED } from '../src/webapp/import_skinport.ts';

test('сопоставление с инвентарём: точно, без регистра, без износа (если один); не угадываем', () => {
  assert.equal(matchName(['Tec-9 | Rebel (Field-Tested)'], ['tec-9 | rebel (field-tested)']), 'tec-9 | rebel (field-tested)');
  assert.equal(matchName(['P2000 | Marsh'], ['P2000 | Marsh (Minimal Wear)']), 'P2000 | Marsh (Minimal Wear)');
  assert.equal(matchName(['P2000 | Marsh'], ['P2000 | Marsh (Minimal Wear)', 'P2000 | Marsh (Field-Tested)']), null, 'два варианта — не угадываем');
  assert.equal(matchName([], ['A']), null);
  assert.equal(SKINPORT_LISTED.length, 21);
  assert.ok(Math.abs(SKINPORT_LISTED.reduce((s, x) => s + x.priceMinor, 0) - 795) < 1, 'сумма со скриншотов — 7,95 PLN');
});

test('импорт со Skinport: только владельцу; сопоставлено с инвентарём; запись пачкой «ждёт оплаты»', async () => {
  const d = migratedDb();
  const D = d as unknown as D1Database;
  const env = testEnv(d);
  const ADMIN = Number(env.ADMIN_TELEGRAM_ID), SID = '76561198000000011', NOW = Date.parse('2026-11-06T02:00:00Z') / 1000;
  d.db.prepare('INSERT INTO users (telegram_id, created_at, steam_id, steam_verified) VALUES (?, ?, ?, 1)').run(ADMIN, NOW, SID);
  await storeInventory(D, ADMIN, { status: 'ok', steamId: SID, items: [{ name: 'Dreams & Nightmares Case', qty: 3, marketable: 1, tradable: 1, img: null }, { name: 'P2000 | Marsh (Field-Tested)', qty: 1, marketable: 1, tradable: 1, img: null }], partial: false }, NOW - 100);
  const call = async (uid: number, path: string, method = 'GET', body?: unknown) => {
    const init = await signInitData({ auth_date: String(NOW), query_id: 'Q', user: JSON.stringify({ id: uid }) }, 'TEST_TOKEN');
    return (await handleAppApi(new Request('https://w.dev/app/api/' + path, { method, headers: { 'X-Init-Data': init }, body: body ? JSON.stringify(body) : undefined }), env, NOW)).json() as Promise<Record<string, any>>;
  };
  assert.equal((await call(555, 'import/skinport')).ok, false, 'чужому — нет');
  const r = await call(ADMIN, 'import/skinport');
  assert.equal(r.items.length, 21);
  assert.equal(r.items[0].name, 'Dreams & Nightmares Case');
  assert.equal(r.items.find((x: any) => /Marsh/.test(x.text)).name, 'P2000 | Marsh (Field-Tested)', 'износ взят из инвентаря');
  assert.equal(r.items[1].name, null, 'Kitbash нет в инвентаре — выбрать вручную');
  const b = await call(ADMIN, 'sales/batch', 'POST', { rows: [{ name: 'Dreams & Nightmares Case', qty: 1, receivedKop: 3500, platform: 'skinport', buyKop: 0, pending: true }] });
  assert.equal(b.sold, 1);
  assert.equal((await call(ADMIN, 'trades')).pending.length, 1);
});
