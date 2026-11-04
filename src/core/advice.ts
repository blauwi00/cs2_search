// Подсказка «что делать» простыми словами. Правила прозрачные и проверяемые — никакой «магии».
// Это не прогноз и не гарантия: только сравнение текущей цены с недавней историей, ликвидностью и комиссиями.

import { steamSellerProceeds } from './fees.ts';
import type { LiquidityClass } from './liquidity.ts';
import { formatUah } from '../utils/money.ts';

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
  /**
   * Запасной ориентир, пока своя история цен Steam не накопилась (1–2 дня):
   * реальные продажи на площадке (медиана Skinport за 30/7 дней) или медиана продаж Steam за сутки.
   */
  alt?: { curKop: number; refKop: number; where: string; basis: string; liquid?: boolean } | null;
}

export interface Advice { action: Action; title: string; reason: string; diffBp: number | null }

const SRC: Record<string, string> = { skinport: 'Skinport', csfloat: 'CSFloat' };
const fmt = (k: number) => formatUah(k);
const pct = (bp: number) => `${Math.abs(Math.round(bp / 100))}%`;

/** Отклонение, которое считаем «заметно дешевле/дороже обычного». */
export const NOTABLE_BP = 800;

export function advise(i: AdviceInput): Advice {
  const ownDiff = i.steamLowKop && i.avg7Kop ? Math.trunc(((i.steamLowKop - i.avg7Kop) * 10000) / i.avg7Kop) : null;
  const own = i.historyDays >= 2 && ownDiff !== null;
  const altDiff = i.alt && i.alt.refKop > 0 ? Math.trunc(((i.alt.curKop - i.alt.refKop) * 10000) / i.alt.refKop) : null;
  // Чем сравниваем: своя недельная история Steam, иначе — реальные продажи (Skinport/Steam).
  const diffBp = own ? ownDiff : altDiff;
  const enoughHistory = diffBp !== null;
  const where = own ? 'в Steam' : i.alt?.where ?? '';
  const vs = own ? 'средней цены за неделю' : i.alt?.basis ?? '';
  const liquidOk = i.liquidity === 'high' || i.liquidity === 'medium' || (i.liquidity === 'unknown' && !!i.alt?.liquid);

  // 1. Уже есть в инвентаре — главный вопрос «продавать ли».
  if (i.lot && i.lot.openQty > 0 && i.steamLowKop) {
    const proceeds = steamSellerProceeds(Math.max(3, i.steamLowKop - 1))?.sellerReceives ?? 0;
    const profit = proceeds - i.lot.costPerUnitKop;
    const roi = i.lot.costPerUnitKop > 0 ? Math.trunc((profit * 10000) / i.lot.costPerUnitKop) : null;
    if (i.lot.targetKop && i.steamLowKop >= i.lot.targetKop) {
      return { action: 'sell', title: 'Продать', reason: `Цена дошла до твоей цели ${fmt(i.lot.targetKop)}.`, diffBp };
    }
    if (roi !== null && roi >= i.minRoiBp && profit >= i.minProfitKop) {
      const peak = own && ownDiff! >= NOTABLE_BP ? ` Сейчас ещё и дороже обычного на ${pct(ownDiff!)}.` : '';
      return { action: 'sell', title: 'Можно продать', reason: `После комиссии Steam ≈ +${fmt(profit)} за шт. (+${pct(roi)}) к цене покупки.${peak}`, diffBp };
    }
    if (own && ownDiff! >= NOTABLE_BP && profit > 0) {
      return { action: 'sell', title: 'Хороший момент продать', reason: `Цена выше средней за неделю на ${pct(ownDiff!)}, продажа уже в плюс (+${fmt(profit)}/шт.).`, diffBp };
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
    return { action: 'nodata', title: 'Мало данных', reason: 'Нет истории продаж ни в Steam, ни на Skinport — предмет редкий или цены ещё не пришли.', diffBp };
  }
  if (i.uniquePriced) {
    return { action: 'hold', title: 'Оценить вручную', reason: 'Цена зависит от паттерна/фазы — общая цена ненадёжна.', diffBp };
  }
  if (diffBp! <= -NOTABLE_BP && liquidOk) {
    return { action: 'buy', title: 'Дешевле обычного', reason: `${where === 'в Steam' ? 'Цена' : `Цена ${where}`} ниже ${vs} на ${pct(diffBp!)}, продаётся хорошо. Выгодно, если держать до возврата к обычной цене (перепродажа сразу съест комиссия).`, diffBp };
  }
  if (diffBp! <= -NOTABLE_BP) {
    return { action: 'hold', title: 'Дёшево, но редкий', reason: `${where === 'в Steam' ? 'Цена' : `Цена ${where}`} ниже ${vs} на ${pct(diffBp!)}, но продаётся редко — перепродать быстро будет сложно.`, diffBp };
  }
  if (diffBp! >= NOTABLE_BP) {
    return { action: 'avoid', title: 'Дорого', reason: `${where === 'в Steam' ? 'Цена' : `Цена ${where}`} выше ${vs} на ${pct(diffBp!)} — покупать сейчас невыгодно.`, diffBp };
  }
  return { action: 'hold', title: 'Ждать', reason: `Цена${where === 'в Steam' ? '' : ` ${where}`} обычная: ${diffBp! >= 0 ? '+' : '−'}${pct(diffBp!)} относительно ${vs}. Выгодной сделки нет.`, diffBp };
}

export const ACTION_RANK: Record<Action, number> = { sell: 0, buy: 1, avoid: 3, hold: 4, nodata: 5 };
