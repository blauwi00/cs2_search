import type { Env } from '../env.ts';
import * as db from '../storage/db.ts';
import { budgetedDb, newBudget } from '../storage/budget.ts';
import { setJobEnabled, listJobs } from '../core/scheduler.ts';
import { TelegramClient, esc, type Keyboard } from './api.ts';
import * as M from './menus.ts';
import { metaFor, parseSettingInput, nextChoice } from './settings.ts';
import { searchSteam, type SearchHit } from '../api/steam.ts';
import { SourceError } from '../types/market.ts';
import { parseUahInput, formatUah } from '../utils/money.ts';
import { runDemo } from '../demo.ts';
import type { Fetcher } from '../utils/http.ts';
import { say, show, type H } from './context.ts';
import * as INV from './inventory.ts';
import { parseMarketHashName } from '../core/normalization.ts';
import { chartUrl } from '../chart.ts';

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

interface TgUser { id: number }
interface TgMessage { message_id: number; from?: TgUser; chat: { id: number; type: string }; text?: string }
interface TgCallback { id: string; from: TgUser; data?: string; message?: TgMessage }
interface TgUpdate { update_id: number; message?: TgMessage; callback_query?: TgCallback }

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

  const adminId = Number(env.ADMIN_TELEGRAM_ID);
  const fromId = update.message?.from?.id ?? update.callback_query?.from?.id;
  // Чужие пользователи игнорируются молча (200, чтобы Telegram не повторял доставку).
  if (!Number.isSafeInteger(adminId) || fromId !== adminId) return new Response('ok');
  // Работаем только в личном чате с ботом: chat.id личного чата совпадает с ID пользователя.
  const chatId = update.message?.chat.id ?? update.callback_query?.message?.chat.id;
  if (chatId !== adminId) return new Response('ok');

  const budget = newBudget();
  const d = budgetedDb(rawDb ?? env.DB, budget);
  const tg = new TelegramClient(env.TELEGRAM_BOT_TOKEN, fetcher);
  try {
    if (update.callback_query) await onCallback(update.callback_query, { env, d, tg, adminId, now, fetcher, origin: new URL(req.url).origin });
    else if (update.message?.text) await onText(update.message.text, { env, d, tg, adminId, now, fetcher, origin: new URL(req.url).origin });
  } catch (e) {
    await db.log(d, 'error', 'telegram', 'handler', (e as Error).message, now);
    try { await tg.sendMessage(adminId, `⚠️ Ошибка обработки команды: ${esc((e as Error).message).slice(0, 300)}`); } catch { /* ignore */ }
  }
  return new Response('ok');
}


async function onText(text: string, h: H): Promise<void> {
  // Добавление списком: /addlist и точные названия, по одному в строке (без поиска в Steam).
  if (/^\/addlist(@\w+)?(\s|$)/i.test(text.trim())) return addList(h, text.trim().replace(/^\/addlist(@\w+)?/i, ''));
  const t = text.trim().slice(0, 200);
  const cmd = t.split(/\s+/)[0].toLowerCase().replace(/@\w+$/, '');
  await db.ensureUser(h.d, h.adminId, true, h.now);
  switch (cmd) {
    case '/start': case '/menu': await db.clearState(h.d, h.adminId); return show(h, await M.mainMenu(h.d, h.now));
    case '/status': return show(h, await M.statusView(h.d, h.now, !!h.env.CSFLOAT_API_KEY, h.env.COLLECTOR === 'github'));
    case '/deals': return show(h, await M.dealsView(h.d, h.now, 'spread', h.adminId));
    case '/cases': return show(h, await M.casesView(h.d, h.adminId, h.now, 'name'));
    case '/watch': return show(h, await M.watchView(h.d, h.adminId));
    case '/settings': return show(h, await M.settingsView(h.d, h.adminId));
    case '/demo': return runDemo(h.tg, h.adminId, h.now);
    case '/inv': case '/inventory': await db.clearState(h.d, h.adminId); return show(h, await INV.inventoryView(h));
    case '/trades': return show(h, await INV.tradesView(h));
    case '/add': {
      const q = t.slice(4).trim();
      if (q) return doSearch(h, q);
      await db.setState(h.d, h.adminId, 'search', null, h.now);
      return say(h, 'Напиши часть названия предмета на английском, например: <code>redline</code> или <code>revolution case</code>.');
    }
    case '/help': return say(h, HELP);
  }
  const st = await db.getState(h.d, h.adminId, h.now);
  if (!st) return say(h, 'Не понял. Открой меню: /start', [[{ text: 'Меню', callback_data: 'm' }]]);
  if (await INV.onText(h, st, t)) return;
  if (st.awaiting === 'search') return doSearch(h, t);
  if (st.awaiting === 'addlist') return addList(h, text);
  if (st.awaiting.startsWith('set:')) {
    const m = metaFor(st.awaiting.slice(4));
    if (!m) return;
    const r = parseSettingInput(m, t);
    if (!r.ok) return say(h, `❌ ${r.error}`);
    await db.setSetting(h.d, h.adminId, m.key, r.value, h.now);
    await db.clearState(h.d, h.adminId);
    return show(h, await M.settingsView(h.d, h.adminId));
  }
  if (st.awaiting.startsWith('target:')) {
    const id = Number(st.awaiting.slice(7));
    const kop = parseUahInput(t);
    if (kop === null || kop <= 0) return say(h, '❌ Введи цену в гривнах, например 120 или 120,50');
    await db.setWatchTarget(h.d, h.adminId, id, kop);
    await db.clearState(h.d, h.adminId);
    await h.tg.sendMessage(h.adminId, `🎯 Целевая цена ${formatUah(kop)} сохранена. Уведомлю, когда самое дешёвое объявление в Steam будет не дороже.`);
    return show(h, await M.watchCard(h.d, h.adminId, id, h.now));
  }
}

