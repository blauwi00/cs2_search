import { getMeta } from '../core/channel.ts';
import { suggestStart, suggestReceive, suggestDecide } from './suggest.ts';
import type { Env } from '../env.ts';
import * as db from '../storage/db.ts';
import { hideSignal } from '../storage/db.ts';
import { WATCH_LIMIT } from '../core/audience.ts';
import { channelCommand, postPreview, publishNow, refStmt, statsCommand, refCommand, broadcastCommand, broadcastConfirm, fixNewsPost } from './owner.ts';
import { budgetedDb, newBudget, sampleWrites, WRITE_SAMPLE } from '../storage/budget.ts';
import { setJobEnabled, listJobs } from '../core/scheduler.ts';
import { TelegramClient, esc, type Keyboard } from './api.ts';
import * as M from './menus.ts';
import { metaFor, ADMIN_ONLY, parseSettingInput, nextChoice } from './settings.ts';
import type { SearchHit } from '../api/steam.ts';
import { searchCatalog, catalogInfo } from '../catalog.ts';
import { SourceError } from '../types/market.ts';
import { parseMoneyInput, formatUah } from '../utils/money.ts';
import { runDemo } from '../demo.ts';
import type { Fetcher } from '../utils/http.ts';
import { say, show, hcur, inCur, type H } from './context.ts';
import * as INV from './inventory.ts';
import { parseMarketHashName } from '../core/normalization.ts';
import { chartUrl } from '../chart.ts';
import { moneyResolver, guessCurrency, isCurrency, loadRates, availableCurrencies } from '../currency/display.ts';
import { TERMS_VERSION, termsText, privacyPolicyText, termsPrompt, deleteUserStmts } from '../core/terms.ts';
import { submitFeedback, donateInvoiceLink, parseDonatePayload, donorName, DONATE_AMOUNTS } from '../core/support.ts';

/** Максимальный размер тела webhook, который мы готовы разбирать. */
export const MAX_UPDATE_BYTES = 64 * 1024;

/** Сравнение строк за постоянное время (секреты). */
export function safeEqual(a: string | null | undefined, b: string | null | undefined): boolean {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length === 0 || b.length === 0) return false;
  const enc = new TextEncoder();
  const x = enc.encode(a);
  const y = enc.encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

interface TgUser { is_bot?: boolean; id: number; language_code?: string; first_name?: string }
interface TgMessage { message_id: number; from?: TgUser; chat: { id: number; type: string }; text?: string; caption?: string; photo?: { file_id: string; width: number }[]; successful_payment?: { currency: string; total_amount: number; invoice_payload: string; telegram_payment_charge_id: string } }
interface TgCallback { id: string; from: TgUser; data?: string; message?: TgMessage }
interface TgUpdate { update_id: number; message?: TgMessage; callback_query?: TgCallback; pre_checkout_query?: { id: string; from: TgUser; currency: string; total_amount: number; invoice_payload: string } }

