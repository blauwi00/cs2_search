// CSFloatAdapter. Требует API-ключ (профиль CSFloat → вкладка Developer). Цены — в центах USD.
// Без ключа адаптер выключен и честно показывает статус «требуется API-ключ».
// Формат ответа /api/v1/listings менялся (массив или { data: [...] }) — поддерживаются оба.

import { fetchJson, type Fetcher } from '../utils/http.ts';
import { SourceError, type Quote } from '../types/market.ts';

export function listingsUrl(marketHashName: string): string {
  const q = new URLSearchParams({ market_hash_name: marketHashName, sort_by: 'lowest_price', type: 'buy_now', limit: '5' });
  return `https://csfloat.com/api/v1/listings?${q}`;
}

interface Listing { id?: unknown; price?: unknown; state?: unknown; item?: { market_hash_name?: unknown; float_value?: unknown; paint_seed?: unknown } }

export function parseListings(json: unknown, marketHashName: string, now: number): Quote[] {
  const arr = Array.isArray(json) ? json : (json && Array.isArray((json as { data?: unknown }).data) ? (json as { data: unknown[] }).data : null);
  if (!arr) throw new SourceError('schema', 'CSFloat: неожиданный формат ответа');
  const out: Quote[] = [];
  for (const l of arr as Listing[]) {
    if (l?.item?.market_hash_name !== marketHashName) continue; // защита от неточного фильтра
    if (l.state !== undefined && l.state !== 'listed') continue;
    if (typeof l.price !== 'number' || !Number.isSafeInteger(l.price) || l.price <= 0) continue;
    const id = typeof l.id === 'string' || typeof l.id === 'number' ? String(l.id) : null;
    out.push({
      source: 'csfloat', marketHashName, priceType: 'listing', priceMinor: l.price, currency: 'USD',
      quantity: arr.length, volume: null, volumePeriod: null, listingId: id,
      floatValue: typeof l.item.float_value === 'number' ? l.item.float_value : null,
      paintSeed: typeof l.item.paint_seed === 'number' ? l.item.paint_seed : null,
      url: id ? `https://csfloat.com/item/${encodeURIComponent(id)}` : null,
      fetchedAt: now, sourceUpdatedAt: null, tradable: null, quality: 'ok',
    });
  }
  out.sort((a, b) => (a.priceMinor as number) - (b.priceMinor as number));
  return out;
}

export async function fetchCsfloatListings(marketHashName: string, apiKey: string, now: number, fetcher?: Fetcher): Promise<Quote[]> {
  const json = await fetchJson(listingsUrl(marketHashName), { fetcher, timeoutMs: 12000, headers: { Authorization: apiKey } });
  return parseListings(json, marketHashName, now);
}
