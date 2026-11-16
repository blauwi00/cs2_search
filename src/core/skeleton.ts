/**
 * Звуковой «скелет» слова: русское «блейз» и английское «Blaze» дают один скелет, поэтому игроки находят скины, называя их
 * по-русски на слух («килл конфирмед», «тайгер», «хайпер бист»). Гласные выбрасываются, парные согласные сливаются.
 * ВАЖНО: функция продублирована в .github/scripts/catalogtokens.mjs (сборщик строит индекс слов каталога); тест сверяет обе.
 */
const RU: Record<string, string> = {
  б: 'p', в: 'f', г: 'k', д: 't', ж: 's', з: 's', к: 'k', л: 'l', м: 'm', н: 'n', п: 'p', р: 'r', с: 's', т: 't', ф: 'f', х: 'h', ц: 's', ч: 's', ш: 's', щ: 's',
};
const LAT: Record<string, string> = { b: 'p', d: 't', f: 'f', g: 'k', h: 'h', j: 's', k: 'k', l: 'l', m: 'm', n: 'n', p: 'p', q: 'k', r: 'r', s: 's', t: 't', v: 'f', w: 'f', x: 'ks', z: 's' };

export function skeleton(word: string): string {
  let w = word.toLowerCase().replace(/ё/g, 'е');
  const isRu = /[а-я]/.test(w);
  let out = '';
  if (isRu) {
    for (const ch of w) out += RU[ch] ?? '';
  } else {
    w = w.replace(/sh|ch|zh/g, 's').replace(/th/g, 't').replace(/ph/g, 'f').replace(/ck/g, 'k').replace(/kh/g, 'h').replace(/c(?=[eiy])/g, 's').replace(/c/g, 'k');
    for (const ch of w) out += LAT[ch] ?? '';
  }
  return out.replace(/(.)\1+/g, '$1');
}
