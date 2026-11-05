// Рубрики канала — чтобы посты не были только «рекомендации и обновления».
// Каждый день в 13:00 (Варшава) одна рубрика по дню недели:
//   пн, чт — «Где дешевле»: один предмет, цены на всех площадках из свежего сканирования;
//   вт, пт, вс — «Совет»: короткая правда о рынке и безопасности (без цифр, которые устаревают);
//   ср, сб — «Опрос»: что будет с ценой кейса к следующему опросу; в следующий раз — итог по фактической цене.

import type { Currency } from '../types/market.ts';
import { toKop, type FxRate } from '../currency/nbu.ts';
import { MARKETS, type ScanEntry } from './recs.ts';
import { header, esc, money, pct } from './postfmt.ts';
import type { CaseStat } from './insights.ts';

export type RubricKind = 'cheapest' | 'tip' | 'poll';

/** 0 = воскресенье (Варшава). */
export function rubricFor(weekday: number): RubricKind {
  return weekday === 1 || weekday === 4 ? 'cheapest' : weekday === 3 || weekday === 6 ? 'poll' : 'tip';
}

// ---------- «Где дешевле» ----------

const MIN_KOP = 5_000;       // от 50 ₴ — копеечные предметы неинтересны
const MAX_KOP = 2_000_000;   // до 20 000 ₴

export interface CheapestPick { name: string; text: string }

/** Предмет с ценами минимум на 3 площадках + Steam; самый продаваемый из тех, что не показывали недавно. */
export function cheapestPost(entries: ScanEntry[], fx: Map<Currency, FxRate>, recent: string[], now: number): CheapestPick | null {
  const cands = entries.map((e) => {
    const prices = new Map<string, number>();
    for (const o of e.offers) {
      if (o.qty === 0) continue;
      const r = fx.get(o.cur);
      const k = r ? toKop(o.minor, o.cur, r) : null;
      if (k && (!prices.has(o.m) || k < prices.get(o.m)!)) prices.set(o.m, k);
    }
    const steam = e.steam?.lowestKop ?? null;
    return { e, prices, steam };
  }).filter((c) => c.prices.size >= 3 && c.steam && c.steam >= MIN_KOP && c.steam <= MAX_KOP && !recent.includes(c.e.name));
  if (!cands.length) return null;
  cands.sort((a, b) => (b.e.s7?.volume ?? 0) - (a.e.s7?.volume ?? 0) || (b.e.steam?.volume24h ?? 0) - (a.e.steam?.volume24h ?? 0));
  const c = cands[0];
  const rows = [...c.prices].map(([m, k]) => ({ name: MARKETS[m as keyof typeof MARKETS].name, k, cash: true }))
    .concat([{ name: 'Steam', k: c.steam!, cash: false }]).sort((a, b) => a.k - b.k);
  const lo = rows[0], hi = rows[rows.length - 1];
  const lines = [header('🔎', 'Где дешевле', now), '', `<b>${esc(c.e.name)}</b>`, ''];
  rows.forEach((r, i) => lines.push(`${i === 0 ? '🟢' : i === rows.length - 1 ? '🔴' : '▫️'} ${esc(r.name)} — <b>${money(r.k)}</b>${r.cash ? '' : ' (баланс Steam)'}`));
  if (hi.k > lo.k) lines.push('', `Разница между самой низкой и самой высокой ценой — <b>${money(hi.k - lo.k)}</b> (${pct(Math.round(((hi.k - lo.k) * 10000) / lo.k)).replace('+', '')}).`);
  if (rows.some((r) => r.name === 'Waxpeer') && lo.name === 'Waxpeer') lines.push('⚠️ У Waxpeer низкая оценка на Trustpilot — будь осторожнее.');
  lines.push('', '<i>Самые дешёвые объявления на момент проверки. Деньги со сторонних площадок можно вывести, баланс Steam — нет. Float и наклейки у объявлений разные — смотри перед покупкой.</i>');
  return { name: c.e.name, text: lines.join('\n') };
}

// ---------- «Совет» ----------