export async function handleWebhook(req: Request, env: Env, now: number, fetcher?: Fetcher, rawDb?: D1Database): Promise<Response> {
  if (req.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });
  if (!safeEqual(req.headers.get('X-Telegram-Bot-Api-Secret-Token'), env.TELEGRAM_WEBHOOK_SECRET)) {
    return new Response('Forbidden', { status: 403 });
  }
  const len = Number(req.headers.get('content-length') ?? '0');
  if (len > MAX_UPDATE_BYTES) return new Response('Payload Too Large', { status: 413 });
  const body = await req.text();
  if (body.length > MAX_UPDATE_BYTES) return new Response('Payload Too Large', { status: 413 });
  let update: TgUpdate;
  try { update = JSON.parse(body) as TgUpdate; } catch { return new Response('Bad Request', { status: 400 }); }

  // Оплата звёздами: Telegram спрашивает подтверждение перед списанием — отвечаем сразу (иначе платёж отменится).
  if (update.pre_checkout_query) {
    const q = update.pre_checkout_query;
    const ok = q.currency === 'XTR' && parseDonatePayload(q.invoice_payload) === q.total_amount;
    await new TelegramClient(env.TELEGRAM_BOT_TOKEN, fetcher).call('answerPreCheckoutQuery', ok ? { pre_checkout_query_id: q.id, ok: true }
      : { pre_checkout_query_id: q.id, ok: false, error_message: 'Платёж не распознан, попробуй ещё раз из бота.' }).catch(() => undefined);
    return new Response('ok');
  }
  // Бот для всех. Работаем только в личном чате с ботом: chat.id личного чата совпадает с ID пользователя.
  const fromId = update.message?.from?.id ?? update.callback_query?.from?.id;
  const chatId = update.message?.chat.id ?? update.callback_query?.message?.chat.id;
  if (!Number.isSafeInteger(fromId) || chatId !== fromId) return new Response('ok');
  if (update.message?.from?.is_bot || update.callback_query?.from?.is_bot) return new Response('ok');
  const uid = fromId as number;
  const isAdmin = uid === Number(env.ADMIN_TELEGRAM_ID);

  const budget = newBudget();
  const d = budgetedDb(rawDb ?? env.DB, budget);
  const tg = new TelegramClient(env.TELEGRAM_BOT_TOKEN, fetcher);
  tg.money = moneyResolver(d);
  const lang = update.message?.from?.language_code ?? update.callback_query?.from?.language_code;
  try {
    await db.ensureUser(d, uid, isAdmin, now, guessCurrency(lang));
    await d.batch(db.touchActiveStmts(d, uid, now, false));
    if (update.callback_query) await onCallback(update.callback_query, { env, d, tg, uid, isAdmin, now, fetcher, origin: new URL(req.url).origin });
    else if (update.message?.successful_payment) await onPaid(update.message.successful_payment, update.message.from?.first_name, { env, d, tg, uid, isAdmin, now, fetcher, origin: new URL(req.url).origin });
    else if (isAdmin && (update.message as { forward_origin?: { type?: string } } | undefined)?.forward_origin?.type === 'channel') {
      const fo = (update.message as unknown as { forward_origin: { chat: { id: number }; message_id: number } }).forward_origin;
      await fixNewsPost({ env, d, tg, uid, isAdmin, now, fetcher, origin: new URL(req.url).origin }, fo.chat.id, fo.message_id);
    } else if (update.message?.photo?.length) {
      // Картинка — только для предложки (подпись — в том же сообщении).
      const h = { env, d, tg, uid, isAdmin, now, fetcher, origin: new URL(req.url).origin };
      const big = update.message.photo[update.message.photo.length - 1].file_id;
      if (!(await suggestReceive(h, update.message.caption, big))) await say(h, 'Картинки бот принимает только в предложке: /suggest');
    } else if (update.message?.text) await onText(update.message.text, { env, d, tg, uid, isAdmin, now, fetcher, origin: new URL(req.url).origin });
  } catch (e) {
    await db.log(d, 'error', 'telegram', 'handler', (e as Error).message, now);
    try { await tg.sendMessage(uid, `⚠️ Ошибка обработки команды: ${esc((e as Error).message).slice(0, 300)}`); } catch { /* ignore */ }
  }
  if (budget.written > 0 && sampleWrites()) await db.counterStmt(d, 'w:tg', (budget.written + 1) * WRITE_SAMPLE, now).run().catch(() => undefined);
  return new Response('ok');
}


