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

export default {
  async fetch(req: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === '/telegram') return handleWebhook(req, env, nowSec());
    if (url.pathname.startsWith('/admin/')) return handleAdmin(req, env, nowSec());
    if (url.pathname === '/ingest' || url.pathname === '/ingest/items') return handleIngest(req, env, nowSec());
    if (url.pathname === '/app' && req.method === 'GET') {
      return new Response(APP_HTML, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache', 'X-Robots-Tag': 'noindex' } });
    }
    if (url.pathname.startsWith('/app/api/')) return handleAppApi(req, env, nowSec());
    if (url.pathname === '/steam/callback' && req.method === 'GET') return handleSteamCallback(req, env, nowSec());
    if (url.pathname === '/chart' && req.method === 'GET') return handleChart(req, env, nowSec());
    if (url.pathname.startsWith('/card/') && req.method === 'GET') return handleCard(url, env);
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
