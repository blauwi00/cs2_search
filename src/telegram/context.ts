import type { Env } from '../env.ts';
import type { TelegramClient, Keyboard } from './api.ts';
import type { Fetcher } from '../utils/http.ts';
import { UAH_CUR, type Cur } from '../utils/money.ts';

/** Контекст обработки одного обновления Telegram. */
/** uid — тот, кто пишет боту (бот для всех); isAdmin — владелец бота (технические экраны). */
export interface H { env: Env; d: D1Database; tg: TelegramClient; uid: number; isAdmin: boolean; now: number; fetcher?: Fetcher; origin: string }
export interface View { text: string; keyboard: Keyboard }

/** Валюта того, кто пишет боту. */
export function hcur(h: H): Promise<Cur> {
  return h.tg.money ? h.tg.money(h.uid) : Promise.resolve(UAH_CUR);
}
/** «в долларах (USD)» — подсказка для ввода сумм. */
export async function inCur(h: H): Promise<string> {
  const c = await hcur(h);
  return `в ${c.code} (${c.sign})`;
}

export async function say(h: H, text: string, keyboard?: Keyboard): Promise<void> {
  await h.tg.sendMessage(h.uid, text, keyboard);
}

export async function show(h: H, v: View, editMsgId?: number): Promise<void> {
  if (editMsgId) await h.tg.editMessage(h.uid, editMsgId, v.text, v.keyboard);
  else await h.tg.sendMessage(h.uid, v.text, v.keyboard);
}
