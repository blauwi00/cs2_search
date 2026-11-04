// Служебные адреса для настройки с телефона. Открываются в Safari, защищены ключом ADMIN_KEY.
//   /admin/setup?key=…  — установить webhook Telegram и меню команд, создать запись администратора
//   /admin/diag?key=…   — диагностика первого запуска (+ отчёт в Telegram)
//   /admin/run?key=…    — выполнить цикл сбора прямо сейчас

import type { Env } from './env.ts';
import { safeEqual } from './telegram/webhook.ts';
import { TelegramClient } from './telegram/api.ts';
import * as db from './storage/db.ts';
import { runCycle, JOBS } from './core/runner.ts';
import { ensureJobs } from './core/scheduler.ts';
import { fetchNbuRates } from './currency/nbu.ts';
import { fetchSteamPriceOverview } from './api/steam.ts';
import { fetchChecked, type Fetcher } from './utils/http.ts';
import { itemsUrl } from './api/skinport.ts';
import { listingsUrl } from './api/csfloat.ts';
import { SourceError } from './types/market.ts';
import { moneyResolver } from './currency/display.ts';

const text = (s: string, status = 200) => new Response(s, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } });

export function missingSecrets(env: Env): string[] {
  const need: (keyof Env)[] = ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_WEBHOOK_SECRET', 'ADMIN_TELEGRAM_ID', 'ADMIN_KEY'];
  const out: string[] = need.filter((k) => !env[k]);
  if (env.ADMIN_TELEGRAM_ID && !/^\d{3,15}$/.test(env.ADMIN_TELEGRAM_ID)) out.push('ADMIN_TELEGRAM_ID (должен быть числом)');
  if (env.TELEGRAM_WEBHOOK_SECRET && !/^[A-Za-z0-9_-]{16,256}$/.test(env.TELEGRAM_WEBHOOK_SECRET)) out.push('TELEGRAM_WEBHOOK_SECRET (16–256 символов: A-Z a-z 0-9 _ -)');
  return out;
}

