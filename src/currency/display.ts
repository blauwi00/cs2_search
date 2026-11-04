// Валюта показа: человек выбирает сам (по умолчанию — по языку Telegram). Внутри всё в копейках UAH.
// Курсы: НБУ (официальные, к гривне) и, для валют, которых у НБУ нет (RUB, BRL, ARS), — кросс-курс через доллар
// из открытого файла CSGO Trader (prices.csgotrader.app/latest/exchange_rates.json, его забирает сборщик).

import { UAH_CUR, type Cur } from '../utils/money.ts';
import { loadLatestFx } from '../storage/db.ts';

export const CURRENCIES: { code: string; sign: string; name: string }[] = [
  { code: 'USD', sign: '$', name: 'Доллар США' }, { code: 'EUR', sign: '€', name: 'Евро' },
  { code: 'UAH', sign: '₴', name: 'Гривна' }, { code: 'PLN', sign: 'zł', name: 'Злотый' },
  { code: 'RUB', sign: '₽', name: 'Рубль' }, { code: 'KZT', sign: '₸', name: 'Тенге' },
  { code: 'GBP', sign: '£', name: 'Фунт' }, { code: 'TRY', sign: '₺', name: 'Турецкая лира' },
  { code: 'CNY', sign: '¥', name: 'Юань' }, { code: 'BRL', sign: 'R$', name: 'Бразильский реал' },
  { code: 'CAD', sign: 'C$', name: 'Канадский доллар' }, { code: 'AUD', sign: 'A$', name: 'Австралийский доллар' },
  { code: 'CZK', sign: 'Kč', name: 'Чешская крона' }, { code: 'SEK', sign: 'SEK', name: 'Шведская крона' },
  { code: 'NOK', sign: 'NOK', name: 'Норвежская крона' }, { code: 'DKK', sign: 'DKK', name: 'Датская крона' },
  { code: 'CHF', sign: 'CHF', name: 'Швейцарский франк' }, { code: 'HUF', sign: 'Ft', name: 'Форинт' },
  { code: 'RON', sign: 'lei', name: 'Румынский лей' }, { code: 'GEL', sign: '₾', name: 'Лари' },
  { code: 'AZN', sign: '₼', name: 'Манат' }, { code: 'MDL', sign: 'MDL', name: 'Молдавский лей' },
  { code: 'INR', sign: '₹', name: 'Индийская рупия' }, { code: 'JPY', sign: 'JPY', name: 'Иена' },
  { code: 'KRW', sign: '₩', name: 'Вона' }, { code: 'ILS', sign: '₪', name: 'Шекель' },
  { code: 'MXN', sign: 'MX$', name: 'Мексиканское песо' }, { code: 'ARS', sign: 'ARS', name: 'Аргентинское песо' },
];
const BY_CODE = new Map(CURRENCIES.map((c) => [c.code, c]));
export const isCurrency = (c: unknown): c is string => typeof c === 'string' && BY_CODE.has(c);

/** Язык Telegram → валюта по умолчанию (человек потом может сменить). */
const LANG: Record<string, string> = {
  uk: 'UAH', pl: 'PLN', kk: 'KZT', tr: 'TRY', 'pt-br': 'BRL', cs: 'CZK', sv: 'SEK', nb: 'NOK', no: 'NOK', da: 'DKK',
  hu: 'HUF', ro: 'RON', ka: 'GEL', az: 'AZN', zh: 'CNY', ja: 'JPY', ko: 'KRW', he: 'ILS', hi: 'INR', 'en-gb': 'GBP',
  de: 'EUR', fr: 'EUR', es: 'EUR', it: 'EUR', nl: 'EUR', pt: 'EUR', fi: 'EUR', el: 'EUR', sk: 'EUR', sl: 'EUR',
  et: 'EUR', lv: 'EUR', lt: 'EUR', hr: 'EUR', ga: 'EUR',
};
export function guessCurrency(lang: unknown): string {
  if (typeof lang !== 'string') return 'USD';
  const l = lang.toLowerCase();
  return LANG[l] ?? LANG[l.split('-')[0]] ?? 'USD';
}

