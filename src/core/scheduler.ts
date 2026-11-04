// Планировщик задач поверх D1. Cron вызывает Worker каждую минуту; здесь решается, какие задачи
// действительно пора выполнять. Защита от параллельного запуска — атомарный UPDATE с проверкой lock_until.

import { SourceError } from '../types/market.ts';

export interface JobDef {
  name: string;
  intervalSec: number;
  /** Максимальное время, на которое задача удерживает блокировку. */
  lockSec: number;
  /** Задачи-«тяжеловесы» запускаются не больше одной за вызов. */
  heavy?: boolean;
  /** Задержка первого запуска: служебные задачи не должны отнимать лимит у сбора цен в первую минуту. */
  firstDelaySec?: number;
}

export const MAX_BACKOFF_SEC = 6 * 3600;
/** Сколько подряд оборванных запусков (например, превышение лимита CPU) до автоматического отключения задачи. */
export const MAX_UNFINISHED = 3;

export async function ensureJobs(db: D1Database, defs: JobDef[], now: number): Promise<void> {
  await db.batch(defs.map((d) => db.prepare(
    `INSERT INTO scheduler_jobs (name, interval_sec, next_run_at) VALUES (?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET interval_sec = excluded.interval_sec`,
  ).bind(d.name, d.intervalSec, now + (d.firstDelaySec ?? 0))));
}

export interface JobRow {
  name: string; interval_sec: number; next_run_at: number; lock_until: number; last_ok_at: number | null; last_run_at: number | null;
  last_error: string | null; fail_count: number; started_unfinished: number; enabled: number; cursor: string | null;
}

export async function listJobs(db: D1Database): Promise<JobRow[]> {
  return (await db.prepare('SELECT * FROM scheduler_jobs ORDER BY name').all<JobRow>()).results;
}

/**
 * Пытается захватить задачу. true — только у одного вызова, даже если Cron сработал дважды.
 * started_unfinished увеличивается при захвате и обнуляется при нормальном завершении:
 * если платформа оборвала выполнение, счётчик останется увеличенным.
 */
export async function tryAcquire(db: D1Database, name: string, lockSec: number, now: number, token: string, force = false): Promise<boolean> {
  const r = await db.prepare(
    `UPDATE scheduler_jobs SET lock_until = ?, lock_token = ?, last_run_at = ?, started_unfinished = started_unfinished + 1
     WHERE name = ? AND enabled = 1 AND lock_until < ? AND (next_run_at <= ? OR ? = 1)`,
  ).bind(now + lockSec, token, now, name, now, now, force ? 1 : 0).run();
  return (r.meta.changes ?? 0) === 1;
}

export function backoffSec(intervalSec: number, failCount: number, retryAfterSec: number | null, jitter: number): number {
  const exp = Math.min(MAX_BACKOFF_SEC, intervalSec * 2 ** Math.min(failCount, 10));
  const base = Math.max(exp, retryAfterSec ?? 0);
  return Math.min(MAX_BACKOFF_SEC, base) + jitter;
}

export async function releaseOk(db: D1Database, name: string, token: string, intervalSec: number, now: number, jitter: number, cursor?: string | null): Promise<void> {
  await db.prepare(
    `UPDATE scheduler_jobs SET lock_until = 0, lock_token = NULL, last_ok_at = ?, last_error = NULL, fail_count = 0, started_unfinished = 0,
       next_run_at = ?, cursor = COALESCE(?, cursor) WHERE name = ? AND lock_token = ?`,
  ).bind(now, now + intervalSec + jitter, cursor ?? null, name, token).run();
}

export async function releaseFail(db: D1Database, name: string, token: string, err: unknown, intervalSec: number, now: number, jitter: number): Promise<number> {
  const row = await db.prepare('SELECT fail_count FROM scheduler_jobs WHERE name = ?').bind(name).first<{ fail_count: number }>();
  const fails = (row?.fail_count ?? 0) + 1;
  const retryAfter = err instanceof SourceError ? err.retryAfterSec : null;
  // Ошибки доступа/ключа не исправятся сами быстро — сразу большой интервал.
  const permanent = err instanceof SourceError && (err.kind === 'forbidden' || err.kind === 'auth');
  const delay = permanent ? MAX_BACKOFF_SEC : backoffSec(intervalSec, fails, retryAfter, jitter);
  const msg = err instanceof Error ? err.message : String(err);
  await db.prepare(
    `UPDATE scheduler_jobs SET lock_until = 0, lock_token = NULL, last_error = ?, fail_count = ?, started_unfinished = 0, next_run_at = ?
     WHERE name = ? AND lock_token = ?`,
  ).bind(msg.slice(0, 300), fails, now + delay, name, token).run();
  return delay;
}

/** Задачи, чьи запуски несколько раз подряд обрывались, — выключаются, чтобы не тратить лимиты впустую. */
export async function disableStuckJobs(db: D1Database, now: number): Promise<string[]> {
  const r = await db.prepare(
    `SELECT name FROM scheduler_jobs WHERE enabled = 1 AND started_unfinished >= ? AND lock_until < ?`,
  ).bind(MAX_UNFINISHED, now).all<{ name: string }>();
  const names = r.results.map((x) => x.name);
  if (names.length) {
    await db.batch(names.map((n) => db.prepare(
      `UPDATE scheduler_jobs SET enabled = 0, last_error = 'Отключено: запуск обрывался платформой (вероятно, лимит CPU бесплатного тарифа)' WHERE name = ?`,
    ).bind(n)));
  }
  return names;
}

export async function setJobEnabled(db: D1Database, name: string, enabled: boolean, now: number): Promise<void> {
  await db.prepare('UPDATE scheduler_jobs SET enabled = ?, started_unfinished = 0, fail_count = 0, next_run_at = ? WHERE name = ?').bind(enabled ? 1 : 0, now, name).run();
}

export const jitterSec = (max = 15): number => Math.floor(Math.random() * (max + 1));