async function onText(text: string, h: H): Promise<void> {
  // Добавление списком: /addlist и точные названия, по одному в строке (без поиска в Steam).
  // Владелец прислал ссылку на пост канала (если переслать нельзя — «Копировать ссылку»): исправить пост об обновлении на русский.
  const postLink = h.isAdmin ? /^(?:https?:\/\/)?t\.me\/(?:c\/\d+|[A-Za-z0-9_]{4,})\/(\d+)\/?(?:\?\S*)?$/i.exec(text.trim()) : null;
  if (postLink) {
    const chat = Number(await getMeta(h.d, 'channel_id'));
    if (chat) return fixNewsPost(h, chat, Number(postLink[1]));
  }
  if (/^\/addlist(@\w+)?(\s|$)/i.test(text.trim())) return addList(h, text.trim().replace(/^\/addlist(@\w+)?/i, ''));
  const t = text.trim().slice(0, 200);
  const cmd = t.split(/\s+/)[0].toLowerCase().replace(/@\w+$/, '');
  await db.ensureUser(h.d, h.uid, h.isAdmin, h.now);
  // Удаление данных и тексты условий доступны всегда; всё остальное — после принятия условий.
  if (cmd === '/deletemydata') return say(h, '🗑 Удалить всё, что бот знает о тебе? Настройки, список, покупки, привязка Steam и уведомления удалятся без возможности восстановления.', [[{ text: 'Да, удалить всё', callback_data: 'delme:yes' }], [{ text: 'Отмена', callback_data: 'delme:no' }]]);
  if (!['/terms', '/privacy', '/paysupport'].includes(cmd) && !(await termsAccepted(h))) {
    // Метку из ссылки (t.me/бот?start=ch, ?start=suggest) запоминаем до согласия — после «Принимаю» выполним /start с ней.
    const p = cmd === '/start' ? (t.split(/\s+/)[1] ?? '') : '';
    if (/^[A-Za-z0-9_]{1,32}$/.test(p)) {
      await h.d.prepare(`INSERT INTO user_settings (telegram_id, key, value, updated_at) VALUES (?, 'start_param', ?, ?)
        ON CONFLICT(telegram_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`).bind(h.uid, p, h.now).run();
    }
    return askTerms(h);
  }
  switch (cmd) {
    case '/start': {
      await db.clearState(h.d, h.uid);
      // Метка источника (t.me/бот?start=tt) — чтобы видеть, откуда приходят люди.
      if ((t.split(/\s+/)[1] ?? '') === 'suggest') return suggestStart(h);
      const ref = refStmt(h.d, h.uid, t.split(/\s+/)[1] ?? '', h.now);
      if (ref) await ref.run();
      // Кнопка приложения у поля ввода; повторная установка безопасна.
      try { await h.tg.setMenuButton(h.uid, `${h.origin}/app`); } catch { /* не критично */ }
      // Главное — приложение. Текстовое меню осталось за второй кнопкой и командой /menu.
      const cur = await hcur(h);
      return say(h, `<b>CS2 Market</b>\n\nВсё — в приложении: что купить, что продать, цены и инвентарь.\n\n💱 Валюта: <b>${cur.code}</b> — если не твоя, смени: /currency\n🛡 Бот не спрашивает пароль Steam и ничего не покупает сам. Что он знает и что нужно для работы: /privacy\n\nЖми кнопку 👇`, [
        [{ text: '📱 Открыть приложение', web_app: { url: `${h.origin}/app` } }],
        [{ text: '☰ Текстовое меню', callback_data: 'm' }],
      ]);
    }
    case '/currency': case '/valuta': return currencyView(h);
    case '/privacy': return say(h, privacyPolicyText());
    case '/donate': return donateView(h);
    case '/paysupport': return say(h, '💛 Пожертвования добровольные и ничего не покупают. Если звёзды списались по ошибке — напиши сюда, в этот чат, командой /feedback и опиши ситуацию, владелец бота ответит. Возврат возможен в течение 7 дней.');
    case '/feedback': {
      const msg = text.trim().replace(/^\/feedback(@\w+)?/i, '').trim();
      if (!msg) return say(h, 'Напиши после команды, что не так: <code>/feedback цена Revolution Case на Skinport не совпадает</code>');
      const err = await submitFeedback(h.d, h.tg, Number(h.env.ADMIN_TELEGRAM_ID), h.uid, { reason: 'other', comment: msg, context: 'из чата бота' }, h.now);
      return say(h, err ? `❌ ${err}` : '✅ Спасибо! Передал владельцу бота.');
    }
    case '/suggest': return suggestStart(h);
    case '/terms': return say(h, termsText());
    case '/channel': return channelCommand(h, t.replace(/^\/channel(@\w+)?/i, ''));
    case '/post': return postPreview(h, t.replace(/^\/post(@\w+)?/i, ''));
    case '/stats': return statsCommand(h);
    case '/ref': return refCommand(h, t.replace(/^\/ref(@\w+)?/i, ''));
    case '/broadcast': return broadcastCommand(h, text.trim().replace(/^\/broadcast(@\w+)?/i, ''));
    case '/menu': {
      await db.clearState(h.d, h.uid);
      return show(h, await M.mainMenu(h.d, h.now, `${h.origin}/app`, h.isAdmin));
    }
    case '/app': return say(h, 'Приложение откроется внутри Telegram:', [[{ text: '📱 Открыть приложение', web_app: { url: `${h.origin}/app` } }]]);
    case '/status': if (!h.isAdmin) return say(h, '✅ Бот работает. Цены обновляются примерно каждые 10 минут.');
      return show(h, await M.statusView(h.d, h.now, !!h.env.CSFLOAT_API_KEY, h.env.COLLECTOR === 'github'));
    case '/deals': return show(h, await M.dealsView(h.d, h.now, 'spread', h.uid));
    case '/cases': return show(h, await M.casesView(h.d, h.uid, h.now, 'name'));
    case '/watch': return show(h, await M.watchView(h.d, h.uid));
    case '/settings': return show(h, await M.settingsView(h.d, h.uid, h.isAdmin));
    case '/demo': return runDemo(h.tg, h.uid, h.now);
    case '/inv': case '/inventory': await db.clearState(h.d, h.uid); return show(h, await INV.inventoryView(h));
    case '/trades': return show(h, await INV.tradesView(h));
    case '/add': {
      const q = t.slice(4).trim();
      if (q) return doSearch(h, q);
      await db.setState(h.d, h.uid, 'search', null, h.now);
      return say(h, 'Напиши часть названия предмета на английском, например: <code>redline</code> или <code>revolution case</code>.');
    }
    case '/help': return say(h, HELP);
  }
  const st = await db.getState(h.d, h.uid, h.now);
  if (!st) return say(h, 'Не понял. Открой меню: /start', [[{ text: 'Меню', callback_data: 'm' }]]);
  if (st.awaiting === 'suggest') { await suggestReceive(h, text, null); return; }
  if (await INV.onText(h, st, t)) return;
  if (st.awaiting === 'search') return doSearch(h, t);
  if (st.awaiting === 'addlist') return addList(h, text);
  if (st.awaiting.startsWith('set:')) {
    const m = metaFor(st.awaiting.slice(4));
    if (!m || (!h.isAdmin && ADMIN_ONLY.includes(m.key))) return;
    const r = parseSettingInput(m, t, await hcur(h));
    if (!r.ok) return say(h, `❌ ${r.error}`);
    await db.setSetting(h.d, h.uid, m.key, r.value, h.now);
    await db.clearState(h.d, h.uid);
    return show(h, await M.settingsView(h.d, h.uid, h.isAdmin));
  }
  if (st.awaiting.startsWith('target:')) {
    const id = Number(st.awaiting.slice(7));
    const kop = parseMoneyInput(t, await hcur(h));
    if (kop === null || kop <= 0) return say(h, `❌ Введи цену ${await inCur(h)}, например 120 или 120,50`);
    await db.setWatchTarget(h.d, h.uid, id, kop);
    await db.clearState(h.d, h.uid);
    await h.tg.sendMessage(h.uid, `🎯 Целевая цена ${formatUah(kop)} сохранена. Уведомлю, когда самое дешёвое объявление в Steam будет не дороже.`);
    return show(h, await M.watchCard(h.d, h.uid, id, h.now));
  }
}

