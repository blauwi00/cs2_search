export interface Env {
  DB: D1Database;
  /** Встроенные нейросети Cloudflare (Workers AI, бесплатный дневной лимит) — чтение скриншотов. */
  AI?: { run(model: string, input: Record<string, unknown>): Promise<unknown> };
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
  /** Общий секрет сборщика цен (GitHub Actions → POST /ingest). Тот же в GitHub Secrets (Secret). */
  INGEST_SECRET?: string;
  /** 'github' — цены Steam/Skinport собирает GitHub Actions; Worker их не запрашивает (обычная переменная в wrangler.jsonc). */
  COLLECTOR?: string;
  /**
   * Токен GitHub (fine-grained, доступ только к этому репозиторию, право Actions: Read and write) — Secret.
   * Нужен, потому что расписание GitHub Actions срабатывает ненадёжно: Worker сам запускает сборщик каждые 10 минут.
   */
  GH_DISPATCH_TOKEN?: string;
  /** Репозиторий сборщика, например blauwi00/cs2_search (обычная переменная в wrangler.jsonc). */
  GH_REPO?: string;
}
