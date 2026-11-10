import type { Env } from './env.ts';
import { handleWebhook } from './telegram/webhook.ts';
import { handleAdmin } from './admin.ts';
import { handleSteamCallback } from './steam_link.ts';
import { runCycle } from './core/runner.ts';
import { nowSec } from './utils/time.ts';
import { handleChart } from './chart.ts';
import { handleIngest } from './ingest.ts';
import { handleAppApi } from './webapp/api.ts';
import APP_HTML from './webapp/app.html';
import { handleCard } from './card.ts';
import { handleImgProxy } from './imgproxy.ts';
import { FINGERPRINT, OFFICIAL_HOST, recordCopy, rememberSelfHost } from './core/origin.ts';
import { TelegramClient } from './telegram/api.ts';

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    // Где запущен этот код (для LICENSE): официальный бот принимает отчёты копий, копия запоминает свой домен.
    if (url.pathname === '/beacon') {
      const h = (url.searchParams.get('h') ?? '').toLowerCase();
      if (url.hostname === OFFICIAL_HOST && url.searchParams.get('fp') === FINGERPRINT) {
        ctx.waitUntil(recordCopy(env.DB, h, nowSec()).then(async (isNew) => {
          if (isNew) await new TelegramClient(env.TELEGRAM_BOT_TOKEN).sendMessage(Number(env.ADMIN_TELEGRAM_ID), `🕵️ Найдена копия бота: <code>${h.replace(/[<>&]/g, '')}</code>\nОна запущена из твоего кода. Список копий: /stats`).catch(() => undefined);
        }));
      }
      return new Response('ok');
    }
    if (url.hostname !== OFFICIAL_HOST && (url.pathname === '/app' || url.pathname === '/telegram')) ctx.waitUntil(rememberSelfHost(env.DB, url.hostname).catch(() => undefined));
    if (url.pathname === '/telegram') return handleWebhook(req, env, nowSec());
    if (url.pathname.startsWith('/admin/')) return handleAdmin(req, env, nowSec());
    if (url.pathname === '/ingest' || url.pathname === '/ingest/items' || url.pathname === '/ingest/backtest') return handleIngest(req, env, nowSec());
    if (url.pathname === '/app' && req.method === 'GET') {
      return new Response(APP_HTML, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache', 'X-Robots-Tag': 'noindex', 'X-Cenolov': FINGERPRINT } });
    }
    // Временно (#33): что Steam отвечает серверу бота на инвентарь владельца. Только этот SteamID, без содержимого — коды и признаки.
    if (url.pathname === '/debug/steaminv' && req.method === 'GET') {
      const id = '76561198451512431', UA = 'Mozilla/5.0 (compatible; CenolovBot/1.0; +https://t.me/cenolow_bot)';
      const out: Record<string, unknown> = {};
      try {
        const j = await fetch(`https://steamcommunity.com/inventory/${id}/730/2?l=english&count=500`, { headers: { 'User-Agent': UA, Accept: 'application/json', Referer: `https://steamcommunity.com/profiles/${id}/inventory/` } });
        const t = await j.text();
        out.json = { status: j.status, len: t.length, start: t.slice(0, 80) };
      } catch (e) { out.json = { error: String(e) }; }
      try {
        const r = await fetch(`https://steamcommunity.com/profiles/${id}/inventory/`, { headers: { 'User-Agent': UA, Accept: 'text/html' } });
        const h = await r.text();
        out.page = { status: r.status, url: r.url, len: h.length, cs2tab: /games_list_tab_name">\s*Counter-Strike 2\s*</.test(h), cs2count: (h.match(/Counter-Strike 2 \(\d+\)/) ?? [null])[0],
          markers: ['inventory is currently private', 'profile_private_info', 'This profile is private', 'private_profile', 'Sign In', 'g-recaptcha', 'error_ctn'].filter((m) => h.includes(m)), title: (h.match(/<title>([^<]*)/) ?? [null, null])[1] };
      } catch (e) { out.page = { error: String(e) }; }
      return new Response(JSON.stringify(out, null, 1), { headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
    }
    if (url.pathname.startsWith('/app/api/')) return handleAppApi(req, env, nowSec());
    if (url.pathname === '/steam/callback' && req.method === 'GET') return handleSteamCallback(req, env, nowSec());
    if (url.pathname === '/chart' && req.method === 'GET') return handleChart(req, env, nowSec());
    if (url.pathname.startsWith('/card/') && req.method === 'GET') return handleCard(url, env);
    if (url.pathname === '/img' && req.method === 'GET') return handleImgProxy(url, ctx);
    // Публичный адрес ничего не раскрывает.
    if (url.pathname === '/') return new Response('CS2 Market Bot: OK', { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    return new Response('Not Found', { status: 404 });
  },

  async scheduled(_c: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runCycle(env, { now: nowSec() }).then(() => undefined, (e) => {
      console.error('cycle failed', (e as Error).message);
    }));
  },
};
