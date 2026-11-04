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
  return searchChunks(r.results.map((x) => x.names), query, limit);
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
