// «Разгон баланса» Steam: подбор безопасных сделок внутри Steam, учёт капитала, симуляция.
// Никаких автоматических покупок/продаж: бот только считает и подсказывает, человек сам подтверждает каждую сделку.
// Все суммы — копейки валюты кошелька (по умолчанию гривна; котировки Steam сборщик берёт в UAH).
import { steamNetKop } from './fees.ts';
import { parseMarketHashName } from './normalization.ts';
import { pumpCheck } from './pump.ts';

// ---------- Настройки ----------
export interface RallySettings {
  startKop: number;        // стартовый баланс Steam (реальный режим)
  simStartKop: number;     // виртуальный баланс симуляции
  maxItemKop: number;      // максимум на одну покупку
  reserveKop: number;      // неснижаемый резерв
  maxPositions: number;    // одновременно открытых позиций
  minProfitKop: number;    // минимальная чистая прибыль на сделку
  minRoiBp: number;        // минимальная доходность
  risk: 'low' | 'medium' | 'high';   // какой максимальный риск показывать среди рекомендованных
  notify: boolean;
  externalKop: number;     // средства на внешних площадках (ручной ввод)
  walletCur: string;       // валюта кошелька Steam
}
export const RALLY_DEFAULTS: RallySettings = {
  startKop: 3000, simStartKop: 3000, maxItemKop: 600, reserveKop: 1800, maxPositions: 2, minProfitKop: 100, minRoiBp: 2500,
  risk: 'low', notify: true, externalKop: 0, walletCur: 'UAH',
};
export const RALLY_KEYS: Record<keyof RallySettings, string> = {
  startKop: 'rally_start', simStartKop: 'rally_sim_start', maxItemKop: 'rally_max_item', reserveKop: 'rally_reserve', maxPositions: 'rally_max_pos',
  minProfitKop: 'rally_min_profit', minRoiBp: 'rally_min_roi', risk: 'rally_risk', notify: 'rally_notify', externalKop: 'rally_external', walletCur: 'rally_cur',
};

export function parseRallySettings(raw: Record<string, string | undefined>): RallySettings {
  const n = (k: keyof RallySettings, min: number, max: number) => {
    const v = Number(raw[RALLY_KEYS[k]]);
    return Number.isSafeInteger(v) && v >= min && v <= max ? v : (RALLY_DEFAULTS[k] as number);
  };
  const risk = raw[RALLY_KEYS.risk];
  return {
    startKop: n('startKop', 0, 1e9), simStartKop: n('simStartKop', 100, 1e9), maxItemKop: n('maxItemKop', 3, 1e9), reserveKop: n('reserveKop', 0, 1e9),
    maxPositions: n('maxPositions', 1, 20), minProfitKop: n('minProfitKop', 1, 1e9), minRoiBp: n('minRoiBp', 0, 100000),
    risk: risk === 'medium' || risk === 'high' ? risk : 'low', notify: raw[RALLY_KEYS.notify] !== '0', externalKop: n('externalKop', 0, 1e10),
    walletCur: /^[A-Z]{3}$/.test(raw[RALLY_KEYS.walletCur] ?? '') ? raw[RALLY_KEYS.walletCur]! : 'UAH',
  };
}

// ---------- Данные кандидатов (их собирает сборщик GitHub) ----------
export interface RallyEntry {
  name: string;
  img?: string | null;
  cur: string;                                     // валюта котировок Steam (UAH)
  sa: { d1: number | null; d7: number | null; d30: number | null; d90: number | null } | null;  // средние продаж, в копейках валюты
  steam: { lowest: number | null; median: number | null; volume: number | null; at: number } | null;
  orders: { buy: number | null; sell: number | null; buyCount: number | null; sellCount: number | null; at: number } | null;
}

export const RALLY_LIVE_MAX_SEC = 3 * 3600;   // котировка Steam для покупки — не старше 3 часов
export const UNLOCK_SEC = 7 * 86400;           // CS2: купленное на Торговой площадке нельзя продать 7 дней (точную дату показывает Steam)
export const NO_DEALS_TEXT = 'Безопасных торговых возможностей по текущим критериям не найдено';

export type Risk = 'low' | 'medium' | 'high' | 'unknown';
export const RISK_RU: Record<Risk, string> = { low: 'низкий', medium: 'средний', high: 'высокий', unknown: 'недостаточно данных' };
const RISK_ORDER: Record<Risk, number> = { low: 0, medium: 1, high: 2, unknown: 3 };

