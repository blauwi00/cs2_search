import * as db from '../storage/db.ts';
import { listJobs } from '../core/scheduler.ts';
import { esc, type Keyboard } from './api.ts';
import { SETTINGS_META, displayValue } from './settings.ts';
import { formatUah, formatBp } from '../utils/money.ts';
import { ago } from '../utils/time.ts';
import { SOURCE_RU } from './messages.ts';
import { classifyLiquidity, LIQUIDITY_RU } from '../core/liquidity.ts';
import { stats } from '../core/analyzer.ts';
import { backtest } from '../core/quality.ts';
import { PRIORITY_RU, CATEGORY_SIGNAL_RU } from '../core/scoring.ts';
import { parseMarketHashName, CATEGORY_RU } from '../core/normalization.ts';
import { FEE_REGISTRY } from '../core/fees.ts';
import { steamListingUrl } from '../utils/http.ts';

export interface View { text: string; keyboard: Keyboard }
const back: Keyboard[number] = [{ text: '⬅️ Меню', callback_data: 'm' }];

const STATUS_RU: Record<string, string> = {
  ok: '✅ работает', degraded: '⚠️ ошибки', down: '❌ недоступен', disabled: '⏸ выключен', rate_limited: '⏳ лимит запросов',
};

export async function mainMenu(d: D1Database, now: number): Promise<View> {
  const jobs = await listJobs(d);
  const sources = await db.listSourceStatus(d);
  const watched = await db.countActiveWatched(d);
  const lastRun = Math.max(0, ...jobs.map((j) => j.last_run_at ?? 0));
  const priceSources = sources.filter((s) => s.source === 'steam' || s.source === 'skinport' || s.source === 'csfloat');
  const lastOk = Math.max(0, ...priceSources.map((s) => s.last_ok_at ?? 0));
  const okSources = priceSources.filter((s) => s.status === 'ok').length;
  const cronAlive = lastRun > 0 && now - lastRun < 300;
  const text = [
    '<b>CS2 Market Bot</b>', '',
    `Мониторинг: ${cronAlive ? 'активен' : lastRun ? `⚠️ планировщик не запускался ${ago(lastRun, now)}` : 'ещё не запускался'}`,
    `Источников цен работает: ${okSources} из ${priceSources.length}`,
    `Предметов отслеживается: ${watched}`,
    `Последняя проверка цен: ${ago(lastOk || null, now)}`,
    '', '<i>Валюта: гривна. Бот только анализирует — ничего не покупает и не продаёт.</i>',
  ].join('\n');
  const keyboard: Keyboard = [
    [{ text: '💰 Выгодные сделки', callback_data: 'm:deals' }, { text: '👁 Мониторинг цен', callback_data: 'm:watch' }],
    [{ text: '📦 Кейсы', callback_data: 'm:cases' }, { text: '🎒 Мой инвентарь', callback_data: 'm:inv' }],
    [{ text: '📈 Аналитика', callback_data: 'm:an' }, { text: '🧾 История сделок', callback_data: 'm:trades' }],
    [{ text: '⚙️ Настройки', callback_data: 'm:set' }, { text: '🩺 Состояние системы', callback_data: 'm:status' }],
  ];
  return { text, keyboard };
}

const DEAL_SRC = [{ v: 'all', t: 'все площадки' }, { v: 'skinport', t: 'Skinport' }, { v: 'csfloat', t: 'CSFloat' }];
const DEAL_CAT = [{ v: 'all', t: 'все категории' }, { v: 'case', t: 'кейсы' }, { v: 'capsule', t: 'капсулы' }, { v: 'weapon', t: 'оружие' },
  { v: 'sticker', t: 'наклейки' }, { v: 'knife', t: 'ножи' }, { v: 'gloves', t: 'перчатки' }, { v: 'other', t: 'другое' }];
export const cycle = (list: { v: string }[], cur: string) => list[(list.findIndex((x) => x.v === cur) + 1) % list.length].v;