export async function handleAdmin(req: Request, env: Env, now: number, fetcher?: Fetcher): Promise<Response> {
  const url = new URL(req.url);
  // iPhone при копировании часто добавляет невидимый пробел или перенос — обрезаем его с обеих сторон.
  const given = (url.searchParams.get('key') ?? '').trim();
  if (!env.ADMIN_KEY || !safeEqual(given, env.ADMIN_KEY.trim())) {
    // Подсказка без раскрытия ключа: только длины и признаки частых ошибок.
    const expected = env.ADMIN_KEY ?? '';
    const hints: string[] = [];
    if (!expected) hints.push('Секрет ADMIN_KEY не найден в Worker. Проверь имя (ровно ADMIN_KEY) и нажми Deploy.');
    else {
      hints.push(`ADMIN_KEY в Cloudflare: ${expected.length} симв.; ключ в ссылке: ${given.length} симв.`);
      if (expected.trim() !== expected) hints.push('В значении секрета ADMIN_KEY есть пробел или перенос строки в начале/конце — пересоздай секрет без пробелов.');
      if (given.trim() !== given) hints.push('В ссылке после key= есть пробел.');
      if (!given) hints.push('В ссылке нет ?key=… или ключ пустой.');
      if (expected.trim() === given.trim() && expected !== given) hints.push('Ключи совпадают, если убрать пробелы — дело в пробелах.');
      if (/[^A-Za-z0-9_-]/.test(expected)) hints.push('В ADMIN_KEY есть символы кроме латиницы, цифр, _ и - (их ломает ссылка). Задай ключ только из букв и цифр.');
    }
    return text(`Forbidden\n\n${hints.join('\n')}`, 403);
  }
  const missing = missingSecrets(env);
  if (missing.length) return text(`Не заданы или некорректны секреты: ${missing.join(', ')}`, 500);
  const tg = new TelegramClient(env.TELEGRAM_BOT_TOKEN, fetcher);
  tg.money = moneyResolver(env.DB);
  const adminId = Number(env.ADMIN_TELEGRAM_ID);

  if (url.pathname === '/admin/setup') {
    const lines: string[] = [];
    try {
      await db.ensureUser(env.DB, adminId, true, now);
      await ensureJobs(env.DB, JOBS, now);
      lines.push('D1: OK (таблицы на месте)');
    } catch (e) {
      return text(`D1: ошибка — ${(e as Error).message}\nВероятно, не выполнены миграции или не привязана база DB.`, 500);
    }
    const hook = `${url.origin}/telegram`;
    try {
      await tg.call('setWebhook', { url: hook, secret_token: env.TELEGRAM_WEBHOOK_SECRET, allowed_updates: ['message', 'callback_query'], drop_pending_updates: true });
      lines.push(`Webhook: установлен на ${hook}`);
      const common = [
        { command: 'start', description: 'Открыть приложение' }, { command: 'menu', description: 'Текстовое меню' }, { command: 'add', description: 'Добавить предмет' },
        { command: 'deals', description: 'Выгодные сделки' }, { command: 'watch', description: 'Мониторинг цен' },
        { command: 'currency', description: 'Валюта цен' }, { command: 'settings', description: 'Настройки' },
        { command: 'privacy', description: 'Что нужно боту и что он знает' },
      ];
      await tg.call('setMyCommands', { commands: common });
      // Владельцу — ещё служебные команды (видны только в его чате).
      await tg.call('setMyCommands', { scope: { type: 'chat', chat_id: adminId }, commands: [...common,
        { command: 'status', description: 'Состояние системы' }, { command: 'stats', description: 'Статистика и ссылки с метками' },
        { command: 'channel', description: 'Автопостинг в канал' }, { command: 'post', description: 'Предпросмотр поста' },
      ] });
      lines.push('Команды меню: установлены');
      await tg.setMenuButton(adminId, `${url.origin}/app`);
      lines.push('Кнопка «Приложение»: установлена');
      await tg.sendMessage(adminId, '✅ Бот подключён. Нажми /start');
      lines.push('Тестовое сообщение: отправлено в Telegram');
    } catch (e) {
      lines.push(`Telegram: ошибка — ${(e as Error).message}`);
      return text(lines.join('\n'), 500);
    }
    return text(lines.join('\n') + '\n\nДальше: открой /admin/diag?key=… для проверки источников.');
  }

  if (url.pathname === '/admin/diag') {
    const report = await diagnostics(env, now, fetcher);
    try { await tg.sendMessage(adminId, '<b>CS2 Market Bot — диагностика</b>\n\n' + report.join('\n')); } catch { /* покажем в браузере */ }
    return text(report.join('\n'));
  }

  if (url.pathname === '/admin/run') {
    const r = await runCycle(env, { now, force: ['fx', 'steam', 'skinport_items', 'evaluate'], fetcher });
    return text([
      `Выполнено: ${r.ran.join(', ') || '—'}`,
      `Пропущено: ${r.skipped.join(', ') || '—'}`,
      `Ошибки: ${r.errors.map((e) => `${e.job}: ${e.error}`).join('; ') || 'нет'}`,
      `Остаток лимита за вызов: D1 ${r.budget.d1}, внешние ${r.budget.external}`,
    ].join('\n'));
  }
  return text('Not Found', 404);
}

async function check(label: string, fn: () => Promise<string>): Promise<string> {
  try { return `${label}: ✅ ${await fn()}`; } catch (e) {
    const se = e instanceof SourceError ? ` [${e.kind}${e.status ? ' ' + e.status : ''}]` : '';
    return `${label}: ❌ ${(e as Error).message}${se}`;
  }
}

