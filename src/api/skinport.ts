// SkinportAdapter — официальный документированный API (docs.skinport.com).
// /v1/items и /v1/sales/history: без авторизации, 8 запросов / 5 минут, кэш 5 минут, обязателен Accept-Encoding: br.
// UAH Skinport не поддерживает → запрашиваем EUR и пересчитываем по курсу НБУ.

import { fetchChecked, fetchJson, type Fetcher } from '../utils/http.ts';
import { decimalToMinor } from '../utils/money.ts';
import { SourceError, type Quote } from '../types/market.ts';

export const SKINPORT_CURRENCY = 'EUR' as const;
const BASE = 'https://api.skinport.com/v1';

export function itemsUrl(): string {
  return `${BASE}/items?${new URLSearchParams({ app_id: '730', currency: SKINPORT_CURRENCY, tradable: '0' })}`;
}

export function salesHistoryUrl(names: string[]): string {
  return `${BASE}/sales/history?${new URLSearchParams({ app_id: '730', currency: SKINPORT_CURRENCY, market_hash_name: names.join(',') })}`;
}

interface SkinportItem {
  market_hash_name?: unknown; currency?: unknown; min_price?: unknown; median_price?: unknown;
  quantity?: unknown; item_page?: unknown; updated_at?: unknown;
}

export function itemToQuote(o: SkinportItem, now: number): Quote | null {
  if (typeof o.market_hash_name !== 'string') return null;
  if (o.currency !== SKINPORT_CURRENCY) throw new SourceError('schema', `Skinport: неожиданная валюта ${String(o.currency)}`);
  const qty = typeof o.quantity === 'number' && o.quantity >= 0 ? o.quantity : null;
  const min = o.min_price === null ? null : decimalToMinor(o.min_price);
  return {
    source: 'skinport', marketHashName: o.market_hash_name, priceType: 'lowest_listing',
    priceMinor: qty === 0 ? null : min, currency: 'EUR', quantity: qty, volume: null, volumePeriod: null,
    listingId: null, floatValue: null, paintSeed: null,
    url: typeof o.item_page === 'string' ? o.item_page : null,
    fetchedAt: now,
    sourceUpdatedAt: typeof o.updated_at === 'number' ? o.updated_at : null,
    tradable: null,
    quality: min === null && qty !== 0 ? 'partial' : 'ok',
  };
}

const KEY = '"market_hash_name"';
/** Позиция первой кавычки значения после ключа (допускает пробелы вокруг двоеточия) или -1, если данных ещё нет. */
function valueQuote(buf: string, afterKey: number): number {
  let i = afterKey;
  while (i < buf.length && (buf[i] === ' ' || buf[i] === '\n' || buf[i] === '\r' || buf[i] === '\t')) i++;
  if (buf[i] !== ':') return i >= buf.length ? -1 : -2;
  i++;
  while (i < buf.length && (buf[i] === ' ' || buf[i] === '\n' || buf[i] === '\r' || buf[i] === '\t')) i++;
  if (i >= buf.length) return -1;
  return buf[i] === '"' ? i : -2;
}

/**
 * Потоковый разбор /v1/items: вместо JSON.parse всего каталога (несколько МБ — не помещается в лимит CPU
 * бесплатного Worker) ищем только нужные предметы и разбираем лишь их объекты.
 * Предполагается, что объекты каталога плоские (без вложенных {}), как в документации.
 */
