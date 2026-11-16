import { translateQuery } from './core/ruslang.ts';
import { skeleton } from './core/skeleton.ts';

// Поиск предметов по каталогу названий (его присылает сборщик со Skinport раз в сутки).
// Строка каталога: "нормализованное\tоригинальное". Поиск — нативный indexOf по тексту куска,
// без разбора всех 20 тыс. строк в JS: так он укладывается в лимит CPU бесплатного Worker.

/** Нормализация для поиска: регистр, ™/★, дефисы и лишние пробелы не мешают. */
export function norm(s: string): string {
  return s.toLowerCase().replace(/[™★|()]/g, ' ').replace(/[-_]/g, ' ').replace(/\s+/g, ' ').trim();
}

export function catalogLines(names: string[]): string {
  return names.filter((n) => typeof n === 'string' && n.length > 0 && n.length < 200 && !/[\n\t]/.test(n))
    .map((n) => `${norm(n)}\t${n}`).join('\n');
}

/** Ищет названия, содержащие все слова запроса. Короче и «с начала» — выше; StatTrak/Souvenir ниже, если не запрошены. */
export function searchChunks(texts: string[], query: string, limit = 15): string[] {
  const q = norm(query);
  const words = q.split(' ').filter(Boolean);
  if (words.length === 0) return [];
  const longest = [...words].sort((a, b) => b.length - a.length)[0];
  const hits: { n: string; score: number }[] = [];
  const seen = new Set<string>();
  for (const t of texts) {
    let pos = t.indexOf(longest);
    while (pos >= 0 && hits.length < 300) {
      const ls = t.lastIndexOf('\n', pos) + 1;
      let le = t.indexOf('\n', pos);
      if (le < 0) le = t.length;
      const line = t.slice(ls, le);
      const tab = line.indexOf('\t');
      if (tab > 0 && pos - ls < tab) {
        const h = line.slice(0, tab);
        const orig = line.slice(tab + 1);
        if (!seen.has(orig) && words.every((w) => h.includes(w))) {
          seen.add(orig);
          let score = h.length;
          if (h.startsWith(words[0])) score -= 100;
          if (/stattrak|souvenir/.test(h) && !/stattrak|souvenir/.test(q)) score += 50;
          if ((words.includes('gloves') || words.includes('knife')) && orig.startsWith('★')) score -= 200; // «перчатки»/«нож» — сначала сами перчатки и ножи, а не наклейки с таким словом
          hits.push({ n: orig, score });
        }
      }
      pos = t.indexOf(longest, le);
    }
  }
  return hits.sort((a, b) => a.score - b.score).slice(0, limit).map((x) => x.n);
}

export async function searchCatalog(db: D1Database, query: string, limit = 15): Promise<string[]> {
  const r = await db.prepare('SELECT names FROM catalog_chunks ORDER BY chunk').all<{ names: string }>();
  const texts = r.results.map((x) => x.names);
  if (!/[а-яё]/i.test(query)) return searchSmart(texts, query, limit);
  // 1) Официальные русские названия Steam («Горячечные грёзы», «Синобу»), 2) словарь и звуковое сопоставление.
  const official = searchRu(texts, query, limit, await loadRuLines(db));
  if (official.length) return official;
  return searchSmart(texts, query, limit, await loadTokens(db));
}

let ruMemo: { at: number; text: string } | null = null;
export const resetRuMemo = (): void => { ruMemo = null; };
export async function loadRuLines(db: D1Database): Promise<string> {
  const now = Date.now() / 1000;
  if (ruMemo && now - ruMemo.at < 1800) return ruMemo.text;
  const text = (await db.prepare(`SELECT value FROM meta WHERE key = 'catalog_ru'`).first<{ value: string }>())?.value ?? '';
  ruMemo = { at: now, text };
  return text;
}
const noYo = (s: string): string => s.toLowerCase().replace(/ё/g, 'е');
/** Поиск по официальным русским названиям Steam: найденное базовое английское название разворачивается во все предметы каталога (износы, StatTrak™). */
export function searchRu(texts: string[], query: string, limit: number, ruLines: string): string[] {
  if (!ruLines) return [];
  const bases = searchChunks([ruLines], noYo(query), 6);
  const out: string[] = [];
  for (const b of bases) for (const n of searchChunks(texts, b, limit)) if (!out.includes(n) && out.length < limit) out.push(n);
  return out;
}