/** Реальная проверка каждого компонента. Ничего не помечается «работает» без фактического ответа. */
export async function diagnostics(env: Env, now: number, fetcher?: Fetcher): Promise<string[]> {
  const out: string[] = [];
  out.push(await check('D1', async () => {
    const r = await env.DB.prepare('SELECT COUNT(*) AS n FROM scheduler_jobs').first<{ n: number }>();
    return `работает, задач в планировщике: ${r?.n ?? 0}`;
  }));
  out.push(await check('Telegram', async () => {
    const me = await new TelegramClient(env.TELEGRAM_BOT_TOKEN, fetcher).call<{ username: string }>('getMe', {});
    return `бот @${me.username}`;
  }));
  out.push(await check('Курсы НБУ', async () => {
    const r = await fetchNbuRates(fetcher);
    await db.storeFx(env.DB, r, now);
    return r.map((x) => `${x.base} ${(x.rateMicro / 1e6).toFixed(4)} (${x.rateDate})`).join(', ');
  }));
  if (env.COLLECTOR === 'github') {
    // Steam и Skinport блокируют сеть Cloudflare — их опрашивает GitHub Actions, проверяем, приходят ли данные.
    const rows = await db.listSourceStatus(env.DB).catch(() => []);
    const ago = (t: number | null | undefined) => (t ? `${Math.round((now - t) / 60)} мин назад` : 'ни разу');
    const c = rows.find((r) => r.source === 'collector');
    out.push(`Сборщик (GitHub Actions): ${c?.last_ok_at && now - c.last_ok_at < 45 * 60 ? '✅' : '❌'} последние данные ${ago(c?.last_ok_at)}${env.INGEST_SECRET ? '' : ' — не задан секрет INGEST_SECRET'}`);
    if (!env.GH_DISPATCH_TOKEN) out.push('Автозапуск сборщика: ⚠️ не задан секрет GH_DISPATCH_TOKEN — расписание GitHub срабатывает ненадёжно, цены могут не обновляться часами');
    else {
      const r = await (fetcher ?? fetch)(`https://api.github.com/repos/${env.GH_REPO ?? ''}/actions/workflows/collect.yml`, { headers: { Authorization: `Bearer ${env.GH_DISPATCH_TOKEN.trim()}`, Accept: 'application/vnd.github+json', 'User-Agent': 'cs2-market-bot' } }).catch(() => null);
      out.push(`Автозапуск сборщика (Worker → GitHub): ${r?.ok ? '✅ токен работает' : `❌ GitHub ответил ${r?.status ?? 'ошибкой'} — проверь токен GH_DISPATCH_TOKEN и доступ к репозиторию`}`);
    }
    for (const s of ['steam', 'skinport']) {
      const r = rows.find((x) => x.source === s);
      out.push(`${s === 'steam' ? 'Steam Market' : 'Skinport'} (через сборщик): ${r?.status === 'ok' ? '✅' : '❌'} успех ${ago(r?.last_ok_at)}${r?.status !== 'ok' && r?.last_error ? ` — ${r.last_error}` : ''}`);
    }
  } else {
  out.push(await check('Steam Market (ограниченный режим, неофициальный endpoint)', async () => {
    const q = await fetchSteamPriceOverview('Revolution Case', now, fetcher);
    return `ответ получен: самое дешёвое объявление ${q[0].priceMinor !== null ? (q[0].priceMinor / 100).toFixed(2) + ' грн' : 'нет данных'}`;
  }));
  out.push(await check('Skinport', async () => {
    const res = await fetchChecked(itemsUrl(), { fetcher, timeoutMs: 20000, headers: { 'Accept-Encoding': 'br' } });
    try { await res.body?.cancel(); } catch { /* ignore */ }
    return `доступен (HTTP ${res.status}); каталог разбирается потоково`;
  }));
  }
  if (!env.CSFLOAT_API_KEY) out.push('CSFloat: ⏸ требуется API-ключ (секрет CSFLOAT_API_KEY) — интеграция выключена');
  else out.push(await check('CSFloat', async () => {
    const res = await fetchChecked(listingsUrl('Revolution Case'), { fetcher, headers: { Authorization: env.CSFLOAT_API_KEY! } });
    try { await res.body?.cancel(); } catch { /* ignore */ }
    return `ключ принят (HTTP ${res.status})`;
  }));
  const jobs = await env.DB.prepare('SELECT MAX(last_run_at) AS t FROM scheduler_jobs').first<{ t: number | null }>().catch(() => null);
  out.push(jobs?.t ? `Cron: ✅ последний запуск ${Math.round((now - jobs.t) / 60)} мин назад` : 'Cron: ⚠️ ещё не запускался (первый запуск — в течение минуты после настройки Cron Trigger)');
  out.push('Валюта: у каждого своя (/currency), внутри расчёт в UAH по курсам НБУ');
  out.push('Режим: мониторинг без автоматической торговли');
  return out;
}
