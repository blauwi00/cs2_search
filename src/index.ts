import type { Env } from './env.ts';
import { handleWebhook } from './telegram/webhook.ts';
import { handleAdmin } from './admin.ts';
import { runCycle } from './core/runner.ts';
import { nowSec } from './utils/time.ts';
import { handleChart } from './chart.ts';

export default {
  async fetch(req: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === '/telegram') return handleWebhook(req, env, nowSec());
    if (url.pathname.startsWith('/admin/')) return handleAdmin(req, env, nowSec());
    if (url.pathname === '/chart' && req.method === 'GET') return handleChart(req, env, nowSec());
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