/** Поиск: каталог названий Skinport (Steam-поиск из сети Cloudflare блокируется). */
export async function findItems(h: H, query: string): Promise<string[]> {
  return searchCatalog(h.d, query, 12);
}

/** Точные market_hash_name списком. Существование проверится при первом запросе цен (нет данных — запись в журнале). */
export async function addList(h: H, body: string): Promise<void> {
  const names = [...new Set(body.split(/\r?\n/).map((x) => x.trim()).filter((x) => x.length >= 3 && x.length <= 120))].slice(0, 60);
  if (names.length === 0) {
    await db.setState(h.d, h.uid, 'addlist', null, h.now);
    return say(h, 'Пришли точные названия предметов, каждое с новой строки (как в Steam), например:\n<code>Revolution Case\nFracture Case</code>');
  }
  if (!h.isAdmin) {
    const have = await db.countUserWatch(h.d, h.uid);
    if (have + names.length > WATCH_LIMIT) {
      await db.clearState(h.d, h.uid);
      return say(h, have >= WATCH_LIMIT ? `❌ Лимит — ${WATCH_LIMIT} предметов на человека. Удали ненужные, чтобы добавить новые.`
        : `❌ Можно добавить ещё ${WATCH_LIMIT - have} (лимит — ${WATCH_LIMIT} предметов на человека). Пришли список покороче.`);
    }
  }
  // Всё одним-двумя batch: по запросу на предмет не хватило бы лимита (50 запросов к D1 за вызов).
  const before = (await h.d.prepare('SELECT COUNT(*) AS n FROM watchlist WHERE telegram_id = ? AND active = 1').bind(h.uid).first<{ n: number }>())?.n ?? 0;
  const stmts: D1PreparedStatement[] = [];
  for (const n of names) {
    stmts.push(...db.upsertItemStmts(h.d, n, h.now));
    stmts.push(h.d.prepare(
      `INSERT INTO watchlist (telegram_id, item_id, created_at) SELECT ?, id, ? FROM items WHERE market_hash_name = ?
       ON CONFLICT(telegram_id, item_id) DO UPDATE SET active = 1`,
    ).bind(h.uid, h.now, parseMarketHashName(n).marketHashName));
  }
  for (let i = 0; i < stmts.length; i += 90) await h.d.batch(stmts.slice(i, i + 90));
  const after = (await h.d.prepare('SELECT COUNT(*) AS n FROM watchlist WHERE telegram_id = ? AND active = 1').bind(h.uid).first<{ n: number }>())?.n ?? 0;
  const added = after - before, existed = names.length - added;
  await db.clearState(h.d, h.uid);
  return say(h, `✅ Добавлено в наблюдение: ${added}${existed ? `, уже были: ${existed}` : ''}.\nЕсли название написано неточно, Steam вернёт «нет данных» — это будет видно в «Состоянии системы».`);
}

