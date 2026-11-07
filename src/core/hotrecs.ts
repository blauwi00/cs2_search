// Горячие рекомендации по всему рынку (не только по своему списку): после каждой свежей проверки рынка
// новая выгодная сделка «купи → продай» приходит тем, у кого это включено, по ЕГО порогам прибыли и комиссиям,
// не больше recs_per_day в сутки, с учётом тихих часов. Одна и та же сделка повторно — не раньше чем через сутки
// (или если прибыль выросла на 25%+).
import { buildRecs, HELD_SEC, MARKETS, itemUrl, loadSkinportPages, type Rec, type ItemPages } from './recs.ts';
import { loadScan } from '../storage/scan.ts';
import * as db from '../storage/db.ts';
import { getMeta, setMetaStmt } from './channel.ts';
import { loadUserSettings, nextAllowed } from './audience.ts';
import { formatUah, formatSignedUah } from '../utils/money.ts';
import { esc } from '../telegram/api.ts';
import { TERMS_VERSION } from './terms.ts';
import { IDEA_SETTINGS } from './insights.ts';
import type { Keyboard } from '../telegram/api.ts';
import { steamBalances } from './steambalance.ts';

export const HOT_FRESH_SEC = 40 * 60;
export const HOT_REPEAT_SEC = 24 * 3600;
export const HOT_UP_BP = 2500;

export const hotKey = (r: Rec) => `${r.name}|${r.buyAt}|${r.sellAt}`;

/** balanceKop — баланс Steam человека (если вписан и сделка — покупка в Steam): «хватает на покупку». */
export function hotText(r: Rec, balanceKop: number | null = null): string {
  return [
    '🔥 <b>Горячая рекомендация</b>', '',
    `<b>${esc(r.name)}</b>`,
    `🛒 Купить: ${MARKETS[r.buyAt].name} — <b>${formatUah(r.payKop)}</b>`,
    `💰 Продать: ${MARKETS[r.sellAt].name} — ${formatUah(r.sellKop)}`,
    `✅ Чистыми: <b>${formatSignedUah(r.profitKop ?? 0)}</b> (+${Math.round((r.roiBp ?? 0) / 100)}%) · ${r.wallet === 'cash' ? 'деньгами' : 'на баланс Steam'}`,
    r.sales7 ? `📊 ${r.sales7} продаж за неделю` : '',
    balanceKop !== null && r.buyAt === 'steam' ? `💳 Хватает твоего баланса Steam (≈${formatUah(balanceKop)})` : '',
    '', '<i>Цена на момент проверки, комиссии учтены по твоим настройкам. Не финансовый совет — проверь цену на сайте.</i>',
  ].filter((x) => x !== '').join('\n').replace('\n\n<i>', '\n\n<i>');
}

/** Какую сделку предложить. Есть баланс Steam — сначала покупка в Steam, которая в него укладывается; дороже баланса в Steam — никогда. */
export function pickRec(list: Rec[], balanceKop: number | null, isNew: (r: Rec) => boolean): Rec | undefined {
  if (balanceKop !== null) {
    const fit = list.find((x) => x.buyAt === 'steam' && x.payKop <= balanceKop && isNew(x));
    if (fit) return fit;
  }
  return list.find((x) => isNew(x) && (x.buyAt !== 'steam' || balanceKop === null || x.payKop <= balanceKop));
}

export function hotKeyboard(r: Rec, origin: string | null, pages?: ItemPages | null): Keyboard {
  return [
    [{ text: `🛒 Купить на ${MARKETS[r.buyAt].name}`, url: itemUrl(r.buyAt, r.name, pages) }],
    ...(origin ? [[{ text: '📱 Все рекомендации', web_app: { url: `${origin}/app#deals` } }]] : []),
    [{ text: '🔕 Не присылать такие', callback_data: 'nr:off' }],
  ];
}

interface Ctx { db: D1Database; now: number }

