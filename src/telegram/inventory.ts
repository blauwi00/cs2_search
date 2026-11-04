// Этап 4: «Мой инвентарь» и «История сделок» — пошаговый ввод кнопками и короткими сообщениями.

import * as db from '../storage/db.ts';
import * as T from '../storage/trades.ts';
import { esc, type Keyboard } from './api.ts';
import { say, show, type H, type View } from './context.ts';
import { formatUah, formatSignedUah, formatBp, parseUahInput } from '../utils/money.ts';
import { warsawDate } from '../utils/time.ts';
import { searchSteam } from '../api/steam.ts';
import { CATEGORY_RU } from '../core/normalization.ts';
import { steamSellerProceeds } from '../core/fees.ts';
import {
  PLATFORM_RU, PLATFORMS, valuation, viewLot, realizedStats, parseDateInput, walletFor, openQty,
} from '../core/portfolio.ts';

const back: Keyboard[number] = [{ text: '⬅️ Меню', callback_data: 'm' }];

interface Draft {
  name?: string; itemId?: number; signalId?: number | null; qty?: number; price?: number; priceSuggest?: number;
  platform?: string; fee?: number;
  // продажа
  tradeId?: number; left?: number; salePlatform?: string; salePrice?: number; received?: number;
}

async function loadValuations(d: D1Database, itemIds: number[]) {
  const quotes = await db.quotesForItems(d, [...new Set(itemIds)].slice(0, 90));
  const out = new Map<number, ReturnType<typeof valuation> & { fetchedAt: number | null }>();
  for (const [id, list] of quotes) {
    const q = (s: string, t: string) => list.find((x) => x.source === s && x.price_type === t);
    const low = q('steam', 'lowest_listing');
    out.set(id, { ...valuation(low?.price_kop ?? null, q('steam', 'median_24h')?.price_kop ?? null, q('skinport', 'lowest_listing')?.price_kop ?? null), fetchedAt: low?.fetched_at ?? null });
  }
  return out;
}

export async function inventoryView(h: H): Promise<View> {
  const lots = await T.openTrades(h.d, h.adminId);
  const vals = await loadValuations(h.d, lots.map((l) => l.item_id));
  let cost = 0, costKnown = 0, value = 0, unknown = 0, qty = 0;
  const lines = ['<b>🎒 Мой инвентарь</b>', ''];
  const kb: Keyboard = [];
  for (const l of lots) {
    const v = viewLot(l, vals.get(l.item_id) ?? valuation(null, null, null));
    qty += v.openQty;
    cost += v.openCostKop;
    if (v.steamValueKop === null) unknown++; else { value += v.steamValueKop; costKnown += v.openCostKop; }
    kb.push([{ text: `${l.market_hash_name.slice(0, 38)} ×${v.openQty} ${v.unrealizedRoiBp === null ? '' : formatBp(v.unrealizedRoiBp)}`, callback_data: `iv:${l.id}` }]);
  }
  if (lots.length === 0) lines.push('Пока пусто. Добавь предмет, который у тебя есть или который ты купил.');
  else {
    lines.push(`Позиций: ${lots.length}, предметов: ${qty}`);
    lines.push(`Себестоимость: ${formatUah(cost)}`);
    lines.push(`Оценка продажи в Steam (на баланс, после комиссий): ${formatUah(value)}${unknown ? ` + ${unknown} поз. без цены` : ''}`);
    lines.push(`Нереализованная разница (по позициям с ценой): ${formatSignedUah(value - costKnown)}`);
    lines.push('', '<i>Это оценка, а не прибыль: прибыль появляется только после продажи.</i>');
  }
  kb.push([{ text: '➕ Добавить предмет', callback_data: 'ia' }, { text: '🧾 История сделок', callback_data: 'm:trades' }]);
  kb.push(back);
  return { text: lines.join('\n'), keyboard: kb };
}

