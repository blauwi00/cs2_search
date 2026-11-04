import type { Env } from '../env.ts';
import type { TelegramClient, Keyboard } from './api.ts';
import type { Fetcher } from '../utils/http.ts';

/** Контекст обработки одного обновления Telegram. */
/** uid — тот, кто пишет боту (бот для всех); isAdmin — владелец бота (технические экраны). */
export interface H { env: Env; d: D1Database; tg: TelegramClient; uid: number; isAdmin: boolean; now: number; fetcher?: Fetcher; origin: string }
export interface View { text: string; keyboard: Keyboard }

export async function say(h: H, text: string, keyboard?: Keyboard): Promise<void> {
  await h.tg.sendMessage(h.uid, text, keyboard);
}

export async function show(h: H, v: View, editMsgId?: number): Promise<void> {
  if (editMsgId) await h.tg.editMessage(h.uid, editMsgId, v.text, v.keyboard);
  else await h.tg.sendMessage(h.uid, v.text, v.keyboard);
}
