// Обратная связь («ошибка в цене») и пожертвования звёздами Telegram (XTR — для цифровых товаров и донатов в ботах).
import type { TelegramClient } from '../telegram/api.ts';
import { esc } from '../telegram/api.ts';

export const FEEDBACK_REASONS: Record<string, string> = {
  price: 'Цена неверная', gone: 'Предмета уже нет / купили', link: 'Ссылка не работает', idea: 'Рекомендация странная', other: 'Другое',
};
export const FEEDBACK_PER_HOUR = 5;

/** Записать сообщение и переслать владельцу. Возвращает текст ошибки или null. */
export async function submitFeedback(d: D1Database, tg: TelegramClient, adminId: number, tid: number, f: { item?: unknown; reason?: unknown; comment?: unknown; context?: unknown }, now: number): Promise<string | null> {
  const reason = typeof f.reason === 'string' && f.reason in FEEDBACK_REASONS ? f.reason : null;
  if (!reason) return 'Выбери, что не так';
  const item = typeof f.item === 'string' ? f.item.slice(0, 200) : null;
  const comment = typeof f.comment === 'string' ? f.comment.trim().slice(0, 500) : '';
  const context = typeof f.context === 'string' ? f.context.slice(0, 300) : null;
  const n = (await d.prepare('SELECT COUNT(*) AS n FROM feedback WHERE telegram_id = ? AND created_at >= ?').bind(tid, now - 3600).first<{ n: number }>())?.n ?? 0;
  if (n >= FEEDBACK_PER_HOUR) return 'Слишком много сообщений за час — попробуй позже';
  await d.prepare('INSERT INTO feedback (telegram_id, item, reason, comment, context, created_at) VALUES (?, ?, ?, ?, ?, ?)').bind(tid, item, reason, comment || null, context, now).run();
  await tg.sendMessage(adminId, [
    '📮 <b>Сообщение об ошибке</b>',
    `От: <code>${tid}</code>`,
    item ? `Предмет: <b>${esc(item)}</b>` : '',
    `Что не так: ${FEEDBACK_REASONS[reason]}`,
    comment ? `Комментарий: ${esc(comment)}` : '',
    context ? `<i>${esc(context)}</i>` : '',
  ].filter(Boolean).join('\n')).catch(() => undefined);
  return null;
}

/** Имя для топа: только имя из Telegram, без ссылок и служебных символов, коротко. */
export function donorName(first?: unknown): string | null {
  const s = typeof first === 'string' ? first.replace(/[\u0000-\u001f\u200b-\u200f\u202a-\u202e<>@]/g, '').replace(/https?:\/\/\S+|t\.me\/\S+/gi, '').replace(/\s+/g, ' ').trim() : '';
  return s ? Array.from(s).slice(0, 18).join('') : null;
}

/** Топ поддержки за всё время: сумма звёзд на человека; скрывшие себя — не показываются. */
export async function topDonors(d: D1Database, limit = 10): Promise<{ name: string; stars: number }[]> {
  const r = await d.prepare(`SELECT MAX(name) AS name, SUM(stars) AS stars FROM donations
    WHERE telegram_id NOT IN (SELECT telegram_id FROM user_settings WHERE key = 'donor_top' AND value = '0')
    GROUP BY telegram_id ORDER BY stars DESC, MIN(created_at) LIMIT ?`).bind(limit).all<{ name: string | null; stars: number }>();
  return r.results.map((x) => ({ name: x.name || 'Аноним', stars: x.stars }));
}

export const DONATE_AMOUNTS = [25, 50, 100, 250, 500];
export const donatePayload = (stars: number) => `donate:${stars}`;
export const parseDonatePayload = (p: unknown) => {
  const m = typeof p === 'string' ? p.match(/^donate:(\d{1,6})$/) : null;
  const n = m ? Number(m[1]) : 0;
  return n >= 1 && n <= 100000 ? n : null;
};

/** Ссылка на оплату звёздами (открывается в приложении через tg.openInvoice или кнопкой в чате). */
export function donateInvoiceLink(tg: TelegramClient, stars: number): Promise<string> {
  return tg.call<string>('createInvoiceLink', {
    title: 'Поддержать Ценолова', description: `Добровольное пожертвование на развитие бесплатного бота: ${stars} ⭐. Ничего не покупаешь — просто спасибо.`,
    payload: donatePayload(stars), currency: 'XTR', prices: [{ label: 'Пожертвование', amount: stars }],
  });
}