export interface RallyCandidate {
  name: string; img: string | null;
  buyKop: number;            // самое дешёвое объявление сейчас (столько спишется)
  targetKop: number;         // плановая цена продажи после разблокировки (цена покупателя)
  netKop: number;            // придёт на баланс за 1 шт. после комиссии Steam
  profitKop: number;         // чистая прибыль за 1 шт.
  roiBp: number;
  downsideNetKop: number;    // придёт, если цена упадёт на 10%
  volume24h: number | null;
  avg: RallyEntry['sa'];
  medianKop: number | null;
  buyOrderKop: number | null;
  risk: Risk; riskWhy: string[];
  reason: string;
  unlockAt: number;
  dataAt: number;
  confirmed: string[];       // какие значения подтверждены и откуда
}

export interface Track { n: number; hit: number }   // история прогнозов: сколько сделок закрыто и сколько оправдали прогноз

/** Оценка одного предмета. reject — почему не подходит (для честной статистики «отброшено»). */
export function evaluate(e: RallyEntry, s: RallySettings, now: number, track: Track = { n: 0, hit: 0 }): { c: RallyCandidate | null; reject: string | null } {
  if (e.cur !== s.walletCur) return { c: null, reject: `котировки в ${e.cur}, а кошелёк в ${s.walletCur}` };
  if (parseMarketHashName(e.name).uniquePriced) return { c: null, reject: 'цена зависит от паттерна/фазы' };
  const st = e.steam;
  if (!st || st.lowest == null || now - st.at > RALLY_LIVE_MAX_SEC) return { c: null, reject: 'нет свежей цены Steam' };
  const buy = st.lowest;
  if (buy > s.maxItemKop) return { c: null, reject: 'дороже лимита на покупку' };
  const a = e.sa;
  // Плановая цена продажи — консервативно: меньшая из медианы за сутки и средних за 7 и 30 дней, на 1 коп. ниже.
  const refs = [st.median, a?.d7, a?.d30].filter((x): x is number => typeof x === 'number' && x > 0);
  if (refs.length < 2 || !a?.d7 || !a.d30) return { c: null, reject: 'мало истории продаж' };
  const pump = pumpCheck({ d1: a.d1, d30: a.d30, vol24: st.volume, listing: buy, buyOrder: e.orders?.buy ?? null, listings: e.orders?.sellCount ?? null });
  if (pump) return { c: null, reject: 'похоже на разгон цены' };
  const target = Math.min(...refs) - 1;
  const net = steamNetKop(target);
  if (net == null) return { c: null, reject: 'ниже минимальной цены Steam' };
  const profit = net - buy;
  const roi = Math.trunc((profit * 10000) / buy);
  if (profit < s.minProfitKop || roi < s.minRoiBp) return { c: null, reject: 'прибыль после комиссии ниже порога' };
  const downside = steamNetKop(Math.max(3, Math.floor(target * 0.9))) ?? 0;

  // ---------- Риск — только по наблюдаемым данным ----------
  const why: string[] = [];
  let risk: Risk = 'low';
  const bump = (r: Risk, text: string) => { why.push(text); if (RISK_ORDER[r] > RISK_ORDER[risk]) risk = r; };
  const vol = st.volume;
  const series = [a.d1, a.d7, a.d30, a.d90].filter((x): x is number => typeof x === 'number' && x > 0);
  if (vol == null || series.length < 3) return { c: null, reject: 'недостаточно данных для оценки риска' };
  const med = [...series].sort((x, y) => x - y)[Math.floor(series.length / 2)];
  const dev = Math.max(...series.map((x) => Math.abs(x - med) / med));
  if (vol < 20) bump('high', `мало продаж: ${vol} за сутки`);
  else if (vol < 100) bump('medium', `продаж за сутки ${vol} — продать может занять время`);
  if (dev > 0.25) bump('high', `цена сильно скачет (до ${Math.round(dev * 100)}% от обычной)`);
  else if (dev > 0.1) bump('medium', `заметные колебания цены (до ${Math.round(dev * 100)}%)`);
  if (a.d1 && a.d7 && a.d1 > a.d7 * 1.15) bump('high', 'резкий скачок за сутки — может откатиться');
  if (a.d1 && a.d7 && a.d1 < a.d7 * 0.9) bump('high', 'цена падает: за сутки ниже средней за неделю на 10%+');
  else if (a.d7 < a.d30 * 0.97) bump('medium', 'неделю цена ниже средней за месяц — рынок слабеет');
  if (st.median && buy < st.median * 0.5) bump('high', 'объявление вдвое дешевле медианы — похоже на аномалию, его могут быстро купить');
  if (e.orders?.buy && e.orders.at && now - e.orders.at <= RALLY_LIVE_MAX_SEC) {
    const spread = (buy - e.orders.buy) / buy;
    if (spread > 0.3) bump('medium', `большой разрыв между объявлениями и ордерами покупателей (${Math.round(spread * 100)}%)`);
  } else if (vol < 300) bump('medium', 'ордер покупателя неизвестен, а продаж меньше 300 в сутки');
  if (downside < buy) bump('medium', 'при падении цены на 10% за 7 дней блокировки сделка уйдёт в минус');
  if (track.n >= 5 && track.hit / track.n < 0.5) bump('medium', `прошлые прогнозы сбылись только в ${track.hit} из ${track.n}`);
  if (!why.length) why.push(`${vol} продаж за сутки, цена ровная (колебания до ${Math.round(dev * 100)}%), даже при −10% без убытка`);

  const fmt = (k: number) => `⟦${k}⟧`;
  const confirmed = [`объявление Steam ${fmt(buy)}`, st.median ? `медиана продаж за сутки ${fmt(st.median)} (${vol} продаж)` : '', `средние продаж за 7/30 дней`,
    e.orders?.buy ? `ордер покупателя ${fmt(e.orders.buy)}` : ''].filter(Boolean);
  return {
    reject: null,
    c: {
      name: e.name, img: e.img ?? null, buyKop: buy, targetKop: target, netKop: net, profitKop: profit, roiBp: roi, downsideNetKop: downside,
      volume24h: vol, avg: a, medianKop: st.median, buyOrderKop: e.orders?.buy ?? null, risk, riskWhy: why,
      reason: `Объявление ${fmt(buy)} ниже, чем обычно продают (${fmt(target + 1)}). После 7 дней блокировки и комиссии Steam придёт ${fmt(net)}: +${fmt(profit)} (${Math.round(roi / 100)}%).`,
      unlockAt: now + UNLOCK_SEC, dataAt: st.at, confirmed,
    },
  };
}

