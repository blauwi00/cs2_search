import { fetchJson, type Fetcher } from '../utils/http.ts';
import { SourceError, type Currency } from '../types/market.ts';

export const NBU_URL = 'https://bank.gov.ua/NBUStatService/v1/statdirectory/exchange?json';
export const NEEDED_BASES: Currency[] = ['USD', 'EUR', 'PLN'];

export interface FxRate {
  id?: number;
  base: Currency;
  rateMicro: number;   // UAH за 1 base, умноженное на 1e6
  rateDate: string;    // YYYY-MM-DD
  source: string;
}

interface NbuRow { cc?: unknown; rate?: unknown; exchangedate?: unknown }

/** Разбирает ответ НБУ. Дата приходит как "05.11.2026". */
export function parseNbu(json: unknown): FxRate[] {
  if (!Array.isArray(json)) throw new SourceError('schema', 'НБУ: ожидался массив');
  const out: FxRate[] = [];
  for (const row of json as NbuRow[]) {
    if (typeof row?.cc !== 'string' || !NEEDED_BASES.includes(row.cc as Currency)) continue;
    if (typeof row.rate !== 'number' || !(row.rate > 0) || row.rate > 10000) continue;
    const d = typeof row.exchangedate === 'string' ? row.exchangedate.match(/^(\d{2})\.(\d{2})\.(\d{4})$/) : null;
    if (!d) continue;
    out.push({ base: row.cc as Currency, rateMicro: Math.round(row.rate * 1e6), rateDate: `${d[3]}-${d[2]}-${d[1]}`, source: 'nbu' });
  }
  if (out.length === 0) throw new SourceError('schema', 'НБУ: нужные валюты не найдены');
  return out;
}

export async function fetchNbuRates(fetcher?: Fetcher): Promise<FxRate[]> {
  return parseNbu(await fetchJson(NBU_URL, { fetcher, timeoutMs: 10000 }));
}

/** Конвертация минимальных единиц валюты в копейки UAH (half-up). */
export function toKop(minor: number, currency: Currency, rate: FxRate | null): number | null {
  if (currency === 'UAH') return minor;
  if (!rate || rate.base !== currency) return null;
  return Math.round((minor * rate.rateMicro) / 1e6);
}

/** Насколько устарел курс относительно текущей даты (в днях). Выходные НБУ — нормальны. */
export function fxAgeDays(rateDate: string, now: number): number {
  const t = Date.parse(rateDate + 'T00:00:00Z') / 1000;
  return Math.floor((now - t) / 86400);
}

/** Курс считается пригодным для сигналов высокого приоритета, если ему не больше 4 дней (длинные выходные). */
export const FX_MAX_AGE_DAYS_HIGH = 4;
