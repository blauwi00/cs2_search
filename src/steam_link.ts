// Вход через Steam (OpenID 2.0). Steam сообщает боту только SteamID64 — номер аккаунта.
// Пароль, Steam Guard и cookies бот не видит и не хранит; покупать от имени пользователя он не может.
// Подлинность ответа проверяется у самого Steam (mode=check_authentication), подделать SteamID нельзя.

import type { Env } from './env.ts';
import type { Fetcher } from './utils/http.ts';

const OPENID = 'https://steamcommunity.com/openid/login';
const NS = 'http://specs.openid.net/auth/2.0';

export function steamLoginUrl(origin: string, nonce: string): string {
  const p = new URLSearchParams({
    'openid.ns': NS, 'openid.mode': 'checkid_setup',
    'openid.return_to': `${origin}/steam/callback?s=${encodeURIComponent(nonce)}`,
    'openid.realm': origin,
    'openid.identity': `${NS}/identifier_select`, 'openid.claimed_id': `${NS}/identifier_select`,
  });
  return `${OPENID}?${p}`;
}

export function newNonce(): string {
  const b = new Uint8Array(18);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

/** Ссылка на профиль / SteamID64 → { id } или { vanity } (короткое имя определит сборщик). */
export function parseSteamProfile(input: string): { id?: string; vanity?: string } | null {
  const t = input.trim();
  if (/^7656119\d{10}$/.test(t)) return { id: t };
  const m = t.match(/steamcommunity\.com\/profiles\/(7656119\d{10})/i);
  if (m) return { id: m[1] };
  const v = t.match(/steamcommunity\.com\/id\/([A-Za-z0-9_-]{2,32})/i);
  if (v) return { vanity: v[1] };
  if (/^[A-Za-z0-9_-]{2,32}$/.test(t)) return { vanity: t };
  return null;
}

const page = (title: string, text: string, ok: boolean) => new Response(`<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title><style>body{margin:0;font:17px/1.45 -apple-system,system-ui,sans-serif;background:#171a21;color:#e8eaed;display:grid;place-items:center;min-height:100vh;padding:24px;box-sizing:border-box;text-align:center}
.c{max-width:420px}.i{font-size:56px}h1{font-size:22px;margin:12px 0 8px}p{color:#9aa3ae;margin:0}</style></head>
<body><div class="c"><div class="i">${ok ? '✅' : '⚠️'}</div><h1>${title}</h1><p>${text}</p></div></body></html>`, { status: ok ? 200 : 400, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });

export async function handleSteamCallback(req: Request, env: Env, now: number, fetcher?: Fetcher): Promise<Response> {
  const url = new URL(req.url);
  const nonce = url.searchParams.get('s') ?? '';
  if (!/^[0-9a-f]{36}$/.test(nonce)) return page('Ссылка устарела', 'Начни вход через Steam заново в приложении бота.', false);
  const row = await env.DB.prepare('SELECT telegram_id, created_at FROM steam_login WHERE nonce = ?').bind(nonce).first<{ telegram_id: number; created_at: number }>();
  if (!row || now - row.created_at > 15 * 60) return page('Ссылка устарела', 'Начни вход через Steam заново в приложении бота.', false);
  if (url.searchParams.get('openid.mode') !== 'id_res') return page('Вход отменён', 'Можно вернуться в Telegram и попробовать ещё раз.', false);
  // Steam должен был вернуть нас ровно на наш адрес с нашей меткой.
  const returnTo = url.searchParams.get('openid.return_to') ?? '';
  if (returnTo !== `${url.origin}/steam/callback?s=${nonce}`) return page('Ошибка входа', 'Ответ Steam не совпадает с запросом. Попробуй ещё раз.', false);
  const claimed = url.searchParams.get('openid.claimed_id') ?? '';
  const m = claimed.match(/^https:\/\/steamcommunity\.com\/openid\/id\/(7656119\d{10})$/);
  if (!m) return page('Ошибка входа', 'Steam не прислал номер аккаунта. Попробуй ещё раз.', false);
  // Проверка подписи у самого Steam.
  const check = new URLSearchParams();
  for (const [k, v] of url.searchParams) if (k.startsWith('openid.')) check.set(k, v);
  check.set('openid.mode', 'check_authentication');
  let valid = false;
  try {
    const r = await (fetcher ?? fetch)(OPENID, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: check.toString() });
    valid = r.ok && /is_valid\s*:\s*true/.test(await r.text());
  } catch { valid = false; }
  if (!valid) return page('Steam не подтвердил вход', 'Не получилось проверить вход у Steam (бывает, если Steam перегружен). Попробуй через пару минут или вставь ссылку на профиль в приложении.', false);
  await env.DB.batch([
    env.DB.prepare('UPDATE users SET steam_id = ?, steam_vanity = NULL, steam_verified = 1, inv_requested_at = ?, inv_status = NULL WHERE telegram_id = ?').bind(m[1], now, row.telegram_id),
    env.DB.prepare('DELETE FROM steam_login WHERE nonce = ? OR created_at < ?').bind(nonce, now - 3600),
  ]);
  return page('Steam подключён', 'Вернись в Telegram — инвентарь подтянется в течение ~10 минут. Пароль и доступ к аккаунту бот не получал.', true);
}