async function doSearch(h: H, query: string): Promise<void> {
  if (query.length < 2) return say(h, 'Слишком короткий запрос.');
  const hits: SearchHit[] = (await findItems(h, query)).map((n) => ({ marketHashName: n, sellListings: null }));
  if (hits.length === 0 && (await catalogInfo(h.d)).count === 0) {
    return say(h, '⏳ Поиск по названиям ещё готовится. Пока можно добавить предмет точным названием: /addlist');
  }
  if (hits.length === 0) return say(h, 'Ничего не найдено. Попробуй другое название (на английском, как в Steam).');
  await db.setState(h.d, h.uid, 'pick', hits.map((x) => x.marketHashName), h.now);
  const kb: Keyboard = hits.map((x, i) => [{ text: `${x.marketHashName.slice(0, 55)}${x.sellListings !== null ? ` (${x.sellListings})` : ''}`, callback_data: `wp:${i}` }]);
  kb.push([{ text: 'Отмена', callback_data: 'm:watch' }]);
  await h.tg.sendMessage(h.uid, 'Выбери точный вариант:', kb);
}

async function onCallback(cb: TgCallback, h: H): Promise<void> {
  const data = (cb.data ?? '').slice(0, 64);
  const msgId = cb.message?.message_id;
  await h.tg.answerCallback(cb.id).catch(() => undefined);
  const [a, b, c] = data.split(':');
  const idArg = Number(b);

  if (a === 'terms') {
    if (b === 'full') return say(h, termsText(), TERMS_KB);
    if (b === 'ok') {
      await db.setSetting(h.d, h.uid, 'terms_ok', TERMS_VERSION, h.now);
      // Метка, с которой человек пришёл до согласия, — не теряем (источник в /stats, «Предложить пост»).
      const p = (await h.d.prepare(`DELETE FROM user_settings WHERE telegram_id = ? AND key = 'start_param' RETURNING value`).bind(h.uid).first<{ value: string }>())?.value;
      return onText(p && /^[A-Za-z0-9_]{1,32}$/.test(p) ? `/start ${p}` : '/start', h);
    }
  }
  if (a === 'delme') {
    if (b !== 'yes') return say(h, 'Хорошо, ничего не удалено.');
    await h.d.batch(deleteUserStmts(h.d, h.uid));
    return say(h, '✅ Всё удалено. Если напишешь боту снова, он начнёт с чистого листа.');
  }
  if (!(await termsAccepted(h))) return askTerms(h);
  if (a === 'chpost' && b) return publishNow(h, b);
  if (a === 'bc') return broadcastConfirm(h, b === 'send');
  if (a === 'sg' && b === 'go') return suggestStart(h);
  if (a === 'sg' && Number.isInteger(Number(c))) return suggestDecide(h, b, Number(c));
  if (a === 'wk' && b === 'off') {
    await db.setSetting(h.d, h.uid, 'weekly_report', '0', h.now);
    return say(h, '🔕 Воскресная сводка выключена. Включить: приложение → Ещё → Настройки → «Воскресная сводка по инвентарю Steam».');
  }
  if (a === 'dt') {
    const on = b === 'on';
    await db.setSetting(h.d, h.uid, 'donor_top', on ? '1' : '0', h.now);
    return say(h, on ? '👀 Ты снова в «Топе поддержки» (если поддерживал звёздами).' : '🙈 Готово: в «Топе поддержки» тебя не видно.', [[donorTopButton(on)]]);
  }
  if (a === 'don' && b) {
    const stars = Number(b);
    if (!DONATE_AMOUNTS.includes(stars)) return;
    const link = await donateInvoiceLink(h.tg, stars);
    return say(h, `Спасибо! Нажми, чтобы отправить <b>${stars} ⭐</b>:`, [[{ text: `⭐ Отправить ${stars}`, url: link }]]);
  }
  if (a === 'nr' && b === 'off') {
    await db.setSetting(h.d, h.uid, 'notify_recs', '0', h.now);
    return say(h, '🔕 Горячие рекомендации больше не приходят. Включить снова: приложение → Ещё → Настройки → «Горячие рекомендации по всему рынку».');
  }
  if (data === 'm') { await db.clearState(h.d, h.uid); return show(h, await M.mainMenu(h.d, h.now, `${h.origin}/app`, h.isAdmin), msgId); }
  if (a === 'm') {
    switch (b) {
      case 'deals': return show(h, await M.dealsView(h.d, h.now, c === 'roi' || c === 'priority' ? c : 'spread', h.uid), msgId);
      case 'watch': await db.clearState(h.d, h.uid); return show(h, await M.watchView(h.d, h.uid), msgId);
      case 'cases': return show(h, await M.casesView(h.d, h.uid, h.now, c === 'up' || c === 'down' ? c : 'name'), msgId);
      case 'set': return show(h, await M.settingsView(h.d, h.uid, h.isAdmin), msgId);
      case 'status': if (!h.isAdmin) return say(h, '✅ Бот работает. Цены обновляются примерно каждые 10 минут.');
        return show(h, await M.statusView(h.d, h.now, !!h.env.CSFLOAT_API_KEY, h.env.COLLECTOR === 'github'), msgId);
      case 'an': return show(h, await M.analyticsView(h.d, h.now), msgId);
      case 'inv': await db.clearState(h.d, h.uid); return show(h, await INV.inventoryView(h), msgId);
      case 'trades': return show(h, await INV.tradesView(h), msgId);
    }
    return;
  }
  if (a === 'bt' && Number.isInteger(idArg)) return show(h, await M.backtestView(h.d, h.uid, idArg, h.now));
  if (a === 'df') {
    await M.toggleDealFilter(h.d, h.uid, b, h.now);
    return show(h, await M.dealsView(h.d, h.now, c === 'roi' || c === 'priority' ? c : 'spread', h.uid), msgId);
  }
  if ((a === 'ch' || a === 'chi') && Number.isInteger(idArg)) {
    const itemId = a === 'chi' ? idArg : (await db.getSignal(h.d, idArg))?.item_id;
    if (!itemId) return say(h, 'Предмет не найден.');
    const name = (await db.getItem(h.d, itemId))?.market_hash_name ?? '';
    const kb: Keyboard = [[7, 30, 90].map((days) => ({ text: `${days} дн`, url: '' }))];
    for (let i = 0; i < 3; i++) kb[0][i].url = await chartUrl(h.origin, h.env.ADMIN_KEY, itemId, [7, 30, 90][i]);
    return say(h, `📈 График цен: <b>${esc(name)}</b>\nОткроется в браузере. Ссылка личная — не пересылай её.`, kb);
  }
  if (await INV.onCallback(h, data, msgId)) return;
  if (a === 'wa') {
    await db.setState(h.d, h.uid, 'search', null, h.now);
    return say(h, 'Напиши часть названия на английском, например: <code>ak-47 redline</code> или <code>fracture case</code>.');
  }
  if (a === 'wp') {
    const st = await db.getState(h.d, h.uid, h.now);
    const list = st?.awaiting === 'pick' && Array.isArray(st.payload) ? (st.payload as string[]) : [];
    const name = Number.isInteger(idArg) ? list[idArg] : undefined;
    if (!name) return say(h, 'Список устарел, выполни поиск ещё раз.');
    if (!h.isAdmin && (await db.countUserWatch(h.d, h.uid)) >= WATCH_LIMIT) {
      await db.clearState(h.d, h.uid);
      return say(h, `❌ Лимит — ${WATCH_LIMIT} предметов на человека. Удали ненужные в «👁 Мониторинг цен», чтобы добавить новые.`);
    }
    const item = await db.upsertItem(h.d, name, h.now);
    const r = await db.addWatch(h.d, h.uid, item.id, h.now);
    await db.clearState(h.d, h.uid);
    await h.tg.sendMessage(h.uid, r === 'added'
      ? `✅ <b>${esc(name)}</b> добавлен в наблюдение.\nПервые цены появятся в течение нескольких минут (Steam проверяется порциями, Skinport — раз в 10 минут).`
      : `Уже в наблюдении: ${esc(name)}`);
    return show(h, await M.watchView(h.d, h.uid));
  }
  if (a === 'w' && Number.isInteger(idArg)) return show(h, await M.watchCard(h.d, h.uid, idArg, h.now), msgId);
  if (a === 'wr' && Number.isInteger(idArg)) { await db.removeWatch(h.d, h.uid, idArg); return show(h, await M.watchView(h.d, h.uid), msgId); }
  if (a === 'wt' && Number.isInteger(idArg)) {
    await db.setState(h.d, h.uid, `target:${idArg}`, null, h.now);
    return say(h, `Введи целевую цену покупки в Steam ${await inCur(h)}, например 150:`);
  }
  if (a === 'wtc' && Number.isInteger(idArg)) { await db.setWatchTarget(h.d, h.uid, idArg, null); return show(h, await M.watchCard(h.d, h.uid, idArg, h.now), msgId); }
  if (a === 'd' && Number.isInteger(idArg)) return show(h, await M.dealCard(h.d, idArg, h.now));
  if (a === 'dh' && Number.isInteger(idArg)) {
    await hideSignal(h.d, h.uid, idArg, h.now);
    return say(h, 'Скрыто. Этот сигнал больше не будет приходить.');
  }
  if (a === 'cur') {
    if (b && isCurrency(b)) {
      await db.setSetting(h.d, h.uid, 'currency', b, h.now);
      await db.setSetting(h.d, h.uid, 'currency_ok', '1', h.now);
      h.tg.money = moneyResolver(h.d);
    }
    return currencyView(h, msgId, !!b);
  }
  if (a === 's' && b) {
    const m = metaFor(b);
    if (!m || (!h.isAdmin && ADMIN_ONLY.includes(m.key))) return;
    if (m.kind === 'toggle' || m.kind === 'choice') {
      const s = await db.getSettings(h.d, h.uid);
      await db.setSetting(h.d, h.uid, m.key, nextChoice(m, s[m.key]), h.now);
      return show(h, await M.settingsView(h.d, h.uid, h.isAdmin), msgId);
    }
    await db.setState(h.d, h.uid, `set:${m.key}`, null, h.now);
    return say(h, `Введи новое значение: <b>${esc(m.label)}</b>${m.hint ? `\n<i>${esc(m.hint)}</i>` : ''}`);
  }
  if (data === 'jobs:enable' && h.isAdmin) {
    for (const j of await listJobs(h.d)) if (j.enabled !== 1) await setJobEnabled(h.d, j.name, true, h.now);
    return show(h, await M.statusView(h.d, h.now, !!h.env.CSFLOAT_API_KEY, h.env.COLLECTOR === 'github'), msgId);
  }
}

