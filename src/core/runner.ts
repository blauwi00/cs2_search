// Один запуск Cron: выбирает задачи, которым пора выполняться, и укладывается в лимиты вызова.

import type { Env } from '../env.ts';
import * as db from '../storage/db.ts';
import { budgetedDb, newBudget, BudgetExceeded, D1_RESERVE, type Budget } from '../storage/budget.ts';
import { ensureJobs, listJobs, tryAcquire, releaseOk, releaseFail, disableStuckJobs, jitterSec, type JobDef } from './scheduler.ts';
import * as P from './pipeline.ts';
import { SYSTEM_SETTINGS } from './audience.ts';
import { TelegramClient } from '../telegram/api.ts';
import type { Fetcher } from '../utils/http.ts';

/** Порядок важен: при нехватке лимита раньше выполняются верхние задачи. */
export const JOBS: (JobDef & { minD1: number })[] = [
  { name: 'fx', intervalSec: 3 * 3600, lockSec: 60, minD1: 3 },
  // Массовые источники дешёвые по запросам (1 внешний + 3–5 к D1) и идут раньше поштучного Steam.
  { name: 'skinport_items', intervalSec: 10 * 60, lockSec: 120, heavy: true, minD1: 6 },
  { name: 'skinport_sales', intervalSec: 15 * 60, lockSec: 120, heavy: true, minD1: 6 },
  { name: 'evaluate', intervalSec: 60, lockSec: 120, minD1: 10 },
  { name: 'steam', intervalSec: 60, lockSec: 120, minD1: 12 },
  { name: 'csfloat', intervalSec: 3 * 60, lockSec: 120, minD1: 12 },
  { name: 'outbox', intervalSec: 60, lockSec: 90, minD1: 5 },
  { name: 'health', intervalSec: 5 * 60, lockSec: 60, minD1: 2, firstDelaySec: 5 * 60 },
  { name: 'quality', intervalSec: 30 * 60, lockSec: 60, minD1: 4, firstDelaySec: 30 * 60 },
  { name: 'daily_report', intervalSec: 5 * 60, lockSec: 60, minD1: 3, firstDelaySec: 3 * 60 },
  { name: 'cleanup', intervalSec: 24 * 3600, lockSec: 120, minD1: 2, firstDelaySec: 3600 },
];

export interface CycleResult { ran: string[]; skipped: string[]; errors: { job: string; error: string }[]; budget: Budget; disabled: string[] }

export async function runCycle(env: Env, opts: { now: number; force?: string[]; fetcher?: Fetcher; rawDb?: D1Database } = { now: 0 }): Promise<CycleResult> {
  const budget = newBudget();
  const d = budgetedDb(opts.rawDb ?? env.DB, budget);
  const now = opts.now;
  const adminId = Number(env.ADMIN_TELEGRAM_ID);
  const tg = new TelegramClient(env.TELEGRAM_BOT_TOKEN, opts.fetcher);
  const result: CycleResult = { ran: [], skipped: [], errors: [], budget, disabled: [] };

  await ensureJobs(d, JOBS, now);
  // Сигналы считаются по общим (системным) порогам; рассылка фильтруется настройками каждого человека.
  // Включение/выключение источников — настройка администратора.
  const admin = await db.getSettings(d, adminId);
  const settings: db.Settings = { ...SYSTEM_SETTINGS, src_steam: admin.src_steam, src_skinport: admin.src_skinport, src_csfloat: admin.src_csfloat, max_stale_min: admin.max_stale_min };
  const ctx: P.Ctx = { env, db: d, tg, adminId, now, fetcher: opts.fetcher, budget, settings, cache: { counters: new Map() }, reserveD1: 0 };

  result.disabled = await disableStuckJobs(d, now);
  for (const name of result.disabled) {
    await db.log(d, 'error', name, 'cpu_limit', 'Задача отключена: запуски обрывались платформой (вероятно, лимит CPU 10 мс бесплатного тарифа)', now);
  }

  const jobs = new Map((await listJobs(d)).map((j) => [j.name, j]));
  const minD1 = (def: (typeof JOBS)[number]) => (def.name === 'csfloat' && !env.CSFLOAT_API_KEY ? 2 : def.minD1);
  // Только задачи, которым пора; из «тяжёлых» — не больше одной за вызов.
  const due: (typeof JOBS)[number][] = [];
  let heavyPicked = false;
  // Режим внешнего сборщика: Steam и Skinport опрашивает GitHub Actions (сеть Cloudflare они блокируют).
  const external = new Set(env.COLLECTOR === 'github' ? ['steam', 'skinport_items', 'skinport_sales'] : []);
  for (const def of JOBS) {
    if (external.has(def.name)) continue;
    const row = jobs.get(def.name);
    const forced = opts.force?.includes(def.name) ?? false;
    if (!row || row.enabled !== 1) { result.skipped.push(def.name); continue; }
    if (!forced && row.next_run_at > now) continue;
    if (def.heavy && heavyPicked) { result.skipped.push(def.name); continue; }
    if (def.heavy) heavyPicked = true;
    due.push(def);
  }
  for (let idx = 0; idx < due.length; idx++) {
    const def = due[idx];
    const row = jobs.get(def.name)!;
    const forced = opts.force?.includes(def.name) ?? false;
    // Лимит D1 делится честно: задача оставляет запросы тем, кто идёт после неё в этом вызове.
    ctx.reserveD1 = due.slice(idx + 1).reduce((s, x) => s + minD1(x), 0);
    if (budget.d1 - D1_RESERVE < minD1(def) || budget.external < 2) { result.skipped.push(def.name); continue; }

    const token = `${now}-${Math.random().toString(36).slice(2, 10)}`;
    if (!(await tryAcquire(d, def.name, def.lockSec, now, token, forced))) { result.skipped.push(def.name); continue; }
    try {
      let cursor: string | null | undefined;
      switch (def.name) {
        case 'fx': await P.jobFx(ctx); break;
        case 'steam': await P.jobSteam(ctx); break;
        case 'skinport_items': await P.jobSkinportItems(ctx); break;
        case 'skinport_sales': cursor = await P.jobSkinportSales(ctx, row.cursor); break;
        case 'evaluate': await P.jobEvaluate(ctx); break;
        case 'csfloat': await P.jobCsfloat(ctx); break;
        case 'outbox': await P.jobOutbox(ctx); break;
        case 'health': await P.jobHealth(ctx); break;
        case 'quality': await P.jobQuality(ctx); break;
        case 'daily_report': await P.jobDailyReport(ctx); break;
        case 'cleanup': await P.jobCleanup(ctx); break;
      }
      await releaseOk(d, def.name, token, def.intervalSec, now, def.intervalSec >= 300 ? jitterSec(20) : 0, cursor ?? null);
      result.ran.push(def.name);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      result.errors.push({ job: def.name, error: msg });
      if (e instanceof BudgetExceeded) {
        // Не ошибка источника: просто закончился лимит вызова. Продолжим в следующий запуск.
        // Блокировку снимаем через «сырое» подключение — на это оставлен запас вне бюджета задач.
        await releaseOk(opts.rawDb ?? env.DB, def.name, token, 0, now, 0);
        break;
      }
      const delay = await releaseFail(budget.d1 >= 2 ? d : (opts.rawDb ?? env.DB), def.name, token, e, def.intervalSec, now, jitterSec(30));
      await db.log(d, 'warn', def.name, 'job_failed', `${msg} (повтор через ${Math.round(delay / 60)} мин)`, now);
    }
  }
  try { await P.flushCounters(ctx); } catch { /* счётчики не критичны */ }
  return result;
}
