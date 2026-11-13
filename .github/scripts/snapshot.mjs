// Суточный архив цен: ВСЕ предметы × площадки одним сжатым файлом в приватном репозитории данных (cs2-prices-data).
// Цены — центы USD как в файлах площадок (Skinport переводится из евро по курсу НБУ), без догадок: нет цены — пустая ячейка.
import { gzipSync } from 'node:zlib';

export const COLUMNS = ['steam_24h', 'steam_7d', 'steam_30d', 'steam_90d', 'skinport', 'csgomarket', 'waxpeer', 'lisskins', 'buff163', 'youpin898', 'c5game', 'csfloat', 'csmoney'];
const cents = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 && v < 1e6 ? Math.round(v * 100) : null);

/** Собирает строки: Map<имя, {колонка: центы}> из уже скачанных сборщиком файлов. */
export function collectRows({ steamAvg, sp, eurUsd, markets, files }) {
  const rows = new Map();
  const put = (name, col, c) => { if (c) { let r = rows.get(name); if (!r) rows.set(name, (r = {})); r[col] = c; } };
  for (const [n, v] of steamAvg) { put(n, 'steam_24h', cents(v.d1)); put(n, 'steam_7d', cents(v.d7)); put(n, 'steam_30d', cents(v.d30)); put(n, 'steam_90d', cents(v.d90)); }
  if (eurUsd) for (const [n, eur] of sp) put(n, 'skinport', cents(eur * eurUsd));
  for (const m of ['csgomarket', 'waxpeer', 'lisskins']) for (const [n, v] of markets[m]) put(n, m, cents(v.p));
  const extra = { buff163: 'starting_at', youpin898: 'starting_at', c5game: 'starting_at', csfloat: 'starting_at', csmoney: null };
  for (const [prov, mode] of Object.entries(extra)) for (const [n, x] of Object.entries(files[prov] ?? {})) { const v = mode ? x?.[mode]?.price : x?.price; put(n, prov, cents(Number(v))); }
  return rows;
}

/** TSV: две служебные строки (#дата, #колонки), дальше «название ⇥ цены по колонкам». Названия отсортированы — файл лучше сжимается. */
export function buildTsv(date, rows, srcAt = {}) {
  const lines = [`#date\t${date}`, `#src_at\t${JSON.stringify(srcAt)}`, `#cols\tname\t${COLUMNS.join('\t')}`];
  for (const n of [...rows.keys()].sort()) { const r = rows.get(n); lines.push(n.replace(/[\t\n\r]/g, ' ') + '\t' + COLUMNS.map((c) => r[c] ?? '').join('\t')); }
  return lines.join('\n') + '\n';
}
export const gzipB64 = (text) => gzipSync(Buffer.from(text, 'utf8'), { level: 9 }).toString('base64');

/** Кладёт файл в репозиторий данных через GitHub API; существующий не перезаписывает. Возвращает 'saved' | 'exists'. */
export async function putIfMissing({ repo, token, path, contentB64, message, fetchImpl = fetch }) {
  const base = `https://api.github.com/repos/${repo}/contents/${path}`;
  const h = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'cenolov-archive', 'X-GitHub-Api-Version': '2022-11-28' };
  const g = await fetchImpl(base, { headers: h });
  if (g.status === 200) return 'exists';
  if (g.status !== 404) throw new Error(`GitHub GET ${g.status}`);
  const p = await fetchImpl(base, { method: 'PUT', headers: { ...h, 'Content-Type': 'application/json' }, body: JSON.stringify({ message, content: contentB64 }) });
  if (!p.ok) throw new Error(`GitHub PUT ${p.status}: ${(await p.text()).slice(0, 200)}`);
  return 'saved';
}
export const dayPath = (d) => `daily/${d.slice(0, 4)}/${d.slice(5, 7)}/${d}.tsv.gz`;