const HELP = [
  '<b>Команды</b>',
  '/start — открыть приложение', '/menu — текстовое меню',
  '/currency — валюта цен', '/terms — условия и риски', '/privacy — конфиденциальность', '/deletemydata — удалить мои данные',
  '/app — открыть приложение',
  '/add название — добавить предмет в наблюдение',
  '/addlist — добавить несколько предметов списком (точные названия, по одному в строке)',
  '/watch — список наблюдения',
  '/deals — выгодные сделки',
  '/settings — настройки',
  '/status — состояние системы',
  '/cases — кейсы и капсулы',
  '/inv — мой инвентарь',
  '/trades — история сделок',
  '/demo — тестовое уведомление на тестовых данных',
].join('\n');

/** Выбор валюты: кнопки по 4 в ряд (только валюты, для которых есть курс). */
async function currencyView(h: H, msgId?: number, saved = false): Promise<void> {
  const [rates, cur] = await Promise.all([loadRates(h.d), hcur(h)]);
  const list = availableCurrencies(rates);
  const kb: Keyboard = [];
  for (let i = 0; i < list.length; i += 4) {
    kb.push(list.slice(i, i + 4).map((c) => ({ text: `${c.code === cur.code ? '✅ ' : ''}${c.code} ${c.sign}`, callback_data: `cur:${c.code}` })));
  }
  kb.push([{ text: '⬅️ Меню', callback_data: 'm' }]);
  const text = [
    saved ? `✅ Валюта: <b>${cur.code}</b>` : `<b>💱 Валюта</b>\nСейчас: <b>${cur.code} (${cur.sign})</b>`, '',
    'В ней бот показывает все цены, уведомления и приложение. Суммы в настройках тоже вводишь в ней.',
    '<i>Площадки продают в своих валютах, бот пересчитывает по курсу НБУ (для RUB, BRL, ARS — через доллар). Цена в Steam в твоём кошельке может немного отличаться: у Steam свои курсы.</i>',
  ].join('\n');
  return show(h, { text, keyboard: kb }, msgId);
}