export async function scanSkinportItems(body: ReadableStream<Uint8Array>, wanted: Set<string>, now: number): Promise<Map<string, Quote>> {
  const found = new Map<string, Quote>();
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let done = false;
  let sawArray = false;
  while (!done && found.size < wanted.size) {
    const r = await reader.read();
    done = r.done;
    buf += r.value ? decoder.decode(r.value, { stream: true }) : decoder.decode();
    if (!sawArray) {
      const t = buf.trimStart();
      if (t.length > 0) {
        if (t[0] !== '[') throw new SourceError('schema', 'Skinport: ожидался массив');
        sawArray = true;
      }
    }
    let pos = 0;
    for (;;) {
      const k = buf.indexOf(KEY, pos);
      if (k < 0) break;
      const objStart = buf.lastIndexOf('{', k);
      const objEnd = buf.indexOf('}', k);
      if (objStart < 0 || objEnd < 0) break; // объект ещё не дочитан
      const vq = valueQuote(buf, k + KEY.length);
      if (vq === -2) { pos = objEnd + 1; continue; } // не строка — пропускаем
      if (vq < 0 || vq > objEnd) break;
      const nameStart = vq + 1;
      let nameEnd = buf.indexOf('"', nameStart);
      while (nameEnd > 0 && buf[nameEnd - 1] === '\\') nameEnd = buf.indexOf('"', nameEnd + 1);
      if (nameEnd < 0 || nameEnd > objEnd) { pos = objEnd + 1; continue; }
      const raw = buf.slice(nameStart, nameEnd);
      const name = raw.includes('\\') ? (JSON.parse(`"${raw}"`) as string) : raw;
      if (wanted.has(name)) {
        try {
          const q = itemToQuote(JSON.parse(buf.slice(objStart, objEnd + 1)) as SkinportItem, now);
          if (q) found.set(name, q);
        } catch (e) {
          if (e instanceof SourceError) throw e;
          throw new SourceError('bad_json', 'Skinport: некорректный объект в каталоге');
        }
      }
      pos = objEnd + 1;
    }
    // Оставляем хвост: начало последнего недочитанного объекта.
    const lastOpen = buf.lastIndexOf('{');
    buf = lastOpen >= pos ? buf.slice(lastOpen) : buf.slice(Math.max(pos, buf.length - KEY.length));
  }
  try { await reader.cancel(); } catch { /* уже закрыт */ }
  if (!sawArray) throw new SourceError('bad_json', 'Skinport: пустой ответ');
  return found;
}

export async function fetchSkinportItems(wanted: Set<string>, now: number, fetcher?: Fetcher): Promise<Map<string, Quote>> {
  const res = await fetchChecked(itemsUrl(), { fetcher, timeoutMs: 25000, headers: { 'Accept-Encoding': 'br' } });
  if (!res.body) throw new SourceError('bad_json', 'Skinport: пустое тело ответа');
  return scanSkinportItems(res.body, wanted, now);
}

interface Period { median?: unknown; volume?: unknown }
interface SalesRow { market_hash_name?: unknown; currency?: unknown; item_page?: unknown; last_7_days?: Period; last_30_days?: Period }

export function parseSalesHistory(json: unknown, now: number): Quote[] {
  if (!Array.isArray(json)) throw new SourceError('schema', 'Skinport sales: ожидался массив');
  const out: Quote[] = [];
  for (const row of json as SalesRow[]) {
    if (typeof row?.market_hash_name !== 'string') continue;
    if (row.currency !== SKINPORT_CURRENCY) throw new SourceError('schema', 'Skinport sales: неожиданная валюта');
    const mk = (p: Period | undefined, type: 'sale_median_7d' | 'sale_median_30d', period: '7d' | '30d'): Quote => {
      const median = p && p.median !== null ? decimalToMinor(p.median) : null;
      const vol = p && typeof p.volume === 'number' ? p.volume : null;
      return {
        source: 'skinport', marketHashName: row.market_hash_name as string, priceType: type, priceMinor: median,
        currency: 'EUR', quantity: null, volume: vol, volumePeriod: period, listingId: null, floatValue: null, paintSeed: null,
        url: typeof row.item_page === 'string' ? row.item_page : null, fetchedAt: now, sourceUpdatedAt: null, tradable: null,
        quality: median === null ? 'partial' : 'ok',
      };
    };
    out.push(mk(row.last_7_days, 'sale_median_7d', '7d'), mk(row.last_30_days, 'sale_median_30d', '30d'));
  }
  return out;
}

export async function fetchSkinportSales(names: string[], now: number, fetcher?: Fetcher): Promise<Quote[]> {
  return parseSalesHistory(await fetchJson(salesHistoryUrl(names), { fetcher, timeoutMs: 20000, headers: { 'Accept-Encoding': 'br' } }), now);
}