export async function jobHotRecs(ctx: Ctx): Promise<{ queued: number }> {
  const d = ctx.db;
  const scan = await loadScan(d);
  if (!scan || ctx.now - scan.fetchedAt > HOT_FRESH_SEC) return { queued: 0 };
  if (Number(await getMeta(d, 'hot_scan_at')) >= scan.fetchedAt) return { queued: 0 }; // эту проверку рынка уже разослали
  const fx = await db.loadLatestFx(d);
  let sent: Record<string, { p: number; at: number }> = {};
  try { sent = JSON.parse((await getMeta(d, 'hot_sent')) ?? '{}'); } catch { sent = {}; }
  const writes: D1PreparedStatement[] = [setMetaStmt(d, 'hot_scan_at', String(scan.fetchedAt))];

  // Кто получает: уведомления включены, горячие рекомендации включены, условия приняты.
  const ids = (await d.prepare('SELECT telegram_id FROM users ORDER BY telegram_id LIMIT 2000').all<{ telegram_id: number }>()).results.map((r) => r.telegram_id);
  const settings = new Map<number, db.Settings>();
  for (let i = 0; i < ids.length; i += 90) for (const [k, v] of await loadUserSettings(d, ids.slice(i, i + 90))) settings.set(k, v);
  const eligible = ids.filter((id) => { const s = settings.get(id)!; return s.notify_enabled === '1' && s.notify_recs === '1' && s.terms_ok === TERMS_VERSION; });
  if (!eligible.length) { await d.batch(writes); return { queued: 0 }; }

  // Сколько горячих уже получили за сутки.
  const today = new Map((await d.prepare(`SELECT telegram_id, COUNT(*) AS n FROM outbox WHERE kind = 'recs' AND created_at >= ? GROUP BY telegram_id`)
    .bind(ctx.now - 86400).all<{ telegram_id: number; n: number }>()).results.map((r) => [r.telegram_id, r.n]));

  // Сделки считаем один раз на каждый набор порогов и комиссий (у большинства — одинаковые).
  const combos = new Map<string, Rec[]>();
  const comboOf = (s: db.Settings) => {
    const rs = {
      minProfitKop: Math.max(db.num(s.min_profit_kop), IDEA_SETTINGS.minProfitKop), minRoiBp: Math.max(db.num(s.min_roi_bp), IDEA_SETTINGS.minRoiBp),
      depositFeeBp: db.num(s.deposit_fee_bp), withdrawFeeBp: db.num(s.withdraw_fee_bp), minHeldSec: HELD_SEC,
    };
    const key = `${rs.minProfitKop}|${rs.minRoiBp}|${rs.depositFeeBp}|${rs.withdrawFeeBp}`;
    if (!combos.has(key)) combos.set(key, combos.size < 12 ? buildRecs(scan.entries, fx, rs).deals : []);
    return combos.get(key)!;
  };
  const before = { ...sent }; // «новизна» — относительно прошлых рассылок, а не этой
  const isNew = (r: Rec) => { const p = before[hotKey(r)]; return !p || ctx.now - p.at >= HOT_REPEAT_SEC || (r.profitKop ?? 0) >= p.p * (1 + HOT_UP_BP / 10000); };

  const origin = await getMeta(d, 'public_origin');
  // Баланс Steam (у кого вписан): сначала предлагаем то, что можно купить в Steam на эти деньги; дороже баланса в Steam — не предлагаем.
  const balances = await steamBalances(d, new Map(eligible.map((id) => [id, settings.get(id)!])));
  const pending: { tid: number; r: Rec; s: db.Settings; bal: number | null }[] = [];
  for (const tid of eligible) {
    const s = settings.get(tid)!;
    const limit = Math.min(10, Math.max(1, db.num(s.recs_per_day) || 3));
    if ((today.get(tid) ?? 0) >= limit) continue;
    const b = balances.get(tid) ?? null;
    const r = pickRec(comboOf(s), b?.kop ?? null, isNew);
    if (!r) continue;
    pending.push({ tid, r, s, bal: b && r.buyAt === 'steam' ? b.kop : null });
    sent[hotKey(r)] = { p: Math.max(r.profitKop ?? 0, sent[hotKey(r)]?.p ?? 0), at: ctx.now };
  }
  // Ссылка «Купить» — сразу на страницу предмета (для Skinport адрес берём из его API): один запрос на всю рассылку.
  const spNames = pending.filter((x) => x.r.buyAt === 'skinport').map((x) => x.r.name);
  const pages = spNames.length ? await loadSkinportPages(d, spNames) : null;
  let queued = 0;
  for (const { tid, r, s, bal } of pending) {
    writes.push(d.prepare(`INSERT OR IGNORE INTO outbox (telegram_id, kind, ref, signal_id, text, keyboard, edit_msg_id, not_before, created_at)
      VALUES (?, 'recs', ?, NULL, ?, ?, NULL, ?, ?)`).bind(tid, `${hotKey(r)}:${scan.fetchedAt}`, hotText(r, bal), JSON.stringify(hotKeyboard(r, origin, pages)),
      nextAllowed(ctx.now, db.num(s.quiet_start), db.num(s.quiet_end)), ctx.now));
    queued++;
  }
  for (const [k, v] of Object.entries(sent)) if (ctx.now - v.at > 3 * 86400) delete sent[k];
  writes.push(setMetaStmt(d, 'hot_sent', JSON.stringify(sent)));
  for (let i = 0; i < writes.length; i += 90) await d.batch(writes.slice(i, i + 90));
  return { queued };
}
