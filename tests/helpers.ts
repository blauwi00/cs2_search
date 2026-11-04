import { TERMS_VERSION } from '../src/core/terms.ts';
// Тестовая обвязка: D1 поверх встроенного SQLite Node (тот же диалект SQL, что и у D1),
// подставной fetch и тестовые секреты.

import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Env } from '../src/env.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

export function fixture(name: string): string {
  return readFileSync(join(root, 'fixtures', name), 'utf8');
}
export const fixtureJson = (name: string): unknown => JSON.parse(fixture(name));

class Stmt {
  db: DatabaseSync; sql: string; params: unknown[]; owner: FakeD1;
  constructor(owner: FakeD1, sql: string, params: unknown[] = []) { this.owner = owner; this.db = owner.db; this.sql = sql; this.params = params; }
  bind(...v: unknown[]) {
    return new Stmt(this.owner, this.sql, v.map((x) => (x === undefined ? null : typeof x === 'boolean' ? (x ? 1 : 0) : x)));
  }
  private conv() { return this.params as (string | number | null)[]; }
  async first<T>() { this.owner.execs++; const r = this.db.prepare(this.sql).get(...this.conv()); return (r ? { ...r } : null) as T | null; }
  async all<T>() { this.owner.execs++; const r = this.db.prepare(this.sql).all(...this.conv()); return { results: r.map((x) => ({ ...x })) as T[], success: true, meta: {} }; }
  async run() { this.owner.execs++; const r = this.db.prepare(this.sql).run(...this.conv()); return { results: [], success: true, meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } }; }
  runSync() { const r = this.db.prepare(this.sql).run(...this.conv()); return { results: [], success: true, meta: { changes: Number(r.changes) } }; }
}

export class FakeD1 {
  db: DatabaseSync;
  calls = 0;
  /** Число запросов к «D1» (first/all/run/batch) — как их считает лимит Cloudflare. */
  execs = 0;
  constructor() { this.db = new DatabaseSync(':memory:'); }
  prepare(sql: string) { this.calls++; return new Stmt(this, sql) as unknown as D1PreparedStatement; }
  async batch(stmts: D1PreparedStatement[]) {
    this.execs++;
    this.db.exec('BEGIN');
    try {
      const out = stmts.map((s) => (s as unknown as Stmt).runSync());
      this.db.exec('COMMIT');
      return out;
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  async exec(sql: string) { this.db.exec(sql); return {}; }
}

/** termsAccepted: в большинстве тестов условия считаются принятыми (их проверяет отдельный тест). */
export function migratedDb(opts: { termsAccepted?: boolean } = {}): FakeD1 {
  const d = new FakeD1();
  const dir = join(root, 'migrations');
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) d.db.exec(readFileSync(join(dir, f), 'utf8'));
  if (opts.termsAccepted !== false) {
    d.db.exec(`CREATE TRIGGER test_terms AFTER INSERT ON users BEGIN
      INSERT OR IGNORE INTO user_settings (telegram_id, key, value, updated_at) VALUES (NEW.telegram_id, 'terms_ok', '${TERMS_VERSION}', 0); END;`);
  }
  return d;
}

export const ADMIN = 111222333;

export function testEnv(db: FakeD1, extra: Partial<Env> = {}): Env {
  return {
    DB: db as unknown as D1Database,
    TELEGRAM_BOT_TOKEN: 'TEST_TOKEN',
    TELEGRAM_WEBHOOK_SECRET: 'test_secret_value_123456',
    ADMIN_TELEGRAM_ID: String(ADMIN),
    ADMIN_KEY: 'admin_key_test_value',
    ...extra,
  };
}

export interface Route { match: (url: string) => boolean; respond: (url: string, init?: RequestInit) => Response | Promise<Response> }

export function mockFetch(routes: Route[]) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetcher = async (url: string, init?: RequestInit): Promise<Response> => {
    calls.push({ url, init });
    const r = routes.find((x) => x.match(url));
    if (!r) return new Response('not mocked: ' + url, { status: 599 });
    return r.respond(url, init);
  };
  return { fetcher, calls };
}

export const json = (v: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(typeof v === 'string' ? v : JSON.stringify(v), { status, headers: { 'Content-Type': 'application/json', ...headers } });

/** Telegram API: запоминает отправленные сообщения. */
export function telegramRoute(sent: { method: string; body: Record<string, unknown> }[]): Route {
  let id = 100;
  return {
    match: (u) => u.startsWith('https://api.telegram.org/'),
    respond: (u, init) => {
      const method = u.split('/').pop()!;
      sent.push({ method, body: JSON.parse(String(init?.body ?? '{}')) });
      return json({ ok: true, result: method === 'getMe' ? { username: 'test_bot' } : { message_id: ++id } });
    },
  };
}
