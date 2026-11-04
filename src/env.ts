export interface Env {
  DB: D1Database;
  /** Токен бота от BotFather (Secret). */
  TELEGRAM_BOT_TOKEN: string;
  /** Случайная строка, которую Telegram присылает в заголовке X-Telegram-Bot-Api-Secret-Token (Secret). */
  TELEGRAM_WEBHOOK_SECRET: string;
  /** Твой числовой Telegram ID (Secret). Только он может управлять ботом. */
  ADMIN_TELEGRAM_ID: string;
  /** Ключ для служебных адресов /admin/* (Secret). */
  ADMIN_KEY: string;
  /** Необязательно: API-ключ CSFloat (Secret). Без него адаптер CSFloat выключен. */
  CSFLOAT_API_KEY?: string;
}
