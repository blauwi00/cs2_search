// Площадки, с которых бот берёт цены, и партнёрские (реферальные) ссылки владельца бота.
// Партнёрскую ссылку владелец задаёт командой /ref; без неё — обычная ссылка на сайт.
// В приложении такие ссылки честно помечены «партнёрская ссылка».

import { getMeta, setMetaStmt } from './channel.ts';

export type SiteKey = 'skinport' | 'csgomarket' | 'waxpeer' | 'lisskins' | 'csfloat' | 'csmoney' | 'dmarket' | 'steam';

export const SITES: { key: SiteKey; name: string; url: string; host: RegExp; desc: string }[] = [
  { key: 'steam', name: 'Steam Market', url: 'https://steamcommunity.com/market/search?appid=730', host: /^steamcommunity\.com$/, desc: 'Официальный рынок, деньги остаются в Steam' },
  { key: 'skinport', name: 'Skinport', url: 'https://skinport.com/', host: /(^|\.)skinport\.com$/, desc: 'Объявления от игроков, вывод денег на карту' },
  { key: 'csfloat', name: 'CSFloat', url: 'https://csfloat.com/', host: /(^|\.)csfloat\.com$/, desc: 'Поиск по float и паттерну' },
  { key: 'csgomarket', name: 'Market.CSGO', url: 'https://market.csgo.com/', host: /(^|\.)(market\.csgo\.com|csgo\.com)$/, desc: 'Большой рынок, часто дешевле Steam' },
  { key: 'csmoney', name: 'CS.MONEY', url: 'https://cs.money/', host: /(^|\.)cs\.money$/, desc: 'Большой рынок и обмен скинов' },
  { key: 'waxpeer', name: 'Waxpeer', url: 'https://waxpeer.com/', host: /(^|\.)waxpeer\.com$/, desc: 'Рынок между игроками, низкие комиссии' },
  { key: 'lisskins', name: 'LIS-SKINS', url: 'https://lis-skins.com/', host: /(^|\.)lis-skins\.(com|ru)$/, desc: 'Быстрые покупки, моментальная продажа' },
  { key: 'dmarket', name: 'DMarket', url: 'https://dmarket.com/', host: /(^|\.)dmarket\.com$/, desc: 'Рынок и обмен, вывод денег' },
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

export function sitesFor(links: RefLinks): { key: SiteKey; name: string; url: string; desc: string; ref: boolean; icon: string }[] {
  return SITES.map((s) => ({ key: s.key, name: s.name, desc: s.desc, url: links[s.key] ?? s.url, ref: !!links[s.key], icon: siteIcon(s.url) }));
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

export interface SitePrice { key: string; name: string; group: string; kop: number; url: string; icon: string; ref: boolean }

/** Цены предмета на всех площадках (самое дешёвое объявление), в копейках. Партнёрская ссылка — на главную площадки. */
export function sitePriceList(name: string, usdCents: Record<string, number>, toKopUsd: (c: number) => number | null, links: RefLinks): SitePrice[] {
  const out: SitePrice[] = [];
  for (const s of PRICE_SITES) {
    const c = usdCents[s.key];
    const kop = c ? toKopUsd(c) : null;
    if (!kop) continue;
    const ref = links[s.key as SiteKey];
    out.push({ key: s.key, name: s.name, group: s.group, kop, url: ref ?? s.url(name), icon: siteIcon(s.home), ref: !!ref });
  }
  return out.sort((a, b) => a.kop - b.kop);
}
