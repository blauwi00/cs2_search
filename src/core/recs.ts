// Рекомендации по всему рынку (не только по списку наблюдения).
// Сборщик GitHub присылает (kind=scan) для ~80 кандидатов: самые дешёвые объявления на площадках
// (Skinport, Market.CSGO, Waxpeer, LIS-SKINS), историю продаж Skinport за 7/30 дней и, для части, цены Steam.
// Здесь считаем: «Купи на X за A → продай на Y за B → получишь C» со всеми комиссиями.
// Важно: ничто не растёт «на 100%». Тренд — только то, что уже произошло за последние недели.

import { steamSellerProceeds } from './fees.ts';
import { parseMarketHashName } from './normalization.ts';
import { toKop, type FxRate } from '../currency/nbu.ts';
import { parseSteamPriceString } from '../utils/money.ts';
import type { Currency } from '../types/market.ts';
import { formatUah } from '../utils/money.ts';

export type Market = 'steam' | 'skinport' | 'csgomarket' | 'waxpeer' | 'lisskins';

/**
 * Комиссии продавца. Покупатель на этих площадках платит цену объявления (0%).
 * Steam — официально (5% + 10%). Остальное — по обзорам steamanalyst.com / csdb.gg (проверено 04.11.2026),
 * официальных таблиц в API нет: это ДОПУЩЕНИЕ, в интерфейсе стоит пометка «проверь на сайте».
 * Комиссии пополнения и вывода зависят от способа оплаты — их вводит пользователь в настройках.
 */
export const MARKETS: Record<Market, { name: string; sellFeeBp: number; wallet: 'steam_wallet' | 'cash'; url: (n: string) => string }> = {
  steam: { name: 'Steam', sellFeeBp: 1500, wallet: 'steam_wallet', url: (n) => `https://steamcommunity.com/market/listings/730/${encodeURIComponent(n)}` },
  skinport: { name: 'Skinport', sellFeeBp: 800, wallet: 'cash', url: (n) => `https://skinport.com/market?search=${encodeURIComponent(n)}&sort=price&order=asc` },
  csgomarket: { name: 'Market.CSGO', sellFeeBp: 500, wallet: 'cash', url: (n) => `https://market.csgo.com/?search=${encodeURIComponent(n)}` },
  waxpeer: { name: 'Waxpeer', sellFeeBp: 500, wallet: 'cash', url: (n) => `https://waxpeer.com/?search=${encodeURIComponent(n)}&sort=ASC&order=price` },
  lisskins: { name: 'LIS-SKINS', sellFeeBp: 500, wallet: 'cash', url: (n) => `https://lis-skins.com/market/csgo/?query=${encodeURIComponent(n)}` },
};
/** Прямые страницы предмета (#4). Skinport — точный адрес из его API (item_page), он хранится в market_quotes.url.
 *  LIS-SKINS — адрес вида /market/csgo/ak-47-redline-field-tested/: строим только для обычных скинов оружия «X | Y (Износ)»,
 *  где формат проверен; для StatTrak, сувениров, ножей, кейсов и наклеек остаётся поиск (адрес может отличаться). */
