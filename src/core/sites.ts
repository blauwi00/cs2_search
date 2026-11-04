// Площадки, с которых бот берёт цены, и партнёрские (реферальные) ссылки владельца бота.
// Партнёрскую ссылку владелец задаёт командой /ref; без неё — обычная ссылка на сайт.
// В приложении такие ссылки честно помечены «партнёрская ссылка».

import { getMeta, setMetaStmt } from './channel.ts';

export type SiteKey = 'skinport' | 'csgomarket' | 'waxpeer' | 'lisskins' | 'csfloat' | 'steam';

export const SITES: { key: SiteKey; name: string; url: string; host: RegExp; desc: string }[] = [
  { key: 'skinport', name: 'Skinport', url: 'https://skinport.com/', host: /(^|\.)skinport\.com$/, desc: 'Объявления от игроков, вывод денег на карту' },
  { key: 'csgomarket', name: 'Market.CSGO', url: 'https://market.csgo.com/', host: /(^|\.)(market\.csgo\.com|csgo\.com)$/, desc: 'Большой рынок, часто дешевле Steam' },
  { key: 'waxpeer', name: 'Waxpeer', url: 'https://waxpeer.com/', host: /(^|\.)waxpeer\.com$/, desc: 'Рынок между игроками, низкие комиссии' },
  { key: 'lisskins', name: 'LIS-SKINS', url: 'https://lis-skins.com/', host: /(^|\.)lis-skins\.(com|ru)$/, desc: 'Быстрые покупки, моментальная продажа' },
  { key: 'csfloat', name: 'CSFloat', url: 'https://csfloat.com/', host: /(^|\.)csfloat\.com$/, desc: 'Поиск по float и паттерну' },
  { key: 'steam', name: 'Steam Market', url: 'https://steamcommunity.com/market/search?appid=730', host: /^steamcommunity\.com$/, desc: 'Официальный рынок, деньги остаются в Steam' },
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