export function findCandidates(entries: RallyEntry[], s: RallySettings, now: number, track?: Track, limit = 5): { list: RallyCandidate[]; hidden: number; rejected: Record<string, number>; message: string | null } {
  const ok: RallyCandidate[] = [];
  const rejected: Record<string, number> = {};
  for (const e of entries) {
    const r = evaluate(e, s, now, track);
    if (r.c) ok.push(r.c); else if (r.reject) rejected[r.reject] = (rejected[r.reject] ?? 0) + 1;
  }
  const allowed = ok.filter((c) => c.risk !== 'unknown' && RISK_ORDER[c.risk] <= RISK_ORDER[s.risk]);
  const list = allowed.sort((x, y) => RISK_ORDER[x.risk] - RISK_ORDER[y.risk] || y.profitKop - x.profitKop).slice(0, limit);
  return { list, hidden: ok.length - allowed.length, rejected, message: list.length ? null : NO_DEALS_TEXT };
}

// ---------- Учёт капитала ----------
export interface RallyTrade {
  id: number; mode: 'real' | 'sim'; name: string; img: string | null; qty: number; buy_kop: number; bought_at: number; unlock_at: number;
  target_kop: number | null; predicted_net_kop: number | null; risk: string | null; status: 'open' | 'sold' | 'cancelled';
  sold_qty: number; sold_price_kop: number | null; sold_net_kop: number | null; sold_at: number | null; parent_id: number | null;
}

export interface Capital {
  startKop: number; balanceKop: number; availableKop: number; inItemsKop: number; externalKop: number; lockedCount: number; openCount: number;
  expectedProfitKop: number; realizedKop: number; lossesKop: number; feesKop: number; roiBp: number; closedCount: number; totalKop: number;
}