/** Только то, что не устаревает за неделю. Порядок — по кругу. */
export const TIPS: { title: string; text: string }[] = [
  { title: 'Сколько ставить в Steam, чтобы получить нужную сумму', text: 'Со сделки на Торговой площадке Steam удерживаются две комиссии: 5% Steam и 10% игры (каждая — минимум 0,01). Чтобы получить на баланс 100 ₴, выставляй примерно за 115 ₴.\n\n📌 В боте: «Рассчитать прибыль» считает точную сумму с округлением.' },
  { title: 'Купил в Steam — продать сразу не выйдет', text: 'Предмет, купленный на Торговой площадке Steam, какое-то время нельзя перепродать или передать — дату Steam показывает в инвентаре. Планируя перепродажу, считай цену на момент, когда блокировка закончится, а не сегодняшнюю.' },
  { title: 'Мобильный Steam Guard — обязательно', text: 'Без мобильного аутентификатора Steam Guard обмены задерживаются на срок до 15 дней. С ним обмены проходят сразу, а каждый обмен и продажа подтверждаются в приложении — это ещё и защита от мошенников.' },
  { title: 'Перед подтверждением обмена — смотри, кому отдаёшь', text: 'Мошенники подменяют получателя: обмен выглядит как с ботом площадки, а уходит на чужой аккаунт. В мобильном подтверждении проверь имя, уровень и дату регистрации получателя. Не совпадает — отклоняй.' },
  { title: 'API-ключ Steam — только если создавал сам', text: 'Одна из частых схем: сайт просит создать Steam Web API Key, а потом с его помощью подменяет твои обмены. Если ключ есть, а ты его не создавал или не помнишь зачем, — отзови его на странице steamcommunity.com/dev/apikey и смени пароль.' },
  { title: 'Ссылки «зайди через Steam»', text: 'Вход через Steam на любом сайте должен открываться на steamcommunity.com — проверь адрес в строке браузера. Поддельные окна входа рисуют прямо на странице. Логин и код Steam Guard никогда не нужны «для проверки» или «для выплаты».' },
  { title: '«Гарант» в Discord — почти всегда обман', text: 'Если в обмене предлагают посредника-«гаранта», которого нашёл продавец, это частая схема: «гарант» в сговоре. Безопаснее торговать через площадки с защитой сделки или прямым обменом в Steam.' },
  { title: 'Float — почему одинаковые скины стоят по-разному', text: 'Float — число от 0 до 1: чем меньше, тем меньше потёртостей. Внутри одного износа (например, Field-Tested) скин с низким float может стоить заметно дороже. Сравнивая цены на площадках, смотри float, а не только название.' },
  { title: 'Наклейки не возвращают свои деньги', text: 'Наклейка, наклеенная на скин, обычно продаётся вместе с ним намного дешевле, чем стоила отдельно. Переплачивать за «скин с наклейками» стоит, только если это редкие наклейки и ты понимаешь их цену.' },
  { title: 'Баланс Steam и деньги — не одно и то же', text: 'В Steam цены обычно выше, чем на сторонних площадках: деньги с баланса Steam нельзя вывести. Поэтому «купил на площадке дешевле, продал в Steam дороже» часто означает только перевод денег в баланс Steam — уже с комиссией.' },
  { title: 'Ликвидность важнее красивой цены', text: 'Предмет, который продаётся раз в неделю, можно долго не продать по нужной цене. Перед покупкой «на перепродажу» смотри, сколько штук продаётся в сутки. Чем больше продаж, тем ближе реальная цена к той, что видишь.' },
  { title: 'Заявка на покупку в Steam', text: 'В Steam можно не покупать по самой низкой цене, а выставить заявку на покупку (ордер) дешевле и подождать продавца. Медленнее, зато дешевле. Деньги за заявку резервируются на балансе, пока её не отменишь.' },
  { title: 'Не всё в одном предмете', text: 'Если весь баланс вложен в один скин, любое падение его цены — сразу минус по всем деньгам. Несколько разных предметов снижают риск, а свободный остаток на балансе даёт купить, когда появится выгодная цена.' },
  { title: 'Оценка площадки — до первой сделки', text: 'Перед первой покупкой или продажей на новой площадке посмотри её оценку и свежие отзывы (например, на Trustpilot). На главной бота у каждой площадки есть оценка; у площадок ниже 3.5 — знак ⚠️, там жалоб больше.' },
  { title: 'Комиссии сторонних площадок', text: 'У сторонних площадок своя комиссия с продажи, а иногда ещё и за вывод денег. Прибыль считай только после всех комиссий — иначе «выгодная» разница может оказаться нулём или минусом.\n\n📌 В боте: «Рассчитать прибыль» учитывает комиссии площадок.' },
  { title: 'Обновления CS2 двигают цены', text: 'После крупных обновлений (новый кейс, изменения карт или оружия) цены отдельных предметов могут резко меняться в обе стороны. Покупать на волне ажиотажа рискованно: рост уже может быть в цене.\n\n📌 Краткое содержание обновлений — в этом канале, на русском.' },
];

