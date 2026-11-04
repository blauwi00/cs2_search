// Картинка поста канала: /card/<слот-дата>.jpg (её забирает Telegram для превью над постом).
import type { Env } from './env.ts';

export async function handleCard(url: URL, env: Env): Promise<Response> {
  const m = url.pathname.match(/^\/card\/((?:ideas|trends|cases|weekly)-\d{4}-\d{2}-\d{2})\.jpg$/);
  if (!m) return new Response('Not Found', { status: 404 });
  const r = await env.DB.prepare('SELECT jpg_b64 FROM cards WHERE id = ?').bind(m[1]).first<{ jpg_b64: string }>();
  if (!r) return new Response('Not Found', { status: 404 });
  const bin = Uint8Array.from(atob(r.jpg_b64), (c) => c.charCodeAt(0));
  return new Response(bin, { headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=604800' } });
}