/** Баланс = старт − покупки + выручка от продаж (после комиссии). Ожидаемая прибыль — отдельно и НЕ входит в баланс. */
export function capital(trades: RallyTrade[], s: RallySettings, mode: 'real' | 'sim', now: number): Capital {
  const mine = trades.filter((t) => t.mode === mode && t.status !== 'cancelled');
  const start = mode === 'sim' ? s.simStartKop : s.startKop;
  let spent = 0, received = 0, inItems = 0, expected = 0, realized = 0, losses = 0, fees = 0, locked = 0, open = 0, closed = 0;
  for (const t of mine) {
    spent += t.buy_kop * t.qty;
    if (t.status === 'open') {
      open++; inItems += t.buy_kop * t.qty;
      if (t.unlock_at > now) locked++;
      if (t.predicted_net_kop != null) expected += (t.predicted_net_kop - t.buy_kop) * t.qty;
    } else if (t.status === 'sold') {
      closed++;
      received += t.sold_net_kop ?? 0;
      const p = (t.sold_net_kop ?? 0) - t.buy_kop * t.qty;
      realized += p; if (p < 0) losses += -p;
      if (t.sold_price_kop != null) fees += t.sold_price_kop * t.qty - (t.sold_net_kop ?? 0);
    }
  }
  const balance = start - spent + received;
  const external = mode === 'real' ? s.externalKop : 0;
  return {
    startKop: start, balanceKop: balance, availableKop: Math.max(0, balance - s.reserveKop), inItemsKop: inItems, externalKop: external,
    lockedCount: locked, openCount: open, expectedProfitKop: expected, realizedKop: realized, lossesKop: losses, feesKop: fees,
    roiBp: start > 0 ? Math.trunc((realized * 10000) / start) : 0, closedCount: closed, totalKop: balance + inItems + external,
  };
}

/** Можно ли купить: лимит на покупку, резерв, число позиций, хватает ли денег. Пустой список — можно. */
export function buyBlockers(cap: Capital, s: RallySettings, costKop: number): string[] {
  const out: string[] = [];
  if (!(costKop > 0)) out.push('Укажи цену покупки');
  if (costKop > s.maxItemKop) out.push(`Покупка ⟦${costKop}⟧ больше лимита ⟦${s.maxItemKop}⟧ на один предмет`);
  if (cap.openCount >= s.maxPositions) out.push(`Уже открыто ${cap.openCount} из ${s.maxPositions} позиций — сначала продай или отмени одну`);
  if (costKop > cap.balanceKop) out.push(`Не хватает денег: на балансе ⟦${cap.balanceKop}⟧`);
  else if (cap.balanceKop - costKop < s.reserveKop) out.push(`После покупки на балансе останется ⟦${cap.balanceKop - costKop}⟧ — меньше резерва ⟦${s.reserveKop}⟧`);
  return out;
}

/** Симуляция: продажа после разблокировки по ФАКТИЧЕСКОЙ цене на тот момент (не по прогнозу). null — ждать. */
export function simSale(t: RallyTrade, e: RallyEntry | undefined, now: number): { priceKop: number; netKop: number; note: string } | null {
  if (t.status !== 'open' || t.unlock_at > now || !e?.steam || now - e.steam.at > RALLY_LIVE_MAX_SEC) return null;
  // Используем только данные, полученные ПОСЛЕ разблокировки — никаких «будущих» данных для прошлых сигналов и наоборот.
  if (e.steam.at < t.unlock_at) return null;
  const vol = e.steam.volume ?? 0;
  if (vol < t.qty) return null; // не продали бы — ждём
  const candidates = [e.steam.lowest != null ? e.steam.lowest - 1 : null, e.steam.median].filter((x): x is number => typeof x === 'number' && x >= 3);
  if (!candidates.length) return null;
  const price = Math.min(...candidates);
  const net = steamNetKop(price);
  if (net == null) return null;
  return { priceKop: price, netKop: net * t.qty, note: `продано в симуляции по фактической цене ${new Date(e.steam.at * 1000).toISOString().slice(0, 16).replace('T', ' ')} UTC` };
}