export function tipPost(idx: number, now: number): string {
  const t = TIPS[((idx % TIPS.length) + TIPS.length) % TIPS.length];
  return [header('🧠', 'Совет', now), '', `<b>${esc(t.title)}</b>`, '', t.text].join('\n');
}

// ---------- «Опрос» ----------

export const POLL_FLAT_BP = 300; // ±3% — «почти не изменится»
export const POLL_OPTIONS = ['📈 Подорожает больше чем на 3%', '📉 Подешевеет больше чем на 3%', '➖ Почти не изменится (±3%)'];

/** Открытый опрос: какой кейс, цена в начале (средняя продаж Steam за сутки, центы USD), id сообщения. */
export interface OpenPoll { name: string; d1: number; at: number; msgId?: number }

/** Кейс для опроса: с продажами за сутки/неделю/месяц, не повторяем последние. */
export function pickPollCase(cases: CaseStat[], recent: string[]): CaseStat | null {
  const ok = cases.filter((c) => c.d1 && c.d7 && c.d30 && c.d1 >= 10 && !recent.includes(c.name));
  if (!ok.length) return null;
  // Самые дорогие кейсы — их знают все; из первой десятки по цене — по очереди.
  ok.sort((a, b) => b.d1! - a.d1!);
  return ok[recent.length % Math.min(ok.length, 10)];
}

export function pollQuestion(c: CaseStat, fx: Map<Currency, FxRate>): string {
  const usd = fx.get('USD');
  const k = usd ? toKop(c.d1!, 'USD', usd) : null;
  return `🗳 ${c.name} сейчас ≈ ${money(k)} в Steam. Что будет с ценой к следующему опросу (через 3–4 дня)?`;
}

/** Итог прошлого опроса по фактической средней цене продаж Steam. votes — сколько проголосовало за каждый вариант (если удалось узнать). */
export function pollResultText(p: OpenPoll, nowD1: number, fx: Map<Currency, FxRate>, votes: number[] | null, now: number): string {
  const usd = fx.get('USD');
  const k = (c: number) => (usd ? toKop(c, 'USD', usd) : null);
  const bp = Math.round(((nowD1 - p.d1) * 10000) / p.d1);
  const right = bp > POLL_FLAT_BP ? 0 : bp < -POLL_FLAT_BP ? 1 : 2;
  const lines = [header('🗳', 'Итог опроса', now), '', `<b>${esc(p.name)}</b>: было ${money(k(p.d1))} → стало <b>${money(k(nowD1))}</b> (${pct(bp)})`, `Правильный ответ: <b>${POLL_OPTIONS[right]}</b>`];
  const total = votes?.reduce((s, x) => s + x, 0) ?? 0;
  if (votes && total > 0) lines.push(`Угадали ${Math.round((votes[right] * 100) / total)}% из ${total} проголосовавших.`);
  lines.push('', '<i>Цена — средняя продаж в Steam за сутки (открытый прайс). Новый опрос — ниже.</i>');
  return lines.join('\n');
}
