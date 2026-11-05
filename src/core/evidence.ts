// Достоверность цен (аудит, приоритет 1). Разные виды цен Steam хранятся и показываются раздельно:
//   listing   — самое дешёвое активное объявление (priceoverview lowest_price), реальное предложение;
//   buyOrder  — максимальный ордер покупателя (itemordershistogram), если удалось получить;
//   median24h — медиана фактических продаж за 24 ч (priceoverview median_price) + число продаж;
//   avg       — средние цены продаж за 1/7/30/90 дней (открытый прайс CSGO Trader), это история, НЕ предложение.
// Если свежих данных нет — статус no_data: оценку и рекомендацию продажи не строим.
import { toKop, type FxRate } from '../currency/nbu.ts';

export const LIVE_MAX_AGE_SEC = 6 * 3600;    // объявление/медиана Steam старше — уже не «сейчас»
export const ORDER_MAX_AGE_SEC = 6 * 3600;
export const AVG_MAX_AGE_SEC = 48 * 3600;    // средние продаж: прайс обновляется раз в сутки

export interface QuoteLike { source: string; price_type: string; price_kop: number | null; volume?: number | null; fetched_at: number }
export interface AvgLike { d1: number | null; d7: number | null; d30: number | null; d90: number | null; updated_at: number }

export interface SteamEvidence {
  listing: { kop: number; at: number } | null;
  buyOrder: { kop: number; at: number } | null;
  median24h: { kop: number; volume: number | null; at: number } | null;
  avg: { d1: number | null; d7: number | null; d30: number | null; d90: number | null; at: number } | null;
  /** live — есть свежие данные Steam; history — только средние продаж (свежие); no_data — нет актуальных данных. */
  status: 'live' | 'history' | 'no_data';
  stale: string[];   // что было, но устарело (для честной подписи)
}

export function steamEvidence(quotes: QuoteLike[], avg: AvgLike | null | undefined, usd: FxRate | null, now: number): SteamEvidence {
  const stale: string[] = [];
  const pick = (type: string, maxAge: number) => {
    const q = quotes.find((x) => x.source === 'steam' && x.price_type === type && x.price_kop != null && x.price_kop > 0);
    if (!q) return null;
    if (now - q.fetched_at > maxAge) { stale.push(type); return null; }
    return q;
  };
  const l = pick('lowest_listing', LIVE_MAX_AGE_SEC);
  const m = pick('median_24h', LIVE_MAX_AGE_SEC);
  const o = pick('buy_order', ORDER_MAX_AGE_SEC);
  let a: SteamEvidence['avg'] = null;
  if (avg && (avg.d1 || avg.d7)) {
    if (now - avg.updated_at > AVG_MAX_AGE_SEC) stale.push('avg');
    else if (usd) {
      const k = (c: number | null) => (c ? toKop(c, 'USD', usd) : null);
      a = { d1: k(avg.d1), d7: k(avg.d7), d30: k(avg.d30), d90: k(avg.d90), at: avg.updated_at };
    }
  }
  const listing = l ? { kop: l.price_kop!, at: l.fetched_at } : null;
  const median24h = m ? { kop: m.price_kop!, volume: m.volume ?? null, at: m.fetched_at } : null;
  const buyOrder = o ? { kop: o.price_kop!, at: o.fetched_at } : null;
  return { listing, buyOrder, median24h, avg: a, status: listing || median24h ? 'live' : a ? 'history' : 'no_data', stale };
}

/** Оценка «сколько стоит» для инвентаря: объявление → медиана продаж за сутки → средняя продаж (меньшая из 1 и 7 дней). */
export function marketValue(e: SteamEvidence): { kop: number; basis: 'listing' | 'median24h' | 'avg' } | null {
  if (e.listing) return { kop: e.listing.kop, basis: 'listing' };
  if (e.median24h) return { kop: e.median24h.kop, basis: 'median24h' };
  const a = e.avg && (e.avg.d1 && e.avg.d7 ? Math.min(e.avg.d1, e.avg.d7) : e.avg.d1 ?? e.avg.d7);
  return a ? { kop: a, basis: 'avg' } : null;
}

export const BASIS_RU: Record<string, string> = {
  listing: 'самое дешёвое объявление Steam', median24h: 'медиана продаж Steam за 24 ч', avg: 'средняя цена продаж Steam (история, не предложение)',
};
