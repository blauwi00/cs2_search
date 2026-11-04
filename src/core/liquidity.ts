export type LiquidityClass = 'high' | 'medium' | 'low' | 'unknown';

export interface LiquidityInput {
  /** Продажи на Steam за 24 ч (поле volume в priceoverview). */
  steamSales24h: number | null;
  /** Продажи на Skinport за 7 дней (sales history). */
  skinportSales7d: number | null;
  /** Число активных объявлений — НЕ продажи, в классификацию не входит. */
  activeListings: number | null;
}

export interface LiquidityThresholds { highPerDay: number; mediumPerDay: number }
export const DEFAULT_LIQUIDITY: LiquidityThresholds = { highPerDay: 50, mediumPerDay: 10 };

export interface LiquidityResult { cls: LiquidityClass; salesPerDay: number | null; basis: string }

/**
 * Классификация только по ЗАВЕРШЁННЫМ продажам. Если данных о продажах нет — 'unknown',
 * даже если объявлений много.
 */
export function classifyLiquidity(i: LiquidityInput, t: LiquidityThresholds = DEFAULT_LIQUIDITY): LiquidityResult {
  let perDay: number | null = null;
  let basis = 'нет данных о продажах';
  if (i.steamSales24h !== null) { perDay = i.steamSales24h; basis = 'продажи Steam за 24 ч'; }
  else if (i.skinportSales7d !== null) { perDay = i.skinportSales7d / 7; basis = 'продажи Skinport за 7 дней'; }
  if (perDay === null) return { cls: 'unknown', salesPerDay: null, basis };
  const cls: LiquidityClass = perDay >= t.highPerDay ? 'high' : perDay >= t.mediumPerDay ? 'medium' : 'low';
  return { cls, salesPerDay: perDay, basis };
}

export const LIQUIDITY_RU: Record<LiquidityClass, string> = {
  high: 'высокая', medium: 'средняя', low: 'низкая', unknown: 'недостаточно данных',
};