// ---------- Стратегия B: Steam → внешняя площадка → Steam ----------
export interface ChainInput {
  freeKop: number;                 // свободно сверх резерва
  steamBuyKop: number | null;      // покупка в Steam (объявление)
  siteSellNetKop: number | null;   // выручка на площадке после её комиссии (в той же валюте, пересчитано по курсу)
  siteMinWithdrawKop: number | null; // минимальная сумма/цена на площадке, если известна
  backItemCostKop: number | null;  // покупка предмета на площадке для возврата в Steam
  backItemSteamTargetKop: number | null; // за сколько продать его в Steam
  confirmed: boolean;              // все цены — реальные свежие объявления
}
/** Цепочка проверяется целиком; если чего-то не хватает или нужны доп. деньги — «невыполнима», с причинами. */
export function checkChain(i: ChainInput): { feasible: boolean; finalKop: number | null; profitKop: number | null; days: number; reasons: string[] } {
  const reasons: string[] = [];
  const days = 7 + 7 + 7; // блокировка после покупки в Steam + защита обмена при передаче на площадку и обратно (Trade Protection) — оценка
  if (i.steamBuyKop == null || i.siteSellNetKop == null || i.backItemCostKop == null || i.backItemSteamTargetKop == null) reasons.push('нет подтверждённых цен для всех шагов цепочки');
  if (!i.confirmed) reasons.push('цены не подтверждены свежими объявлениями');
  if (i.steamBuyKop != null && i.steamBuyKop > i.freeKop) reasons.push('покупка в Steam больше свободных денег сверх резерва — понадобятся доп. вложения');
  if (i.siteMinWithdrawKop != null && i.siteSellNetKop != null && i.siteSellNetKop < i.siteMinWithdrawKop) reasons.push('выручка на площадке ниже её минимальной суммы — без доплаты не провести');
  if (i.siteSellNetKop != null && i.backItemCostKop != null && i.backItemCostKop > i.siteSellNetKop) reasons.push('на площадке не хватит денег на предмет для возврата — нужна доплата');
  let finalKop: number | null = null, profit: number | null = null;
  if (i.backItemSteamTargetKop != null && i.steamBuyKop != null) {
    finalKop = steamNetKop(i.backItemSteamTargetKop);
    profit = finalKop != null ? finalKop - i.steamBuyKop : null;
    if (profit == null || profit <= 0) reasons.push('после всех комиссий итог не больше вложенного');
  }
  return { feasible: reasons.length === 0, finalKop, profitKop: profit, days, reasons };
}

// ---------- Проверка схемы на истории (бэктест) ----------
// Только на ценах, которые бот сам собрал: самое дешёвое объявление Steam по дням (минимум и среднее за день).
// Сигнал в день D строится ТОЛЬКО по данным до D включительно; результат — по цене через 7 дней (без «заглядывания в будущее»).
export interface DayPrice { day: string; min: number; avg: number }
export interface BacktestTrade { name: string; day: string; buyKop: number; targetKop: number; predictedNetKop: number; sellDay: string; sellKop: number; netKop: number; profitKop: number; win: boolean }

export function backtestItem(name: string, series: DayPrice[], s: RallySettings = RALLY_DEFAULTS): BacktestTrade[] {
  const out: BacktestTrade[] = [];
  const byDay = new Map(series.map((x) => [x.day, x]));
  const addDays = (day: string, n: number) => new Date(Date.parse(day + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
  let busyUntil = '';
  for (let i = 7; i < series.length; i++) {
    const d = series[i];
    if (d.day < busyUntil) continue;                          // одна позиция по предмету за раз
    const prev = series.slice(Math.max(0, i - 30), i);         // только прошлое
    const last7 = prev.slice(-7);
    if (last7.length < 5) continue;
    const avg7 = last7.reduce((a, x) => a + x.avg, 0) / last7.length;
    const avg30 = prev.reduce((a, x) => a + x.avg, 0) / prev.length;
    const dev = Math.max(...last7.map((x) => Math.abs(x.avg - avg7) / avg7));
    if (dev > 0.1) continue;                                   // как «низкий риск»: цена ровная
    const target = Math.floor(Math.min(avg7, avg30)) - 1;
    const buy = d.min;                                         // допущение: удалось купить по минимуму дня
    if (buy > s.maxItemKop || buy < 3) continue;
    const pred = steamNetKop(target);
    if (pred == null || pred - buy < s.minProfitKop || ((pred - buy) * 10000) / buy < s.minRoiBp) continue;
    const sellDay = addDays(d.day, 7);
    const later = byDay.get(sellDay) ?? series.find((x) => x.day > sellDay && x.day <= addDays(sellDay, 3));
    if (!later) continue;                                      // нет данных о продаже — сделку не считаем
    const sell = Math.max(3, Math.floor(later.avg) - 1);       // продаём по средней цене того дня, на 1 коп. ниже
    const net = steamNetKop(sell) ?? 0;
    out.push({ name, day: d.day, buyKop: buy, targetKop: target, predictedNetKop: pred, sellDay: later.day, sellKop: sell, netKop: net, profitKop: net - buy, win: net > buy });
    busyUntil = later.day;
  }
  return out;
}
