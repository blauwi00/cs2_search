// Защита авторства (см. LICENSE): отпечаток кода и сообщение автору, где запущена копия.
// Копия на чужом сервере раз в сутки сообщает официальному боту свой домен (только домен, без данных пользователей).
// Официальный бот записывает такие домены и присылает владельцу уведомление.
import { getMeta, setMetaStmt } from './channel.ts';

export const FINGERPRINT = 'cenolov-fp-7q3k9x2m';
export const OFFICIAL_HOST = 'cs2-search.blauwi925.workers.dev';
const HOST_RE = /^[a-z0-9.-]{3,120}$/;

/** Запомнить свой домен (по первому запросу к Worker). */
export async function rememberSelfHost(d: D1Database, host: string): Promise<void> {
  if (!HOST_RE.test(host) || host === OFFICIAL_HOST) return;
  if ((await getMeta(d, 'self_host')) === host) return;
  await setMetaStmt(d, 'self_host', host).run();
}

/** Копия (не официальный бот) сообщает о себе. */
export async function reportCopy(d: D1Database, fetcher: (u: string) => Promise<unknown>): Promise<void> {
  const host = await getMeta(d, 'self_host');
  if (!host || host === OFFICIAL_HOST) return;
  try { await fetcher(`https://${OFFICIAL_HOST}/beacon?h=${encodeURIComponent(host)}&fp=${FINGERPRINT}`); } catch { /* нет связи — не страшно */ }
}

/** Официальный бот: записать домен копии. Возвращает true, если домен новый. */
export async function recordCopy(d: D1Database, host: string, now: number): Promise<boolean> {
  if (!HOST_RE.test(host) || host === OFFICIAL_HOST || host.endsWith('.localhost')) return false;
  let copies: Record<string, number> = {};
  try { copies = JSON.parse((await getMeta(d, 'copies')) ?? '{}'); } catch { copies = {}; }
  const isNew = !(host in copies);
  if (!isNew && now - copies[host] < 3600) return false;
  copies[host] = now;
  const keep = Object.fromEntries(Object.entries(copies).sort((a, b) => b[1] - a[1]).slice(0, 50));
  await setMetaStmt(d, 'copies', JSON.stringify(keep)).run();
  return isNew;
}

export async function listCopies(d: D1Database): Promise<[string, number][]> {
  try { return Object.entries(JSON.parse((await getMeta(d, 'copies')) ?? '{}') as Record<string, number>).sort((a, b) => b[1] - a[1]); } catch { return []; }
}
