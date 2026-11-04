// Денежные значения — целые числа в минимальных единицах (копейки, центы).
// Никаких float в расчётах прибыли.

/** Формат копеек: 155250 → "1 552,50 грн". */
export function formatUah(kop: number | null): string {
  if (kop === null || !Number.isFinite(kop)) return '— грн';
  const sign = kop < 0 ? '−' : '';
  const abs = Math.abs(Math.round(kop));
  const whole = Math.floor(abs / 100);
  const frac = String(abs % 100).padStart(2, '0');
  const wholeStr = String(whole).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return `${sign}${wholeStr},${frac} грн`;
}

export function formatSignedUah(kop: number): string {
  return (kop > 0 ? '+' : '') + formatUah(kop);
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