export type Rates = Record<string, number>; // сколько UAH за 1 единицу

/** Курсы НБУ для всех валют показа (из того же ответа НБУ, что и основные курсы). */
export function parseNbuDisplay(json: unknown): Rates {
  const out: Rates = {};
  if (!Array.isArray(json)) return out;
  for (const r of json as { cc?: unknown; rate?: unknown }[]) {
    if (isCurrency(r?.cc) && typeof r.rate === 'number' && r.rate > 0 && r.rate < 1e5) out[r.cc] = r.rate;
  }
  return out;
}

/** Курсы к доллару из файла CSGO Trader: { "EUR": 0.92, "RUB": 81.5, ... } — сколько единиц за 1 $. */
export function parseUsdRates(v: unknown): Rates {
  const out: Rates = {};
  if (!v || typeof v !== 'object') return out;
  for (const [k, r] of Object.entries(v as Record<string, unknown>)) {
    if (isCurrency(k) && typeof r === 'number' && Number.isFinite(r) && r > 0 && r < 1e7) out[k] = r;
  }
  return out;
}

/** Итоговые курсы: НБУ, а чего у НБУ нет — через доллар. */
export function mergeRates(nbu: Rates, usd: Rates, nbuUsdFallback: number | null): Rates {
  const out: Rates = { ...nbu, UAH: 1 };
  const uahPerUsd = nbu.USD ?? nbuUsdFallback;
  if (uahPerUsd) {
    out.USD = uahPerUsd;
    for (const [k, perUsd] of Object.entries(usd)) if (!(k in out)) out[k] = uahPerUsd / perUsd;
  }
  return out;
}

export async function loadRates(d: D1Database): Promise<Rates> {
  const rows = (await d.prepare(`SELECT key, value FROM meta WHERE key IN ('fx_display', 'fx_usd')`).all<{ key: string; value: string }>()).results;
  const get = (k: string): Rates => { try { return JSON.parse(rows.find((r) => r.key === k)?.value ?? '{}') as Rates; } catch { return {}; } };
  let nbu = get('fx_display');
  if (!nbu.USD) {
    // До первого обновления — основные курсы из таблицы курсов.
    const fx = await loadLatestFx(d);
    nbu = { ...Object.fromEntries([...fx.values()].map((r) => [r.base, r.rateMicro / 1e6])), ...nbu };
  }
  return mergeRates(nbu, get('fx_usd'), null);
}

export function curFor(code: string | null | undefined, rates: Rates): Cur {
  const c = code && BY_CODE.get(code);
  const per = c ? rates[c.code] : undefined;
  return c && per ? { code: c.code, sign: c.sign, per } : code === 'USD' || !code ? (rates.USD ? { code: 'USD', sign: '$', per: rates.USD } : UAH_CUR) : UAH_CUR;
}

/** Валюты, которые можно выбрать прямо сейчас (есть курс). */
export function availableCurrencies(rates: Rates): { code: string; sign: string; name: string }[] {
  return CURRENCIES.filter((c) => rates[c.code]);
}

/** Валюта человека: своя настройка; у старых пользователей без настройки — гривна, как было. Канал/группа — доллар. */
export async function userCur(d: D1Database, chatId: number, rates: Rates): Promise<Cur> {
  if (chatId < 0) return curFor('USD', rates);
  const r = await d.prepare(`SELECT value FROM user_settings WHERE telegram_id = ? AND key = 'currency'`).bind(chatId).first<{ value: string }>();
  return r?.value ? curFor(r.value, rates) : UAH_CUR;
}

/** Для TelegramClient: валюта получателя, с кэшем на один вызов Worker. */
export function moneyResolver(d: D1Database): (chatId: number) => Promise<Cur> {
  let rates: Promise<Rates> | null = null;
  const cache = new Map<number, Promise<Cur>>();
  return (chatId) => {
    rates ??= loadRates(d).catch(() => ({ UAH: 1 }));
    let c = cache.get(chatId);
    if (!c) { c = rates.then((r) => userCur(d, chatId, r)); cache.set(chatId, c); }
    return c;
  };
}
