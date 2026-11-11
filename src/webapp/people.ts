// Вкладка владельца «Люди»: кто пользуется ботом, что у них в инвентаре и списке, что делали. Только для администратора (проверка в api.ts).
// Данные уже есть в базе; ник и имя из Telegram — ключи user_settings tg_username / tg_name (удаляются вместе с остальными данными).
import { toKop, type FxRate } from '../currency/nbu.ts';

export type PeopleFilter = 'all' | 'new' | 'steam' | 'list';
export const PEOPLE_PAGE = 30;

export interface PersonRow {
  id: number; createdAt: number; seen: number | null; ref: string | null; username: string | null; name: string | null;
  steam: boolean; watch: number; trades: number;
}

const FILTER_SQL: Record<PeopleFilter, string> = {
  all: '1=1',
  new: 'u.created_at >= ?1 - 7 * 86400',
  steam: '(u.steam_id IS NOT NULL OR u.steam_vanity IS NOT NULL)',
  list: 'EXISTS (SELECT 1 FROM watchlist w WHERE w.telegram_id = u.telegram_id AND w.active = 1)',
};

export function normalizeName(username: unknown, firstName: unknown): { username: string | null; name: string | null } {
  const u = typeof username === 'string' && /^[A-Za-z0-9_]{3,40}$/.test(username) ? username : null;
  const n = typeof firstName === 'string' ? firstName.replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 60) : '';
  return { username: u, name: n || null };
}

/** Записать ник и имя, только если они изменились (лишних записей в базу нет). */
export function saveNameStmts(d: D1Database, tid: number, username: unknown, firstName: unknown, now: number): D1PreparedStatement[] {
  const { username: u, name: n } = normalizeName(username, firstName);
  const up = (key: string, v: string) => d.prepare(
    `INSERT INTO user_settings (telegram_id, key, value, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(telegram_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at WHERE user_settings.value != excluded.value`).bind(tid, key, v, now);
  return [...(u ? [up('tg_username', u)] : []), ...(n ? [up('tg_name', n)] : [])];
}

export async function peopleList(d: D1Database, now: number, filter: PeopleFilter, offset: number) {
  const where = FILTER_SQL[filter] ?? FILTER_SQL.all;
  const base = `u.is_admin = 0 AND u.telegram_id > 0`;
  const [sum, rows] = await Promise.all([
    d.prepare(`SELECT COUNT(*) AS total,
        SUM(COALESCE(s.updated_at, u.created_at) >= ?1 - 86400) AS today,
        SUM(u.created_at >= ?1 - 86400) AS newToday,
        SUM(COALESCE(s.updated_at, 0) >= ?1 - 86400 AND COALESCE(s.updated_at, 0) >= u.created_at + 604800) AS back,
        SUM(u.steam_id IS NOT NULL OR u.steam_vanity IS NOT NULL) AS steam,
        SUM(EXISTS (SELECT 1 FROM watchlist w WHERE w.telegram_id = u.telegram_id AND w.active = 1)) AS list
      FROM users u LEFT JOIN user_settings s ON s.telegram_id = u.telegram_id AND s.key = 'seen' WHERE ${base}`).bind(now)
      .first<{ total: number; today: number | null; newToday: number | null; back: number | null; steam: number | null; list: number | null }>(),
    d.prepare(`SELECT u.telegram_id AS id, u.created_at AS createdAt, s.updated_at AS seen, r.value AS ref, un.value AS username, nm.value AS name,
        (u.steam_id IS NOT NULL OR u.steam_vanity IS NOT NULL) AS steam,
        (SELECT COUNT(*) FROM watchlist w WHERE w.telegram_id = u.telegram_id AND w.active = 1) AS watch,
        (SELECT COUNT(*) FROM trades t WHERE t.telegram_id = u.telegram_id) AS trades
      FROM users u
      LEFT JOIN user_settings s ON s.telegram_id = u.telegram_id AND s.key = 'seen'
      LEFT JOIN user_settings r ON r.telegram_id = u.telegram_id AND r.key = 'ref'
      LEFT JOIN user_settings un ON un.telegram_id = u.telegram_id AND un.key = 'tg_username'
      LEFT JOIN user_settings nm ON nm.telegram_id = u.telegram_id AND nm.key = 'tg_name'
      WHERE ${base} AND ${where}
      ORDER BY COALESCE(s.updated_at, u.created_at) DESC LIMIT ?2 OFFSET ?3`).bind(now, PEOPLE_PAGE + 1, Math.max(0, offset | 0))
      .all<Omit<PersonRow, 'steam'> & { steam: number }>(),
  ]);
  const list = rows.results.slice(0, PEOPLE_PAGE).map((r) => ({ ...r, steam: !!r.steam }));
  return {
    summary: { total: sum?.total ?? 0, today: sum?.today ?? 0, newToday: sum?.newToday ?? 0, back: sum?.back ?? 0, steam: sum?.steam ?? 0, list: sum?.list ?? 0 },
    people: list as PersonRow[], more: rows.results.length > PEOPLE_PAGE,
  };
}

