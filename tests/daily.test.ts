// Ежедневная сводка: пустую (всё по нулям) не шлём; при продажах/инвентаре/возможностях — шлём.
import test from 'node:test';
import assert from 'node:assert/strict';
import { migratedDb, testEnv } from './helpers.ts';
import * as P from '../src/core/pipeline.ts';
import * as db from '../src/storage/db.ts';
import * as T from '../src/storage/trades.ts';
import { TelegramClient } from '../src/telegram/api.ts';
import { newBudget } from '../src/storage/budget.ts';

const NOW = Date.parse('2026-11-04T20:30:00Z') / 1000; // 21:30 по Варшаве — после часа сводки (20)

function ctxFor(d: ReturnType<typeof migratedDb>, now: number): P.Ctx {
  const env = testEnv(d);
  return { env, db: d as unknown as D1Database, tg: new TelegramClient('x'), adminId: Number(env.ADMIN_TELEGRAM_ID), now, budget: newBudget(),
    settings: {} as db.Settings, cache: { counters: new Map() }, reserveD1: 0 };
}
const daily = (d: ReturnType<typeof migratedDb>, tid: number) =>
  (d.db.prepare(`SELECT COUNT(*) AS n FROM outbox WHERE telegram_id = ? AND ref LIKE 'daily:%'`).get(tid) as { n: number }).n;

test('ежедневная сводка: всё по нулям — не отправляется (но день отмечен); с инвентарём — отправляется', async () => {
  const d = migratedDb();
  const D = d as unknown as D1Database;
  const it = await db.upsertItem(D, 'Revolution Case', NOW);
  for (const u of [11, 12]) { await db.ensureUser(D, u, false, NOW); await db.addWatch(D, u, it.id, NOW); }
  await T.addTrade(D, { tid: 12, itemId: it.id, signalId: null, quantity: 1, buyPriceKop: 1000, buyFeeKop: 0, platform: 'steam', buyDate: '2026-11-01', note: null, now: NOW });
  await P.jobDailyReport(ctxFor(d, NOW));
  assert.equal(daily(d, 11), 0, 'пустая сводка не уходит');
  assert.equal(daily(d, 12), 1, 'есть инвентарь — сводка уходит');
  assert.ok(d.db.prepare(`SELECT 1 FROM user_settings WHERE telegram_id = 11 AND key = 'last_daily_report'`).get(), 'день отмечен — не перебираем снова');
});
