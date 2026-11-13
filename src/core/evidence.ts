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

/**
 * Оценка «сколько стоит» для инвентаря: объявление → медиана продаж за сутки → средняя продаж (меньшая из 1 и 7 дней).
 * Средняя — история и может сильно отставать (у предмета резко упала цена: средняя 54 ₴, в Steam 14 ₴).
 * Поэтому её сверяем с ценами других площадок (siteKop — типичная цена объявления там): если там вдвое дешевле,
 * средней не верим и берём цену площадок (basis 'site') — оценка ниже, но честнее.
 */
export function marketValue(e: SteamEvidence, siteKop?: number | null): { kop: number; basis: 'listing' | 'median24h' | 'avg' | 'site' } | null {
  if (e.listing) return { kop: e.listing.kop, basis: 'listing' };
  if (e.median24h) return { kop: e.median24h.kop, basis: 'median24h' };
  // Средние продаж Steam из открытого прайса CSGO Trader как сумму НЕ используем: проверка 13.11.2026 на живом Steam —
  // они выше реальной цены в 1,2–2 раза (Kilowatt Case: $0,24 против $0,13). Нет живой цены — честная цена других площадок.
  if (siteKop && siteKop > 0) return { kop: siteKop, basis: 'site' };
  return null;
}

/** Средняя Steam больше цены других площадок во столько раз — средней не верим (обычная наценка Steam — до ~1,5×). */
export const AVG_DOUBT_RATIO = 2;

/** Типичная цена объявления на сторонних площадках: медиана по площадкам (одна площадка с ошибкой не сбивает оценку). */
export function siteMedianKop(prices: number[]): number | null {
  const v = prices.filter((x) => Number.isFinite(x) && x > 0).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = v.length >> 1;
  return v.length % 2 ? v[m] : Math.round((v[m - 1] + v[m]) / 2);
}

export const BASIS_RU: Record<string, string> = {
  listing: 'самое дешёвое объявление Steam', median24h: 'медиана продаж Steam за 24 ч', avg: 'средняя цена продаж Steam (история, не предложение)', site: 'по ценам других площадок — средняя Steam устарела',
};