/** Точные market_hash_name списком. Существование проверится при первом запросе цен (нет данных — запись в журнале). */
export async function addList(h: H, body: string): Promise<void> {
  const names = [...new Set(body.split(/\r?\n/).map((x) => x.trim()).filter((x) => x.length >= 3 && x.length <= 120))].slice(0, 60);
  if (names.length === 0) {
    await db.setState(h.d, h.adminId, 'addlist', null, h.now);
    return say(h, 'Пришли точные названия предметов, каждое с новой строки (как в Steam), например:\n<code>Revolution Case\nFracture Case</code>');
  }
  // Всё одним-двумя batch: по запросу на предмет не хватило бы лимита (50 запросов к D1 за вызов).
  const before = (await h.d.prepare('SELECT COUNT(*) AS n FROM watchlist WHERE telegram_id = ? AND active = 1').bind(h.adminId).first<{ n: number }>())?.n ?? 0;
  const stmts: D1PreparedStatement[] = [];
  for (const n of names) {
    stmts.push(...db.upsertItemStmts(h.d, n, h.now));
    stmts.push(h.d.prepare(
      `INSERT INTO watchlist (telegram_id, item_id, created_at) SELECT ?, id, ? FROM items WHERE market_hash_name = ?
       ON CONFLICT(telegram_id, item_id) DO UPDATE SET active = 1`,
    ).bind(h.adminId, h.now, parseMarketHashName(n).marketHashName));
  }
  for (let i = 0; i < stmts.length; i += 90) await h.d.batch(stmts.slice(i, i + 90));
  const after = (await h.d.prepare('SELECT COUNT(*) AS n FROM watchlist WHERE telegram_id = ? AND active = 1').bind(h.adminId).first<{ n: number }>())?.n ?? 0;
  const added = after - before, existed = names.length - added;
  await db.clearState(h.d, h.adminId);
  return say(h, `✅ Добавлено в наблюдение: ${added}${existed ? `, уже были: ${existed}` : ''}.\nЕсли название написано неточно, Steam вернёт «нет данных» — это будет видно в «Состоянии системы».`);
}

async function doSearch(h: H, query: string): Promise<void> {
  if (query.length < 2) return say(h, 'Слишком короткий запрос.');
  let hits: SearchHit[];
  try {
    hits = await searchSteam(query, h.fetcher);
  } catch (e) {
    const rl = e instanceof SourceError && e.kind === 'rate_limited';
    return say(h, rl
      ? '⏳ Steam временно ограничил поиск (HTTP 429). Попробуй через пару минут.'
      : `⚠️ Поиск в Steam не удался: ${esc((e as Error).message)}`);
  }
  if (hits.length === 0) return say(h, 'Ничего не найдено. Попробуй другое название (на английском, как в Steam).');
  await db.setState(h.d, h.adminId, 'pick', hits.map((x) => x.marketHashName), h.now);
  const kb: Keyboard = hits.map((x, i) => [{ text: `${x.marketHashName.slice(0, 55)}${x.sellListings !== null ? ` (${x.sellListings})` : ''}`, callback_data: `wp:${i}` }]);
  kb.push([{ text: 'Отмена', callback_data: 'm:watch' }]);
  await h.tg.sendMessage(h.adminId, 'Выбери точный вариант (в скобках — число объявлений в Steam):', kb);
}

