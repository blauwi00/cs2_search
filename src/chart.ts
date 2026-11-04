// Этап 3: график цен. Лёгкая HTML-страница с SVG, которую рисует сам Worker (без библиотек и внешних сервисов).
// Ссылка подписана HMAC (ключ ADMIN_KEY): открыть график может только тот, кому бот прислал ссылку.

import type { Env } from './env.ts';
import * as db from './storage/db.ts';
import { esc } from './telegram/api.ts';
import { formatUah } from './utils/money.ts';

const enc = new TextEncoder();

async function hmacHex(key: string, msg: string): Promise<string> {
  const k = await crypto.subtle.importKey('raw', enc.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', k, enc.encode(msg)));
  return [...sig].slice(0, 16).map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function chartUrl(origin: string, adminKey: string, itemId: number, days: number): Promise<string> {
  const s = await hmacHex(adminKey, `chart:${itemId}:${days}`);
  return `${origin}/chart?i=${itemId}&d=${days}&s=${s}`;
}

export interface Series { label: string; color: string; points: { t: number; v: number | null }[] }

/** Разрывы линии там, где данных не было (не рисуем выдуманную интерполяцию). */
export function splitOnGaps(points: { t: number; v: number | null }[], maxGapSec: number): { t: number; v: number }[][] {
  const out: { t: number; v: number }[][] = [];
  let cur: { t: number; v: number }[] = [];
  let lastT: number | null = null;
  for (const p of points) {
    if (p.v === null) { if (cur.length) out.push(cur); cur = []; lastT = null; continue; }
    if (lastT !== null && p.t - lastT > maxGapSec && cur.length) { out.push(cur); cur = []; }
    cur.push({ t: p.t, v: p.v });
    lastT = p.t;
  }
  if (cur.length) out.push(cur);
  return out;
}

export function renderChart(title: string, series: Series[], fromT: number, toT: number, requestedDays: number): string {
  const W = 360, H = 240, L = 58, R = 10, T = 14, B = 30;
  const all = series.flatMap((s) => s.points.map((p) => p.v).filter((v): v is number => v !== null));
  const pointsAll = series.flatMap((s) => s.points.filter((p) => p.v !== null));
  const dataFrom = pointsAll.length ? Math.min(...pointsAll.map((p) => p.t)) : toT;
  const spanDays = (toT - dataFrom) / 86400;
  let svg = '';
  if (all.length < 2) {
    svg = `<text x="${W / 2}" y="${H / 2}" text-anchor="middle" fill="currentColor">Данных пока мало</text>`;
  } else {
    let min = Math.min(...all), max = Math.max(...all);
    if (min === max) { min = Math.max(0, min - 100); max = max + 100; }
    const pad = (max - min) * 0.08;
    min = Math.max(0, min - pad); max = max + pad;
    const x = (t: number) => L + ((t - fromT) / Math.max(1, toT - fromT)) * (W - L - R);
    const y = (v: number) => T + (1 - (v - min) / (max - min)) * (H - T - B);
    for (let i = 0; i <= 4; i++) {
      const v = min + ((max - min) * i) / 4;
      svg += `<line x1="${L}" x2="${W - R}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}" stroke="currentColor" stroke-opacity=".12"/>`;
      svg += `<text x="${L - 4}" y="${(y(v) + 3).toFixed(1)}" font-size="9" text-anchor="end" fill="currentColor" fill-opacity=".7">${Math.round(v / 100)}</text>`;
    }
    for (let i = 0; i <= 3; i++) {
      const t = fromT + ((toT - fromT) * i) / 3;
      const d = new Date(t * 1000).toISOString().slice(5, 10).split('-').reverse().join('.');
      svg += `<text x="${x(t).toFixed(1)}" y="${H - 10}" font-size="9" text-anchor="middle" fill="currentColor" fill-opacity=".7">${d}</text>`;
    }
    const gap = Math.max(3 * 3600, ((toT - fromT) / 60));
    for (const s of series) {
      for (const seg of splitOnGaps(s.points, gap)) {
        if (seg.length === 1) svg += `<circle cx="${x(seg[0].t).toFixed(1)}" cy="${y(seg[0].v).toFixed(1)}" r="2" fill="${s.color}"/>`;
        else svg += `<polyline fill="none" stroke="${s.color}" stroke-width="1.8" points="${seg.map((p) => `${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join(' ')}"/>`;
      }
    }
    svg += `<text x="4" y="${T + 2}" font-size="9" fill="currentColor" fill-opacity=".7">грн</text>`;
  }
  const legend = series.map((s) => {
    const last = [...s.points].reverse().find((p) => p.v !== null);
    return `<div><span style="display:inline-block;width:10px;height:10px;background:${s.color};border-radius:2px"></span> ${esc(s.label)}: ${last ? formatUah(last.v) : 'нет данных'}</div>`;
  }).join('');
  const note = spanDays < requestedDays - 0.5
    ? `Данных за ${spanDays.toFixed(1).replace('.', ',')} дн из запрошенных ${requestedDays} — мониторинг идёт меньше этого срока.`
    : `Период: ${requestedDays} дн.`;
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><style>
:root{color-scheme:light dark}body{font:14px -apple-system,system-ui,sans-serif;margin:0;padding:16px;background:Canvas;color:CanvasText}
h1{font-size:16px;margin:0 0 8px}svg{width:100%;height:auto;max-width:560px}.n{opacity:.7;font-size:12px;margin-top:8px}.l div{margin:3px 0}
</style></head><body><h1>${esc(title)}</h1>
<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="График цены">${svg}</svg>
<div class="l">${legend}</div>
<div class="n">${note} Цены в гривнах. Разрывы линии — периоды без данных (не дорисовываются). Skinport пересчитан по курсу НБУ на момент наблюдения.</div>
</body></html>`;
}

export async function handleChart(req: Request, env: Env, now: number): Promise<Response> {
  const u = new URL(req.url);
  const itemId = Number(u.searchParams.get('i'));
  const days = Number(u.searchParams.get('d'));
  if (!Number.isSafeInteger(itemId) || ![7, 30, 90].includes(days)) return new Response('Bad Request', { status: 400 });
  const expect = await hmacHex(env.ADMIN_KEY, `chart:${itemId}:${days}`);
  const got = u.searchParams.get('s') ?? '';
  let diff = expect.length ^ got.length;
  for (let i = 0; i < expect.length; i++) diff |= expect.charCodeAt(i) ^ (got.charCodeAt(i) || 0);
  if (diff !== 0) return new Response('Forbidden', { status: 403 });

  const item = await db.getItem(env.DB, itemId);
  if (!item) return new Response('Not Found', { status: 404 });
  const from = now - days * 86400;
  const series: Series[] = [];
  const defs: [string, string, string, string][] = [
    ['steam', 'lowest_listing', 'Steam: самое дешёвое объявление', '#7c5cff'],
    ['steam', 'median_24h', 'Steam: медиана продаж 24 ч', '#22a06b'],
    ['skinport', 'lowest_listing', 'Skinport: самое дешёвое объявление', '#e5793b'],
  ];
  for (const [src, type, label, color] of defs) {
    let pts: { t: number; v: number | null }[];
    if (days <= 30) {
      pts = (await db.history(env.DB, itemId, src as 'steam', type, from)).map((h) => ({ t: h.observed_at, v: h.price_kop }));
    } else {
      // Старше 30 дней — дневные агрегаты (сырые снимки удаляются). Для Steam курс не нужен (UAH); для Skinport — пересчёт по последнему курсу.
      const daily = (await env.DB.prepare(
        `SELECT day, last_minor, currency FROM price_daily WHERE item_id = ? AND source = ? AND price_type = ? AND day >= ? ORDER BY day`,
      ).bind(itemId, src, type, new Date(from * 1000).toISOString().slice(0, 10)).all<{ day: string; last_minor: number | null; currency: string }>()).results;
      const fx = daily.some((d) => d.currency !== 'UAH') ? await db.loadLatestFx(env.DB) : null;
      const recent = (await db.history(env.DB, itemId, src as 'steam', type, now - 30 * 86400)).map((h) => ({ t: h.observed_at, v: h.price_kop }));
      pts = [...daily.map((d) => {
        const r = d.currency === 'UAH' ? null : fx?.get(d.currency as 'EUR') ?? null;
        const v = d.last_minor === null ? null : d.currency === 'UAH' ? d.last_minor : r ? Math.round((d.last_minor * r.rateMicro) / 1e6) : null;
        return { t: Date.parse(d.day + 'T12:00:00Z') / 1000, v };
      }), ...recent];
    }
    if (pts.length) series.push({ label, color, points: pts });
  }
  return new Response(renderChart(item.market_hash_name, series, from, now, days), {
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'private, max-age=60', 'X-Robots-Tag': 'noindex' },
  });
}