const WEAR = '(Factory New|Minimal Wear|Field-Tested|Well-Worn|Battle-Scarred)';
const SIMPLE_SKIN = new RegExp(`^[A-Za-z0-9-]+(?: [A-Za-z0-9-]+)* \\| [A-Za-z0-9' -]+ \\(${WEAR}\\)$`);
export function lisSkinsSlug(name: string): string | null {
  if (!SIMPLE_SKIN.test(name) || name.startsWith('Souvenir ')) return null;
  return name.toLowerCase().replace(/'/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}
const SKINPORT_PAGE = /^https:\/\/skinport\.com\/item\/[a-z0-9-]+$/;
export type ItemPages = Map<string, string>;
/** Ссылка «Купить/Продать» на площадке: страница предмета, где адрес известен точно, иначе — поиск по названию. */
export function itemUrl(m: Market | string, name: string, skinportPages?: ItemPages | null): string {
  if (m === 'skinport') { const p = skinportPages?.get(name); if (p && SKINPORT_PAGE.test(p)) return p; }
  if (m === 'lisskins') { const s = lisSkinsSlug(name); if (s) return `https://lis-skins.com/market/csgo/${s}/`; }
  return (MARKETS as Record<string, { url: (n: string) => string }>)[m]?.url(name) ?? '';
}
/** Адреса страниц Skinport для набора предметов — одним запросом (по 90 названий). */
export async function loadSkinportPages(d: D1Database, names: string[]): Promise<ItemPages> {
  const out: ItemPages = new Map();
  const uniq = [...new Set(names)];
  for (let i = 0; i < uniq.length; i += 90) {
    const part = uniq.slice(i, i + 90);
    const r = await d.prepare(`SELECT i.market_hash_name AS n, MAX(q.url) AS url FROM market_quotes q JOIN items i ON i.id = q.item_id
      WHERE q.source = 'skinport' AND q.url IS NOT NULL AND i.market_hash_name IN (${part.map(() => '?').join(',')}) GROUP BY i.market_hash_name`).bind(...part).all<{ n: string; url: string }>();
    for (const x of r.results) out.set(x.n, x.url);
  }
  return out;
}
export const SKINPORT_SELL_FEE_HIGH_BP = 600;      // Skinport: 6% для продаж дороже 1000 €
export const SKINPORT_HIGH_EUR_CENTS = 100_000;

export interface ScanOffer { m: Exclude<Market, 'steam'>; cur: Currency; minor: number; qty: number | null }
export interface ScanPeriod { median: number | null; volume: number | null }
export interface ScanEntry {
  name: string;
  img?: string | null;
  offers: ScanOffer[];
  s7: ScanPeriod | null;            // продажи Skinport за 7 дней (EUR, центы)
  s30: ScanPeriod | null;
  /** Средние продажи Steam (USD, центы) из открытого прайса CSGO Trader: за сутки / неделю / месяц / 3 месяца. */
  sa?: { d1: number | null; d7: number | null; d30: number | null; d90: number | null } | null;
  steam: { lowestKop: number | null; medianKop: number | null; volume24h: number | null; at: number } | null;
}

const cents = (x: unknown, scale = 100): number | null => {
  const n = typeof x === 'string' ? Number(x) : x;
  return typeof n === 'number' && Number.isFinite(n) && n > 0 && n < 1e7 ? Math.round(n * scale) : null;
};
const int = (x: unknown): number | null => {
  const n = typeof x === 'string' ? Number(x) : x;
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? Math.trunc(n) : null;
};
const period = (p: unknown): ScanPeriod | null => {
  const o = p as { median?: unknown; volume?: unknown } | null;
  return o && typeof o === 'object' ? { median: cents(o.median), volume: int(o.volume) } : null;
};
const OFFER_CUR: Record<ScanOffer['m'], Currency> = { skinport: 'EUR', csgomarket: 'USD', waxpeer: 'USD', lisskins: 'USD' };
const IMG_OK = /^https:\/\/(community\.(akamai|cloudflare|fastly)\.steamstatic\.com|steamcommunity-a\.akamaihd\.net|raw\.githubusercontent\.com)\//;
export const safeImg = (u: unknown): string | null => (typeof u === 'string' && u.length < 600 && IMG_OK.test(u) ? u : null);

/** Проверка того, что прислал сборщик (никаким полям не доверяем). Цены площадок — в долларах/евро (числа). */
export function parseScan(items: unknown, now: number): ScanEntry[] {
  if (!Array.isArray(items)) return [];
  const out: ScanEntry[] = [];
  for (const r of items.slice(0, 400) as Record<string, unknown>[]) {
    if (!r || typeof r.name !== 'string' || r.name.length > 200) continue;
    const offers: ScanOffer[] = [];
    const raw = r.offers && typeof r.offers === 'object' ? (r.offers as Record<string, { p?: unknown; q?: unknown }>) : {};
    for (const m of Object.keys(OFFER_CUR) as ScanOffer['m'][]) {
      const minor = cents(raw[m]?.p);
      if (minor) offers.push({ m, cur: OFFER_CUR[m], minor, qty: int(raw[m]?.q) });
    }
    const st = r.steam as { lowest_price?: unknown; median_price?: unknown; volume?: unknown } | null | undefined;
    const steam = st && typeof st === 'object' ? {
      lowestKop: parseSteamPriceString(typeof st.lowest_price === 'string' ? st.lowest_price : null),
      medianKop: parseSteamPriceString(typeof st.median_price === 'string' ? st.median_price : null),
      volume24h: typeof st.volume === 'string' && st.volume.replace(/[^\d]/g, '') ? Number(st.volume.replace(/[^\d]/g, '')) : null,
      at: now,
    } : null;
    const sa = r.sa && typeof r.sa === 'object' ? r.sa as Record<string, unknown> : null;
    out.push({ name: r.name, img: safeImg(r.img), offers, s7: period(r.s7), s30: period(r.s30), steam,
      sa: sa ? { d1: cents(sa.d1), d7: cents(sa.d7), d30: cents(sa.d30), d90: cents(sa.d90) } : null });
  }
  return out;
}

/** Новый скан + то, чего в нём нет, из прошлого: цены Steam (если свежее 3 часов) и картинка. */
export function mergeScan(fresh: ScanEntry[], old: ScanEntry[], now: number): ScanEntry[] {
  const prev = new Map(old.map((e) => [e.name, e]));
  return fresh.map((e) => {
    const p = prev.get(e.name);
    if (!p) return e;
    const steam = e.steam ?? (p.steam && now - p.steam.at < 3 * 3600 ? p.steam : null);
    return { ...e, steam, img: e.img ?? p.img ?? null };
  });
}

export interface RecSettings { minProfitKop: number; minRoiBp: number; depositFeeBp: number; withdrawFeeBp: number }

export type RecKind = 'flip' | 'trend';
export interface Rec {
  kind: RecKind; name: string; img: string | null;
  buyAt: Market; sellAt: Market;
  buyKop: number;          // цена объявления
  payKop: number;          // сколько реально заплатишь (с комиссией оплаты)
  sellKop: number | null;  // за сколько выставить
  getKop: number | null;   // сколько получишь после всех комиссий
  profitKop: number | null; roiBp: number | null;
  trendBp: number | null; sales7: number | null; wallet: 'steam_wallet' | 'cash' | null;
  fees: string[];          // расшифровка комиссий простыми словами
  sellBasis: string;
  title: string; reason: string; risk: string;
}

const fmt = (k: number) => formatUah(k);
const pct = (bp: number) => `${(bp / 100).toString().replace('.', ',')}%`;
const roiOf = (profit: number, cost: number) => (cost > 0 ? Math.trunc((profit * 10000) / cost) : 0);
const MIN_QTY = 5;   // меньше объявлений — цена «самого дешёвого» случайна, продать по ней сложно
/**
 * Проверки здравого смысла (без них в идеи попадали неликвидные наклейки с «+3000%»):
 * — нужна реальная цена продаж: медиана продаж Skinport за 7 дней, минимум 7 продаж;
 * — продать на сайте можно не дороже реальной цены продаж + 15%;
 * — объявление дешевле половины реальной цены — подозрительно (ошибка, блокировка, не тот предмет);
 * — доходность выше 60% почти всегда ошибка данных, а не сделка.
 */
export const MIN_SALES_7D = 7;
export const MAX_SELL_OVER_REF = 1.15;
export const MIN_BUY_OF_REF = 0.5;
export const MAX_ROI_BP = 6000;

interface SellSide { m: Market; listKop: number; netKop: number; basis: string; fees: string[] }

/** Где купить и где продать один предмет (все проверки здравого смысла). Общая часть для идей и проверки идей через сутки. */
export function marketSides(e: ScanEntry, fx: Map<Currency, FxRate>, s: RecSettings) {
  const kop = (minor: number, cur: Currency) => toKop(minor, cur, fx.get(cur) ?? null);
  const afterWithdraw = (k: number) => Math.floor((k * (10000 - s.withdrawFeeBp)) / 10000);
  const sales7 = e.s7?.volume ?? null;
  // Реальная цена продаж — без неё сделки не предлагаем.
  const refKop = e.s7?.median && sales7 !== null && sales7 >= MIN_SALES_7D ? kop(e.s7.median, 'EUR') : null;
  // ---- Где купить: цена объявления + комиссия оплаты.
  const buys: { m: Market; listKop: number; payKop: number; qty: number | null }[] = [];
  for (const o of e.offers ?? []) {
    const k = kop(o.minor, o.cur);
    if (k) buys.push({ m: o.m, listKop: k, payKop: Math.ceil((k * (10000 + s.depositFeeBp)) / 10000), qty: o.qty });
  }
  if (e.steam?.lowestKop) buys.push({ m: 'steam', listKop: e.steam.lowestKop, payKop: e.steam.lowestKop, qty: null });
  // ---- Где продать: реалистичная цена − комиссия площадки − комиссия вывода.
  const sells: SellSide[] = [];
  const wFee = s.withdrawFeeBp ? [`вывод ${pct(s.withdrawFeeBp)}`] : [];
  if (e.steam?.lowestKop && (e.steam.volume24h ?? 0) >= 5) {
    const list = e.steam.lowestKop - 1;
    const net = steamSellerProceeds(Math.max(3, list))?.sellerReceives ?? 0;
    sells.push({ m: 'steam', listKop: list, netKop: net, basis: `на 1 коп. дешевле самого дешёвого (${e.steam.volume24h} продаж за сутки)`, fees: ['Steam 15%'] });
  } else if (e.sa?.d7 && e.sa.d1) {
    // Живой цены Steam нет — ориентир: средняя цена продаж в Steam за неделю (прайс CSGO Trader, USD → грн по НБУ).
    const list = kop(Math.min(e.sa.d7, e.sa.d1), 'USD');
    const net = list ? steamSellerProceeds(Math.max(3, list))?.sellerReceives ?? 0 : 0;
    if (list) sells.push({ m: 'steam', listKop: list, netKop: net, basis: 'средняя цена продаж в Steam за неделю (≈, пересчёт из USD по курсу НБУ)', fees: ['Steam 15%'] });
  }
  if (e.s7?.median && sales7 !== null && sales7 >= 7) {
    const list = kop(e.s7.median, 'EUR');
    const feeBp = e.s7.median > SKINPORT_HIGH_EUR_CENTS ? SKINPORT_SELL_FEE_HIGH_BP : MARKETS.skinport.sellFeeBp;
    if (list) sells.push({ m: 'skinport', listKop: list, netKop: afterWithdraw(Math.floor((list * (10000 - feeBp)) / 10000)),
      basis: `средняя цена реальных продаж за 7 дней (${sales7} шт.)`, fees: [`Skinport ${pct(feeBp)}`, ...wFee] });
  }
  // Остальные сайты: истории продаж нет — ориентир «на 1% дешевле самого дешёвого», только если объявлений много.
  const offerKops = buys.filter((b) => b.m !== 'steam').map((b) => b.listKop).sort((a, b) => a - b);
  const typical = offerKops.length ? offerKops[Math.floor(offerKops.length / 2)] : null;
  for (const b of buys) {
    if (b.m === 'steam' || b.m === 'skinport' || (b.qty ?? 0) < MIN_QTY) continue;
    if (typical && b.listKop > typical * 1.3) continue; // одинокая завышенная цена — не ориентир
    if (!refKop || b.listKop > refKop * MAX_SELL_OVER_REF) continue; // дороже, чем реально покупают
    const list = Math.floor(b.listKop * 0.99);
    const fee = MARKETS[b.m].sellFeeBp;
    sells.push({ m: b.m, listKop: list, netKop: afterWithdraw(Math.floor((list * (10000 - fee)) / 10000)),
      basis: `на 1% дешевле самого дешёвого (${b.qty} объявлений)`, fees: [`${MARKETS[b.m].name} ${pct(fee)}`, ...wFee] });
  }
  return { sales7, refKop, buys, sells };
}

export function buildRecs(entries: ScanEntry[], fx: Map<Currency, FxRate>, s: RecSettings): { deals: Rec[]; trends: Rec[] } {
  const deals: Rec[] = [];
  const trends: Rec[] = [];
  for (const e of entries) {
    if (parseMarketHashName(e.name).uniquePriced) continue; // цена зависит от паттерна — общая цена ненадёжна
    const { sales7, refKop, buys, sells } = marketSides(e, fx, s);
    // ---- Лучшая пара «купить → продать».
    let best: Rec | null = null;
    for (const b of buys) {
      if (!refKop || b.listKop < refKop * MIN_BUY_OF_REF) continue;
      for (const sl of sells) {
        if (sl.m === b.m && b.m !== 'skinport') continue; // перепродажа на той же площадке — только по истории продаж Skinport
        if (b.m === 'skinport' && sl.m === 'skinport' && b.listKop > sl.listKop * 0.9) continue;
        const profit = sl.netKop - b.payKop;
        const roi = roiOf(profit, b.payKop);
        if (profit < s.minProfitKop || roi < s.minRoiBp || roi > MAX_ROI_BP) continue;
        if (best && best.profitKop! >= profit) continue;
        const fees = [b.m !== 'steam' && s.depositFeeBp ? `оплата ${pct(s.depositFeeBp)}` : null, ...sl.fees].filter((x): x is string => !!x);
        const wallet = MARKETS[sl.m].wallet;
        best = {
          kind: 'flip', name: e.name, img: e.img ?? null, buyAt: b.m, sellAt: sl.m, buyKop: b.listKop, payKop: b.payKop,
          sellKop: sl.listKop, getKop: sl.netKop, profitKop: profit, roiBp: roi, trendBp: null, sales7, wallet, fees, sellBasis: sl.basis,
          title: `${MARKETS[b.m].name} → ${MARKETS[sl.m].name}`,
          reason: `Купи на ${MARKETS[b.m].name} за ${fmt(b.payKop)} → продай на ${MARKETS[sl.m].name} за ${fmt(sl.listKop)} → получишь ${fmt(sl.netKop)} (+${fmt(profit)}).`,
          risk: [
            wallet === 'steam_wallet' ? 'Деньги придут на баланс Steam — вывести их нельзя.' : 'Комиссии сайтов взяты из обзоров — проверь на сайте перед первой сделкой.',
            b.m === 'steam' ? 'Купленное в Steam нельзя передать 7 дней — цена за это время может измениться.' : 'Купленный предмет может быть недоступен для обмена до 7 дней.',
            'Объявление могут купить раньше тебя.',
          ].join(' '),
        };
      }
    }
    if (best) deals.push(best);

    // ---- Тренд: медиана продаж за 7 дней заметно выше, чем за 30 дней, и продаётся часто.
    const cheapest = buys.filter((b) => b.m !== 'steam').sort((a, b) => a.payKop - b.payKop)[0];
    const trendPair = e.s7?.median && e.s30?.median && sales7 !== null && sales7 >= 14 ? [e.s7.median, e.s30.median]
      : e.sa?.d7 && e.sa.d30 && e.sa.d1 && sales7 !== null && sales7 >= 7 ? [e.sa.d7, e.sa.d30] : null;
    if (trendPair && cheapest) {
      const t = Math.trunc(((trendPair[0] - trendPair[1]) * 10000) / trendPair[1]);
      if (t >= 1000) trends.push({
        kind: 'trend', name: e.name, img: e.img ?? null, buyAt: cheapest.m, sellAt: cheapest.m, buyKop: cheapest.listKop, payKop: cheapest.payKop,
        sellKop: null, getKop: null, profitKop: null, roiBp: null, trendBp: t, sales7, wallet: null, fees: [], sellBasis: '',
        title: `Растёт: +${Math.round(t / 100)}%`,
        reason: `Средняя цена продаж за неделю на ${Math.round(t / 100)}% выше, чем за месяц (${sales7} продаж за 7 дней). Дешевле всего сейчас на ${MARKETS[cheapest.m].name}: ${fmt(cheapest.payKop)}.`,
        risk: 'Это не гарантия: рост уже случился и может развернуться. Покупай только то, что готов держать.',
      });
    }
  }
  deals.sort((a, b) => b.profitKop! - a.profitKop!);
  trends.sort((a, b) => b.trendBp! - a.trendBp!);
  return { deals: deals.slice(0, 25), trends: trends.slice(0, 15) };
}