const TERMS_KB: Keyboard = [[{ text: '✅ Принимаю', callback_data: 'terms:ok' }], [{ text: '📄 Полный текст условий', callback_data: 'terms:full' }]];
async function termsAccepted(h: H): Promise<boolean> {
  return (await db.getSettings(h.d, h.uid)).terms_ok === TERMS_VERSION;
}
function askTerms(h: H): Promise<void> {
  return say(h, termsPrompt(), TERMS_KB);
}

async function donateView(h: H): Promise<void> {
  return say(h, [
    '💛 <b>Поддержать Ценолова</b>', '',
    'Бот бесплатный и работает 24/7. Если он тебе помог — можно поддержать звёздами Telegram. Это добровольно и ничего не открывает: бот остаётся бесплатным для всех.',
    '', 'Поддержавшие попадают в бегущую строку «Топ поддержки» в приложении — с именем из Telegram. Скрыть себя можно кнопкой после оплаты или командой /donate → «Скрыть меня».',
  ].join('\n'), [DONATE_AMOUNTS.slice(0, 3).map((n) => ({ text: `⭐ ${n}`, callback_data: `don:${n}` })), DONATE_AMOUNTS.slice(3).map((n) => ({ text: `⭐ ${n}`, callback_data: `don:${n}` })), [donorTopButton((await db.getSettings(h.d, h.uid)).donor_top !== '0')]]);
}