export type TokenIndex = Record<string, string[]>;
let tokensMemo: { at: number; idx: TokenIndex } | null = null;
export const resetTokensMemo = (): void => { tokensMemo = null; };
export async function loadTokens(db: D1Database): Promise<TokenIndex> {
  const now = Date.now() / 1000;
  if (tokensMemo && now - tokensMemo.at < 1800) return tokensMemo.idx;
  let idx: TokenIndex = {};
  try { idx = JSON.parse((await db.prepare(`SELECT value FROM meta WHERE key = 'catalog_tokens'`).first<{ value: string }>())?.value ?? '{}'); } catch { idx = {}; }
  tokensMemo = { at: now, idx };
  return idx;
}

/**
 * Звуковой поиск: русские слова, которых нет в словаре, сопоставляются со словами каталога по звуковому скелету
 * («килл конфирмед» → «kill confirmed», «блейз» → «blaze»). Перебираем не больше 8 сочетаний кандидатов.
 */
export function searchByEar(texts: string[], query: string, limit: number, tokens: TokenIndex): string[] {
  const t = translateQuery(query);
  const words = t.query.split(' ').filter(Boolean);
  const slots: string[][] = words.map((w) => {
    if (!t.unknown.includes(w)) return [w];
    const sk = w.length >= 4 ? skeleton(w) : '';
    const c = sk.length >= 2 ? tokens[sk] : undefined;
    return c?.length ? c : [w];
  });
  let combos: string[][] = [[]];
  for (const slot of slots) combos = combos.flatMap((c) => slot.slice(0, 3).map((x) => [...c, x])).slice(0, 8);
  for (const c of combos) {
    const r = searchChunks(texts, c.join(' '), limit);
    if (r.length) return r;
  }
  return [];
}

/** Есть ли точное название в каталоге (для карточки скина из поиска). */
export async function catalogHas(db: D1Database, name: string): Promise<boolean> {
  const r = await db.prepare('SELECT names FROM catalog_chunks').all<{ names: string }>();
  // Строка каталога: «упрощённое название<TAB>точное название».
  return r.results.some((x) => (x.names + '\n').includes('\t' + name + '\n'));
}

/** #13: сначала как есть; если в запросе русские/сленговые слова — по переводу; незнакомые русские слова — пробуем без них. */
export function searchSmart(texts: string[], query: string, limit = 15, tokens?: TokenIndex): string[] {
  const t = translateQuery(query);
  if (t.query === norm(query)) return searchChunks(texts, query, limit);
  const hits = searchChunks(texts, t.query, limit);
  if (hits.length) return hits;
  // Есть русские слова вне словаря — сначала звуковое сопоставление, и только потом «поиск без незнакомых слов» (он даёт лишнее).
  if (tokens && t.unknown.length) { const ear = searchByEar(texts, query, limit, tokens); if (ear.length) return ear; }
  // «нож керамбит» → у ножей в названии нет слова knife; незнакомые русские слова — тоже пробуем без них.
  const rest = t.query.split(' ').filter((w) => !t.unknown.includes(w) && w !== 'knife' && w !== 'gloves').join(' ');
  return rest && rest !== t.query ? searchChunks(texts, rest, limit) : [];
}

export async function catalogInfo(db: D1Database): Promise<{ count: number; updatedAt: number | null }> {
  const r = await db.prepare(`SELECT MAX(updated_at) AS u, SUM(LENGTH(names) - LENGTH(REPLACE(names, char(10), '')) + 1) AS n FROM catalog_chunks`)
    .first<{ u: number | null; n: number | null }>();
  return { count: r?.n ?? 0, updatedAt: r?.u ?? null };
}

/** Одна часть каталога = одна строка таблицы. На последней части лишние старые части удаляются. */
export function catalogPartStmts(db: D1Database, part: number, parts: number, names: string[], now: number): D1PreparedStatement[] {
  const stmts = [db.prepare('INSERT OR REPLACE INTO catalog_chunks (chunk, names, updated_at) VALUES (?, ?, ?)').bind(part, catalogLines(names), now)];
  if (part === parts - 1) stmts.push(db.prepare('DELETE FROM catalog_chunks WHERE chunk >= ?').bind(parts));
  return stmts;
}