export async function dealsView(d: D1Database, now: number, order: 'spread' | 'roi' | 'priority', tid: number): Promise<View> {
  const s = await db.getSettings(d, tid);
  const all = await db.activeSignals(d, order, 60, now - 2 * 3600);
  const budget = db.num(s.budget_kop), maxBuy = db.num(s.max_buy_kop);
  const rows = all.filter((r) => {
    if (s.deals_src !== 'all' && r.buy_source !== s.deals_src) return false;
    if (s.deals_cat !== 'all' && parseMarketHashName(r.market_hash_name).category !== s.deals_cat) return false;
    if (s.deals_budget === '1' && ((budget && (r.buy_kop ?? 0) > budget) || (maxBuy && (r.buy_kop ?? 0) > maxBuy))) return false;
    if (s.deals_liq === '1') {
      const liq = (JSON.parse(r.snapshot_json) as { liquidity?: { cls?: string } }).liquidity?.cls;
      if (liq !== 'high' && liq !== 'medium') return false;
    }
    return true;
  }).slice(0, 10);
  const lines = ['<b>💰 Выгодные сделки</b> (покупка на внешней площадке → продажа в Steam)', ''];
  const filt = [DEAL_SRC.find((x) => x.v === s.deals_src)?.t, DEAL_CAT.find((x) => x.v === s.deals_cat)?.t,
    s.deals_budget === '1' ? 'в пределах бюджета' : null, s.deals_liq === '1' ? 'без низкой ликвидности' : null].filter(Boolean).join(', ');
  lines.push(`Фильтр: ${filt}`, '');
  if (rows.length === 0) {
    lines.push(all.length ? 'Под фильтр ничего не подходит.' : 'Сейчас активных возможностей нет.', '',
      'Возможности появляются, когда у предметов из списка наблюдения есть свежие цены и Steam, и Skinport/CSFloat.');
  }
  const kb: Keyboard = [];
  rows.forEach((r, i) => {
    lines.push(`${i + 1}. <b>${esc(r.market_hash_name)}</b>`,
      `   ${SOURCE_RU[r.buy_source ?? ''] ?? r.buy_source}: ${formatUah(r.buy_kop)} → Steam: ${formatUah(r.proceeds_kop)} на баланс`,
      `   Разница ${formatUah(r.spread_kop)} (${formatBp(r.roi_bp)}), приоритет ${PRIORITY_RU[r.priority as 'high'] ?? r.priority}${r.state === 'unconfirmed' ? ', <i>не подтверждено</i>' : ''}`);
    kb.push([{ text: `${i + 1}. ${r.market_hash_name.slice(0, 40)}`, callback_data: `d:${r.id}` }]);
  });
  kb.push([
    { text: order === 'spread' ? '• по сумме' : 'по сумме', callback_data: 'm:deals:spread' },
    { text: order === 'roi' ? '• по %' : 'по %', callback_data: 'm:deals:roi' },
    { text: order === 'priority' ? '• по качеству' : 'по качеству', callback_data: 'm:deals:priority' },
  ]);
  kb.push([{ text: `Площадка: ${DEAL_SRC.find((x) => x.v === s.deals_src)?.t}`, callback_data: `df:src:${order}` },
    { text: `Категория: ${DEAL_CAT.find((x) => x.v === s.deals_cat)?.t}`, callback_data: `df:cat:${order}` }]);
  kb.push([{ text: s.deals_budget === '1' ? '✅ В пределах бюджета' : 'В пределах бюджета', callback_data: `df:bud:${order}` },
    { text: s.deals_liq === '1' ? '✅ Без низкой ликвидности' : 'Без низкой ликвидности', callback_data: `df:liq:${order}` }]);
  kb.push(back);
  return { text: lines.join('\n'), keyboard: kb };
}

export async function toggleDealFilter(d: D1Database, tid: number, which: string, now: number): Promise<void> {
  const s = await db.getSettings(d, tid);
  if (which === 'src') await db.setSetting(d, tid, 'deals_src', cycle(DEAL_SRC, s.deals_src), now);
  if (which === 'cat') await db.setSetting(d, tid, 'deals_cat', cycle(DEAL_CAT, s.deals_cat), now);
  if (which === 'bud') await db.setSetting(d, tid, 'deals_budget', s.deals_budget === '1' ? '0' : '1', now);
  if (which === 'liq') await db.setSetting(d, tid, 'deals_liq', s.deals_liq === '1' ? '0' : '1', now);
}