async function onPaid(p: NonNullable<TgMessage['successful_payment']>, first: string | undefined, h: H): Promise<void> {
  const stars = parseDonatePayload(p.invoice_payload);
  if (p.currency !== 'XTR' || !stars) return;
  const r = await h.d.prepare('INSERT OR IGNORE INTO donations (telegram_id, stars, charge_id, created_at, name) VALUES (?, ?, ?, ?, ?)').bind(h.uid, p.total_amount, p.telegram_payment_charge_id, h.now, donorName(first)).run();
  if (!(r.meta?.changes ?? 0)) return;
  const shown = (await db.getSettings(h.d, h.uid)).donor_top !== '0';
  await say(h, `💛 Спасибо за поддержку — <b>${p.total_amount} ⭐</b>! Это правда помогает развивать бота.\n\n${shown ? 'Твоё имя из Telegram появится в бегущей строке «Топ поддержки» в приложении.' : 'В «Топе поддержки» ты скрыт.'}`, [[donorTopButton(shown)]]);
  await h.tg.sendMessage(Number(h.env.ADMIN_TELEGRAM_ID), `💛 Пожертвование: <b>${p.total_amount} ⭐</b> от <code>${h.uid}</code>`).catch(() => undefined);
}

function donorTopButton(shown: boolean) {
  return shown ? { text: '🙈 Скрыть меня в топе', callback_data: 'dt:off' } : { text: '👀 Показывать меня в топе', callback_data: 'dt:on' };
}
