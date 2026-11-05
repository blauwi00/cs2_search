// Рекомендуемая цена выставления в Steam (цена покупателя) с учётом движения цены.
// Растёт — ставим чуть выше (часть роста за сутки, максимум +5%): дешёвые лоты разберут, а твой купят по более высокой цене.
// Падает или стоит — на 1 копейку ниже самого дешёвого лота, чтобы купили первым.
// Данные: живое самое дешёвое объявление Steam (если свежее) и средние продажи Steam за 1/7/30 дней.

import { steamNetKop, steamListForNetKop } from './fees.ts';

export interface SellPriceInput {
  liveLowKop: number | null;     // самое дешёвое объявление Steam сейчас (свежее, ≤ 6 ч)
  d1Kop: number | null;          // средняя цена продаж Steam за сутки
  d7Kop: number | null;
  d30Kop: number | null;
  costKop?: number | null;       // за сколько купил (если записано) — чтобы предупредить об убытке
  uniquePriced?: boolean;        // цена зависит от паттерна/фазы — общей цене верить нельзя
  wallet?: { per: number };      // валюта кошелька Steam (для минимальных комиссий)
}

export interface SellPrice {
  mode: 'up' | 'down' | 'flat';
  priceKop: number;              // рекомендуемая цена покупателя
  receiveKop: number;            // придёт на баланс после 15%
  quickKop: number;              // чтобы продать быстро
  quickReceiveKop: number;
  trendBp: number | null;        // сутки к неделе
  basis: 'live' | 'avg';
  title: string;
  why: string;
  belowCost: boolean;            // рекомендуемая цена ниже твоей цены покупки (с учётом комиссии)
  breakEvenKop: number | null;   // минимальная цена покупателя без убытка
}

export const UP_BP = 300;        // ≥ +3% за сутки к неделе — растёт
export const MAX_PREMIUM_BP = 500;

const pct = (bp: number) => `${Math.abs(Math.round(bp / 100))}%`;

export function steamSellPrice(i: SellPriceInput): SellPrice | null {
  if (i.uniquePriced) return null;
  const ref = i.liveLowKop ?? i.d1Kop ?? i.d7Kop;
  if (!ref || ref < 3) return null;
  const basis: SellPrice['basis'] = i.liveLowKop ? 'live' : 'avg';
  const trendBp = i.d1Kop && i.d7Kop ? Math.trunc(((i.d1Kop - i.d7Kop) * 10000) / i.d7Kop) : null;
  const monthUp = !i.d30Kop || !i.d7Kop || i.d7Kop >= i.d30Kop * 0.97;
  const quick = Math.max(3, i.liveLowKop ? i.liveLowKop - 1 : Math.floor(ref * 0.98));
  let mode: SellPrice['mode'] = 'flat';
  let price = quick;
  let title = 'Чуть ниже самого дешёвого';
  let why = basis === 'live'
    ? 'Цена ровная — ставь на 1 копейку ниже самого дешёвого лота, тогда купят твой первым.'
    : 'Цена ровная. Живой цены Steam сейчас нет, поэтому ориентир — средняя цена продаж за сутки, чуть ниже неё.';
  if (trendBp !== null && trendBp >= UP_BP && monthUp) {
    mode = 'up';
    const premium = Math.min(MAX_PREMIUM_BP, Math.round(trendBp / 2));
    price = Math.max(ref, Math.round(ref * (1 + premium / 10000)));
    title = `Цена растёт — можно на ${pct(premium)} выше`;
    why = `За сутки продают на ${pct(trendBp)} дороже, чем в среднем за неделю. Поставь чуть выше рынка: дешёвые лоты разберут, и купят твой. Если за 1–2 дня не купят — опусти до «быстро продать».`;
  } else if (trendBp !== null && trendBp <= -UP_BP) {
    mode = 'down';
    title = 'Цена падает — ставь чуть ниже';
    why = `За сутки продают на ${pct(trendBp)} дешевле, чем в среднем за неделю. Если решил продавать — ставь на 1 копейку ниже самого дешёвого лота, чтобы не ждать.`;
  }
  const net = (k: number) => steamNetKop(k, i.wallet) ?? 0;
  const breakEven = i.costKop && i.costKop > 0 ? steamListForNetKop(i.costKop, i.wallet) : null;
  return {
    mode, priceKop: price, receiveKop: net(price), quickKop: quick, quickReceiveKop: net(quick), trendBp, basis, title, why,
    belowCost: breakEven !== null && price < breakEven, breakEvenKop: breakEven,
  };
}
