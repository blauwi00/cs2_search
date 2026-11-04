import { esc, type Keyboard } from './api.ts';
import { formatUah, formatSignedUah, formatBp } from '../utils/money.ts';
import { ago } from '../utils/time.ts';
import { safeLink, steamListingUrl } from '../utils/http.ts';
import type { ArbitrageResult } from '../core/arbitrage.ts';
import type { ScoreResult } from '../core/scoring.ts';
import { PRIORITY_RU, CATEGORY_SIGNAL_RU } from '../core/scoring.ts';
import { LIQUIDITY_RU, type LiquidityResult } from '../core/liquidity.ts';
import type { ChangeEvent } from '../core/analyzer.ts';

export const SOURCE_RU: Record<string, string> = { steam: 'Steam Market', skinport: 'Skinport', csfloat: 'CSFloat', nbu: 'НБУ (курсы)', collector: 'Сборщик цен (GitHub Actions)' };

export interface ArbitrageView {
  signalId: number;
  name: string;
  buySource: string;
  buyUrl: string | null;
  buyOriginal: string | null;     // "12,34 EUR" — для прозрачности пересчёта
  fxNote: string | null;          // "курс НБУ 45,1234 от 2026-11-04"
  arb: ArbitrageResult;
  score: ScoreResult;
  liquidity: LiquidityResult;
  dataAt: number;
  now: number;
  demo?: boolean;
  state?: string;
}

export function arbitrageMessage(v: ArbitrageView): { text: string; keyboard: Keyboard } {
  const emoji = v.score.priority === 'high' ? '🟢' : v.score.priority === 'medium' ? '🟡' : '⚪';
  const lines: string[] = [];
  if (v.demo) lines.push('🧪 <b>DEMO — тестовые данные, не реальный рынок</b>', '');
  if (v.state === 'expired') lines.push('⚫ <b>НЕАКТУАЛЬНО</b> — условия сделки больше не выполняются', '');
  lines.push(`${emoji} <b>НАЙДЕНА ВОЗМОЖНОСТЬ</b> (${CATEGORY_SIGNAL_RU[v.score.category]})`, '');
  lines.push(`<b>${esc(v.name)}</b>`, '');
  lines.push(`Покупка: ${SOURCE_RU[v.buySource] ?? esc(v.buySource)}`);
  lines.push(`Цена: ${formatUah(v.arb.purchaseCostKop)}${v.buyOriginal ? ` (${esc(v.buyOriginal)})` : ''}`);
  if (v.fxNote) lines.push(`<i>${esc(v.fxNote)}</i>`);
  lines.push('');
  lines.push('Ориентир продажи: Steam');
  lines.push(`Цена покупателя: ${formatUah(v.arb.sellReferenceKop)}`);
  lines.push(`<i>${esc(v.arb.sellReferenceBasis)}</i>`);
  lines.push(`Ожидаемое поступление на баланс Steam: ${formatUah(v.arb.expectedProceedsKop)}`);
  lines.push('');
  lines.push(`Разница: <b>${formatSignedUah(v.arb.netSpreadKop)}</b> (баланс Steam, не наличные)`);
  lines.push(`Доходность относительно затрат: ${formatBp(v.arb.returnOnCostBp)}`);
  if (v.arb.breakEvenBuyerKop !== null) lines.push(`Без убытка, если продать не дешевле: ${formatUah(v.arb.breakEvenBuyerKop)}`);
  lines.push('');
  lines.push('Если цена на Steam упадёт до продажи:');
  for (const d of v.arb.downside) lines.push(`• на ${formatBp(d.dropBp).replace('+', '')}: ${formatSignedUah(d.spreadKop)}`);
  lines.push('');
  lines.push(`Ликвидность: ${LIQUIDITY_RU[v.liquidity.cls]}${v.liquidity.salesPerDay !== null ? ` (~${Math.round(v.liquidity.salesPerDay)} продаж/день, ${v.liquidity.basis})` : ''}`);
  lines.push(`Уровень приоритета: ${v.score.priority ? PRIORITY_RU[v.score.priority] : '—'}`);
  if (v.score.priority !== 'high' && v.score.reasons.length) lines.push(`Почему не выше: ${esc(v.score.reasons.join('; '))}`);
  lines.push(`Данные обновлены: ${ago(v.dataAt, v.now)}.`);
  lines.push('');
  lines.push('Риски:');
  for (const r of v.score.risks) lines.push(`• ${esc(r)}`);
  lines.push('', '<i>Это оценка, а не гарантированный заработок. Бот ничего не покупает сам.</i>');

  const kb: Keyboard = [];
  const buy = safeLink(v.buyUrl);
  const row1 = [];
  if (buy) row1.push({ text: 'Открыть покупку', url: buy });
  row1.push({ text: 'Открыть Steam Market', url: steamListingUrl(v.name) });
  kb.push(row1);
  if (!v.demo) {
    kb.push([{ text: '✅ Купил', callback_data: `bs:${v.signalId}` }, { text: 'История цены', callback_data: `ch:${v.signalId}` }]);
    kb.push([{ text: 'Скрыть', callback_data: `dh:${v.signalId}` }, { text: 'В меню', callback_data: 'm' }]);
  }
  return { text: lines.join('\n'), keyboard: kb };
}

const PERIOD_RU: Record<string, string> = { '1h': '1 час', '24h': '24 часа', '7d': '7 дней' };

export function changeMessage(name: string, e: ChangeEvent, fromKop: number | null, toKop: number | null, basis: string, volume: number | null, url: string, demo = false): { text: string; keyboard: Keyboard } {
  const drop = e.kind === 'price_drop';
  const lines: string[] = [];
  if (demo) lines.push('🧪 <b>DEMO — тестовые данные</b>', '');
  lines.push(drop ? '🔻 <b>ПАДЕНИЕ ЦЕНЫ</b>' : '🔺 <b>РОСТ ЦЕНЫ</b>', '', `<b>${esc(name)}</b>`, '');
  lines.push(`Было: ${formatUah(fromKop)}`, `Стало: ${formatUah(toKop)}`, `Изменение: ${formatBp(e.changeBp)}`, `Период: ${PERIOD_RU[e.period]}`);
  lines.push(`Сравнение: ${esc(basis)} (Steam Market, в исходной валюте площадки)`);
  if (volume !== null) lines.push(`Продаж за 24 ч: ${volume}`);
  if (e.thinSupplyWarning) lines.push('', '⚠️ Мало продаж: рост минимальной цены может означать лишь, что дешёвые лоты выкупили.');
  return { text: lines.join('\n'), keyboard: [[{ text: 'Открыть Steam Market', url }]] };
}

export function targetMessage(name: string, priceKop: number, targetKop: number, url: string): { text: string; keyboard: Keyboard } {
  return {
    text: `🎯 <b>ЦЕЛЕВАЯ ЦЕНА ДОСТИГНУТА</b>\n\n<b>${esc(name)}</b>\n\nСамое дешёвое объявление Steam: ${formatUah(priceKop)}\nТвоя цель: ${formatUah(targetKop)}`,
    keyboard: [[{ text: 'Открыть Steam Market', url }]],
  };
}
