// Баланс кошелька Steam. Бот не может узнать его сам (нужен вход в аккаунт — против правил бота),
// поэтому человек вписывает его вручную, а дальше бот ведёт его по записанным сделкам:
// + выручка продаж в Steam (на кошелёк), − покупки в Steam — всё, что записано ПОСЛЕ ввода баланса.
// «Ждёт оплаты» не входит: денег на кошельке ещё нет.

import type { Settings } from '../storage/db.ts';

export interface SteamBalance { kop: number; setKop: number; at: number }

/** Балансы сразу для нескольких людей (у кого вписан): два запроса на всех. */
export async function steamBalances(d: D1Database, settings: Map<number, Settings>): Promise<Map<number, SteamBalance>> {
  const base = new Map<number, { setKop: number; at: number }>();
  for (const [tid, s] of settings) {
    const k = Number(s.steam_balance_kop), at = Number(s.steam_balance_at);
    if (s.steam_balance_kop !== '' && Number.isSafeInteger(k) && k >= 0 && Number.isSafeInteger(at)) base.set(tid, { setKop: k, at });
  }
  const out = new Map<number, SteamBalance>();
  if (!base.size) return out;
  const ids = [...base.keys()].slice(0, 90);
  const ph = ids.map(() => '?').join(',');
  const since = `(SELECT CAST(value AS INTEGER) FROM user_settings u WHERE u.telegram_id = t.telegram_id AND u.key = 'steam_balance_at')`;
  const [sold, bought] = await Promise.all([
    d.prepare(`SELECT t.telegram_id AS tid, SUM(s.received_kop) AS k FROM trade_sales s JOIN trades t ON t.id = s.trade_id
      WHERE t.telegram_id IN (${ph}) AND s.wallet = 'steam_wallet' AND s.created_at >= ${since} GROUP BY t.telegram_id`).bind(...ids).all<{ tid: number; k: number }>(),
    d.prepare(`SELECT t.telegram_id AS tid, SUM(t.buy_price_kop * t.quantity + t.buy_fee_kop) AS k FROM trades t
      WHERE t.telegram_id IN (${ph}) AND t.buy_platform = 'steam' AND t.created_at >= ${since} GROUP BY t.telegram_id`).bind(...ids).all<{ tid: number; k: number }>(),
  ]);
  const plus = new Map(sold.results.map((r) => [r.tid, r.k ?? 0])), minus = new Map(bought.results.map((r) => [r.tid, r.k ?? 0]));
  for (const tid of ids) {
    const b = base.get(tid)!;
    out.set(tid, { setKop: b.setKop, at: b.at, kop: Math.max(0, b.setKop + (plus.get(tid) ?? 0) - (minus.get(tid) ?? 0)) });
  }
  return out;
}

export async function steamBalanceFor(d: D1Database, tid: number, s: Settings): Promise<SteamBalance | null> {
  return (await steamBalances(d, new Map([[tid, s]]))).get(tid) ?? null;
}
