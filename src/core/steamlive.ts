/**
 * Живые цены Steam по всему рынку (домашний сборщик). Источник: steamcommunity.com/market/search/render (без входа),
 * поле sell_price — самое дешёвое объявление в центах USD. Это НЕ средняя продажа: цена, по которой предмет можно купить сейчас.
 * Приём: пачками до 1000 предметов, пишем только изменившееся (см. миграцию 0030).
 */
import { setMetaStmt } from './channel.ts';

export const STEAM_LIVE_BATCH_MAX = 1000;
export const STEAM_LIVE_REFRESH_SEC = 3 * 86400;   // запись без изменений обновляем раз в 3 суток
const ROWS_PER_STMT = 24;                           // 4 параметра на строку, лимит D1 — 100 параметров на запрос

export interface LiveRow { name: string; cents: number; listings: number | null }

/** Проверка пачки от сборщика: никаким полям не доверяем. */
export function parseSteamLive(items: unknown): LiveRow[] {
  const out: LiveRow[] = [];
  if (!items || typeof items !== 'object' || Array.isArray(items)) return out;
  for (const [name, v] of Object.entries(items as Record<string, unknown>).slice(0, STEAM_LIVE_BATCH_MAX)) {
    if (!name || name.length > 200 || !Array.isArray(v)) continue;
    const cents = v[0], n = v[1];
    if (typeof cents !== 'number' || !Number.isInteger(cents) || cents < 1 || cents > 1_000_000_000) continue;
    out.push({ name, cents, listings: typeof n === 'number' && Number.isInteger(n) && n >= 0 && n < 1e9 ? n : null });
  }
  return out;
}

export function steamLiveStmts(d: D1Database, rows: LiveRow[], at: number, passDone: boolean): D1PreparedStatement[] {
  const stmts: D1PreparedStatement[] = [];
  for (let i = 0; i < rows.length; i += ROWS_PER_STMT) {
    const part = rows.slice(i, i + ROWS_PER_STMT);
    stmts.push(d.prepare(`INSERT INTO steam_live (name, cents, listings, at) VALUES ${part.map(() => '(?, ?, ?, ?)').join(',')}
      ON CONFLICT(name) DO UPDATE SET cents = excluded.cents, listings = excluded.listings, at = excluded.at
      WHERE steam_live.cents != excluded.cents OR steam_live.listings IS NOT excluded.listings OR steam_live.at < excluded.at - ${STEAM_LIVE_REFRESH_SEC}`)
      .bind(...part.flatMap((r) => [r.name, r.cents, r.listings, at])));
  }
  stmts.push(setMetaStmt(d, 'steam_live_at', String(at)));
  if (passDone) stmts.push(setMetaStmt(d, 'steam_live_pass_at', String(at)));
  return stmts;
}

/** Живые цены по именам (до 90 имён на запрос). Нет записи — нет живой цены. */
export async function steamLiveFor(d: D1Database, names: string[]): Promise<Map<string, { cents: number; listings: number | null; at: number }>> {
  const out = new Map<string, { cents: number; listings: number | null; at: number }>();
  for (let i = 0; i < names.length; i += 90) {
    const part = names.slice(i, i + 90);
    const r = await d.prepare(`SELECT name, cents, listings, at FROM steam_live WHERE name IN (${part.map(() => '?').join(',')})`).bind(...part).all<{ name: string; cents: number; listings: number | null; at: number }>();
    for (const x of r.results) out.set(x.name, { cents: x.cents, listings: x.listings, at: x.at });
  }
  return out;
}
