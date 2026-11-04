// Подсказка «что делать» простыми словами. Правила прозрачные и проверяемые — никакой «магии».
// Это не прогноз и не гарантия: только сравнение текущей цены с недавней историей, ликвидностью и комиссиями.

import { steamSellerProceeds } from './fees.ts';
import type { LiquidityClass } from './liquidity.ts';

export type Action = 'buy' | 'sell' | 'hold' | 'avoid' | 'nodata';

export interface AdviceInput {
  steamLowKop: number | null;     // самое дешёвое объявление Steam сейчас
  avg7Kop: number | null;         // средняя цена объявления Steam за 7 дней
  historyDays: number;            // сколько дней истории накоплено
  liquidity: LiquidityClass;
  uniquePriced: boolean;
  deal: { spreadKop: number; buyKop: number; buySource: string; proceedsKop: number; priority: string } | null;
  lot: { openQty: number; costPerUnitKop: number; targetKop: number | null } | null;
  minRoiBp: number;
  minProfitKop: number;
}

export interface Advice { action: Action; title: string; reason: string; diffBp: number | null }

const SRC: Record<string, string> = { skinport: 'Skinport', csfloat: 'CSFloat' };
const fmt = (k: number) => `${(k / 100).toFixed(2).replace('.', ',')} ₴`;
const pct = (bp: number) => `${Math.abs(Math.round(bp / 100))}%`;

/** Отклонение, которое считаем «заметно дешевле/дороже обычного». */
export const NOTABLE_BP = 800;

export function advise(i: AdviceInput): Advice {
  const diffBp = i.steamLowKop && i.avg7Kop ? Math.trunc(((i.steamLowKop - i.avg7Kop) * 10000) / i.avg7Kop) : null;
  const enoughHistory = i.historyDays >= 2 && diffBp !== null;
  const liquidOk = i.liquidity === 'high' || i.liquidity === 'medium';

  // 1. Уже есть в инвентаре — главный вопрос «продавать ли».
  if (i.lot && i.lot.openQty > 0 && i.steamLowKop) {
    const proceeds = steamSellerProceeds(Math.max(3, i.steamLowKop - 1))?.sellerReceives ?? 0;
    const profit = proceeds - i.lot.costPerUnitKop;
    const roi = i.lot.costPerUnitKop > 0 ? Math.trunc((profit * 10000) / i.lot.costPerUnitKop) : null;
    if (i.lot.targetKop && i.steamLowKop >= i.lot.targetKop) {
      return { action: 'sell', title: 'Продать', reason: `Цена дошла до твоей цели ${fmt(i.lot.targetKop)}.`, diffBp };
    }
    if (roi !== null && roi >= i.minRoiBp && profit >= i.minProfitKop) {
      const peak = enoughHistory && diffBp! >= NOTABLE_BP ? ` Сейчас ещё и дороже обычного на ${pct(diffBp!)}.` : '';
      return { action: 'sell', title: 'Можно продать', reason: `После комиссии Steam ≈ +${fmt(profit)} за шт. (+${pct(roi)}) к цене покупки.${peak}`, diffBp };
    }
    if (enoughHistory && diffBp! >= NOTABLE_BP && profit > 0) {
      return { action: 'sell', title: 'Хороший момент продать', reason: `Цена выше средней за неделю на ${pct(diffBp!)}, продажа уже в плюс (+${fmt(profit)}/шт.).`, diffBp };
    }
    if (profit <= 0) {
      return { action: 'hold', title: 'Держать', reason: `Сейчас продажа в минус (${fmt(profit)}/шт. после комиссии). Подожди роста цены.`, diffBp };
    }
    return { action: 'hold', title: 'Держать', reason: `Плюс пока небольшой (+${fmt(profit)}/шт.) — ниже твоего порога прибыли.`, diffBp };
  }

  // 2. Найдена сделка «купить на внешней площадке → продать в Steam».
  if (i.deal && i.deal.spreadKop > 0 && i.deal.priority !== 'low') {
    return {
      action: 'buy', title: 'Купить',
      reason: `На ${SRC[i.deal.buySource] ?? i.deal.buySource} за ${fmt(i.deal.buyKop)}, в Steam придёт ≈ ${fmt(i.deal.proceedsKop)}: +${fmt(i.deal.spreadKop)} на баланс Steam.`,
      diffBp,
    };
  }

  if (!enoughHistory) {
    return { action: 'nodata', title: 'Мало данных', reason: 'История цен ещё копится — подсказка появится через 1–2 дня.', diffBp };
  }
  if (i.uniquePriced) {
    return { action: 'hold', title: 'Оценить вручную', reason: 'Цена зависит от паттерна/фазы — общая цена ненадёжна.', diffBp };
  }
  if (diffBp! <= -NOTABLE_BP && liquidOk) {
    return { action: 'buy', title: 'Дешевле обычного', reason: `Цена ниже средней за неделю на ${pct(diffBp!)}, продаётся хорошо. Покупка в Steam и перепродажа там же — в минус из-за комиссии 15%: выгодно, только если держать до роста.`, diffBp };
  }
  if (diffBp! >= NOTABLE_BP) {
    return { action: 'avoid', title: 'Дорого', reason: `Цена выше средней за неделю на ${pct(diffBp!)} — покупать сейчас невыгодно.`, diffBp };
  }
  return { action: 'hold', title: 'Ждать', reason: `Цена обычная (${diffBp! >= 0 ? '+' : '−'}${pct(diffBp!)} к средней за неделю). Выгодной сделки нет.`, diffBp };
}

export const ACTION_RANK: Record<Action, number> = { sell: 0, buy: 1, avoid: 3, hold: 4, nodata: 5 };
