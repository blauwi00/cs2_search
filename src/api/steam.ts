// SteamMarketAdapter.
// ВАЖНО: priceoverview и search/render — НЕ документированные Valve интерфейсы. Они публичны и используются
// сайтом Steam, но могут измениться или начать отвечать 429. Поэтому адаптер работает в «ограниченном режиме»:
// мало запросов за цикл, строгий backoff, никакого обхода ограничений.

import { fetchJson, steamListingUrl, type Fetcher } from '../utils/http.ts';
import { parseSteamPriceString } from '../utils/money.ts';
import { SourceError, type Quote } from '../types/market.ts';

/** Код валюты Steam для гривны (ECurrencyCode UAH = 18). */
export const STEAM_CURRENCY_UAH = 18;

export function priceOverviewUrl(marketHashName: string): string {
  const q = new URLSearchParams({ appid: '730', currency: String(STEAM_CURRENCY_UAH), market_hash_name: marketHashName });
  return `https://steamcommunity.com/market/priceoverview/?${q}`;
}

interface PriceOverview { success?: unknown; lowest_price?: unknown; median_price?: unknown; volume?: unknown }

export function parsePriceOverview(json: unknown, marketHashName: string, now: number): Quote[] {
  const j = json as PriceOverview;
  if (!j || typeof j !== 'object') throw new SourceError('schema', 'Steam: неожиданный формат ответа');
  if (j.success !== true) throw new SourceError('not_found', 'Steam: предмет не найден или нет данных');
  const lowest = parseSteamPriceString(typeof j.lowest_price === 'string' ? j.lowest_price : null);
  const median = parseSteamPriceString(typeof j.median_price === 'string' ? j.median_price : null);
  const volRaw = typeof j.volume === 'string' ? j.volume.replace(/[^\d]/g, '') : '';
  const volume = volRaw ? Number(volRaw) : null;
  const url = steamListingUrl(marketHashName);
  const base = {
    source: 'steam' as const, marketHashName, currency: 'UAH' as const, listingId: null, floatValue: null,
    paintSeed: null, url, fetchedAt: now, sourceUpdatedAt: null, tradable: null,
  };
  return [
    { ...base, priceType: 'lowest_listing', priceMinor: lowest, quantity: null, volume: null, volumePeriod: null,
      quality: lowest === null ? 'partial' : 'ok' },
    // Поле volume у Steam — число продаж за последние 24 часа.
    { ...base, priceType: 'median_24h', priceMinor: median, quantity: null, volume, volumePeriod: volume === null ? null : '24h',
      quality: median === null ? 'partial' : 'ok' },
  ];
}

export async function fetchSteamPriceOverview(marketHashName: string, now: number, fetcher?: Fetcher): Promise<Quote[]> {
  return parsePriceOverview(await fetchJson(priceOverviewUrl(marketHashName), { fetcher, timeoutMs: 12000 }), marketHashName, now);
}

export interface SearchHit { marketHashName: string; sellListings: number | null }

export function searchUrl(query: string): string {
  const q = new URLSearchParams({
    query, start: '0', count: '10', search_descriptions: '0', sort_column: 'popular', sort_dir: 'desc', appid: '730', norender: '1',
  });
  return `https://steamcommunity.com/market/search/render/?${q}`;
}

export function parseSearch(json: unknown): SearchHit[] {
  const j = json as { success?: unknown; results?: unknown };
  if (!j || j.success !== true || !Array.isArray(j.results)) throw new SourceError('schema', 'Steam: неожиданный ответ поиска');
  const out: SearchHit[] = [];
  for (const r of j.results as Record<string, unknown>[]) {
    const name = typeof r.hash_name === 'string' ? r.hash_name : null;
    if (!name) continue;
    out.push({ marketHashName: name, sellListings: typeof r.sell_listings === 'number' ? r.sell_listings : null });
  }
  return out;
}

/** Поиск по названию через Steam — даёт точные market_hash_name, чтобы не вводить их вручную. */
export async function searchSteam(query: string, fetcher?: Fetcher): Promise<SearchHit[]> {
  return parseSearch(await fetchJson(searchUrl(query), { fetcher, timeoutMs: 12000 }));
}
