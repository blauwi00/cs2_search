// DEMO-режим: прогоняет расчёт на ТЕСТОВЫХ данных и присылает уведомления с явной пометкой.
// Ничего не пишет в базу и не смешивается с реальными ценами.

import { parsePriceOverview } from './api/steam.ts';
import { itemToQuote } from './api/skinport.ts';
import { toKop, type FxRate } from './currency/nbu.ts';
import { computeSteamArbitrage } from './core/arbitrage.ts';
import { classifyLiquidity } from './core/liquidity.ts';
import { scoreArbitrage } from './core/scoring.ts';
import { detectChanges } from './core/analyzer.ts';
import { arbitrageMessage, changeMessage } from './telegram/messages.ts';
import type { TelegramClient } from './telegram/api.ts';
import { steamListingUrl } from './utils/http.ts';

export const DEMO_ITEM = 'AK-47 | Redline (Field-Tested)';
/** Тестовый курс — не курс НБУ. */
export const DEMO_FX: FxRate = { base: 'EUR', rateMicro: 45_000_000, rateDate: '2000-01-01', source: 'demo' };

export function demoCalculation(now: number) {
  const steam = parsePriceOverview({ success: true, lowest_price: '650,00₴', median_price: '640,00₴', volume: '120' }, DEMO_ITEM, now);
  const sp = itemToQuote({ market_hash_name: DEMO_ITEM, currency: 'EUR', min_price: 8.5, median_price: 10, quantity: 25, item_page: 'https://skinport.com/item/ak-47-redline-field-tested', updated_at: now }, now)!;
  const costKop = toKop(sp.priceMinor!, 'EUR', DEMO_FX)!;
  const arb = computeSteamArbitrage({ source: 'skinport', costKop, fetchedAt: now }, { lowestKop: steam[0].priceMinor, medianKop: steam[1].priceMinor, fetchedAt: now })!;
  const liquidity = classifyLiquidity({ steamSales24h: steam[1].volume, skinportSales7d: null, activeListings: null });
  const score = scoreArbitrage({
    arb, liquidity, uniquePriced: false, buyQuantity: sp.quantity, buyAgeSec: 60, sellAgeSec: 60, fxAgeDays: 0, fxAvailable: true,
    settings: { minProfitKop: 2000, minRoiBp: 800, maxBuyKop: 0, budgetKop: 0, maxStaleSec: 1800, fxMaxAgeDays: 4, requireLiquidity: 'medium' },
  });
  return { sp, arb, liquidity, score };
}

export async function runDemo(tg: TelegramClient, chatId: number, now: number): Promise<void> {
  const { sp, arb, liquidity, score } = demoCalculation(now);
  const v = arbitrageMessage({
    signalId: 0, name: DEMO_ITEM, buySource: 'skinport', buyUrl: sp.url, buyOriginal: '8,50 EUR',
    fxNote: 'Тестовый курс 45,0000 грн за 1 EUR (не курс НБУ)', arb, score, liquidity, dataAt: now - 60, now, demo: true,
  });
  await tg.sendMessage(chatId, v.text, v.keyboard);
  const ev = detectChanges({ at: now, minor: 52000, currency: 'UAH', volume: 120 },
    [{ at: now - 86400 - 600, minor: 65000, currency: 'UAH', volume: 110 }], now, 1500)[0];
  if (ev) {
    const m = changeMessage(DEMO_ITEM, ev, ev.fromMinor, ev.toMinor, 'самое дешёвое объявление', 120, steamListingUrl(DEMO_ITEM), true);
    await tg.sendMessage(chatId, m.text, m.keyboard);
  }
}
