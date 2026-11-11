// История: суточные точки стоимости инвентаря и цен на площадках; сравнение «за неделю».
import test from 'node:test';
import assert from 'node:assert/strict';
import { migratedDb } from './helpers.ts';
import { jobHistory, weekDelta, parseTop, cleanupHistoryStmts } from '../src/core/history.ts';
import type { Ctx } from '../src/core/pipeline.ts';

const T = (day: string, h = 20) => Date.parse(`${day}T${String(h).padStart(2, '0')}:00:00Z`) / 1000; // 20 UTC = 21–22 Варшава

test('запись раз в сутки вечером: стоимость инвентаря, топ позиций, цены площадок только отслеживаемых предметов', async () => {
  const d = migratedDb(); const D = d as unknown as D1Database;
  const now = T('2026-11-10');
  d.db.exec(`INSERT INTO items (id, market_hash_name, category, created_at) VALUES (1, 'Revolution Case', 'case', 0), (2, 'AK-47 | Redline (Field-Tested)', 'weapon', 0), (3, 'Чужой предмет', 'weapon', 0)`);
  d.db.exec(`INSERT INTO steam_inventory (telegram_id, item_id, qty, marketable) VALUES (1, 1, 10, 1), (1, 2, 1, 1), (2, 1, 5, 0)`);
  d.db.exec(`INSERT INTO steam_avg (item_id, d1, d7, d30, d90, updated_at) VALUES (1, 100, 100, 100, 100, ${now}), (2, 2000, 2000, 2000, 2000, ${now})`);
  d.db.exec(`INSERT INTO site_prices (name, json, updated_at) VALUES ('Revolution Case', '{"waxpeer":95}', ${now}), ('Чужой предмет', '{"waxpeer":1}', ${now})`);
  assert.equal((await jobHistory({ db: D, now: T('2026-11-10', 10) } as Ctx)).wrote, false, 'утром не пишем');
  assert.equal((await jobHistory({ db: D, now } as Ctx)).wrote, true);
  assert.equal((await jobHistory({ db: D, now: now + 60 } as Ctx)).wrote, false, 'второй раз за день — нет');
  const rows = d.db.prepare('SELECT telegram_id, total_usd_c, top FROM inv_value_daily').all() as { telegram_id: number; total_usd_c: number; top: string }[];
  assert.equal(rows.length, 1, 'человек 2 — предметы нельзя продать, строки нет');
  assert.equal(rows[0]!.total_usd_c, 3000);
  assert.deepEqual(parseTop(rows[0]!.top), { '1': [100, 10], '2': [2000, 1] });
  const sp = d.db.prepare('SELECT item_id, json FROM site_price_daily').all() as { item_id: number; json: string }[];
  assert.deepEqual(sp.map((x) => x.item_id), [1], 'только предметы из инвентарей и наблюдений');
  cleanupHistoryStmts(D, now + 200 * 86400).forEach((s) => (s as unknown as { run: () => unknown }).run());
  assert.equal((d.db.prepare('SELECT COUNT(*) AS n FROM inv_value_daily').get() as { n: number }).n, 0, 'старше 120 дней удаляется');
});

test('за неделю: сравнение с точкой 6–10 дней назад, топ-3 по изменению×количество; мало истории — честный ноль', () => {
  const r = (day: string, total: number, top: Record<string, [number, number]>) => ({ day, total, top });
  assert.deepEqual(weekDelta([]), { delta: null, days: 0 });
  assert.equal(weekDelta([r('2026-11-10', 3000, {})]).delta, null);
  assert.equal(weekDelta([r('2026-11-10', 3000, {}), r('2026-11-08', 2500, {})]).delta, null, '2 дня — ещё не неделя');
  const { delta, days } = weekDelta([
    r('2026-11-10', 3300, { '1': [150, 10], '2': [1800, 1], '9': [50, 1] }),
    r('2026-11-03', 3000, { '1': [100, 10], '2': [2000, 1] }),
    r('2026-11-05', 3100, {}),
  ]);
  assert.equal(days, 3);
  assert.equal(delta!.deltaUsdC, 300); assert.equal(delta!.fromDay, '2026-11-03');
  assert.equal(Math.round(delta!.pct), 10);
  assert.deepEqual(delta!.movers, [{ id: 1, deltaUsdC: 500 }, { id: 2, deltaUsdC: -200 }], 'новый предмет без прошлой цены не считается');
});
