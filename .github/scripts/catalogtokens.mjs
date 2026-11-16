// Индекс слов каталога для русского поиска «на слух»: скелет → самые частые слова с таким скелетом.
// skeleton() — копия src/core/skeleton.ts (Worker не может читать .github/scripts, сборщик — src/); тест сверяет их.
const RU = { б: 'p', в: 'f', г: 'k', д: 't', ж: 's', з: 's', к: 'k', л: 'l', м: 'm', н: 'n', п: 'p', р: 'r', с: 's', т: 't', ф: 'f', х: 'h', ц: 's', ч: 's', ш: 's', щ: 's' };
const LAT = { b: 'p', d: 't', f: 'f', g: 'k', h: 'h', j: 's', k: 'k', l: 'l', m: 'm', n: 'n', p: 'p', q: 'k', r: 'r', s: 's', t: 't', v: 'f', w: 'f', x: 'ks', z: 's' };
export function skeleton(word) {
  let w = word.toLowerCase().replace(/ё/g, 'е');
  const isRu = /[а-я]/.test(w);
  let out = '';
  if (isRu) { for (const ch of w) out += RU[ch] ?? ''; }
  else {
    w = w.replace(/sh|ch|zh/g, 's').replace(/th/g, 't').replace(/ph/g, 'f').replace(/ck/g, 'k').replace(/kh/g, 'h').replace(/c(?=[eiy])/g, 's').replace(/c/g, 'k');
    for (const ch of w) out += LAT[ch] ?? '';
  }
  return out.replace(/(.)\1+/g, '$1');
}

/** names — все названия каталога. Возвращает { скелет: [слова по убыванию частоты, не больше 4] } для слов из латинских букв длиной от 3 и скелета от 2 знаков. */
export function buildTokenIndex(names) {
  const freq = new Map();
  for (const n of names) for (const t of String(n).toLowerCase().replace(/[™★|()]/g, ' ').split(/[^a-z]+/)) if (t.length >= 3) freq.set(t, (freq.get(t) ?? 0) + 1);
  const by = new Map();
  for (const [t, c] of freq) { const s = skeleton(t); if (s.length >= 2) (by.get(s) ?? by.set(s, []).get(s)).push([t, c]); }
  const out = {};
  for (const [s, list] of by) out[s] = list.sort((a, b) => b[1] - a[1]).slice(0, 4).map((x) => x[0]);
  return out;
}
