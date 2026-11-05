// Учёт лимитов одного вызова Worker на бесплатном тарифе:
// • не больше 50 запросов к D1 (db.batch() считается одним запросом);
// • не больше 50 внешних запросов (fetch к площадкам и Telegram).
// Обёртка считает запросы к D1 и не даёт превысить лимит: работа останавливается заранее
// и продолжается на следующем запуске Cron, а не падает посередине.

export class BudgetExceeded extends Error {
  constructor(kind: string) { super(`Исчерпан лимит запросов за вызов: ${kind}`); this.name = 'BudgetExceeded'; }
}

/** written — сколько строк записано в D1 за вызов (бесплатный лимит — 100 000 строк в сутки на весь аккаунт). */
export interface Budget { d1: number; external: number; written: number }

export const FREE_LIMITS = { d1: 50, external: 50 } as const;
/** Сколько запросов D1 обёртка разрешает задачам: 3 из 50 всегда остаются на аварийное снятие блокировки. */
export const D1_USABLE = FREE_LIMITS.d1 - 3;
/** Запас запросов D1, который задачи не трогают: он нужен, чтобы снять блокировку и сохранить счётчики. */
export const D1_RESERVE = 4;

export function newBudget(): Budget {
  return { d1: D1_USABLE, external: FREE_LIMITS.external, written: 0 };
}

export function budgetedDb(inner: D1Database, budget: Budget): D1Database {
  const take = () => {
    if (budget.d1 <= 0) throw new BudgetExceeded('D1');
    budget.d1--;
  };
  const count = <R>(r: R): R => { budget.written += rowsWritten(r); return r; };
  const wrapStmt = (st: D1PreparedStatement): D1PreparedStatement & { __inner: D1PreparedStatement } => {
    const w = {
      __inner: st,
      bind: (...v: unknown[]) => wrapStmt(st.bind(...v)),
      first: async <T>() => { take(); return st.first<T>(); },
      all: async <T>() => { take(); return count(await st.all<T>()); },
      run: async () => { take(); return count(await st.run()); },
    };
    return w as D1PreparedStatement & { __inner: D1PreparedStatement };
  };
  return {
    prepare: (q: string) => wrapStmt(inner.prepare(q)),
    batch: async (stmts: D1PreparedStatement[]) => {
      if (stmts.length === 0) return [];
      take();
      const res = await inner.batch(stmts.map((s) => (s as unknown as { __inner?: D1PreparedStatement }).__inner ?? s));
      for (const r of res) count(r);
      return res;
    },
    exec: async (q: string) => { take(); return inner.exec(q); },
  };
}

/** Записанные строки по ответу D1 (rows_written; в тестовой базе — changes). */
export function rowsWritten(r: unknown): number {
  const m = (r as { meta?: { rows_written?: unknown; changes?: unknown } } | null)?.meta;
  const n = Number(m?.rows_written ?? m?.changes ?? 0);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** Учёт записей выборочно (1 из 10 вызовов, ×10): сам учёт тоже тратит записи, поэтому не на каждый вызов. */
export const WRITE_SAMPLE = 10;
export const sampleWrites = (): boolean => Math.random() < 1 / WRITE_SAMPLE;
