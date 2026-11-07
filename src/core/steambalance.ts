// Баланс кошелька Steam. Бот не может узнать его сам (нужен вход в аккаунт — против правил бота),
// поэтому человек вписывает его вручную, а дальше бот ведёт его по записанным сделкам:
// + выручка продаж в Steam (на кошелёк), − покупки в Steam — всё, что записано ПОСЛЕ ввода баланса.
// «Ждёт оплаты» не входит: денег на кошельке ещё нет.
//
// Хранение: steam_balance_kop — сумма в минимальных единицах ВАЛЮТЫ КОШЕЛЬКА (steam_balance_cur, например центы USD),
// чтобы баланс не «плыл» от курса; в копейки бота переводится по текущему курсу в момент использования.
// Пустая steam_balance_cur — старая запись (до валюты кошелька): сумма уже в копейках гривны.
// Галочка recs_by_balance: подбирать идеи с покупкой в Steam под этот баланс (выключена по умолчанию).

import type { Settings } from '../storage/db.ts';
import type { Rates } from '../currency/display.ts';

export const BALANCE_STALE_SEC = 14 * 86400;

export interface SteamBalance {
  /** Текущий баланс в копейках бота (может быть < 0 — тогда mismatch). */
  kop: number;
  /** Вписанная сумма в единицах валюты кошелька и сама валюта. */
  minor: number; cur: string; at: number;
  /** Сколько продаж в Steam и покупок в Steam учтено после ввода. */
  sales: number; buys: number;
  /** Не обновлялся больше 14 дней — «проверь, совпадает ли со Steam». */
  stale: boolean;
  /** По записанным покупкам денег ушло больше, чем было, — «расходится со Steam, обнови». */
  mismatch: boolean;
}

interface Base { minor: number; cur: string; at: number }

export function balanceBase(s: Settings): Base | null {
  if (s.steam_balance_kop === '' || s.steam_balance_at === '') return null;
  const minor = Number(s.steam_balance_kop), at = Number(s.steam_balance_at);
  if (!Number.isSafeInteger(minor) || minor < 0 || !Number.isSafeInteger(at)) return null;
  return { minor, cur: s.steam_balance_cur || 'UAH', at };
}

/** Вписанная сумма в копейках бота по текущему курсу. Нет курса валюты кошелька — null (не выдумываем). */
export function baseKop(b: Base, rates: Rates | null): number | null {
  if (b.cur === 'UAH') return b.minor;
  const per = rates?.[b.cur];
  return per ? Math.round(b.minor * per) : null;
}

/** Галочка «подбирать идеи под баланс» действует, только если баланс вписан. */
export const byBalanceOn = (s: Settings): boolean => s.recs_by_balance === '1' && balanceBase(s) !== null;

/**
 * Балансы сразу для нескольких людей: 2 запроса на всех (+1 за курсы, только если у кого-то кошелёк не в гривне).
 * onlyByBalance — только тем, у кого включена галочка (рассылка: не считаем лишнего).
 */
export async function steamBalances(d: D1Database, settings: Map<number, Settings>, now: number, opts: { onlyByBalance?: boolean; rates?: Rates | null } = {}): Promise<Map<number, SteamBalance>> {
  const base = new Map<number, Base>();
  for (const [tid, s] of settings) {
    if (opts.onlyByBalance && s.recs_by_balance !== '1') continue;
    const b = balanceBase(s);
    if (b) base.set(tid, b);
  }
  const out = new Map<number, SteamBalance>();
  if (!base.size) return out;
  const ids = [...base.keys()].slice(0, 90);
  let rates = opts.rates ?? null;
  if (!rates && ids.some((t) => base.get(t)!.cur !== 'UAH')) rates = await (await import('../currency/display.ts')).loadRates(d);
  const ph = ids.map(() => '?').join(',');
  const since = `(SELECT CAST(value AS INTEGER) FROM user_settings u WHERE u.telegram_id = t.telegram_id AND u.key = 'steam_balance_at')`;
  const [sold, bought] = await Promise.all([
    d.prepare(`SELECT t.telegram_id AS tid, SUM(s.received_kop) AS k, COUNT(*) AS n FROM trade_sales s JOIN trades t ON t.id = s.trade_id
      WHERE t.telegram_id IN (${ph}) AND s.wallet = 'steam_wallet' AND s.created_at >= ${since} GROUP BY t.telegram_id`).bind(...ids).all<{ tid: number; k: number; n: number }>(),
    d.prepare(`SELECT t.telegram_id AS tid, SUM(t.buy_price_kop * t.quantity + t.buy_fee_kop) AS k, COUNT(*) AS n FROM trades t
      WHERE t.telegram_id IN (${ph}) AND t.buy_platform = 'steam' AND t.created_at >= ${since} GROUP BY t.telegram_id`).bind(...ids).all<{ tid: number; k: number; n: number }>(),
  ]);
  const plus = new Map(sold.results.map((r) => [r.tid, r])), minus = new Map(bought.results.map((r) => [r.tid, r]));
  for (const tid of ids) {
    const b = base.get(tid)!;
    const bk = baseKop(b, rates);
    if (bk === null) continue;
    const p = plus.get(tid), m = minus.get(tid);
    const kop = bk + (p?.k ?? 0) - (m?.k ?? 0);
    out.set(tid, { kop, minor: b.minor, cur: b.cur, at: b.at, sales: p?.n ?? 0, buys: m?.n ?? 0, stale: now - b.at > BALANCE_STALE_SEC, mismatch: kop < 0 });
  }
  return out;
}

export async function steamBalanceFor(d: D1Database, tid: number, s: Settings, now: number, rates?: Rates | null): Promise<SteamBalance | null> {
  return (await steamBalances(d, new Map([[tid, s]]), now, { rates })).get(tid) ?? null;
}

/**
 * Предел цены для идей «купить в Steam» при включённой галочке: баланс, а если задана «Макс. цена покупки» — меньшее.
 * null — галочка выключена или баланса нет (идеи как раньше). Баланс расходится со Steam (< 0) — предел 0.
 */
export function steamBuyLimit(bal: SteamBalance | null, s: Settings): number | null {
  if (!bal || s.recs_by_balance !== '1') return null;
  const maxBuy = Number(s.max_buy_kop) || 0;
  const lim = Math.max(0, bal.kop);
  return maxBuy > 0 ? Math.min(lim, maxBuy) : lim;
}

/** Разделить идеи по пределу: подходящие покупки в Steam — первыми, дороже предела — отдельно (в приложении «Ещё N — показать»). */
export function splitByBalance<T extends { buyAt: string; payKop: number }>(list: T[], limit: number | null): { shown: T[]; hidden: T[] } {
  if (limit === null) return { shown: list, hidden: [] };
  const fit = list.filter((x) => x.buyAt === 'steam' && x.payKop <= limit);
  const other = list.filter((x) => x.buyAt !== 'steam');
  return { shown: [...fit, ...other], hidden: list.filter((x) => x.buyAt === 'steam' && x.payKop > limit) };
}
