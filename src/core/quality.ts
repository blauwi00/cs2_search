// Этап 5: оценка качества сигналов и проверка правил на истории (backtesting).
// Главное правило: решение в момент t принимается ТОЛЬКО по данным, известным к моменту t.
// Данные после t используются лишь для оценки результата, никогда — для самого решения.

import { computeSteamArbitrage } from './arbitrage.ts';

export interface TimedValue { t: number; v: number | null }

/** Последнее значение не позже момента t (и не старше maxAge). */
export function asOf(series: TimedValue[], t: number, maxAgeSec: number): number | null {
  let best: TimedValue | null = null;
  for (const p of series) {
    if (p.t > t) break; // ряды отсортированы по времени — дальше только будущее
    best = p;
  }
  if (!best || t - best.t > maxAgeSec) return null;
  return best.v;
}

export type Outcome = 'held' | 'reversed' | 'no_data';

/**
 * Итог сигнала через horizon: если купить по цене сигнала и продать в Steam по ориентиру через horizon,
 * осталась бы разница положительной?
 */
export function outcomeAfter(costKop: number, steamLow: TimedValue[], steamMed: TimedValue[], at: number, horizonSec: number, maxAgeSec = 6 * 3600):
  { outcome: Outcome; spreadKop: number | null } {
  const t = at + horizonSec;
  const low = asOf(steamLow, t, maxAgeSec);
  const med = asOf(steamMed, t, maxAgeSec);
  const arb = computeSteamArbitrage({ source: 'x', costKop, fetchedAt: t }, { lowestKop: low, medianKop: med, fetchedAt: t });
  if (!arb) return { outcome: 'no_data', spreadKop: null };
  return { outcome: arb.netSpreadKop > 0 ? 'held' : 'reversed', spreadKop: arb.netSpreadKop };
}

export interface BacktestParams { minProfitKop: number; minRoiBp: number; horizonSec: number; maxAgeSec: number; cooldownSec: number }

export interface BacktestResult {
  decisions: number;           // сколько моментов проверено
  signals: number;             // сколько раз правило сработало бы
  held: number; reversed: number; noData: number;
  avgSpreadAtSignalKop: number | null;
  avgSpreadAfterKop: number | null;
  spanDays: number;
}

/**
 * Прогон правила «купить на внешней площадке → продать в Steam» по сохранённой истории одного предмета.
 * В момент каждого наблюдения используются только значения ≤ этого момента.
 */
export function backtest(buy: TimedValue[], steamLow: TimedValue[], steamMed: TimedValue[], p: BacktestParams): BacktestResult {
  const times = [...new Set([...buy, ...steamLow, ...steamMed].map((x) => x.t))].sort((a, b) => a - b);
  let signals = 0, held = 0, reversed = 0, noData = 0, sAt = 0, sAfter = 0, nAfter = 0;
  let lastSignalAt = -Infinity;
  for (const t of times) {
    const cost = asOf(buy, t, p.maxAgeSec);
    if (cost === null || cost <= 0) continue;
    const arb = computeSteamArbitrage({ source: 'x', costKop: cost, fetchedAt: t },
      { lowestKop: asOf(steamLow, t, p.maxAgeSec), medianKop: asOf(steamMed, t, p.maxAgeSec), fetchedAt: t });
    if (!arb || arb.netSpreadKop < p.minProfitKop || arb.returnOnCostBp < p.minRoiBp) continue;
    if (t - lastSignalAt < p.cooldownSec) continue;
    lastSignalAt = t;
    signals++;
    sAt += arb.netSpreadKop;
    const o = outcomeAfter(cost, steamLow, steamMed, t, p.horizonSec, p.maxAgeSec);
    if (o.outcome === 'held') held++; else if (o.outcome === 'reversed') reversed++; else noData++;
    if (o.spreadKop !== null) { sAfter += o.spreadKop; nAfter++; }
  }
  return {
    decisions: times.length, signals, held, reversed, noData,
    avgSpreadAtSignalKop: signals ? Math.round(sAt / signals) : null,
    avgSpreadAfterKop: nAfter ? Math.round(sAfter / nAfter) : null,
    spanDays: times.length ? (times[times.length - 1] - times[0]) / 86400 : 0,
  };
}
