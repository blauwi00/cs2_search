import type { ArbitrageResult } from './arbitrage.ts';
import type { LiquidityResult } from './liquidity.ts';

export type Priority = 'high' | 'medium' | 'low';
export type SignalCategory = 'verified_spread' | 'estimated' | 'anomaly';

export interface ScoringContext {
  arb: ArbitrageResult;
  liquidity: LiquidityResult;
  uniquePriced: boolean;
  buyQuantity: number | null;        // объявлений на площадке покупки
  buyAgeSec: number;                 // возраст данных о покупке
  sellAgeSec: number;                // возраст данных Steam
  fxAgeDays: number | null;          // null = курс не нужен (цена уже в UAH)
  fxAvailable: boolean;
  settings: ScoringSettings;
}

export interface ScoringSettings {
  minProfitKop: number;
  minRoiBp: number;
  maxBuyKop: number;             // 0 = без ограничения
  budgetKop: number;             // 0 = бюджета нет
  maxStaleSec: number;           // данные старше — устаревшие
  fxMaxAgeDays: number;
  requireLiquidity: 'high' | 'medium' | 'low';
}

export interface ScoreResult {
  /** null = сигнал не создавать вообще. */
  priority: Priority | null;
  category: SignalCategory;
  reasons: string[];   // почему такой приоритет
  risks: string[];     // что показать пользователю
  affordable: boolean;
}

const LIQ_RANK = { unknown: 0, low: 1, medium: 2, high: 3 } as const;

export function scoreArbitrage(c: ScoringContext): ScoreResult {
  const s = c.settings;
  const reasons: string[] = [];
  const risks: string[] = [
    'Цена продажи не гарантирована.',
    'После покупки предмет может быть недоступен для продажи на Steam несколько дней (торговые ограничения).',
  ];
  if (c.fxAgeDays !== null) risks.push('Курс гривны может измениться до продажи.');

  if (c.arb.netSpreadKop <= 0) {
    return { priority: null, category: 'anomaly', reasons: ['Убыток или ноль после комиссий'], risks, affordable: false };
  }
  if (c.arb.netSpreadKop < s.minProfitKop || c.arb.returnOnCostBp < s.minRoiBp) {
    return { priority: null, category: 'estimated', reasons: ['Ниже порогов прибыли из настроек'], risks, affordable: false };
  }

  const blocksHigh: string[] = [];
  if (c.buyAgeSec > s.maxStaleSec) blocksHigh.push('данные о покупке устарели');
  if (c.sellAgeSec > s.maxStaleSec) blocksHigh.push('данные Steam устарели');
  if (c.buyQuantity === null) blocksHigh.push('неизвестно наличие предложения');
  else if (c.buyQuantity <= 0) return { priority: null, category: 'anomaly', reasons: ['Нет предложений на площадке покупки'], risks, affordable: false };
  if (c.uniquePriced) blocksHigh.push('цена зависит от экземпляра (паттерн/фаза/float) — автоматическая оценка ненадёжна');
  if (c.fxAgeDays !== null && (!c.fxAvailable || c.fxAgeDays > s.fxMaxAgeDays)) blocksHigh.push('курс для пересчёта в UAH устарел');
  if (!c.arb.bothSteamMetrics) blocksHigh.push('у Steam есть только один из показателей (объявление или медиана)');
  if (c.arb.downside[0] && c.arb.downside[0].spreadKop <= 0) risks.push('При падении цены на 5% сделка становится убыточной.');

  const liqOk = LIQ_RANK[c.liquidity.cls] >= LIQ_RANK[s.requireLiquidity];
  if (c.liquidity.cls === 'unknown') blocksHigh.push('нет данных о продажах');
  else if (!liqOk) blocksHigh.push(`ликвидность ниже требуемой (${c.liquidity.cls})`);

  let category: SignalCategory;
  if (c.uniquePriced || c.liquidity.cls === 'unknown') category = c.uniquePriced ? 'anomaly' : 'estimated';
  else if (liqOk && c.arb.bothSteamMetrics) category = 'verified_spread';
  else category = 'estimated';

  let priority: Priority;
  if (blocksHigh.length === 0) { priority = 'high'; reasons.push('положительная разница после комиссий, свежие данные, достаточная ликвидность'); }
  else if (category === 'anomaly') { priority = 'low'; reasons.push(...blocksHigh); }
  else { priority = 'medium'; reasons.push(...blocksHigh); }

  const affordable = (s.maxBuyKop === 0 || c.arb.purchaseCostKop <= s.maxBuyKop)
    && (s.budgetKop === 0 || c.arb.purchaseCostKop <= s.budgetKop);
  if (!affordable) {
    reasons.push('дороже лимита бюджета/цены покупки');
    if (priority === 'high') priority = 'medium';
  }
  return { priority, category, reasons, risks, affordable };
}

export const PRIORITY_RU: Record<Priority, string> = { high: 'высокий', medium: 'средний', low: 'низкий' };
export const CATEGORY_SIGNAL_RU: Record<SignalCategory, string> = {
  verified_spread: 'проверяемый спред', estimated: 'оценочная возможность', anomaly: 'ценовая аномалия',
};