export async function lotCard(h: H, id: number): Promise<View> {
  const l = await T.getTrade(h.d, h.adminId, id);
  if (!l) return { text: 'Запись не найдена.', keyboard: [back] };
  const v0 = (await loadValuations(h.d, [l.item_id])).get(l.item_id) ?? { ...valuation(null, null, null), fetchedAt: null };
  const v = viewLot(l, v0);
  const lines = [
    `<b>${esc(l.market_hash_name)}</b>`, '',
    `Куплено: ${l.quantity} шт. по ${formatUah(l.buy_price_kop)}${l.buy_fee_kop ? ` + комиссия ${formatUah(l.buy_fee_kop)}` : ''}`,
    `Где: ${PLATFORM_RU[l.buy_platform] ?? esc(l.buy_platform)}, дата: ${l.buy_date}${l.signal_id ? ` (по сигналу #${l.signal_id})` : ''}`,
    `Осталось: ${v.openQty} шт., себестоимость остатка ${formatUah(v.openCostKop)}`, '',
    `Оценка в Steam: ${v0.steamProceedsPerUnit === null ? 'нет данных' : `${formatUah(v0.steamProceedsPerUnit)}/шт. на баланс`}`,
    ...(v0.steamBasis ? [`<i>${esc(v0.steamBasis)}</i>`] : []),
    `Skinport, самое дешёвое объявление: ${v0.externalPricePerUnit === null ? 'нет данных' : `${formatUah(v0.externalPricePerUnit)}/шт. (без учёта комиссии продавца)`}`,
    `Нереализованная разница (Steam): ${v.unrealizedSteamKop === null ? '—' : `${formatSignedUah(v.unrealizedSteamKop)} (${formatBp(v.unrealizedRoiBp)})`}`,
  ];
  if (l.target_sell_kop) lines.push(`🎯 Цель продажи в Steam: ${formatUah(l.target_sell_kop)} за 1 шт. (цена покупателя)`);
  if (l.note) lines.push(`Заметка: ${esc(l.note)}`);
  const kb: Keyboard = [];
  if (v.openQty > 0) kb.push([{ text: '💸 Продал', callback_data: `sl:${l.id}` }, { text: '🎯 Цель продажи', callback_data: `itg:${l.id}` }]);
  if (l.sold_quantity === 0) kb.push([{ text: '🗑 Удалить запись (ошибка ввода)', callback_data: `idel:${l.id}` }]);
  kb.push([{ text: '⬅️ Инвентарь', callback_data: 'm:inv' }]);
  return { text: lines.join('\n'), keyboard: kb };
}

export async function tradesView(h: H): Promise<View> {
  const trades = await T.allTrades(h.d, h.adminId);
  const sales = await T.salesFor(h.d, h.adminId);
  const withCost = T.salesWithCost(trades, sales);
  const st = realizedStats(trades, withCost);
  const lines = [
    '<b>🧾 История сделок</b> (только твои реальные сделки)', '',
    `Покупок: ${st.buys}, продаж: ${st.sales} (в плюс: ${st.profitable}, в минус: ${st.losing})`, '',
    '<b>Steam Wallet</b> (деньги внутри Steam, вывести нельзя)',
    `• получено: ${formatUah(st.receivedSteamKop)}, результат: ${formatSignedUah(st.realizedSteamKop)}`,
    '<b>External Cash</b> (реальные деньги на внешних площадках)',
    `• получено: ${formatUah(st.receivedCashKop)}, результат: ${formatSignedUah(st.realizedCashKop)}`, '',
    `Средняя доходность сделки: ${formatBp(st.avgRoiBp)}`,
    `Среднее время удержания: ${st.avgHoldDays === null ? '—' : `${st.avgHoldDays.toFixed(1).replace('.', ',')} дн`}`,
  ];
  // По категориям и последние продажи — без дополнительных запросов: категория и название уже в trades.
  const tradeById = new Map(trades.map((t) => [t.id, t]));
  const byCat = new Map<string, number>();
  for (const s of withCost) {
    const t = tradeById.get(s.trade_id);
    if (t) byCat.set(t.category, (byCat.get(t.category) ?? 0) + s.received_kop - s.costKop);
  }
  if (byCat.size) { lines.push('', '<b>Результат по категориям</b>'); for (const [c, v] of byCat) lines.push(`• ${CATEGORY_RU[c as 'case'] ?? c}: ${formatSignedUah(v)}`); }
  if (withCost.length) {
    lines.push('', '<b>Последние продажи</b>');
    for (const s of withCost.slice(-8).reverse()) {
      const name = tradeById.get(s.trade_id)?.market_hash_name ?? '';
      lines.push(`• ${s.sell_date} ${esc(name)} ×${s.quantity}: ${formatSignedUah(s.received_kop - s.costKop)} (${s.wallet === 'steam_wallet' ? 'Steam Wallet' : 'External Cash'})`);
    }
  }
  lines.push('', '<i>Результаты Steam Wallet и External Cash не складываются: это разные деньги.</i>');
  return { text: lines.join('\n'), keyboard: [[{ text: '🎒 Инвентарь', callback_data: 'm:inv' }], back] };
}

// ---------- Пошаговый ввод ----------

async function setDraft(h: H, step: string, d: Draft) { await db.setState(h.d, h.adminId, step, d, h.now); }

const platformKb = (prefix: string, withGift: boolean): Keyboard => {
  const list = PLATFORMS.filter((p) => withGift || p !== 'gift');
  const rows: Keyboard = [];
  for (let i = 0; i < list.length; i += 2) rows.push(list.slice(i, i + 2).map((p) => ({ text: PLATFORM_RU[p], callback_data: `${prefix}:${p}` })));
  rows.push([{ text: 'Отмена', callback_data: 'm:inv' }]);
  return rows;
};

async function askQty(h: H, d: Draft) {
  await setDraft(h, 'inv_qty', d);
  await say(h, `<b>${esc(d.name ?? '')}</b>\nСколько штук?`, [[{ text: '1', callback_data: 'iq:1' }, { text: '2', callback_data: 'iq:2' }, { text: '5', callback_data: 'iq:5' }], [{ text: 'Отмена', callback_data: 'm:inv' }]]);
}
async function askPrice(h: H, d: Draft) {
  await setDraft(h, 'inv_price', d);
  const kb: Keyboard = [];
  if (d.priceSuggest) kb.push([{ text: `✔️ ${formatUah(d.priceSuggest)} за 1 шт.`, callback_data: 'ipr' }]);
  kb.push([{ text: 'Бесплатно (0 грн)', callback_data: 'ipr0' }], [{ text: 'Отмена', callback_data: 'm:inv' }]);
  await say(h, 'Реальная цена покупки за 1 шт. в гривнах (сколько фактически заплатил):', kb);
}
async function askPlatform(h: H, d: Draft) {
  await setDraft(h, 'inv_platform', d);
  await say(h, 'Где куплено?', platformKb('ipl', true));
}
async function askFee(h: H, d: Draft) {
  await setDraft(h, 'inv_fee', d);
  await say(h, 'Дополнительные комиссии за всю покупку (платёжка, пополнение) в гривнах:', [[{ text: 'Без комиссии', callback_data: 'ifee0' }], [{ text: 'Отмена', callback_data: 'm:inv' }]]);
}
async function askDate(h: H, d: Draft) {
  await setDraft(h, 'inv_date', d);
  await say(h, 'Дата покупки (ГГГГ-ММ-ДД или ДД.ММ.ГГГГ):', [[{ text: 'Сегодня', callback_data: 'idt' }], [{ text: 'Отмена', callback_data: 'm:inv' }]]);
}

async function saveTrade(h: H, d: Draft, date: string) {
  if (!d.name || !d.qty || d.price === undefined || !d.platform) return say(h, 'Не хватает данных, начни заново.');
  const item = d.itemId ? await db.getItem(h.d, d.itemId) : await db.upsertItem(h.d, d.name, h.now);
  if (!item) return say(h, 'Предмет не найден.');
  const id = await T.addTrade(h.d, { tid: h.adminId, itemId: item.id, signalId: d.signalId ?? null, quantity: d.qty, buyPriceKop: d.price, buyFeeKop: d.fee ?? 0, platform: d.platform, buyDate: date, note: null, now: h.now });
  await T.addWatchFromInventory(h.d, h.adminId, item.id, h.now);
  await db.clearState(h.d, h.adminId);
  await say(h, `✅ Записано: ${esc(item.market_hash_name)} ×${d.qty} по ${formatUah(d.price)}. Предмет добавлен в мониторинг с повышенным приоритетом.`);
  return show(h, await lotCard(h, id));
}

async function askSalePlatform(h: H, d: Draft) {
  await setDraft(h, 'sale_platform', d);
  await say(h, 'Где продал?', platformKb('spl', false));
}

async function finishSale(h: H, d: Draft, date: string) {
  if (!d.tradeId || !d.qty || d.salePrice === undefined || d.received === undefined || !d.salePlatform) return say(h, 'Не хватает данных, начни заново.');
  try {
    const r = await T.addSale(h.d, h.adminId, { tradeId: d.tradeId, quantity: d.qty, sellPriceKop: d.salePrice, receivedKop: d.received, platform: d.salePlatform, sellDate: date, now: h.now });
    await db.clearState(h.d, h.adminId);
    const res = d.received - r.costKop;
    const wallet = walletFor(d.salePlatform) === 'steam_wallet' ? 'Steam Wallet (вывести нельзя)' : 'External Cash';
    await say(h, `✅ Продажа записана.\nПолучено: ${formatUah(d.received)} → ${wallet}\nСебестоимость: ${formatUah(r.costKop)}\nРезультат: <b>${formatSignedUah(res)}</b>${r.closed ? '\nЛот закрыт.' : ''}`,
      [[{ text: '🧾 История сделок', callback_data: 'm:trades' }, { text: '🎒 Инвентарь', callback_data: 'm:inv' }]]);
  } catch (e) {
    await say(h, `❌ ${esc((e as Error).message)}`);
  }
}

/** Текстовый ввод в шагах инвентаря. true — сообщение обработано. */
export async function onText(h: H, st: { awaiting: string; payload: unknown }, text: string): Promise<boolean> {
  const d = (st.payload ?? {}) as Draft;
  const t = text.trim();
  const today = warsawDate(h.now);
  switch (st.awaiting) {
    case 'inv_search': {
      if (t.length < 2) { await say(h, 'Слишком короткий запрос.'); return true; }
      let hits;
      try { hits = await searchSteam(t, h.fetcher); } catch (e) { await say(h, `⚠️ Поиск в Steam не удался: ${esc((e as Error).message)}`); return true; }
      if (!hits.length) { await say(h, 'Ничего не найдено, попробуй другое название (на английском, как в Steam).'); return true; }
      await db.setState(h.d, h.adminId, 'inv_pick', hits.map((x) => x.marketHashName), h.now);
      await say(h, 'Выбери предмет:', [...hits.map((x, i) => [{ text: x.marketHashName.slice(0, 60), callback_data: `ip:${i}` }]), [{ text: 'Отмена', callback_data: 'm:inv' }]]);
      return true;
    }
    case 'inv_qty': {
      const n = Number(t);
      if (!Number.isInteger(n) || n < 1 || n > 10000) { await say(h, '❌ Введи целое число от 1 до 10000'); return true; }
      await askPrice(h, { ...d, qty: n }); return true;
    }
    case 'inv_price': {
      const k = parseUahInput(t);
      if (k === null) { await say(h, '❌ Введи цену в гривнах, например 120 или 120,50'); return true; }
      const nd = { ...d, price: k };
      if (nd.platform) await askFee(h, nd); else await askPlatform(h, nd);
      return true;
    }
    case 'inv_fee': {
      const k = parseUahInput(t);
      if (k === null) { await say(h, '❌ Введи сумму в гривнах или нажми «Без комиссии»'); return true; }
      await askDate(h, { ...d, fee: k }); return true;
    }
    case 'inv_date': {
      const date = parseDateInput(t, today);
      if (!date) { await say(h, '❌ Неверная дата (будущие даты не принимаются). Пример: 2026-11-01'); return true; }
      await saveTrade(h, d, date); return true;
    }
    case 'sale_qty': {
      const n = Number(t);
      if (!Number.isInteger(n) || n < 1 || n > (d.left ?? 1)) { await say(h, `❌ Введи число от 1 до ${d.left}`); return true; }
      await askSalePlatform(h, { ...d, qty: n }); return true;
    }
    case 'sale_price': {
      const k = parseUahInput(t);
      if (k === null || k <= 0) { await say(h, '❌ Введи цену в гривнах'); return true; }
      const nd = { ...d, salePrice: k };
      await setDraft(h, 'sale_received', nd);
      const kb: Keyboard = [];
      if (nd.salePlatform === 'steam') {
        const p = steamSellerProceeds(k);
        if (p) kb.push([{ text: `✔️ Получил ${formatUah(p.sellerReceives * (nd.qty ?? 1))} (расчёт комиссии Steam)`, callback_data: 'srv' }]);
      }
      kb.push([{ text: 'Отмена', callback_data: 'm:inv' }]);
      await say(h, `Сколько фактически получил всего за ${nd.qty} шт. (после комиссий), в гривнах?`, kb);
      return true;
    }
    case 'sale_received': {
      const k = parseUahInput(t);
      if (k === null) { await say(h, '❌ Введи сумму в гривнах'); return true; }
      await setDraft(h, 'sale_date', { ...d, received: k });
      await say(h, 'Дата продажи:', [[{ text: 'Сегодня', callback_data: 'sdt' }], [{ text: 'Отмена', callback_data: 'm:inv' }]]);
      return true;
    }
    case 'sale_date': {
      const date = parseDateInput(t, today);
      if (!date) { await say(h, '❌ Неверная дата. Пример: 2026-11-01'); return true; }
      await finishSale(h, d, date); return true;
    }
  }
  if (st.awaiting.startsWith('inv_target:')) {
    const id = Number(st.awaiting.slice('inv_target:'.length));
    const k = parseUahInput(t);
    if (k === null || k <= 0) { await say(h, '❌ Введи цену в гривнах'); return true; }
    await T.setTradeTarget(h.d, h.adminId, id, k, h.now);
    await db.clearState(h.d, h.adminId);
    await say(h, `🎯 Цель продажи ${formatUah(k)} сохранена. Сообщу, когда самое дешёвое объявление в Steam будет не ниже.`);
    await show(h, await lotCard(h, id));
    return true;
  }
  return false;
}

/** Кнопки инвентаря. true — обработано. */
export async function onCallback(h: H, data: string, msgId?: number): Promise<boolean> {
  const [a, b] = data.split(':');
  const n = Number(b);
  const st = await (a === 'm' ? Promise.resolve(null) : db.getState(h.d, h.adminId, h.now));
  const d = ((st?.payload ?? {}) as Draft);
  const today = warsawDate(h.now);
  switch (a) {
    case 'ia':
      await db.setState(h.d, h.adminId, 'inv_search', null, h.now);
      await say(h, 'Напиши часть названия предмета на английском, например <code>fracture case</code>:');
      return true;
    case 'ip': {
      const list = st?.awaiting === 'inv_pick' && Array.isArray(st.payload) ? (st.payload as string[]) : [];
      const name = list[n];
      if (!name) { await say(h, 'Список устарел, выполни поиск ещё раз.'); return true; }
      await askQty(h, { name }); return true;
    }
    case 'iq': if (st?.awaiting === 'inv_qty' && n > 0) { await askPrice(h, { ...d, qty: n }); } return true;
    case 'ipr': if (st?.awaiting === 'inv_price' && d.priceSuggest) { const nd = { ...d, price: d.priceSuggest }; if (nd.platform) await askFee(h, nd); else await askPlatform(h, nd); } return true;
    case 'ipr0': if (st?.awaiting === 'inv_price') { const nd = { ...d, price: 0 }; if (nd.platform) await askFee(h, nd); else await askPlatform(h, nd); } return true;
    case 'ipl': if (st?.awaiting === 'inv_platform' && (PLATFORMS as readonly string[]).includes(b)) { await askFee(h, { ...d, platform: b }); } return true;
    case 'ifee0': if (st?.awaiting === 'inv_fee') await askDate(h, { ...d, fee: 0 }); return true;
    case 'idt': if (st?.awaiting === 'inv_date') await saveTrade(h, d, today); return true;
    case 'bs': {
      // «Купил» из сигнала: подставляем предмет, площадку и цену сигнала, но пользователь подтверждает реальную цену.
      const sig = Number.isInteger(n) ? await db.getSignal(h.d, n) : null;
      const item = sig ? await db.getItem(h.d, sig.item_id) : null;
      if (!sig || !item) { await say(h, 'Сигнал не найден.'); return true; }
      await askQty(h, { name: item.market_hash_name, itemId: item.id, signalId: sig.id, priceSuggest: sig.buy_kop ?? undefined, platform: sig.buy_source ?? undefined });
      return true;
    }
    case 'iv': if (Number.isInteger(n)) await show(h, await lotCard(h, n), msgId); return true;
    case 'itg':
      await db.setState(h.d, h.adminId, `inv_target:${n}`, null, h.now);
      await say(h, 'Цель продажи в Steam за 1 шт. (цена покупателя), в гривнах:');
      return true;
    case 'idel':
      await say(h, 'Удалить эту запись? История продаж не затрагивается (удалить можно только лот без продаж).', [[{ text: 'Да, удалить', callback_data: `idely:${n}` }, { text: 'Нет', callback_data: `iv:${n}` }]]);
      return true;
    case 'idely':
      await say(h, (await T.deleteTrade(h.d, h.adminId, n)) ? 'Удалено.' : 'Нельзя удалить: по лоту уже есть продажи.');
      await show(h, await inventoryView(h));
      return true;
    case 'sl': {
      const t = await T.getTrade(h.d, h.adminId, n);
      if (!t || openQty(t) < 1) { await say(h, 'Нечего продавать в этой позиции.'); return true; }
      const nd: Draft = { tradeId: t.id, left: openQty(t), name: t.market_hash_name };
      if (nd.left === 1) await askSalePlatform(h, { ...nd, qty: 1 });
      else { await setDraft(h, 'sale_qty', nd); await say(h, `Сколько штук продал? (осталось ${nd.left})`); }
      return true;
    }
    case 'spl':
      if (st?.awaiting === 'sale_platform' && (PLATFORMS as readonly string[]).includes(b)) {
        await setDraft(h, 'sale_price', { ...d, salePlatform: b });
        await say(h, b === 'steam' ? 'Цена продажи за 1 шт. — сколько заплатил покупатель в Steam, в гривнах:' : 'Цена продажи за 1 шт. в гривнах:');
      }
      return true;
    case 'srv':
      if (st?.awaiting === 'sale_received' && d.salePrice) {
        const p = steamSellerProceeds(d.salePrice);
        if (p) { await setDraft(h, 'sale_date', { ...d, received: p.sellerReceives * (d.qty ?? 1) }); await say(h, 'Дата продажи:', [[{ text: 'Сегодня', callback_data: 'sdt' }]]); }
      }
      return true;
    case 'sdt': if (st?.awaiting === 'sale_date') await finishSale(h, d, today); return true;
  }
  return false;
}

/** Для отчётов: реализованный результат за дату и оценка инвентаря. */
export async function portfolioSummary(d: D1Database, tid: number, date: string) {
  const trades = await T.allTrades(d, tid);
  const sales = await T.salesFor(d, tid);
  const wc = T.salesWithCost(trades, sales).filter((s) => s.sell_date === date);
  const steam = wc.filter((s) => s.wallet === 'steam_wallet').reduce((x, s) => x + s.received_kop - s.costKop, 0);
  const cash = wc.filter((s) => s.wallet !== 'steam_wallet').reduce((x, s) => x + s.received_kop - s.costKop, 0);
  const open = trades.filter((t) => t.status === 'open');
  const vals = await loadValuations(d, open.map((t) => t.item_id));
  let value = 0, cost = 0, unknown = 0;
  for (const t of open) {
    const v = viewLot(t, vals.get(t.item_id) ?? valuation(null, null, null));
    if (v.steamValueKop === null) { unknown++; continue; }
    value += v.steamValueKop; cost += v.openCostKop;
  }
  return { salesToday: wc.length, realizedSteamToday: steam, realizedCashToday: cash, inventoryValue: value, inventoryCost: cost, inventoryUnknown: unknown, openLots: open.length };
}

