// Автоматическая оценка важности новости 0–100 для канала про скины. Без нейросети и токенов: понятные правила, которые можно подправить.
// Главное — влияние на скины и рынок; большие обновления тоже важны; багфиксы — нет; файлы игры (датамайн) про предметы — важны, но с пометкой.
import { parsePatch, marketImpact } from './patchnotes.mjs';

export const IMP_SKIP = 30;      // ниже — новость Valve не публикуем (багфиксы и мелочи)
export const IMP_MIN_EXTRA = 40; // Reddit, датамайн, киберспорт — публикуем от этой оценки
export const IMP_TOP = 70;       // от этой оценки — публикуем сразу, даже сверх суточного лимита

// [шаблон, баллы, причина] — самое сильное совпадение каждой группы считается один раз.
const STRONG = [
  [/\bnew (weapon )?case|\bcase(s)? (added|removed)|operation\b|\bnew collection|collection (added|removed)|removed from (the )?drop|drop pool|souvenir|\bnew (knife|knives|gloves)\b/i, 32, 'кейсы, коллекции, операции или выпадение'],
  [/trade.?up|contract|trade (hold|ban|restriction|protection)|market(place)? (fee|tax|rule|change)|steam market|inventory (limit|change)|storage unit/i, 32, 'торговля, обмен или рынок'],
  [/\bsticker|capsule|\bcharm|graffiti|music kit|\bagent|skin (finish|update|change)|\bnew skin|workshop/i, 22, 'наклейки, брелки, скины, агенты'],
];
const MEDIUM = [
  [/\bkeys?\b|\bdrops?\b|rarity|\bprice|\bwear|\bfloat|\bpattern|\bfinish/i, 10, 'цены и состояние предметов'],
];
const BIG = [
  [/new map|new weapon|new game ?mode|new feature|major update|overhaul|rework|new (animation|model)s?|premier|season/i, 22, 'крупное новое содержимое'],
];

/** Доля строк, которые только про исправления. */
export function bugfixShare(sections) {
  const lines = sections.flatMap((s) => s.items);
  if (!lines.length) return 0;
  return lines.filter((l) => /^(fix(ed|es)?|resolved|corrected|prevent(ed)?|improved (stability|performance))\b/i.test(l) || /\bfix(ed|es)?\b/i.test(l.slice(0, 20))).length / lines.length;
}

/**
 * item: { source: 'valve'|'reddit'|'datamine'|'esports', title, text?, files?, score?, comments? }
 * Возвращает { imp, why[] } — why показываем в предпросмотре владельцу, чтобы было видно, откуда оценка.
 */
export function scoreNews(item) {
  const why = []; let imp = 0;
  const text = `${item.title ?? ''}\n${item.text ?? ''}`;
  const add = (n, r) => { imp += n; why.push(`+${n} ${r}`); };
  const best = (list) => { for (const [re, n, r] of list) if (re.test(text)) return add(n, r); };
  if (item.source === 'valve') {
    add(10, 'официальная новость Valve');
    const sections = parsePatch(item.text);
    const lines = sections.reduce((a, s) => a + s.items.length, 0);
    best(STRONG); best(MEDIUM); best(BIG);
    if (marketImpact(item.text).length) add(20, 'в тексте есть изменения рынка');
    if (lines >= 40) add(12, `большое обновление (${lines} пунктов)`); else if (lines >= 15) add(6, `заметное обновление (${lines} пунктов)`);
    const bf = bugfixShare(sections);
    if (bf >= 0.7 && imp < 55) { imp = Math.min(imp, 20); why.push('почти все пункты — исправления: потолок 20'); }
  } else if (item.source === 'datamine') {
    const files = (item.files ?? []).join(' ');
    if (/items_game|loot_lists?/i.test(files)) add(50, 'менялись предметы или выпадение');
    else if (/collections?|stickers?|cases?|operation/i.test(files)) add(40, 'менялись коллекции, наклейки или кейсы');
    else if (/csgo_english/i.test(files)) add(25, 'менялись названия и тексты предметов');
    best(STRONG);
  } else if (item.source === 'reddit') {
    add(item.score >= 5000 ? 30 : 15, `высокий рейтинг (${item.score})`);
    if ((item.comments ?? 0) >= 800) add(8, 'очень много комментариев');
    best(STRONG); best(MEDIUM); best(BIG);
  } else if (item.source === 'esports') {
    add(10, 'киберспорт');
    if (/stickers?|capsules?/i.test(text)) add(35, 'наклейки или капсулы турнира');
    else if (/\bmajor\b/i.test(text)) add(25, 'мажор');
  }
  return { imp: Math.max(0, Math.min(100, Math.round(imp))), why: why.slice(0, 6) };
}
