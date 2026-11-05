// #3: воскресная сводка по инвентарю Steam.
import test from 'node:test';
import assert from 'node:assert/strict';
import { migratedDb } from './helpers.ts';
import { jobWeekly, isSunday } from '../src/core/weekly.ts';
import * as db from '../src/storage/db.ts';

const SUN = Date.parse('2026-11-08T18:30:00Z') / 1000;  // воскресенье, 19:30 Варшава
const WED = Date.parse('2026-11-04T18:30:00Z') / 1000;

test('воскресная сводка: первый раз — оценка, через неделю — изменение и лидеры; выключение работает', async () => {
  assert.equal(isSunday(SUN), true); assert.equal(isSunday(WED), false);
  const d = migratedDb(); const D = d as unknown as D1Database;
  await db.storeFx(D, [{ base: 'USD', rateMicro: 40_000_000, rateDate: '2026-11-04', source: 'nbu' }], WED);
  for (const u of [1, 2]) await db.ensureUser(D, u, false, WED);
  await db.setSetting(D, 2, 'weekly_report', '0', WED);
  d.db.exec(`INSERT INTO items (id, market_hash_name, category, created_at) VALUES (1, 'Revolution Case', 'case', 0), (2, 'AK-47 | Redline (Field-Tested)', 'weapon', 0)`);
  d.db.exec(`INSERT INTO steam_inventory (telegram_id, item_id, qty) VALUES (1, 1, 10), (1, 2, 1), (2, 1, 5)`);
  d.db.exec(`INSERT INTO steam_avg (item_id, d1, d7, d30, d90, updated_at) VALUES (1, 100, 100, 100, 100, ${SUN}), (2, 2000, 2000, 2000, 2000, ${SUN})`);

  assert.equal((await jobWeekly({ db: D, now: WED })).queued, 0, 'не воскресенье');
  assert.equal((await jobWeekly({ db: D, now: SUN })).queued, 1);
  let row = d.db.prepare("SELECT text FROM outbox WHERE kind='weekly' AND telegram_id=1").get() as { text: string };
  assert.match(row.text, /Сейчас стоит ≈/); assert.match(row.text, /⟦120000⟧/); // $30 × 40 = 1200 грн
  assert.equal((await jobWeekly({ db: D, now: SUN + 600 })).queued, 0, 'второй раз в то же воскресенье — нет');
  assert.equal((d.db.prepare("SELECT COUNT(*) AS n FROM outbox WHERE telegram_id=2").get() as { n: number }).n, 0, 'выключил — не шлём');

  d.db.exec(`UPDATE steam_avg SET d1 = 150, updated_at = ${SUN + 7 * 86400} WHERE item_id = 1`);
  d.db.exec(`UPDATE steam_avg SET updated_at = ${SUN + 7 * 86400} WHERE item_id = 2`);  // кейс подорожал на 50%
  assert.equal((await jobWeekly({ db: D, now: SUN + 7 * 86400 })).queued, 1);
  row = d.db.prepare("SELECT text, keyboard FROM outbox WHERE kind='weekly' AND telegram_id=1 ORDER BY id DESC").get() as { text: string; keyboard: string };
  assert.match(row.text, /за неделю: ⟦\+20000⟧<\/b> \(\+16,7%\)/);    // +$5 = +200 грн, 30 → 35 $
  assert.match(row.text, /▲ Revolution Case: ⟦\+20000⟧/);
  assert.ok(row.keyboard.includes('wk:off'));
});
