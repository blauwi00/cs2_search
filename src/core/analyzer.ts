// Обнаружение изменений цены. Сравнение всегда ведётся в ИСХОДНОЙ валюте площадки,
// поэтому движение курса гривны не создаёт ложных сигналов роста/падения.

export interface PricePoint { at: number; minor: number | null; currency: string; volume: number | null }

export interface ChangeEvent {
  kind: 'price_drop' | 'price_rise';
  period: '1h' | '24h' | '7d';
  fromMinor: number;
  toMinor: number;
  changeBp: number;
  currency: string;
  /** Рост минимальной цены при малом объёме — может быть просто выкуп дешёвых лотов. */
  thinSupplyWarning: boolean;
}

const PERIODS: { key: '1h' | '24h' | '7d'; sec: number }[] = [
  { key: '1h', sec: 3600 }, { key: '24h', sec: 86400 }, { key: '7d', sec: 7 * 86400 },
];

/** Ближайшая точка не позже (now − period), но не старше чем на 50% периода. */
export function pointAt(history: PricePoint[], now: number, periodSec: number): PricePoint | null {
  const target = now - periodSec;
  let best: PricePoint | null = null;
  for (const p of history) {
    if (p.minor === null || p.at > target) continue;
    if (target - p.at > periodSec * 0.5) continue;
    if (!best || p.at > best.at) best = p;
  }
  return best;
}

export function detectChanges(current: PricePoint, history: PricePoint[], now: number, thresholdBp: number): ChangeEvent[] {
  if (current.minor === null || current.minor <= 0) return [];
  const out: ChangeEvent[] = [];
  for (const per of PERIODS) {
    const ref = pointAt(history, now, per.sec);
    if (!ref || ref.minor === null || ref.minor <= 0 || ref.currency !== current.currency) continue;
    const changeBp = Math.trunc(((current.minor - ref.minor) * 10000) / ref.minor);
    if (Math.abs(changeBp) < thresholdBp) continue;
    out.push({
      kind: changeBp < 0 ? 'price_drop' : 'price_rise',
      period: per.key,
      fromMinor: ref.minor,
      toMinor: current.minor,
      changeBp,
      currency: current.currency,
      thinSupplyWarning: changeBp > 0 && (current.volume === null || current.volume < 5),
    });
  }
  // Оставляем самое показательное событие: наибольшее по модулю.
  out.sort((a, b) => Math.abs(b.changeBp) - Math.abs(a.changeBp));
  return out.slice(0, 1);
}

export interface Stats { count: number; min: number; max: number; mean: number; median: number; volatilityBp: number; spanDays: number }

export function stats(points: PricePoint[]): Stats | null {
  const v = points.filter((p) => p.minor !== null).map((p) => p.minor as number);
  if (v.length === 0) return null;
  const sorted = [...v].sort((a, b) => a - b);
  const mean = v.reduce((s, x) => s + x, 0) / v.length;
  const median = sorted.length % 2 ? sorted[(sorted.length - 1) / 2] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
  const sd = Math.sqrt(v.reduce((s, x) => s + (x - mean) ** 2, 0) / v.length);
  const times = points.map((p) => p.at);
  return {
    count: v.length, min: sorted[0], max: sorted[sorted.length - 1], mean: Math.round(mean), median: Math.round(median),
    volatilityBp: mean > 0 ? Math.round((sd / mean) * 10000) : 0,
    spanDays: (Math.max(...times) - Math.min(...times)) / 86400,
  };
}
