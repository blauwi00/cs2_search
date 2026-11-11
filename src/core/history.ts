// Суточные точки истории: стоимость инвентаря человека и цены предмета на площадках. Только реальные данные, с момента запуска.
import type { Ctx } from './pipeline.ts';
import { getMeta, setMetaStmt } from './channel.ts';
import { warsawDate, warsawHour } from '../utils/time.ts';

export const HISTORY_HOUR = 21;      // пишем вечером по Варшаве, когда за день собрано больше всего цен
export const HISTORY_KEEP_DAYS = 120;
export const TOP_ITEMS = 15;

/** Раз в сутки: по одной строке на человека с инвентарём и на отслеживаемый предмет. Каждый запрос — один INSERT … SELECT. */
export async function jobHistory(ctx: Ctx): Promise<{ wrote: boolean }> {
  const d = ctx.db;
  if (warsawHour(ctx.now) < HISTORY_HOUR) return { wrote: false };
  const day = warsawDate(ctx.now);
  if ((await getMeta(d, 'hist_day')) === day) return { wrote: false };
  const fresh = ctx.now - 48 * 3600;
  await d.batch([
    d.prepare(`INSERT OR REPLACE INTO inv_value_daily (telegram_id, day, total_usd_c, top)
      WITH r AS (
        SELECT v.telegram_id AS t, v.item_id AS i, COALESCE(a.d1, a.d7) AS u, v.qty AS q,
               ROW_NUMBER() OVER (PARTITION BY v.telegram_id ORDER BY COALESCE(a.d1, a.d7) * v.qty DESC) AS rn
        FROM steam_inventory v JOIN steam_avg a ON a.item_id = v.item_id
        WHERE v.marketable = 1 AND COALESCE(a.d1, a.d7) > 0 AND a.updated_at >= ?)
      SELECT t, ?, CAST(SUM(u * q) AS INTEGER), json_group_object(CAST(i AS TEXT), json_array(u, q)) FILTER (WHERE rn <= ${TOP_ITEMS}) FROM r GROUP BY t`).bind(fresh, day),
    d.prepare(`INSERT OR REPLACE INTO site_price_daily (item_id, day, json)
      SELECT i.id, ?, sp.json FROM site_prices sp JOIN items i ON i.market_hash_name = sp.name
      WHERE sp.updated_at >= ? AND i.id IN (SELECT item_id FROM steam_inventory UNION SELECT item_id FROM watchlist WHERE active = 1 UNION SELECT item_id FROM trades WHERE quantity > sold_quantity UNION SELECT item_id FROM item_views WHERE at >= ?)`).bind(day, fresh, ctx.now - 30 * 86400),
    setMetaStmt(d, 'hist_day', day),
  ]);
  return { wrote: true };
}

export function cleanupHistoryStmts(d: D1Database, now: number): D1PreparedStatement[] {
  const cut = warsawDate(now - HISTORY_KEEP_DAYS * 86400);
  return [d.prepare('DELETE FROM inv_value_daily WHERE day < ?').bind(cut), d.prepare('DELETE FROM site_price_daily WHERE day < ?').bind(cut), d.prepare('DELETE FROM item_views WHERE at < ?').bind(now - 60 * 86400)];
}

export interface HistRow { day: string; total: number; top: Record<string, [number, number]> | null }
export interface Mover { id: number; deltaUsdC: number }
export interface WeekDelta { deltaUsdC: number; pct: number; fromDay: string; toDay: string; movers: Mover[] }

const dayMs = (s: string) => Date.parse(s + 'T00:00:00Z');
export function parseTop(raw: string | null): HistRow['top'] {
  if (!raw) return null;
  try { const o = JSON.parse(raw); return o && typeof o === 'object' ? o : null; } catch { return null; }
}

/**
 * Сравнение «за неделю»: последняя точка против точки 7 дней назад (допускаем 6–10 дней, иначе честно «ещё копим»).
 * Топ-3 — только предметы, которые были в обеих точках, по изменению цены × количество сейчас.
 */
export function weekDelta(rows: HistRow[]): { delta: WeekDelta | null; days: number } {
  const sorted = [...rows].sort((a, b) => (a.day < b.day ? 1 : -1));
  const last = sorted[0];
  if (!last) return { delta: null, days: 0 };
  const days = sorted.length;
  const prev = sorted.find((r) => { const gap = (dayMs(last.day) - dayMs(r.day)) / 86400000; return gap >= 6 && gap <= 10; });
  if (!prev || prev.total <= 0) return { delta: null, days };
  const movers: Mover[] = [];
  for (const [id, [u, q]] of Object.entries(last.top ?? {})) {
    const p = prev.top?.[id];
    if (!p || !(p[0] > 0)) continue;
    const dlt = Math.round((u - p[0]) * q);
    if (dlt !== 0) movers.push({ id: Number(id), deltaUsdC: dlt });
  }
  movers.sort((a, b) => Math.abs(b.deltaUsdC) - Math.abs(a.deltaUsdC));
  return { delta: { deltaUsdC: last.total - prev.total, pct: ((last.total - prev.total) / prev.total) * 100, fromDay: prev.day, toDay: last.day, movers: movers.slice(0, 3) }, days };
}
