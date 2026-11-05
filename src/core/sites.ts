// Площадки, с которых бот берёт цены, и партнёрские (реферальные) ссылки владельца бота.
// Партнёрскую ссылку владелец задаёт командой /ref; без неё — обычная ссылка на сайт.
// В приложении такие ссылки честно помечены «партнёрская ссылка».

import { getMeta, setMetaStmt } from './channel.ts';
import { itemUrl, type ItemPages } from './recs.ts';

export type SiteKey = 'skinport' | 'csgomarket' | 'waxpeer' | 'lisskins' | 'csfloat' | 'csmoney' | 'dmarket' | 'buffmarket' | 'skinbaron' | 'csdeals' | 'tradeit' | 'steam';

/** rating — оценка на Trustpilot по сводке CSDB (csdb.gg/trading-sites, проверено июль 2026); null — оценки нет. Обновлять вручную. */
export const RATING_SOURCE = 'Trustpilot, по сводке CSDB, июль 2026';
export const SITES: { key: SiteKey; rating: number | null; name: string; url: string; host: RegExp; desc: string }[] = [
  { key: 'steam', rating: null, name: 'Steam Market', url: 'https://steamcommunity.com/market/search?appid=730', host: /^steamcommunity\.com$/, desc: 'Официальный рынок, деньги остаются в Steam' },
  { key: 'skinport', rating: 4.8, name: 'Skinport', url: 'https://skinport.com/', host: /(^|\.)skinport\.com$/, desc: 'Объявления от игроков, вывод денег на карту' },
  { key: 'csfloat', rating: 4.8, name: 'CSFloat', url: 'https://csfloat.com/', host: /(^|\.)csfloat\.com$/, desc: 'Поиск по float и паттерну' },
  { key: 'csgomarket', rating: null, name: 'Market.CSGO', url: 'https://market.csgo.com/', host: /(^|\.)(market\.csgo\.com|csgo\.com)$/, desc: 'Большой рынок, часто дешевле Steam' },
  { key: 'csmoney', rating: 4.7, name: 'CS.MONEY', url: 'https://cs.money/', host: /(^|\.)cs\.money$/, desc: 'Большой рынок и обмен скинов' },
  { key: 'waxpeer', rating: 2.6, name: 'Waxpeer', url: 'https://waxpeer.com/', host: /(^|\.)waxpeer\.com$/, desc: 'Рынок между игроками, низкие комиссии' },
  { key: 'lisskins', rating: 4.8, name: 'LIS-SKINS', url: 'https://lis-skins.com/', host: /(^|\.)lis-skins\.(com|ru)$/, desc: 'Быстрые покупки, моментальная продажа' },
  { key: 'buffmarket', rating: 4.6, name: 'BUFF Market', url: 'https://buff.market/', host: /(^|\.)buff\.market$/, desc: 'Международная версия BUFF, комиссия 2,5%' },
  { key: 'skinbaron', rating: 4.6, name: 'SkinBaron', url: 'https://skinbaron.de/', host: /(^|\.)skinbaron\.(de|com)$/, desc: 'Немецкая компания, вывод на банк (SEPA)' },
  { key: 'csdeals', rating: 4.7, name: 'CS.Deals', url: 'https://cs.deals/', host: /(^|\.)cs\.deals$/, desc: 'Рынок и обмен, комиссия продавца 2%' },
  { key: 'tradeit', rating: 4.7, name: 'Tradeit.gg', url: 'https://tradeit.gg/', host: /(^|\.)tradeit\.gg$/, desc: 'Обмен через ботов, без вывода денег' },
  { key: 'dmarket', rating: 4.0, name: 'DMarket', url: 'https://dmarket.com/', host: /(^|\.)dmarket\.com$/, desc: 'Рынок и обмен, вывод денег' },
];

export type RefLinks = Partial<Record<SiteKey, string>>;

export async function loadRefLinks(d: D1Database): Promise<RefLinks> {
  try { return JSON.parse((await getMeta(d, 'ref_links')) ?? '{}') as RefLinks; } catch { return {}; }
}

/** Проверка ссылки: только https и только домен этой площадки (чтобы опечаткой не отправить людей на чужой сайт). */
export function checkRefUrl(key: SiteKey, raw: string): string | null {
  const site = SITES.find((s) => s.key === key);
  if (!site) return null;
  try {
    const u = new URL(raw.trim());
    return u.protocol === 'https:' && site.host.test(u.hostname) && raw.length <= 300 ? u.toString() : null;
  } catch { return null; }
}

export function setRefStmt(d: D1Database, links: RefLinks): D1PreparedStatement {
  return setMetaStmt(d, 'ref_links', JSON.stringify(links));
}

/** Для приложения: все площадки, партнёрская ссылка — если задана. */
/** Иконка сайта (favicon) через открытый сервис Google — без запросов к самим площадкам. */
export const siteIcon = (url: string) => `https://www.google.com/s2/favicons?sz=128&domain=${new URL(url).hostname}`;

