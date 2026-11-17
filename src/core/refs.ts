// Реферальные ссылки и промокоды владельца. Раз в день в канал уходит текст-предупреждение с кнопкой в бота;
// в боте человек читает текст, нажимает «Я прочитал данное сообщение» и только тогда получает названия сайтов, ссылки и промокоды.
// Хранится в meta: refs (JSON). Публичного списка ссылок нет нигде — ни в канале, ни в приложении.
import { esc, type Keyboard } from '../telegram/api.ts';

export interface RefLink { name: string; url: string; promo: string | null }
export interface RefsConfig { links: RefLink[]; text: string; daily: boolean }

export const REFS_MAX = 12;
export const REFS_START = 'refs';
export const DEFAULT_REFS_TEXT = [
  'Здесь — реферальные ссылки на сайты, которыми автор бота пользуется сам. Если вы зарегистрируетесь по ссылке или введёте промокод, автор может получить за это бонус.',
  'Это не призыв и не совет пользоваться этими сайтами. Заработок не гарантирован, возможны потери. Только для тех, кому есть 18 лет, и только если это разрешено в вашей стране.',
  'Бот и его команда не связаны с этими сайтами напрямую и не отвечают за них. Все действия на этих сайтах вы совершаете сами и на свою ответственность. Сначала прочитайте правила сайта.',
].join('\n\n');

export const emptyRefs = (): RefsConfig => ({ links: [], text: DEFAULT_REFS_TEXT, daily: false });

/** Проверка того, что прислал редактор владельца: ничему не доверяем, только https-ссылки, короткие названия и промокоды. */
export function parseRefs(raw: unknown): RefsConfig {
  const o = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  const links: RefLink[] = [];
  for (const x of (Array.isArray(o.links) ? o.links : []).slice(0, REFS_MAX)) {
    if (!x || typeof x !== 'object') continue;
    const r = x as Record<string, unknown>;
    const name = typeof r.name === 'string' ? r.name.replace(/[<>\u0000-\u001f]/g, '').trim().slice(0, 40) : '';
    const url = typeof r.url === 'string' ? r.url.trim() : '';
    const promo = typeof r.promo === 'string' ? r.promo.replace(/[<>\s\u0000-\u001f]/g, '').slice(0, 40) : '';
    if (!name || !/^https:\/\/[^\s<>"']{4,300}$/.test(url)) continue;
    links.push({ name, url, promo: promo || null });
  }
  const text = typeof o.text === 'string' ? o.text.replace(/[<>]/g, '').trim().slice(0, 1500) : '';
  return { links, text: text || DEFAULT_REFS_TEXT, daily: o.daily === true };
}

export async function loadRefs(d: D1Database): Promise<RefsConfig> {
  const raw = (await d.prepare("SELECT value FROM meta WHERE key = 'refs'").first<{ value: string }>())?.value;
  if (!raw) return emptyRefs();
  try { return parseRefs(JSON.parse(raw)); } catch { return emptyRefs(); }
}

const head = '<b>Реферальные ссылки и промокоды</b>';
/** Текст в канале и первое сообщение в боте: только предупреждение, без ссылок. */
export const refsWarning = (c: RefsConfig): string => `${head}\n\n${esc(c.text)}`;
/** Сообщение после «Я прочитал»: названия, ссылки, промокоды. */
export function refsLinks(c: RefsConfig): string {
  return [head, '', ...c.links.map((l) => `• <b>${esc(l.name)}</b>\n${esc(l.url)}${l.promo ? `\nПромокод: <code>${esc(l.promo)}</code>` : ''}`)].join('\n').replace(/\n(•)/, '\n\n$1').replace(/\n(•)/g, '\n\n$1').replace(/\n\n\n+/g, '\n\n');
}
export const refsChannelKb = (bot: string): Keyboard => [[{ text: 'Читать и получить ссылки', url: `https://t.me/${bot}?start=${REFS_START}` }]];
export const refsConfirmKb: Keyboard = [[{ text: '✅ Я прочитал данное сообщение', callback_data: 'refs:ok' }]];
