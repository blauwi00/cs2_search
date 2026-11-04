// Рекомендации по всему рынку (не только по списку наблюдения).
// Данные: каталог Skinport (самое дешёвое объявление), история продаж Skinport (медиана и объём за 7/30 дней)
// и цены Steam для части кандидатов. Сборщик GitHub присылает их как kind=scan.
// Важно: ничто не растёт «на 100%». Тренд — это только то, что уже произошло за последние недели.

import { steamSellerProceeds } from './fees.ts';
import { parseMarketHashName } from './normalization.ts';
import { toKop, type FxRate } from '../currency/nbu.ts';
import { parseSteamPriceString } from '../utils/money.ts';

/**
 * Комиссия продавца Skinport: 8% (6% для продаж дороже 1000 €).
 * Источник — сводка комиссий csdb.gg (снижение с 12% 18.07.2025); официальной таблицы в API нет — это ДОПУЩЕНИЕ,
 * поэтому в интерфейсе стоит пометка «проверь на сайте».
 */
export const SKINPORT_SELL_FEE_BP = 800;
export const SKINPORT_SELL_FEE_HIGH_BP = 600;
export const SKINPORT_HIGH_EUR_CENTS = 100_000;

export interface ScanPeriod { median: number | null; volume: number | null }
export interface ScanEntry {
  name: string;
  minEur: number | null;            // самое дешёвое объявление Skinport, EUR
  qty: number | null;               // сколько объявлений на Skinport
  s7: ScanPeriod | null;            // продажи Skinport за 7 дней (EUR)
  s30: ScanPeriod | null;           // за 30 дней
  steam: { lowestKop: number | null; medianKop: number | null; volume24h: number | null; at: number } | null;
}

export type RecKind = 'sp_to_steam' | 'sp_flip' | 'steam_to_sp' | 'trend';
export interface Rec {
  kind: RecKind; name: string;
  buyAt: 'skinport' | 'steam'; sellAt: 'skinport' | 'steam';
  buyKop: number; sellKop: number | null; proceedsKop: number | null; profitKop: number | null; roiBp: number | null;
  trendBp: number | null; sales7: number | null; wallet: 'steam_wallet' | 'cash' | null;
  title: string; reason: string; risk: string;
}

const eurCents = (x: unknown): number | null => (typeof x === 'number' && Number.isFinite(x) && x > 0 && x < 1e6 ? Math.round(x * 100) : null);
const int = (x: unknown): number | null => (typeof x === 'number' && Number.isFinite(x) && x >= 0 ? Math.trunc(x) : null);
const period = (p: unknown): ScanPeriod | null => {
  const o = p as { median?: unknown; volume?: unknown } | null;
  return o && typeof o === 'object' ? { median: eurCents(o.median), volume: int(o.volume) } : null;
};

/** Проверка и нормализация того, что прислал сборщик (никаким полям не доверяем). */
export function parseScan(items: unknown, now: number): ScanEntry[] {
  if (!Array.isArray(items)) return [];
  const out: ScanEntry[] = [];
  for (const r of items.slice(0, 400) as Record<string, unknown>[]) {
    if (!r || typeof r.name !== 'string' || r.name.length > 200) continue;
    const st = r.steam as { lowest_price?: unknown; median_price?: unknown; volume?: unknown } | null | undefined;
    const steam = st && typeof st === 'object' ? {
      lowestKop: parseSteamPriceString(typeof st.lowest_price === 'string' ? st.lowest_price : null),
      medianKop: parseSteamPriceString(typeof st.median_price === 'string' ? st.median_price : null),
      volume24h: typeof st.volume === 'string' && st.volume.replace(/[^\d]/g, '') ? Number(st.volume.replace(/[^\d]/g, '')) : null,
      at: now,
    } : null;
    out.push({ name: r.name, minEur: eurCents(r.minEur), qty: int(r.qty), s7: period(r.s7), s30: period(r.s30), steam });
  }
  return out;
}

/** Новое сканирование + цены Steam из прошлых (если свежее 3 часов), чтобы проверенные раньше предметы не пропадали. */
export function mergeScan(fresh: ScanEntry[], old: ScanEntry[], now: number): ScanEntry[] {
  const prev = new Map(old.map((e) => [e.name, e.steam]));
  return fresh.map((e) => {
    if (e.steam) return e;
    const p = prev.get(e.name);
    return p && now - p.at < 3 * 3600 ? { ...e, steam: p } : e;
  });
}

export interface RecSettings { minProfitKop: number; minRoiBp: number }

const fmt = (k: number) => `${(k / 100).toFixed(2).replace('.', ',')} ₴`;
const pct = (bp: number) => `${Math.round(bp / 100)}%`;
const roi = (profit: number, cost: number) => (cost > 0 ? Math.trunc((profit * 10000) / cost) : 0);

function skinportNet(eurCentsPrice: number): number {
  const fee = eurCentsPrice > SKINPORT_HIGH_EUR_CENTS ? SKINPORT_SELL_FEE_HIGH_BP : SKINPORT_SELL_FEE_BP;
  return Math.floor((eurCentsPrice * (10000 - fee)) / 10000);
}