/** Скрытые с главной площадки. Waxpeer вернули: пусть видят его низкую оценку и будут осторожнее. */
export const HIDDEN_ON_HOME = new Set<SiteKey>([]);
export function sitesFor(links: RefLinks): { key: SiteKey; name: string; url: string; desc: string; ref: boolean; icon: string; rating: number | null }[] {
  // Waxpeer убран с главной (рейтинг 2.6, много жалоб на задержки); его цены в карточках предметов остаются.
  return SITES.filter((s) => !HIDDEN_ON_HOME.has(s.key)).map((s) => ({ key: s.key, name: s.name, rating: s.rating, desc: s.desc, url: links[s.key] ?? s.url, ref: !!links[s.key], icon: siteIcon(s.url) }));
}

/** Площадки в таблице «Цены на площадках» карточки предмета. group: cash — можно вывести деньги, china — китайские (нужен свой аккаунт там). */
export const PRICE_SITES: { key: string; name: string; group: 'cash' | 'china' | 'steam'; home: string; url: (n: string) => string }[] = [
  { key: 'skinport', name: 'Skinport', group: 'cash', home: 'https://skinport.com/', url: (n) => `https://skinport.com/market?search=${encodeURIComponent(n)}&sort=price&order=asc` },
  { key: 'csgomarket', name: 'Market.CSGO', group: 'cash', home: 'https://market.csgo.com/', url: (n) => `https://market.csgo.com/?search=${encodeURIComponent(n)}` },
  { key: 'waxpeer', name: 'Waxpeer', group: 'cash', home: 'https://waxpeer.com/', url: (n) => `https://waxpeer.com/?search=${encodeURIComponent(n)}&sort=ASC&order=price` },
  { key: 'lisskins', name: 'LIS-SKINS', group: 'cash', home: 'https://lis-skins.com/', url: (n) => `https://lis-skins.com/market/csgo/?query=${encodeURIComponent(n)}` },
  { key: 'csfloat', name: 'CSFloat', group: 'cash', home: 'https://csfloat.com/', url: (n) => `https://csfloat.com/search?market_hash_name=${encodeURIComponent(n)}&sort_by=lowest_price` },
  { key: 'csmoney', name: 'CS.MONEY', group: 'cash', home: 'https://cs.money/', url: (n) => `https://cs.money/market/buy/?search=${encodeURIComponent(n)}` },
  { key: 'buff163', name: 'BUFF163', group: 'china', home: 'https://buff.163.com/', url: () => 'https://buff.163.com/market/csgo' },
  { key: 'youpin898', name: 'YouPin', group: 'china', home: 'https://www.youpin898.com/', url: () => 'https://www.youpin898.com/' },
  { key: 'c5game', name: 'C5GAME', group: 'china', home: 'https://www.c5game.com/', url: () => 'https://www.c5game.com/' },
];

/** kind: listing — самое дешёвое активное объявление; reference — ориентир площадки (не объявление, купить по нему нельзя гарантированно). */
export interface SitePrice { key: string; name: string; group: string; kop: number; url: string; icon: string; ref: boolean; kind: 'listing' | 'reference'; at: number | null; cur: string }
/** Что именно отдаёт источник (аудит, приоритет 3). У CS.MONEY в открытом файле — цена бота/обмена, а не объявление. */
export const SITE_PRICE_KIND: Record<string, 'listing' | 'reference'> = { csmoney: 'reference' };
export const SITE_ORIG_CUR: Record<string, string> = { skinport: 'EUR', buff163: 'CNY→USD', youpin898: 'CNY→USD', c5game: 'CNY→USD' };
export const SITE_MAX_AGE_SEC = 48 * 3600;

/** Цены предмета на всех площадках (самое дешёвое объявление), в копейках. Партнёрская ссылка — на главную площадки. */
export function sitePriceList(name: string, usdCents: Record<string, number>, toKopUsd: (c: number) => number | null, links: RefLinks, pages?: ItemPages | null,
  srcAt: Record<string, number> = {}, now: number | null = null): SitePrice[] {
  const out: SitePrice[] = [];
  for (const s of PRICE_SITES) {
    const c = usdCents[s.key];
    const at = srcAt[s.key] ?? null;
    if (now !== null && at !== null && now - at > SITE_MAX_AGE_SEC) continue; // устаревшие данные площадки не показываем как текущие
    const kop = c ? toKopUsd(c) : null;
    if (!kop) continue;
    const ref = links[s.key as SiteKey];
    out.push({ key: s.key, name: s.name, group: s.group, kop, url: ref ?? (s.key === 'skinport' || s.key === 'lisskins' ? itemUrl(s.key, name, pages) : s.url(name)), icon: siteIcon(s.home), ref: !!ref, kind: SITE_PRICE_KIND[s.key] ?? 'listing', at, cur: SITE_ORIG_CUR[s.key] ?? 'USD' });
  }
  return out.sort((a, b) => (a.kind === b.kind ? a.kop - b.kop : a.kind === 'listing' ? -1 : 1));
}