/** Кейсы и капсулы: изменение цены за 7 и 30 дней по накопленной истории, с честной пометкой о нехватке данных. */
export async function casesView(d: D1Database, tid: number, now: number, sort: 'name' | 'up' | 'down'): Promise<View> {
  const watched = (await db.listWatch(d, tid)).filter((w) => w.category === 'case' || w.category === 'capsule');
  const lines = ['<b>📦 Кейсы и капсулы</b>', ''];
  const kb: Keyboard = [];
  if (watched.length === 0) {
    lines.push('Кейсов в наблюдении нет. Нажми «Добавить кейс» и напиши, например, <code>case</code> или <code>capsule</code>.');
  } else {
    const ids = watched.map((w) => w.item_id).slice(0, 90);
    const hist = (await d.prepare(
      `SELECT item_id, observed_at, price_kop, volume, price_type FROM price_snapshots
       WHERE source = 'steam' AND price_type IN ('lowest_listing','median_24h') AND observed_at >= ? AND item_id IN (${ids.map(() => '?').join(',')})
       ORDER BY observed_at`,
    ).bind(now - 30 * 86400, ...ids).all<{ item_id: number; observed_at: number; price_kop: number | null; volume: number | null; price_type: string }>()).results;
    type Row = { w: (typeof watched)[number]; cur: number | null; ch7: number | null; ch30: number | null; span: number; volNow: number | null; vol7: number | null };
    const rows: Row[] = watched.map((w) => {
      const pts = hist.filter((h) => h.item_id === w.item_id && h.price_type === 'lowest_listing' && h.price_kop !== null);
      const med = hist.filter((h) => h.item_id === w.item_id && h.price_type === 'median_24h');
      const cur = pts.at(-1)?.price_kop ?? null;
      const at = (sec: number) => { const t = now - sec; const p = [...pts].reverse().find((x) => x.observed_at <= t); return p && t - p.observed_at < sec * 0.5 ? p.price_kop : null; };
      const pct = (old: number | null) => (old && cur ? Math.trunc(((cur - old) * 10000) / old) : null);
      const volAt = (sec: number) => { const t = now - sec; const p = [...med].reverse().find((x) => x.observed_at <= t); return p?.volume ?? null; };
      return { w, cur, ch7: pct(at(7 * 86400)), ch30: pct(at(30 * 86400)), span: pts.length ? (now - pts[0].observed_at) / 86400 : 0, volNow: med.at(-1)?.volume ?? null, vol7: volAt(7 * 86400) };
    });
    if (sort === 'up') rows.sort((a, b) => (b.ch7 ?? -1e9) - (a.ch7 ?? -1e9));
    if (sort === 'down') rows.sort((a, b) => (a.ch7 ?? 1e9) - (b.ch7 ?? 1e9));
    for (const r of rows.slice(0, 20)) {
      const ch = (v: number | null, days: number) => (v === null ? `${days} дн: мало данных` : `${days} дн: ${formatBp(v)}`);
      let note = '';
      if (r.ch7 !== null && r.ch7 > 0 && r.volNow !== null && r.vol7 !== null && r.volNow < r.vol7 * 0.7) note = ' ⚠️ цена растёт, а продаж меньше — рост может быть неустойчивым';
      lines.push(`<b>${esc(r.w.market_hash_name)}</b>`, `   ${formatUah(r.cur)} · ${ch(r.ch7, 7)} · ${ch(r.ch30, 30)}${r.volNow !== null ? ` · продаж/24ч: ${r.volNow}` : ''}${note}`);
      kb.push([{ text: r.w.market_hash_name.slice(0, 50), callback_data: `w:${r.w.id}` }]);
    }
    lines.push('', '<i>Статус кейса (в дропе / снят) бот не определяет: надёжного бесплатного источника нет. Открывать кейсы ради прибыли бот не рекомендует.</i>');
  }
  kb.push([{ text: sort === 'up' ? '• подорожавшие' : 'подорожавшие', callback_data: 'm:cases:up' }, { text: sort === 'down' ? '• подешевевшие' : 'подешевевшие', callback_data: 'm:cases:down' }]);
  kb.push([{ text: '➕ Добавить кейс', callback_data: 'wa' }]);
  kb.push(back);
  return { text: lines.join('\n'), keyboard: kb };
}

