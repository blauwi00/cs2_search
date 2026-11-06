// Учёт инвентаря и реальных сделок. Чистые функции — проверяются тестами.
// Три разных «кошелька» никогда не складываются в одну сумму:
//   Steam Wallet — деньги внутри Steam (вывести нельзя),
//   External Cash — реальные деньги от продаж на внешних площадках,
//   Inventory Value — только оценка, пока предмет не продан.

import { steamSellerProceeds } from './fees.ts';
import { steamSellReference } from './arbitrage.ts';

export type Wallet = 'steam_wallet' | 'external_cash';

export const PLATFORMS = ['steam', 'skinport', 'csfloat', 'csgomarket', 'csmoney', 'waxpeer', 'lisskins', 'buffmarket', 'skinbaron', 'csdeals', 'tradeit', 'dmarket', 'other', 'gift'] as const;
export type Platform = (typeof PLATFORMS)[number];
export const PLATFORM_RU: Record<string, string> = {
  steam: 'Steam Market', skinport: 'Skinport', csfloat: 'CSFloat', csgomarket: 'Market.CSGO', csmoney: 'CS.MONEY', waxpeer: 'Waxpeer', lisskins: 'LIS-SKINS',
  buffmarket: 'BUFF Market', skinbaron: 'SkinBaron', csdeals: 'CS.Deals', tradeit: 'Tradeit.gg', dmarket: 'DMarket', other: 'Другая площадка', gift: 'Получено бесплатно (дроп/подарок)',
};

export function walletFor(platform: string): Wallet {
  return platform === 'steam' ? 'steam_wallet' : 'external_cash';
}

export interface Lot {
  id: number; quantity: number; sold_quantity: number; buy_price_kop: number; buy_fee_kop: number;
  buy_date: string; created_at: number; status: string;
}

export interface Sale { trade_id: number; quantity: number; received_kop: number; wallet: string; sell_date: string; created_at: number }

/** Себестоимость части лота (цена + доля комиссии покупки), округление половины вверх. */
export function costOf(lot: Pick<Lot, 'quantity' | 'buy_price_kop' | 'buy_fee_kop'>, qty: number): number {
  return lot.buy_price_kop * qty + Math.floor((lot.buy_fee_kop * qty + Math.floor(lot.quantity / 2)) / lot.quantity);
}

export function openQty(lot: Pick<Lot, 'quantity' | 'sold_quantity'>): number {
  return Math.max(0, lot.quantity - lot.sold_quantity);
}

export interface Valuation {
  /** Сколько придёт на баланс Steam за 1 шт. после комиссий (оценка). */
  steamProceedsPerUnit: number | null;
  steamBasis: string | null;
  /** Цена самого дешёвого объявления на Skinport за 1 шт. — без учёта комиссии продавца (неизвестна). */
  externalPricePerUnit: number | null;
}

export function valuation(steamLowestKop: number | null, steamMedianKop: number | null, skinportLowestKop: number | null): Valuation {
  const ref = steamSellReference({ lowestKop: steamLowestKop, medianKop: steamMedianKop, fetchedAt: 0 });
  const p = ref ? steamSellerProceeds(ref.kop) : null;
  return { steamProceedsPerUnit: p?.sellerReceives ?? null, steamBasis: ref?.basis ?? null, externalPricePerUnit: skinportLowestKop };
}

export interface LotView {
  openQty: number;
  openCostKop: number;
  steamValueKop: number | null;       // оценка в Steam за оставшееся количество
  unrealizedSteamKop: number | null;  // оценка − себестоимость (НЕ прибыль)
  unrealizedRoiBp: number | null;
}

export function viewLot(lot: Lot, v: Valuation): LotView {
  const q = openQty(lot);
  const cost = q > 0 ? saleCost(lot, lot.sold_quantity, q) : 0;
  const value = v.steamProceedsPerUnit === null ? null : v.steamProceedsPerUnit * q;
  const unreal = value === null ? null : value - cost;
  return {
    openQty: q, openCostKop: cost, steamValueKop: value, unrealizedSteamKop: unreal,
    unrealizedRoiBp: unreal === null || cost === 0 ? null : Math.trunc((unreal * 10000) / cost),
  };
}

/** Себестоимость проданной части: доля комиссии покупки распределяется пропорционально. */
export function saleCost(lot: Pick<Lot, 'quantity' | 'buy_price_kop' | 'buy_fee_kop'>, alreadySold: number, qty: number): number {
  return costOf(lot, alreadySold + qty) - costOf(lot, alreadySold);
}

export interface RealizedStats {
  buys: number; sales: number; profitable: number; losing: number;
  realizedSteamKop: number; realizedCashKop: number; avgRoiBp: number | null; avgHoldDays: number | null;
  receivedSteamKop: number; receivedCashKop: number;
}

export interface SaleWithCost extends Sale { costKop: number; buyDate: string }

export function realizedStats(lots: Lot[], sales: SaleWithCost[]): RealizedStats {
  let rs = 0, rc = 0, prof = 0, lose = 0, roiSum = 0, roiN = 0, holdSum = 0, recS = 0, recC = 0;
  for (const s of sales) {
    const r = s.received_kop - s.costKop;
    if (s.wallet === 'steam_wallet') { rs += r; recS += s.received_kop; } else { rc += r; recC += s.received_kop; }
    if (r > 0) prof++; else if (r < 0) lose++;
    if (s.costKop > 0) { roiSum += (r * 10000) / s.costKop; roiN++; }
    holdSum += Math.max(0, (Date.parse(s.sell_date) - Date.parse(s.buyDate)) / 86400000);
  }
  return {
    buys: lots.length, sales: sales.length, profitable: prof, losing: lose,
    realizedSteamKop: rs, realizedCashKop: rc, receivedSteamKop: recS, receivedCashKop: recC,
    avgRoiBp: roiN ? Math.round(roiSum / roiN) : null,
    avgHoldDays: sales.length ? holdSum / sales.length : null,
  };
}

/** Корзина изменения стоимости для уведомлений по инвентарю: новое уведомление — только при переходе в новую корзину. */
export function roiBucket(roiBp: number, thresholdBp: number): number {
  if (thresholdBp <= 0) return 0;
  return Math.sign(roiBp) * Math.floor(Math.abs(roiBp) / thresholdBp);
}

export function parseDateInput(t: string, today: string): string | null {
  const s = t.trim().toLowerCase();
  if (s === 'сегодня' || s === 'today') return today;
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) { const k = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/); if (k) m = [k[0], k[3], k[2].padStart(2, '0'), k[1].padStart(2, '0')] as RegExpMatchArray; }
  if (!m) return null;
  const iso = `${m[1]}-${m[2]}-${m[3]}`;
  const d = new Date(iso + 'T00:00:00Z');
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== iso) return null;
  if (iso > today) return null;
  return iso;
}
