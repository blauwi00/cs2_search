// Картинки предметов для «Поделиться инвентарём»: приложение рисует картинку на canvas, а CDN Steam не отдаёт
// заголовок CORS — без него браузер не даёт сохранить нарисованное. Отдаём ту же картинку со своего адреса.
// Только CDN Steam (не открытый прокси), кэш на неделю.
const PROXY_OK = /^https:\/\/(community\.(akamai|cloudflare|fastly)\.steamstatic\.com|steamcommunity-a\.akamaihd\.net)\/economy\/image\/[A-Za-z0-9_\-./]+$/;

export async function handleImgProxy(url: URL, ctx: ExecutionContext, fetcher: typeof fetch = fetch): Promise<Response> {
  const u = url.searchParams.get('u') ?? '';
  if (u.length > 600 || !PROXY_OK.test(u)) return new Response('Bad image', { status: 400 });
  const cache = typeof caches !== 'undefined' ? (caches as unknown as { default: Cache }).default : null;
  const key = new Request(`https://img-cache.local/${encodeURIComponent(u)}`);
  const hit = cache ? await cache.match(key) : undefined;
  if (hit) return hit;
  const r = await fetcher(u, { cf: { cacheTtl: 604800, cacheEverything: true } } as RequestInit);
  const type = r.headers.get('Content-Type') ?? '';
  if (!r.ok || !/^image\//.test(type)) return new Response('Not found', { status: 404 });
  const body = await r.arrayBuffer();
  if (body.byteLength > 2_000_000) return new Response('Too big', { status: 413 });
  const res = new Response(body, { headers: { 'Content-Type': type, 'Cache-Control': 'public, max-age=604800', 'Access-Control-Allow-Origin': '*' } });
  if (cache) ctx.waitUntil(cache.put(key, res.clone()));
  return res;
}