export async function dealCard(d: D1Database, id: number, now: number): Promise<View> {
  const s = await db.getSignal(d, id);
  if (!s) return { text: 'Сигнал не найден.', keyboard: [back] };
  const item = await db.getItem(d, s.item_id);
  const name = item?.market_hash_name ?? '?';
  const snap = JSON.parse(s.snapshot_json) as { arb?: { sellReferenceBasis?: string; downside?: { dropBp: number; spreadKop: number }[] }; buy?: { url?: string }; reasons?: string[] };
  const lines = [
    `<b>${esc(name)}</b>`, '',
    `Тип: ${CATEGORY_SIGNAL_RU[(s.category ?? 'anomaly') as 'anomaly'] ?? s.category}`,
    `Состояние: ${s.state}`,
    `Покупка (${SOURCE_RU[s.buy_source ?? ''] ?? s.buy_source}): ${formatUah(s.buy_kop)}`,
    `Цена покупателя в Steam: ${formatUah(s.sell_kop)}${snap.arb?.sellReferenceBasis ? ` — ${esc(snap.arb.sellReferenceBasis)}` : ''}`,
    `На баланс Steam после комиссий: ${formatUah(s.proceeds_kop)}`,
    `Разница: ${formatUah(s.spread_kop)} (${formatBp(s.roi_bp)}) — баланс Steam, не наличные`,
    ...(snap.arb?.downside ?? []).map((x) => `При падении цены на ${x.dropBp / 100}%: ${formatUah(x.spreadKop)}`),
    `Приоритет: ${PRIORITY_RU[s.priority as 'high'] ?? s.priority}`,
    ...(snap.reasons?.length ? [`Причины: ${esc(snap.reasons.join('; '))}`] : []),
    `Обнаружено: ${ago(s.detected_at, now)}, обновлено: ${ago(s.updated_at, now)}`,
  ];
  const kb: Keyboard = [[{ text: 'Открыть Steam Market', url: steamListingUrl(name) }]];
  if (snap.buy?.url && /^https:\/\/(skinport\.com|csfloat\.com)\//.test(snap.buy.url)) kb[0].unshift({ text: 'Открыть покупку', url: snap.buy.url });
  kb.push([{ text: '✅ Купил', callback_data: `bs:${s.id}` }, { text: 'История цены', callback_data: `ch:${s.id}` }]);
  kb.push([{ text: 'Скрыть', callback_data: `dh:${s.id}` }, { text: '⬅️ К сделкам', callback_data: 'm:deals' }]);
  return { text: lines.join('\n'), keyboard: kb };
}

export async function watchView(d: D1Database, tid: number, onlyCases = false): Promise<View> {
  const all = await db.listWatch(d, tid);
  const rows = onlyCases ? all.filter((w) => w.category === 'case' || w.category === 'capsule') : all;
  const title = onlyCases ? '<b>📦 Кейсы и капсулы в наблюдении</b>' : '<b>👁 Мониторинг цен</b>';
  const lines = [title, ''];
  if (rows.length === 0) lines.push(onlyCases ? 'Кейсов в наблюдении нет. Добавь через поиск — например, напиши «case».' : 'Список пуст. Нажми «Добавить предмет» и напиши часть названия на английском (как в Steam).');
  else lines.push(`Предметов: ${rows.length}. Нажми на предмет, чтобы увидеть цены и историю.`);
  const kb: Keyboard = rows.slice(0, 40).map((w) => [{ text: `${w.target_buy_kop ? '🎯 ' : ''}${w.market_hash_name.slice(0, 50)}`, callback_data: `w:${w.id}` }]);
  kb.push([{ text: '➕ Добавить предмет', callback_data: 'wa' }]);
  kb.push(back);
  return { text: lines.join('\n'), keyboard: kb };
}

export async function watchCard(d: D1Database, tid: number, id: number, now: number): Promise<View> {
  const w = await db.getWatch(d, tid, id);
  if (!w) return { text: 'Предмет не найден в списке наблюдения.', keyboard: [back] };
  const quotes = await db.getQuotes(d, w.item_id);
  const q = (s: string, t: string) => quotes.find((x) => x.source === s && x.price_type === t);
  const p = parseMarketHashName(w.market_hash_name);
  const lines = [`<b>${esc(w.market_hash_name)}</b>`, `Категория: ${CATEGORY_RU[p.category]}${p.stattrak ? ', StatTrak™' : ''}${p.souvenir ? ', Souvenir' : ''}`];
  if (p.uniquePriced) lines.push('⚠️ Цена зависит от экземпляра (паттерн/фаза/float) — общие цены для него ориентировочные.');
  lines.push('');
  const line = (label: string, r: db.QuoteRow | undefined, extra = '') => {
    if (!r) return `${label}: нет данных`;
    const orig = r.currency !== 'UAH' && r.price_minor !== null ? ` (${(r.price_minor / 100).toFixed(2)} ${r.currency})` : '';
    const price = r.price_minor === null ? (r.quantity === 0 ? 'нет предложений' : 'неизвестно') : `${formatUah(r.price_kop)}${orig}`;
    return `${label}: ${price}${extra}, ${ago(r.fetched_at, now)}`;
  };
  const sl = q('steam', 'lowest_listing');
  const sm = q('steam', 'median_24h');
  const spl = q('skinport', 'lowest_listing');
  const sps = q('skinport', 'sale_median_7d');
  lines.push(line('Steam, самое дешёвое объявление', sl));
  lines.push(line('Steam, медиана продаж 24 ч', sm, sm?.volume !== null && sm?.volume !== undefined ? `, продаж: ${sm.volume}` : ''));
  lines.push(line('Skinport, самое дешёвое объявление', spl, spl?.quantity !== null && spl?.quantity !== undefined ? `, объявлений: ${spl.quantity}` : ''));
  lines.push(line('Skinport, медиана продаж 7 дн', sps, sps?.volume !== null && sps?.volume !== undefined ? `, продаж: ${sps.volume}` : ''));
  const cf = q('csfloat', 'listing');
  if (cf) lines.push(line('CSFloat, самое дешёвое объявление', cf));
  const liq = classifyLiquidity({ steamSales24h: sm?.volume ?? null, skinportSales7d: sps?.volume ?? null, activeListings: null });
  lines.push('', `Ликвидность: ${LIQUIDITY_RU[liq.cls]} (${liq.basis})`);
  if (w.target_buy_kop) lines.push(`🎯 Целевая цена покупки в Steam: ${formatUah(w.target_buy_kop)}`);

  const hist = await db.history(d, w.item_id, 'steam', 'lowest_listing', now - 30 * 86400);
  const st = stats(hist.map((h) => ({ at: h.observed_at, minor: h.price_minor, currency: h.currency, volume: h.volume })));
  lines.push('', '<b>История (Steam, самое дешёвое объявление)</b>');
  if (!st || st.count < 2) lines.push('Данных пока мало — история накапливается с момента добавления.');
  else {
    lines.push(`Период данных: ${st.spanDays.toFixed(1).replace('.', ',')} дн (запрошено 30 дн${st.spanDays < 29 ? ' — данных меньше' : ''}), точек: ${st.count}`);
    lines.push(`Мин ${formatUah(st.min)} · Медиана ${formatUah(st.median)} · Макс ${formatUah(st.max)}`);
    lines.push(`Волатильность: ${formatBp(st.volatilityBp).replace('+', '')}`);
  }
  const kb: Keyboard = [
    [{ text: 'Открыть Steam Market', url: steamListingUrl(w.market_hash_name) }, { text: '📈 График', callback_data: `chi:${w.item_id}` }],
    [{ text: '🎯 Целевая цена', callback_data: `wt:${w.id}` }, ...(w.target_buy_kop ? [{ text: 'Убрать цель', callback_data: `wtc:${w.id}` }] : [])],
    [{ text: '🧪 Проверить на истории', callback_data: `bt:${w.item_id}` }],
    [{ text: '🗑 Удалить из наблюдения', callback_data: `wr:${w.id}` }],
    [{ text: '⬅️ К списку', callback_data: 'm:watch' }],
  ];
  return { text: lines.join('\n'), keyboard: kb };
}

export async function settingsView(d: D1Database, tid: number): Promise<View> {
  const s = await db.getSettings(d, tid);
  const lines = ['<b>⚙️ Настройки</b>', 'Все суммы — в гривнах. Нажми на параметр, чтобы изменить.', ''];
  const kb: Keyboard = [];
  for (const m of SETTINGS_META) {
    lines.push(`${m.label}: <b>${displayValue(m, s)}</b>`);
    kb.push([{ text: `${m.label}: ${displayValue(m, s)}`, callback_data: `s:${m.key}` }]);
  }
  lines.push('', '<i>Валюта зафиксирована: UAH. Курсы — НБУ.</i>');
  kb.push(back);
  return { text: lines.join('\n'), keyboard: kb };
}

export async function statusView(d: D1Database, now: number, csfloatKey: boolean, collector = false): Promise<View> {
  const jobs = await listJobs(d);
  const sources = await db.listSourceStatus(d);
  const c = await db.counters(d, now);
  const fx = await db.loadLatestFx(d);
  const errs = await db.recentErrors(d, 3);
  const lastRun = Math.max(0, ...jobs.map((j) => j.last_run_at ?? 0));
  const lines = ['<b>🩺 Состояние системы</b>', ''];
  lines.push(`Worker: ✅ отвечает (это сообщение сформировано им)`);
  lines.push(`Cron: ${lastRun && now - lastRun < 300 ? `✅ последний запуск ${ago(lastRun, now)}` : `❌ не запускался ${ago(lastRun || null, now)} — проверь Cron Trigger`}`);
  lines.push('', '<b>Источники</b>');
  const known = new Set(sources.map((s) => s.source));
  for (const s of sources) {
    lines.push(`${SOURCE_RU[s.source] ?? s.source}: ${STATUS_RU[s.status] ?? s.status}`);
    if (s.disabled_reason) lines.push(`   ${esc(s.disabled_reason)}`);
    lines.push(`   успех: ${ago(s.last_ok_at, now)}${s.last_error && s.status !== 'ok' ? `; ошибка: ${esc(s.last_error)} (${ago(s.last_error_at, now)})` : ''}`);
    lines.push(`   запросов сегодня: ${s.requests_today ?? 0}`);
  }
  if (!known.has('csfloat') && !csfloatKey) lines.push('CSFloat: ⏸ требуется API-ключ');
  lines.push('', '<b>Курсы НБУ</b>');
  if (fx.size === 0) lines.push('ещё не загружены');
  for (const [b, r] of fx) lines.push(`1 ${b} = ${(r.rateMicro / 1e6).toFixed(4).replace('.', ',')} грн (курс на ${r.rateDate})`);
  lines.push('', '<b>Задачи</b>');
  if (collector) lines.push('<i>Steam и Skinport блокируют сеть Cloudflare, поэтому их опрашивает GitHub Actions (сборщик) — задачи steam/skinport в Worker не запускаются.</i>');
  for (const j of jobs) {
    if (collector && (j.name === 'steam' || j.name === 'skinport_items' || j.name === 'skinport_sales')) continue;
    const st = j.enabled !== 1 ? '⏸ выключена' : j.fail_count > 0 ? `⚠️ ошибок подряд: ${j.fail_count}` : '✅';
    lines.push(`${j.name}: ${st}, след. запуск ${j.next_run_at > now ? `через ${Math.ceil((j.next_run_at - now) / 60)} мин` : 'сейчас'}`);
    if (j.last_error && (j.enabled !== 1 || j.fail_count > 0)) lines.push(`   ${esc(j.last_error)}`);
  }
  lines.push('', '<b>Сегодня (UTC)</b>');
  lines.push(`Внешних запросов: ${c.ext_requests ?? 0}; снимков цен: ${c.snapshots ?? 0}; уведомлений: ${c.notifications ?? 0}`);
  lines.push('<i>Лимиты бесплатного тарифа: 100 000 вызовов Worker/день, 50 запросов к D1 и 50 внешних запросов за вызов — бот сам распределяет работу между запусками.</i>');
  if (errs.length) {
    lines.push('', '<b>Последние ошибки</b>');
    for (const e of errs) lines.push(`• ${ago(e.at, now)} ${esc(e.source ?? '')}: ${esc(e.message.slice(0, 120))}`);
  }
  lines.push('', '<b>Комиссии</b>');
  for (const f of Object.values(FEE_REGISTRY)) lines.push(`• ${SOURCE_RU[f.source] ?? f.source}: ${esc(f.note)}`);
  const kb: Keyboard = [[{ text: '🔄 Обновить', callback_data: 'm:status' }], back];
  if (jobs.some((j) => j.enabled !== 1)) kb.unshift([{ text: 'Включить отключённые задачи', callback_data: 'jobs:enable' }]);
  return { text: lines.join('\n'), keyboard: kb };
}

export async function analyticsView(d: D1Database, now: number): Promise<View> {
  const r = await d.prepare(
    `SELECT kind, state, COUNT(*) AS n, AVG(spread_kop) AS avg_spread FROM signals WHERE detected_at >= ? GROUP BY kind, state`,
  ).bind(now - 7 * 86400).all<{ kind: string; state: string; n: number; avg_spread: number | null }>();
  const q = (await d.prepare(
    `SELECT s.category, q.outcome, COUNT(*) AS n, AVG(q.spread_later_kop) AS later FROM signal_quality q JOIN signals s ON s.id = q.signal_id
     WHERE q.checked_at >= ? GROUP BY s.category, q.outcome`,
  ).bind(now - 30 * 86400).all<{ category: string | null; outcome: string; n: number; later: number | null }>()).results;
  const real = (await d.prepare(
    `SELECT s.spread_kop AS expected, t.quantity, ts.quantity AS sold, ts.received_kop, t.buy_price_kop, t.buy_fee_kop
     FROM trades t JOIN signals s ON s.id = t.signal_id JOIN trade_sales ts ON ts.trade_id = t.id LIMIT 200`,
  ).all<{ expected: number | null; quantity: number; sold: number; received_kop: number; buy_price_kop: number; buy_fee_kop: number }>()).results;
  const vol = (await d.prepare(
    `SELECT i.market_hash_name, i.volatility_bp FROM items i WHERE i.volatility_bp IS NOT NULL
       AND i.id IN (SELECT item_id FROM watchlist WHERE active = 1) ORDER BY i.volatility_bp DESC LIMIT 5`,
  ).all<{ market_hash_name: string; volatility_bp: number }>()).results;
  const watched = await db.countActiveWatched(d);
  const by = (k: string, st?: string) => r.results.filter((x) => x.kind === k && (!st || x.state === st)).reduce((s, x) => s + x.n, 0);
  const arbAll = r.results.filter((x) => x.kind === 'arbitrage_steam');
  const avg = arbAll.length ? arbAll.reduce((s, x) => s + (x.avg_spread ?? 0) * x.n, 0) / Math.max(1, arbAll.reduce((s, x) => s + x.n, 0)) : null;
  const lines = [
    '<b>📈 Аналитика</b> (результаты сканера, не твои сделки)', '',
    '<b>За 7 дней</b>',
    `Активных наблюдений: ${watched}`,
    `Арбитражных возможностей: ${by('arbitrage_steam')}`,
    `• подтверждено/отправлено: ${by('arbitrage_steam', 'confirmed') + by('arbitrage_steam', 'notified')}`,
    `• не подтверждено (данные не свежие): ${by('arbitrage_steam', 'unconfirmed')}`,
    `• исчезло/неактуально: ${by('arbitrage_steam', 'expired')}`,
    `• скрыто тобой: ${by('arbitrage_steam', 'dismissed')}`,
    `Средняя потенциальная разница: ${avg === null ? '—' : formatUah(Math.round(avg))}`,
    `Сигналов изменения цены: ${by('price_drop') + by('price_rise')}`,
  ];
  const tot = q.reduce((s, x) => s + x.n, 0);
  lines.push('', '<b>Качество сигналов</b> (через 24 ч после обнаружения, за 30 дней)');
  if (tot === 0) lines.push('Пока нет проверенных сигналов: проверка идёт через сутки после обнаружения.');
  else {
    const n = (o: string) => q.filter((x) => x.outcome === o).reduce((s, x) => s + x.n, 0);
    const checked = n('held') + n('reversed');
    lines.push(`Проверено: ${tot}; выгода сохранилась: ${n('held')}${checked ? ` (${Math.round((n('held') * 100) / checked)}%)` : ''}; стала убытком: ${n('reversed')}; не хватило данных: ${n('no_data')}`);
    const cats = [...new Set(q.map((x) => x.category ?? '—'))];
    for (const c of cats) {
      const h = q.filter((x) => (x.category ?? '—') === c && x.outcome === 'held').reduce((s, x) => s + x.n, 0);
      const rv = q.filter((x) => (x.category ?? '—') === c && x.outcome === 'reversed').reduce((s, x) => s + x.n, 0);
      if (h + rv) lines.push(`• ${CATEGORY_SIGNAL_RU[c as 'anomaly'] ?? c}: ${Math.round((h * 100) / (h + rv))}% сохранили выгоду (${h + rv})`);
    }
    if (tot < 20) lines.push('<i>Выборка маленькая — выводы делать рано.</i>');
  }
  if (real.length) {
    let diff = 0, nn = 0;
    for (const x of real) {
      if (x.expected === null) continue;
      const cost = x.buy_price_kop * x.sold + Math.round((x.buy_fee_kop * x.sold) / x.quantity);
      diff += (x.received_kop - cost) / x.sold - x.expected;
      nn++;
    }
    if (nn) lines.push('', `<b>Твои сделки по сигналам:</b> ${nn}; реальный результат отличался от расчёта в среднем на ${formatUah(Math.round(diff / nn))} за 1 шт.`);
  }
  if (vol.length) {
    lines.push('', '<b>Самые волатильные за 7 дней</b> (размах цены Steam)');
    for (const v of vol) lines.push(`• ${esc(v.market_hash_name)}: ${formatBp(v.volatility_bp).replace('+', '')}`);
  }
  lines.push('', '<i>Проверка правил на истории — в карточке предмета: кнопка «🧪 Проверить на истории».</i>');
  return { text: lines.join('\n'), keyboard: [back] };
}

export async function backtestView(d: D1Database, tid: number, itemId: number, now: number): Promise<View> {
  const item = await db.getItem(d, itemId);
  if (!item) return { text: 'Предмет не найден.', keyboard: [back] };
  const s = await db.getSettings(d, tid);
  const rows = (await d.prepare(
    `SELECT source, price_type, observed_at, price_kop FROM price_snapshots WHERE item_id = ? AND observed_at >= ?
     AND ((source = 'steam' AND price_type IN ('lowest_listing','median_24h')) OR (source = 'skinport' AND price_type = 'lowest_listing'))
     ORDER BY observed_at LIMIT 3000`,
  ).bind(itemId, now - 30 * 86400).all<{ source: string; price_type: string; observed_at: number; price_kop: number | null }>()).results;
  const ser = (src: string, t: string) => rows.filter((r) => r.source === src && r.price_type === t).map((r) => ({ t: r.observed_at, v: r.price_kop }));
  const res = backtest(ser('skinport', 'lowest_listing'), ser('steam', 'lowest_listing'), ser('steam', 'median_24h'), {
    minProfitKop: db.num(s.min_profit_kop), minRoiBp: db.num(s.min_roi_bp), horizonSec: 24 * 3600, maxAgeSec: 2 * 3600, cooldownSec: 6 * 3600,
  });
  const lines = [
    `🧪 <b>Проверка на истории</b>: ${esc(item.market_hash_name)}`, '',
    'Правило: покупка на Skinport → продажа в Steam, твои пороги прибыли; итог оценивается через 24 ч.',
    'В каждый момент используются только данные, известные на тот момент.', '',
    `Период данных: ${res.spanDays.toFixed(1).replace('.', ',')} дн, точек: ${res.decisions}`,
    `Правило сработало бы: ${res.signals} раз`,
    `• выгода сохранилась через 24 ч: ${res.held}`,
    `• стала убытком: ${res.reversed}`,
    `• не хватило данных: ${res.noData}`,
    `Средняя разница в момент сигнала: ${formatUah(res.avgSpreadAtSignalKop)}; через 24 ч: ${formatUah(res.avgSpreadAfterKop)}`,
  ];
  if (res.spanDays < 7) lines.push('', '<i>Истории меньше недели — результат почти ничего не значит.</i>');
  lines.push('<i>Не учитывает комиссии платёжных методов и то, что объявление могли купить раньше тебя.</i>');
  return { text: lines.join('\n'), keyboard: [[{ text: '⬅️ Назад', callback_data: 'm:watch' }]] };
}