async function onCallback(cb: TgCallback, h: H): Promise<void> {
  const data = (cb.data ?? '').slice(0, 64);
  const msgId = cb.message?.message_id;
  await h.tg.answerCallback(cb.id).catch(() => undefined);
  const [a, b, c] = data.split(':');
  const idArg = Number(b);

  if (data === 'm') { await db.clearState(h.d, h.adminId); return show(h, await M.mainMenu(h.d, h.now), msgId); }
  if (a === 'm') {
    switch (b) {
      case 'deals': return show(h, await M.dealsView(h.d, h.now, c === 'roi' || c === 'priority' ? c : 'spread', h.adminId), msgId);
      case 'watch': await db.clearState(h.d, h.adminId); return show(h, await M.watchView(h.d, h.adminId), msgId);
      case 'cases': return show(h, await M.casesView(h.d, h.adminId, h.now, c === 'up' || c === 'down' ? c : 'name'), msgId);
      case 'set': return show(h, await M.settingsView(h.d, h.adminId), msgId);
      case 'status': return show(h, await M.statusView(h.d, h.now, !!h.env.CSFLOAT_API_KEY, h.env.COLLECTOR === 'github'), msgId);
      case 'an': return show(h, await M.analyticsView(h.d, h.now), msgId);
      case 'inv': await db.clearState(h.d, h.adminId); return show(h, await INV.inventoryView(h), msgId);
      case 'trades': return show(h, await INV.tradesView(h), msgId);
    }
    return;
  }
  if (a === 'bt' && Number.isInteger(idArg)) return show(h, await M.backtestView(h.d, h.adminId, idArg, h.now));
  if (a === 'df') {
    await M.toggleDealFilter(h.d, h.adminId, b, h.now);
    return show(h, await M.dealsView(h.d, h.now, c === 'roi' || c === 'priority' ? c : 'spread', h.adminId), msgId);
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
    await db.setState(h.d, h.adminId, 'search', null, h.now);
    return say(h, 'Напиши часть названия на английском, например: <code>ak-47 redline</code> или <code>fracture case</code>.');
  }
  if (a === 'wp') {
    const st = await db.getState(h.d, h.adminId, h.now);
    const list = st?.awaiting === 'pick' && Array.isArray(st.payload) ? (st.payload as string[]) : [];
    const name = Number.isInteger(idArg) ? list[idArg] : undefined;
    if (!name) return say(h, 'Список устарел, выполни поиск ещё раз.');
    const item = await db.upsertItem(h.d, name, h.now);
    const r = await db.addWatch(h.d, h.adminId, item.id, h.now);
    await db.clearState(h.d, h.adminId);
    await h.tg.sendMessage(h.adminId, r === 'added'
      ? `✅ <b>${esc(name)}</b> добавлен в наблюдение.\nПервые цены появятся в течение нескольких минут (Steam проверяется порциями, Skinport — раз в 10 минут).`
      : `Уже в наблюдении: ${esc(name)}`);
    return show(h, await M.watchView(h.d, h.adminId));
  }
  if (a === 'w' && Number.isInteger(idArg)) return show(h, await M.watchCard(h.d, h.adminId, idArg, h.now), msgId);
  if (a === 'wr' && Number.isInteger(idArg)) { await db.removeWatch(h.d, h.adminId, idArg); return show(h, await M.watchView(h.d, h.adminId), msgId); }
  if (a === 'wt' && Number.isInteger(idArg)) {
    await db.setState(h.d, h.adminId, `target:${idArg}`, null, h.now);
    return say(h, 'Введи целевую цену покупки в Steam в гривнах (например 150):');
  }
  if (a === 'wtc' && Number.isInteger(idArg)) { await db.setWatchTarget(h.d, h.adminId, idArg, null); return show(h, await M.watchCard(h.d, h.adminId, idArg, h.now), msgId); }
  if (a === 'd' && Number.isInteger(idArg)) return show(h, await M.dealCard(h.d, idArg, h.now));
  if (a === 'dh' && Number.isInteger(idArg)) {
    await db.setSignalState(h.d, idArg, 'dismissed', h.now);
    return say(h, 'Скрыто. Этот сигнал больше не будет приходить.');
  }
  if (a === 's' && b) {
    const m = metaFor(b);
    if (!m) return;
    if (m.kind === 'toggle' || m.kind === 'choice') {
      const s = await db.getSettings(h.d, h.adminId);
      await db.setSetting(h.d, h.adminId, m.key, nextChoice(m, s[m.key]), h.now);
      return show(h, await M.settingsView(h.d, h.adminId), msgId);
    }
    await db.setState(h.d, h.adminId, `set:${m.key}`, null, h.now);
    return say(h, `Введи новое значение: <b>${esc(m.label)}</b>${m.hint ? `\n<i>${esc(m.hint)}</i>` : ''}`);
  }
  if (data === 'jobs:enable') {
    for (const j of await listJobs(h.d)) if (j.enabled !== 1) await setJobEnabled(h.d, j.name, true, h.now);
    return show(h, await M.statusView(h.d, h.now, !!h.env.CSFLOAT_API_KEY, h.env.COLLECTOR === 'github'), msgId);
  }
}

const HELP = [
  '<b>Команды</b>',
  '/start — главное меню',
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
