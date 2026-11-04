// Денежные значения — целые числа в минимальных единицах (копейки, центы).
// Никаких float в расчётах прибыли.

// Внутри все суммы — копейки UAH (так считаются комиссии и прибыль). Пользователь видит их в своей валюте:
// тексты содержат метку суммы ⟦копейки⟧, а перевод в валюту человека делается в момент отправки
// (TelegramClient, ответы приложения). Так одно уведомление из очереди уходит каждому в его валюте.

export interface Cur { code: string; sign: string; per: number /* сколько UAH стоит 1 единица валюты */ }
export const UAH_CUR: Cur = { code: 'UAH', sign: '₴', per: 1 };

/** Метка суммы: 155250 → "⟦155250⟧" (с плюсом — "⟦+155250⟧"). */
export function formatUah(kop: number | null): string {
  if (kop === null || !Number.isFinite(kop)) return '—';
  return `⟦${Math.round(kop)}⟧`;
}

export function formatSignedUah(kop: number): string {
  return kop > 0 ? `⟦+${Math.round(kop)}⟧` : formatUah(kop);
}

const NO_CENTS = new Set(['JPY', 'KRW', 'HUF', 'KZT', 'ARS', 'CLP', 'VND', 'IDR']);

/** Копейки UAH → число в валюте (не округлённое). */
export function toUnits(kop: number, cur: Cur): number {
  return kop / 100 / cur.per;
}

/** Копейки UAH → текст в валюте: "1 552 ₴", "38,25 $", "−0,05 €". */
export function fmtMoney(kop: number | null, cur: Cur, signed = false): string {
  if (kop === null || !Number.isFinite(kop)) return '—';
  const v = toUnits(kop, cur);
  const abs = Math.abs(v);
  const dec = abs >= 1000 || NO_CENTS.has(cur.code) ? 0 : 2;
  let str = abs.toFixed(dec);
  if (dec === 0 && abs > 0 && Number(str) === 0) str = abs.toFixed(2); // 0,4 ₸ не превращаем в 0
  const [w, f] = str.split('.');
  const body = w.replace(/\B(?=(\d{3})+(?!\d))/g, ' ') + (f ? ',' + f : '');
  const sign = v < 0 && Number(str) !== 0 ? '−' : signed && v > 0 ? '+' : '';
  return `${sign}${body} ${cur.sign}`;
}

const MARK = /⟦(\+?)(-?\d{1,15})⟧/g;
/** Подставляет суммы в валюте человека вместо меток. */
export function renderMoney(text: string, cur: Cur): string {
  if (!text.includes('⟦')) return text;
  return text.replace(MARK, (_, plus: string, n: string) => fmtMoney(Number(n), cur, plus === '+'));
}

/** Ввод суммы в валюте человека → копейки UAH. */
export function parseMoneyInput(text: string, cur: Cur): number | null {
  const minor = parseUahInput(text.replace(/[^\d\s ,.]/g, ''));
  return minor === null ? null : Math.round(minor * cur.per);
}

/** Базисные пункты → "38,1%". */
export function formatBp(bp: number | null): string {
  if (bp === null) return '—';
  const sign = bp > 0 ? '+' : bp < 0 ? '−' : '';
  const v = Math.abs(bp) / 100;
  return `${sign}${v.toFixed(1).replace('.', ',')}%`;
}

/**
 * Разбор суммы, введённой пользователем: "1500", "1 500,50", "1500.5", "1500 грн".
 * Возвращает копейки или null при некорректном вводе.
 */
export function parseUahInput(text: string): number | null {
  const cleaned = text.replace(/грн|uah|₴/gi, '').replace(/[\s ]/g, '').replace(',', '.');
  if (!/^\d{1,9}(\.\d{1,2})?$/.test(cleaned)) return null;
  const [w, f = ''] = cleaned.split('.');
  return Number(w) * 100 + Number(f.padEnd(2, '0'));
}

/**
 * Разбор строки цены из Steam ("1 234,56₴", "$12.34", "12,34€", "1.234,56 zł").
 * Возвращает минимальные единицы. Последний разделитель с 1–2 цифрами после него считается десятичным.
 */
export function parseSteamPriceString(s: string | undefined | null): number | null {
  if (!s) return null;
  const only = s.replace(/[^\d.,]/g, '');
  if (!only || !/\d/.test(only)) return null;
  const m = only.match(/^(.*?)([.,])(\d{1,2})$/);
  let whole: string;
  let frac = '';
  if (m) {
    whole = m[1].replace(/[.,]/g, '');
    frac = m[3];
  } else {
    whole = only.replace(/[.,]/g, '');
  }
  if (whole === '') whole = '0';
  if (!/^\d+$/.test(whole)) return null;
  const v = Number(whole) * 100 + Number(frac.padEnd(2, '0'));
  return Number.isSafeInteger(v) ? v : null;
}

/** Десятичное число из JSON площадки (например 13.18 EUR) → центы, с защитой от ошибок float. */
export function decimalToMinor(v: unknown): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return null;
  return Math.round(v * 100);
}

/** Округление a*b/c до целого, half-up, для неотрицательных целых. */
export function mulDivRound(a: number, b: number, c: number): number {
  return Math.floor((a * b + Math.floor(c / 2)) / c);
}
