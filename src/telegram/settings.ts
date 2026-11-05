import type { SettingKey, Settings } from '../storage/db.ts';
import { formatUah, parseMoneyInput, UAH_CUR, type Cur } from '../utils/money.ts';

export type SettingKind = 'uah' | 'percent' | 'hour' | 'int' | 'toggle' | 'choice';

export interface SettingMeta { key: SettingKey; label: string; kind: SettingKind; choices?: { v: string; t: string }[]; min?: number; max?: number; hint?: string }

export const SETTINGS_META: SettingMeta[] = [
  { key: 'budget_kop', label: 'Бюджет', kind: 'uah', hint: '0 — бюджет не задан (бот только показывает сделки, не считая их доступными)' },
  { key: 'max_buy_kop', label: 'Макс. цена покупки', kind: 'uah', hint: '0 — без ограничения' },
  { key: 'min_profit_kop', label: 'Мин. разница после комиссий', kind: 'uah' },
  { key: 'min_roi_bp', label: 'Мин. доходность', kind: 'percent', min: 0, max: 1000 },
  { key: 'deposit_fee_bp', label: 'Комиссия при оплате', kind: 'percent', min: 0, max: 30, hint: 'Сколько % берёт банк/способ оплаты при пополнении площадки (карта, крипта). Добавляется к цене покупки на сайтах.' },
  { key: 'withdraw_fee_bp', label: 'Комиссия при выводе', kind: 'percent', min: 0, max: 30, hint: 'Сколько % теряешь при выводе денег с площадки. Вычитается из выручки на сайтах (не Steam).' },
  { key: 'min_liquidity', label: 'Мин. ликвидность для высокого приоритета', kind: 'choice',
    choices: [{ v: 'high', t: 'высокая' }, { v: 'medium', t: 'средняя' }, { v: 'low', t: 'низкая' }] },
  { key: 'min_priority', label: 'Уведомлять с приоритета', kind: 'choice',
    choices: [{ v: 'high', t: 'только высокий' }, { v: 'medium', t: 'средний и выше' }, { v: 'low', t: 'все' }] },
  { key: 'change_threshold_bp', label: 'Порог изменения цены', kind: 'percent', min: 1, max: 500 },
  { key: 'max_per_hour', label: 'Макс. уведомлений в час', kind: 'int', min: 1, max: 60 },
  { key: 'quiet_start', label: 'Тихие часы: начало', kind: 'hour' },
  { key: 'quiet_end', label: 'Тихие часы: конец', kind: 'hour' },
  { key: 'max_stale_min', label: 'Данные устаревают через (мин)', kind: 'int', min: 5, max: 1440 },
  { key: 'notify_enabled', label: 'Уведомления', kind: 'toggle' },
  { key: 'sig_arbitrage', label: 'Сигналы арбитража', kind: 'toggle' },
  { key: 'sig_change', label: 'Сигналы изменения цены', kind: 'toggle' },
  { key: 'sig_target', label: 'Целевые цены', kind: 'toggle' },
  { key: 'sig_inventory', label: 'Уведомления по инвентарю', kind: 'toggle' },
  { key: 'notify_recs', label: 'Горячие рекомендации по всему рынку', kind: 'toggle', hint: 'Новая выгодная сделка «купи → продай» по твоим порогам прибыли, даже если предмета нет в твоём списке' },
  { key: 'recs_per_day', label: 'Горячих рекомендаций в сутки, не больше', kind: 'int', min: 1, max: 10 },
  { key: 'weekly_report', label: 'Воскресная сводка по инвентарю Steam', kind: 'toggle', hint: 'Как изменилась стоимость инвентаря за неделю' },
  { key: 'daily_report', label: 'Ежедневная сводка', kind: 'toggle' },
  { key: 'daily_hour', label: 'Час сводки (Варшава)', kind: 'hour' },
  { key: 'src_steam', label: 'Источник Steam', kind: 'toggle' },
  { key: 'src_skinport', label: 'Источник Skinport', kind: 'toggle' },
  { key: 'src_csfloat', label: 'Источник CSFloat', kind: 'toggle' },
];

/** Общие настройки системы — менять может только владелец бота. */
export const ADMIN_ONLY: readonly string[] = ['src_steam', 'src_skinport', 'src_csfloat', 'max_stale_min'];
export const settingsFor = (isAdmin: boolean): SettingMeta[] => SETTINGS_META.filter((m) => isAdmin || !ADMIN_ONLY.includes(m.key));

export function metaFor(key: string): SettingMeta | undefined {
  return SETTINGS_META.find((m) => m.key === key);
}

export function displayValue(m: SettingMeta, s: Settings): string {
  const v = s[m.key];
  switch (m.kind) {
    case 'uah': return formatUah(Number(v));
    case 'percent': return `${(Number(v) / 100).toString().replace('.', ',')}%`;
    case 'hour': return `${v}:00`;
    case 'toggle': return v === '1' ? 'вкл' : 'выкл';
    case 'choice': return m.choices?.find((c) => c.v === v)?.t ?? v;
    default: return v;
  }
}

/** Проверяет ввод пользователя. Возвращает значение для хранения или текст ошибки. */
export function parseSettingInput(m: SettingMeta, text: string, cur: Cur = UAH_CUR): { ok: true; value: string } | { ok: false; error: string } {
  const t = text.trim();
  if (m.kind === 'uah') {
    const kop = parseMoneyInput(t, cur);
    return kop === null ? { ok: false, error: `Введи сумму в ${cur.code}, например 250 или 250,50` } : { ok: true, value: String(kop) };
  }
  if (m.kind === 'percent') {
    const n = Number(t.replace('%', '').replace(',', '.'));
    if (!Number.isFinite(n) || n < (m.min ?? 0) || n > (m.max ?? 1000)) return { ok: false, error: `Введи процент от ${m.min ?? 0} до ${m.max ?? 1000}` };
    return { ok: true, value: String(Math.round(n * 100)) };
  }
  if (m.kind === 'hour') {
    const n = Number(t);
    if (!Number.isInteger(n) || n < 0 || n > 23) return { ok: false, error: 'Введи час от 0 до 23' };
    return { ok: true, value: String(n) };
  }
  if (m.kind === 'int') {
    const n = Number(t);
    if (!Number.isInteger(n) || n < (m.min ?? 0) || n > (m.max ?? 1e6)) return { ok: false, error: `Введи целое число от ${m.min ?? 0} до ${m.max ?? 1e6}` };
    return { ok: true, value: String(n) };
  }
  return { ok: false, error: 'Этот параметр меняется кнопкой' };
}

export function nextChoice(m: SettingMeta, current: string): string {
  if (m.kind === 'toggle') return current === '1' ? '0' : '1';
  const list = m.choices ?? [];
  const i = list.findIndex((c) => c.v === current);
  return list[(i + 1) % list.length]?.v ?? current;
}