export function buildRecs(entries: ScanEntry[], eur: FxRate | null, s: RecSettings): { deals: Rec[]; trends: Rec[] } {
  const deals: Rec[] = [];
  const trends: Rec[] = [];
  if (!eur) return { deals, trends };
  const kop = (c: number) => toKop(c, 'EUR', eur)!;
  for (const e of entries) {
    if (parseMarketHashName(e.name).uniquePriced) continue; // цена зависит от паттерна — общая цена ненадёжна
    const sales7 = e.s7?.volume ?? null;
    const options: Rec[] = [];
    const spBuy = e.minEur ? kop(e.minEur) : null;
    // Перепродажа на Skinport: реалистичная цена продажи — медиана реальных продаж за 7 дней.
    const spSellNet = e.s7?.median && sales7 !== null && sales7 >= 7 ? kop(skinportNet(e.s7.median)) : null;
    const spSellGross = e.s7?.median ? kop(e.s7.median) : null;
    const st = e.steam;
    const steamLiquid = st?.volume24h != null && st.volume24h >= 5;

    // 1. Купить на Skinport → продать в Steam (деньги придут на баланс Steam).
    if (spBuy && st?.lowestKop && steamLiquid) {
      const proceeds = steamSellerProceeds(Math.max(3, st.lowestKop - 1))?.sellerReceives ?? 0;
      const profit = proceeds - spBuy;
      if (profit >= s.minProfitKop && roi(profit, spBuy) >= s.minRoiBp) options.push({
        kind: 'sp_to_steam', name: e.name, buyAt: 'skinport', sellAt: 'steam', buyKop: spBuy, sellKop: st.lowestKop - 1, proceedsKop: proceeds,
        profitKop: profit, roiBp: roi(profit, spBuy), trendBp: null, sales7, wallet: 'steam_wallet',
        title: 'Skinport → Steam',
        reason: `Купить на Skinport за ${fmt(spBuy)}, выставить в Steam за ${fmt(st.lowestKop - 1)} — после комиссии 15% придёт ≈ ${fmt(proceeds)}.`,
        risk: 'Деньги будут на балансе Steam — вывести их нельзя. Купленный предмет может быть недоступен для обмена до 7 дней.',
      });
    }
    // 2. Купить на Skinport дешевле обычного → продать там же (реальные деньги).
    if (spBuy && spSellNet && spSellGross && spBuy <= Math.floor(spSellGross * 0.9)) {
      const profit = spSellNet - spBuy;
      if (profit >= s.minProfitKop && roi(profit, spBuy) >= s.minRoiBp) options.push({
        kind: 'sp_flip', name: e.name, buyAt: 'skinport', sellAt: 'skinport', buyKop: spBuy, sellKop: spSellGross, proceedsKop: spSellNet,
        profitKop: profit, roiBp: roi(profit, spBuy), trendBp: null, sales7, wallet: 'cash',
        title: 'Skinport → Skinport',
        reason: `Самое дешёвое объявление ${fmt(spBuy)}, а обычно продаётся за ${fmt(spSellGross)} (медиана продаж за 7 дней, ${sales7} шт.). После комиссии 8% ≈ ${fmt(spSellNet)}.`,
        risk: 'Объявление могут купить раньше тебя. После покупки предмет может быть недоступен для обмена до 7 дней, цена за это время может измениться. Комиссию Skinport проверь на сайте.',
      });
    }
    // 3. Купить в Steam → продать на Skinport (из баланса Steam в реальные деньги).
    if (st?.lowestKop && spSellNet && steamLiquid) {
      const profit = spSellNet - st.lowestKop;
      if (profit >= s.minProfitKop && roi(profit, st.lowestKop) >= s.minRoiBp) options.push({
        kind: 'steam_to_sp', name: e.name, buyAt: 'steam', sellAt: 'skinport', buyKop: st.lowestKop, sellKop: spSellGross, proceedsKop: spSellNet,
        profitKop: profit, roiBp: roi(profit, st.lowestKop), trendBp: null, sales7, wallet: 'cash',
        title: 'Steam → Skinport',
        reason: `Купить в Steam за ${fmt(st.lowestKop)}, на Skinport обычно продаётся за ${fmt(spSellGross!)} — после комиссии ≈ ${fmt(spSellNet)}.`,
        risk: 'Купленное в Steam нельзя передать 7 дней — цена на Skinport за это время может упасть. Комиссию Skinport проверь на сайте.',
      });
    }
    if (options.length) deals.push(options.sort((a, b) => b.profitKop! - a.profitKop!)[0]);

    // 4. Тренд: медиана продаж за 7 дней заметно выше, чем за 30 дней, и продаётся часто.
    if (e.s7?.median && e.s30?.median && sales7 !== null && sales7 >= 14 && spBuy) {
      const t = Math.trunc(((e.s7.median - e.s30.median) * 10000) / e.s30.median);
      if (t >= 1000) trends.push({
        kind: 'trend', name: e.name, buyAt: 'skinport', sellAt: 'skinport', buyKop: spBuy, sellKop: null, proceedsKop: null,
        profitKop: null, roiBp: null, trendBp: t, sales7, wallet: null,
        title: `Растёт: +${pct(t)}`,
        reason: `Средняя цена продаж за неделю на ${pct(t)} выше, чем за месяц (${sales7} продаж за 7 дней). Сейчас от ${fmt(spBuy)} на Skinport.`,
        risk: 'Это не гарантия: рост уже случился и может развернуться. Покупай только то, что готов держать.',
      });
    }
  }
  deals.sort((a, b) => b.profitKop! - a.profitKop!);
  trends.sort((a, b) => b.trendBp! - a.trendBp!);
  return { deals: deals.slice(0, 20), trends: trends.slice(0, 15) };
}
