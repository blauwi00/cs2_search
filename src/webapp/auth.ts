// Проверка Telegram Mini App initData (официальный алгоритм Telegram):
// secret = HMAC_SHA256(key="WebAppData", data=bot_token); hash = hex(HMAC_SHA256(key=secret, data=data_check_string)).
// data_check_string — все поля, кроме hash, отсортированные по ключу, в виде key=value через перевод строки.

const enc = new TextEncoder();
const bytes = (s: string): Uint8Array<ArrayBuffer> => new Uint8Array(enc.encode(s));

async function hmac(key: ArrayBuffer | Uint8Array<ArrayBuffer>, data: string): Promise<ArrayBuffer> {
  const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return crypto.subtle.sign('HMAC', k, enc.encode(data));
}

const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');

export interface WebAppUser { id: number; first_name?: string; username?: string; language_code?: string }

export async function verifyInitData(initData: string, botToken: string, nowSec: number, maxAgeSec = 24 * 3600): Promise<WebAppUser | null> {
  if (!initData || initData.length > 4096) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash || !/^[0-9a-f]{64}$/.test(hash)) return null;
  const pairs = [...params].filter(([k]) => k !== 'hash').sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => `${k}=${v}`);
  const secret = await hmac(bytes('WebAppData'), botToken);
  const calc = hex(await hmac(secret, pairs.join('\n')));
  let diff = 0;
  for (let i = 0; i < 64; i++) diff |= calc.charCodeAt(i) ^ hash.charCodeAt(i);
  if (diff !== 0) return null;
  const authDate = Number(params.get('auth_date'));
  if (!Number.isFinite(authDate) || nowSec - authDate > maxAgeSec || authDate > nowSec + 300) return null;
  try {
    const u = JSON.parse(params.get('user') ?? 'null') as WebAppUser | null;
    return u && Number.isSafeInteger(u.id) ? u : null;
  } catch {
    return null;
  }
}

/** Для тестов: подписать initData так же, как Telegram. */
export async function signInitData(fields: Record<string, string>, botToken: string): Promise<string> {
  const pairs = Object.entries(fields).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => `${k}=${v}`);
  const secret = await hmac(bytes('WebAppData'), botToken);
  const hash = hex(await hmac(secret, pairs.join('\n')));
  const p = new URLSearchParams(fields);
  p.set('hash', hash);
  return p.toString();
}
