/**
 * «Куда потратить баланс Steam»: предметы, которые покупаются прямо в Steam на сумму баланса и держатся/растут в цене.
 * Это не сделка с гарантированной прибылью (деньги на балансе Steam вывести нельзя, комиссия Steam при продаже обратно ≈13%),
 * поэтому показываем только то, что ликвидно (много продаж за сутки), не похоже на разгон и дорожало последнюю неделю.
 */
import { steamBuyerPriceForReceived } from './fees.ts';
import { parseMarketHashName } from './normalization.ts';
import { scanPump, type ScanEntry } from './recs.ts';

export interface SpendIdea {
  name: string; img: string | null;
  priceKop: number;        // самая низкая цена в Steam сейчас
  trendBp: number;         // рост средней цены продаж за неделю против месяца (в сотых долях процента)
  vol24h: number;          // продаж в Steam за сутки
  breakevenKop: number;    // за сколько выставить в Steam, чтобы после комиссии вернуть потраченное
}
export const SPEND_MIN_KOP = 500;       // дешевле 5 ₴ — копеечный мусор
export const SPEND_MIN_VOL24 = 20;
export const SPEND_MIN_TREND_BP = 300;  // не меньше +3%
export const SPEND_MAX_TREND_BP = 5000; // больше +50% — это уже разгон, не рекомендуем

export function spendIdeas(entries: ScanEntry[], limitKop: number, max = 6): SpendIdea[] {
  const out: SpendIdea[] = [];
  for (const e of entries) {
    const price = e.steam?.lowestKop ?? null, vol = e.steam?.volume24h ?? 0;
    if (!price || price < SPEND_MIN_KOP || price > limitKop || vol < SPEND_MIN_VOL24) continue;
    const sa = e.sa;
    if (!sa?.d7 || !sa.d30 || !sa.d1) continue;
    const trend = Math.trunc(((sa.d7 - sa.d30) * 10000) / sa.d30);
    if (trend < SPEND_MIN_TREND_BP || trend > SPEND_MAX_TREND_BP) continue;
    if (sa.d1 < sa.d7 * 0.9) continue;                      // сегодня уже падает — не берём
    if (parseMarketHashName(e.name).uniquePriced || scanPump(e)) continue;
    out.push({ name: e.name, img: e.img ?? null, priceKop: price, trendBp: trend, vol24h: vol, breakevenKop: steamBuyerPriceForReceived(price).buyerPays });
  }
  out.sort((a, b) => b.vol24h * Math.min(b.trendBp, 1500) - a.vol24h * Math.min(a.trendBp, 1500));
  return out.slice(0, max);
}