export async function personCard(d: D1Database, now: number, tid: number, usd: FxRate | null) {
  const [u, inv, watch, tr, ev] = await Promise.all([
    d.prepare(`SELECT u.telegram_id AS id, u.created_at AS createdAt, u.inv_status AS invStatus, u.inv_synced_at AS invSyncedAt, s.updated_at AS seen, r.value AS ref, un.value AS username, nm.value AS name,
        (u.steam_id IS NOT NULL OR u.steam_vanity IS NOT NULL) AS steam
      FROM users u LEFT JOIN user_settings s ON s.telegram_id = u.telegram_id AND s.key = 'seen'
      LEFT JOIN user_settings r ON r.telegram_id = u.telegram_id AND r.key = 'ref'
      LEFT JOIN user_settings un ON un.telegram_id = u.telegram_id AND un.key = 'tg_username'
      LEFT JOIN user_settings nm ON nm.telegram_id = u.telegram_id AND nm.key = 'tg_name'
      WHERE u.telegram_id = ? AND u.is_admin = 0`).bind(tid).first<Record<string, unknown>>(),
    d.prepare(`SELECT i.market_hash_name AS name, v.qty, v.marketable, COALESCE(a.d1, a.d7) AS unit
      FROM steam_inventory v JOIN items i ON i.id = v.item_id LEFT JOIN steam_avg a ON a.item_id = v.item_id
      WHERE v.telegram_id = ? ORDER BY COALESCE(a.d1, a.d7, 0) * v.qty DESC LIMIT 40`).bind(tid).all<{ name: string; qty: number; marketable: number; unit: number | null }>(),
    d.prepare(`SELECT i.market_hash_name AS name, w.target_buy_kop AS target FROM watchlist w JOIN items i ON i.id = w.item_id
      WHERE w.telegram_id = ? AND w.active = 1 ORDER BY w.created_at DESC LIMIT 30`).bind(tid).all<{ name: string; target: number | null }>(),
    d.prepare(`SELECT COUNT(*) AS n, SUM(status = 'open') AS open, COALESCE(SUM(sold_quantity), 0) AS sold FROM trades WHERE telegram_id = ?`).bind(tid).first<{ n: number; open: number | null; sold: number }>(),
    d.prepare(`SELECT at, k, t FROM (
        SELECT w.created_at AS at, 'watch' AS k, i.market_hash_name AS t FROM watchlist w JOIN items i ON i.id = w.item_id WHERE w.telegram_id = ?1
        UNION ALL SELECT t.created_at, 'buy', i.market_hash_name FROM trades t JOIN items i ON i.id = t.item_id WHERE t.telegram_id = ?1
        UNION ALL SELECT ts.created_at, 'sell', i.market_hash_name FROM trade_sales ts JOIN trades t ON t.id = ts.trade_id JOIN items i ON i.id = t.item_id WHERE t.telegram_id = ?1
        UNION ALL SELECT f.created_at, 'report', COALESCE(f.item, '') FROM feedback f WHERE f.telegram_id = ?1
        UNION ALL SELECT o.created_at, 'notice', o.kind FROM outbox o WHERE o.telegram_id = ?1 AND o.state = 'sent'
      ) ORDER BY at DESC LIMIT 20`).bind(tid).all<{ at: number; k: string; t: string }>(),
  ]);
  if (!u) return null;
  const items = inv.results.map((r) => ({ name: r.name, qty: r.qty, marketable: !!r.marketable, kop: r.unit && usd ? toKop(r.unit, 'USD', usd) : null }));
  const totalKop = items.reduce((a, x) => a + (x.marketable && x.kop ? x.kop * x.qty : 0), 0);
  return {
    person: { ...u, steam: !!u.steam }, inventory: { items, totalKop, noPrice: items.filter((x) => x.marketable && !x.kop).length },
    watch: watch.results, trades: { total: tr?.n ?? 0, open: tr?.open ?? 0, sold: tr?.sold ?? 0 }, events: ev.results,
    invSyncedAt: (u.invSyncedAt as number | null) ?? null,
  };
}
