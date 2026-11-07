// Горячие рекомендации по всему рынку: по порогам каждого, не чаще лимита, без повторов, с кнопкой «Не присылать».
import test from 'node:test';
import assert from 'node:assert/strict';
import { migratedDb, testEnv } from './helpers.ts';
import { handleIngest } from '../src/ingest.ts';
import { jobHotRecs } from '../src/core/hotrecs.ts';
import * as db from '../src/storage/db.ts';

const NOW = Date.parse('2026-11-04T12:00:00Z') / 1000; // 13:00 Варшава
const SECRET = 'ingest_secret_test_123';
const item = (name: string, p: number, median: number) => ({ name, offers: { skinport: { p, q: 50 } }, s7: { median, volume: 300 }, s30: { median, volume: 1200 } });

test('горячие рекомендации: новая сделка уходит тем, у кого включено и хватает порога; повтор — нет; лимит в сутки', async () => {
  const d = migratedDb(); const D = d as unknown as D1Database;
  const env = testEnv(d, { INGEST_SECRET: SECRET });
  await db.storeFx(D, [{ base: 'EUR', rateMicro: 45_000_000, rateDate: '2026-11-04', source: 'nbu' }, { base: 'USD', rateMicro: 40_000_000, rateDate: '2026-11-04', source: 'nbu' }], NOW);
  for (const u of [1, 2, 3, 4]) await db.ensureUser(D, u, false, NOW);
  await db.setSetting(D, 2, 'notify_recs', '0', NOW);              // выключил
  await db.setSetting(D, 3, 'min_profit_kop', '99999900', NOW);    // порог слишком высокий
  await db.setSetting(D, 4, 'recs_per_day', '1', NOW);
  const scan = (items: object[], at: number) => handleIngest(new Request('https://w.example.dev/ingest', { method: 'POST', headers: { 'X-Ingest-Secret': SECRET }, body: JSON.stringify({ kind: 'scan', fetchedAt: at, items }) }), env, at);
  await scan([item('Revolution Case', 10, 13)], NOW - 600);
  await scan([item('Revolution Case', 10, 13)], NOW);
  assert.equal((await jobHotRecs({ db: D, now: NOW + 60 })).queued, 2);
  const rows = d.db.prepare("SELECT telegram_id, text, keyboard FROM outbox WHERE kind = 'recs' ORDER BY telegram_id").all() as { telegram_id: number; text: string; keyboard: string }[];
  assert.deepEqual(rows.map((r) => r.telegram_id), [1, 4]);
  assert.match(rows[0].text, /Горячая рекомендация[\s\S]*Revolution Case[\s\S]*Купить: Skinport/);
  assert.ok(JSON.parse(rows[0].keyboard).flat().some((b: { callback_data?: string }) => b.callback_data === 'nr:off'));
  assert.equal((await jobHotRecs({ db: D, now: NOW + 120 })).queued, 0, 'та же проверка рынка — второй раз не рассылаем');
  await scan([item('Revolution Case', 10, 13)], NOW + 600);
  assert.equal((await jobHotRecs({ db: D, now: NOW + 660 })).queued, 0, 'та же сделка — не повторяем');
  await scan([item('Revolution Case', 10, 13), item('Fever Case', 20, 26)], NOW + 1200);
  assert.equal((await jobHotRecs({ db: D, now: NOW + 1260 })).queued, 0, 'новое объявление — ждём подтверждения следующей проверкой');
  await scan([item('Revolution Case', 10, 13), item('Fever Case', 20, 26)], NOW + 1800);
  const r = await jobHotRecs({ db: D, now: NOW + 1860 });
  assert.equal(r.queued, 1, 'новая сделка — только тому, у кого не исчерпан лимит в сутки');
  assert.equal((d.db.prepare("SELECT COUNT(*) AS n FROM outbox WHERE kind = 'recs' AND telegram_id = 4").get() as { n: number }).n, 1);
});

test('горячие рекомендации частями: 650 человек — по 300 за запуск, каждый получает одну, без потолка и без повторов', async () => {
  const d = migratedDb(); const D = d as unknown as D1Database;
  const env = testEnv(d, { INGEST_SECRET: SECRET });
  await db.storeFx(D, [{ base: 'EUR', rateMicro: 45_000_000, rateDate: '2026-11-04', source: 'nbu' }, { base: 'USD', rateMicro: 40_000_000, rateDate: '2026-11-04', source: 'nbu' }], NOW);
  const ins = d.db.prepare('INSERT INTO users (telegram_id, is_admin, created_at) VALUES (?, 0, ?)');
  for (let u = 1; u <= 650; u++) ins.run(u, NOW);
  const scan = (items: object[], at: number) => handleIngest(new Request('https://w.example.dev/ingest', { method: 'POST', headers: { 'X-Ingest-Secret': SECRET }, body: JSON.stringify({ kind: 'scan', fetchedAt: at, items }) }), env, at);
  await scan([item('Revolution Case', 10, 13)], NOW - 600);
  await scan([item('Revolution Case', 10, 13)], NOW);
  const n = () => ({ ...(d.db.prepare("SELECT COUNT(*) AS n, COUNT(DISTINCT telegram_id) AS u FROM outbox WHERE kind = 'recs'").get() as { n: number; u: number }) });
  assert.equal((await jobHotRecs({ db: D, now: NOW + 60 })).queued, 300);
  await jobHotRecs({ db: D, now: NOW + 120 });
  await jobHotRecs({ db: D, now: NOW + 180 });
  assert.deepEqual(n(), { n: 650, u: 650 }, 'все 650 получили по одной');
  assert.equal((await jobHotRecs({ db: D, now: NOW + 240 })).queued, 0, 'рассылка по этой проверке закончена');
});
