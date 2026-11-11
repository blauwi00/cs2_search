// Единый вид постов канала: крючок первой строкой (жирным, с главной цифрой), 3–5 коротких строк, вывод и сноска в одну строку, без эмодзи.

import { formatUah, formatSignedUah } from '../utils/money.ts';
import { warsawDate } from '../utils/time.ts';

const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
/** 1762248600 → «4 ноября». */
export function ruDate(t: number): string {
  const [, m, d] = warsawDate(t).split('-').map(Number);
  return `${d} ${MONTHS[m - 1]}`;
}

export const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
export const money = (k: number | null) => formatUah(k);
export const plus = (k: number) => (k > 0 ? formatSignedUah(k) : formatUah(k));
export const pct = (bp: number) => `${bp >= 0 ? '+' : '−'}${Math.abs(Math.round(bp / 100))}%`;

/** Крючок: первая строка поста — жирным, с главным фактом или цифрой. */
export const hook = (text: string): string => `<b>${text}</b>`;

/** Старый заголовок «значок название · дата» — остался для редких служебных постов. */
export function header(icon: string, title: string, now: number): string {
  return `${icon} <b>${title}</b> · ${ruDate(now)}`;
}

/** Блок одной сделки «купи → продай». */
export function dealBlock(i: number, d: { name: string; buyName: string; sellName: string; payKop: number; sellKop: number | null; getKop: number; profitKop: number; roiBp: number; cash: boolean }): string[] {
  return [
    `<b>${i}. ${esc(d.name)}</b>`,
    `Купить: ${esc(d.buyName)} — <b>${money(d.payKop)}</b>`,
    `Продать: ${esc(d.sellName)} — ${money(d.sellKop)}`,
    `Чистыми: <b>${plus(d.profitKop)}</b> (${pct(d.roiBp)}) · ${d.cash ? 'деньгами' : 'на баланс Steam'}`,
  ];
}

/** Строка изменения цены: «Kilowatt Case — +20% · 1,20 $». */
export function moveLine(name: string, bp: number, kop: number | null): string {
  return `${bp >= 0 ? '▲' : '▼'} ${esc(name)} — <b>${pct(bp)}</b>${kop ? ` · ${money(kop)}` : ''}`;
}

export const FOOT_DEALS = '<i>Цены на момент публикации, комиссии учтены. Не финансовый совет.</i>';
