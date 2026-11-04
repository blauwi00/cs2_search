import { SourceError } from '../types/market.ts';

export type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

export interface HttpOptions {
  timeoutMs?: number;
  headers?: Record<string, string>;
  fetcher?: Fetcher;
}

export const USER_AGENT = 'cs2-market-bot/1.0 (personal price monitor; Cloudflare Worker)';

/** Разбор Retry-After: секунды или HTTP-дата. */
export function parseRetryAfter(v: string | null, nowMs: number = Date.now()): number | null {
  if (!v) return null;
  if (/^\d+$/.test(v.trim())) return Number(v.trim());
  const t = Date.parse(v);
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.ceil((t - nowMs) / 1000));
}

/** Выполняет запрос и превращает любые сбои в SourceError определённого вида. Повторов не делает: ими управляет планировщик. */
export async function fetchChecked(url: string, opts: HttpOptions = {}): Promise<Response> {
  const fetcher = opts.fetcher ?? ((i, init) => fetch(i, init));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 15000);
  let res: Response;
  try {
    res = await fetcher(url, {
      headers: { 'User-Agent': USER_AGENT, ...opts.headers },
      signal: controller.signal,
    });
  } catch (e) {
    const name = (e as Error)?.name;
    if (name === 'AbortError') throw new SourceError('timeout', `Таймаут запроса`);
    throw new SourceError('network', `Сетевая ошибка: ${(e as Error)?.message ?? e}`);
  } finally {
    clearTimeout(timer);
  }
  if (res.ok) return res;
  const ra = parseRetryAfter(res.headers.get('retry-after'));
  if (res.status === 429) throw new SourceError('rate_limited', 'HTTP 429: лимит запросов', 429, ra);
  if (res.status === 401) throw new SourceError('auth', 'HTTP 401: ключ отклонён', 401);
  if (res.status === 403) {
    // Начало ответа помогает отличить блокировку защитой сайта (Cloudflare, «error code: 10xx») от ответа API.
    let snippet = '';
    try { snippet = (await res.text()).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160); } catch { /* ignore */ }
    const server = res.headers.get('server') ?? '';
    throw new SourceError('forbidden', `HTTP 403: доступ запрещён${server ? ` (server: ${server})` : ''}${snippet ? ` — ${snippet}` : ''}`, 403);
  }
  if (res.status === 404) throw new SourceError('not_found', 'HTTP 404', 404);
  if (res.status >= 500) throw new SourceError('server', `HTTP ${res.status}: ошибка сервера`, res.status, ra);
  throw new SourceError('server', `HTTP ${res.status}`, res.status);
}

export async function fetchJson<T = unknown>(url: string, opts: HttpOptions = {}): Promise<T> {
  const res = await fetchChecked(url, opts);
  const text = await res.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new SourceError('bad_json', 'Некорректный JSON в ответе');
  }
}

/** Разрешённые домены для ссылок в кнопках Telegram. */
const ALLOWED_LINK_HOSTS = new Set(['steamcommunity.com', 'skinport.com', 'csfloat.com']);

export function safeLink(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:') return null;
    if (!ALLOWED_LINK_HOSTS.has(u.hostname)) return null;
    return u.toString();
  } catch {
    return null;
  }
}

export function steamListingUrl(marketHashName: string): string {
  return `https://steamcommunity.com/market/listings/730/${encodeURIComponent(marketHashName)}`;
}
