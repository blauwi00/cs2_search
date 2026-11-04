import { steamSellerProceeds, type SteamFeeParams, STEAM_CS2_FEES } from './fees.ts';
import { mulDivRound } from '../utils/money.ts';

export interface SteamSide {
  lowestKop: number | null;     // самое дешёвое объявление на Steam (цена покупателя)
  medianKop: number | null;     // медиана продаж за 24 ч
  fetchedAt: number;
}

export interface BuySide {
  source: string;
  /** Полная стоимость покупки в копейках (цена + известные комиссии). */
  costKop: number;
  fetchedAt: number;
}

export interface ArbitrageResult {
  purchaseCostKop: number;
  /** Цена покупателя на Steam, от которой считаем выплату. */
  sellReferenceKop: number;
  sellReferenceBasis: string;
  expectedProceedsKop: number;
  netSpreadKop: number;
  returnOnCostBp: number;
  /** Минимальная цена покупателя на Steam, при которой нет убытка. */
  breakEvenBuyerKop: number | null;
  downside: { dropBp: number; proceedsKop: number; spreadKop: number }[];
  /** Ориентир продажи построен по обоим показателям Steam (объявление и медиана). */
  bothSteamMetrics: boolean;
}

/**
 * Ориентир продажи — консервативный: меньшее из (самое дешёвое объявление − 1 коп., медиана продаж 24 ч).
 * Самое дешёвое объявление конкурента не гарантирует продажу, поэтому мы не берём максимум.
 */
export function steamSellReference(s: SteamSide): { kop: number; basis: string; both: boolean } | null {
  const undercut = s.lowestKop !== null && s.lowestKop > 1 ? s.lowestKop - 1 : null;
  if (undercut !== null && s.medianKop !== null) {
    return undercut <= s.medianKop
      ? { kop: undercut, basis: 'ниже самого дешёвого объявления Steam на 1 коп.', both: true }
      : { kop: s.medianKop, basis: 'медиана продаж Steam за 24 ч', both: true };
  }
  if (s.medianKop !== null) return { kop: s.medianKop, basis: 'медиана продаж Steam за 24 ч (нет данных об объявлениях)', both: false };
  if (undercut !== null) return { kop: undercut, basis: 'самое дешёвое объявление Steam (нет данных о продажах)', both: false };
  return null;
}

export function breakEvenBuyerPrice(costKop: number, fees: SteamFeeParams = STEAM_CS2_FEES): number | null {
  if (costKop <= 0) return null;
  let lo = 1;
  let hi = costKop * 2 + 100;
  const ok = (b: number) => (steamSellerProceeds(b, fees)?.sellerReceives ?? -1) >= costKop;
  if (!ok(hi)) return null;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (ok(mid)) hi = mid; else lo = mid + 1;
  }
  return lo;
}

export function computeSteamArbitrage(buy: BuySide, steam: SteamSide, fees: SteamFeeParams = STEAM_CS2_FEES): ArbitrageResult | null {
  const ref = steamSellReference(steam);
  if (!ref || buy.costKop <= 0) return null;
  const proceeds = steamSellerProceeds(ref.kop, fees);
  if (!proceeds) return null;
  const spread = proceeds.sellerReceives - buy.costKop;
  const downside = [500, 1000].map((dropBp) => {
    const lowered = ref.kop - mulDivRound(ref.kop, dropBp, 10000);
    const p = steamSellerProceeds(lowered, fees)?.sellerReceives ?? 0;
    return { dropBp, proceedsKop: p, spreadKop: p - buy.costKop };
  });
  return {
    purchaseCostKop: buy.costKop,
    sellReferenceKop: ref.kop,
    sellReferenceBasis: ref.basis,
    expectedProceedsKop: proceeds.sellerReceives,
    netSpreadKop: spread,
    returnOnCostBp: Math.trunc((spread * 10000) / buy.costKop),
    breakEvenBuyerKop: breakEvenBuyerPrice(buy.costKop, fees),
    downside,
    bothSteamMetrics: ref.both,
  };
}
