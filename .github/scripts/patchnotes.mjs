// Краткое содержание патчноута CS2 на русском: разбор разделов и пунктов + перевод через MyMemory
// (бесплатный открытый API перевода, ~5000 символов в день без ключа — для 1–3 обновлений в неделю хватает).

const SECTION_RU = {
  MAPS: 'Карты', MAP: 'Карты', GAMEPLAY: 'Геймплей', MISC: 'Разное', MISCELLANEOUS: 'Разное', AUDIO: 'Звук', SOUND: 'Звук', ANIMATION: 'Анимация', ANIMATIONS: 'Анимация',
  UI: 'Интерфейс', HUD: 'Интерфейс', ITEMS: 'Предметы', ITEM: 'Предметы', 'CS2': 'CS2', PREMIER: 'Премьер', COMPETITIVE: 'Соревновательный', MATCHMAKING: 'Матчмейкинг',
  WEAPONS: 'Оружие', WEAPON: 'Оружие', GRAPHICS: 'Графика', RENDERING: 'Графика', NETWORKING: 'Сеть', NETWORK: 'Сеть', 'ANTI-CHEAT': 'Античит', VAC: 'Античит',
  INVENTORY: 'Инвентарь', ECONOMY: 'Экономика', MARKET: 'Торговая площадка', TRADING: 'Обмен', SPECTATING: 'Наблюдение', 'GAME MODES': 'Режимы', DEATHMATCH: 'Бой насмерть',
  ARMORY: 'Арсенал', STEAM: 'Steam', MOVEMENT: 'Передвижение', CHARACTERS: 'Персонажи', 'CHARACTER': 'Персонажи', WORKSHOP: 'Мастерская', SDK: 'SDK', LINUX: 'Linux',
};
const MARKET = /\b(case|cases|capsule|sticker|stickers|charm|keychain|armory|operation|collection|souvenir|trade|trading|market|inventory|drop|drops|skin|skins|graffiti|agent|patch|music kit)\b/i;

/** BBCode/HTML патчноута → разделы с пунктами. */
// Что изменение обычно значит для цен — правила из гайдов по трейдингу скинов (не прогноз, а типичная реакция рынка).
const IMPACT = [
  [/(removed|retired|moved)\b[^.]{0,60}\b(drop pool|active drop|rare drop)|no longer (drop|be dropped|available)/i,
    'Кейсы или коллекции уходят из выпадения: их становится меньше — обычно со временем дорожают (не за один день).'],
  [/\b(added|new|introduc\w+)\b[^.]{0,40}\b(case|collection|operation)\b/i,
    'Новый кейс или коллекция: в первые дни цены самые высокие, потом падают — покупать сразу обычно невыгодно.'],
  [/\barmory\b/i,
    'Изменения в Арсенале: новые предметы оттуда сначала дорогие, потом дешевеют по мере выпадения.'],
  [/sticker capsule|souvenir|\bmajor\b/i,
    'Наклейки и сувениры мейджора: дешевле всего обычно во время турнира, дорожают после снятия капсул с продажи.'],
  [/trade (hold|protection|lock)|trade.?ban|community market|market (fee|listing)|trading (rules|restriction)/i,
    'Изменены правила обмена или Торговой площадки — цены могут резко дёрнуться; не спеши покупать или продавать в первые часы.'],
  [/trade.?up|contract/i,
    'Изменены контракты обмена — это может сдвинуть цены дешёвых скинов, из которых их собирают.'],
  [/(skin|finish|pattern|texture|wear|float|model)s?\b[^.]{0,40}\b(updated|changed|adjusted|reworked|fixed)/i,
    'Изменён внешний вид скинов — цены затронутых предметов могут сильно измениться в любую сторону.'],
];
export function marketImpact(raw) {
  const t = String(raw ?? '').replace(/\[[^\]]{1,40}\]/g, ' ');
  return IMPACT.filter(([re]) => re.test(t)).map(([, ru]) => ru).slice(0, 3);
}

export function parsePatch(raw) {
  const text = String(raw ?? '')
    .replace(/\{STEAM_CLAN_IMAGE\}[^\s\]]*/g, ' ')
    .replace(/\[\*\]/g, '\n- ').replace(/\[\/?(p|list|ul|ol|li|h[1-6]|b|i|u|url[^\]]*|img[^\]]*)\]/gi, '\n')
    .replace(/<\/?(p|br|li|ul|h\d)[^>]*>/gi, '\n').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  const sections = [];
  let cur = { name: null, items: [] };
  let sub = null;
  for (let line of text.split('\n')) {
    line = line.replace(/\s+/g, ' ').trim();
    if (!line) continue;
    const head = line.match(/^\[\s*([A-Z0-9 &/\-]{2,40})\s*\]$/) || (line.length <= 30 && /^[A-Z0-9 &/\-]+$/.test(line) && /[A-Z]{3}/.test(line) ? [null, line] : null);
    if (head) { if (cur.items.length) sections.push(cur); cur = { name: head[1].trim(), items: [] }; sub = null; continue; }
    const item = line.replace(/^[-*•]\s*/, '');
    // «Mirage», «Dust II», «Inferno» — подзаголовок (карта): добавляем его к следующим пунктам.
    if (item.split(' ').length <= 3 && item.length <= 24 && !/[.,:;!?]/.test(item)) { sub = item; continue; }
    if (item.length >= 8 && !/^https?:\/\//.test(item)) cur.items.push(sub ? `${sub}: ${item}` : item);
  }
  if (cur.items.length) sections.push(cur);
  return sections;
}

/** Отбор: сначала всё, что касается рынка (кейсы, наклейки, обмен…), потом по 2 пункта из каждого раздела, всего ≤ 9. */
export function pickSummary(sections, max = 9) {
  const market = [];
  for (const s of sections) for (const it of s.items) if (MARKET.test(it) && market.length < 3) market.push(it);
  const picked = [];
  let left = max - market.length;
  for (const s of sections) {
    const items = s.items.filter((x) => !market.includes(x)).slice(0, 2);
    if (!items.length || left <= 0) continue;
    const take = items.slice(0, Math.min(items.length, left));
    picked.push({ name: s.name, items: take });
    left -= take.length;
  }
  const total = sections.reduce((a, s) => a + s.items.length, 0);
  const shown = market.length + picked.reduce((a, s) => a + s.items.length, 0);
  return { market, sections: picked, more: Math.max(0, total - shown) };
}

export async function translate(text, sleep) {
  const q = text.length > 300 ? text.slice(0, 297) + '…' : text;
  const r = await fetch(`https://api.mymemory.translated.net/get?langpair=en|ru&q=${encodeURIComponent(q)}`, { headers: { 'User-Agent': 'cenolov-bot/1.0' } });
  if (!r.ok) throw new Error(`MyMemory HTTP ${r.status}`);
  const j = await r.json();
  const t = j?.responseData?.translatedText;
  if (j?.responseStatus !== 200 || typeof t !== 'string' || !t || /MYMEMORY WARNING|QUOTA/i.test(t)) throw new Error(`перевод недоступен: ${String(j?.responseDetails ?? '').slice(0, 80)}`);
  await sleep(400);
  return t.replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&');
}

/** Полный патчноут → { title_ru, summary } для Worker. Ошибка перевода — исключение (попробуем в следующий запуск). */
export async function russianSummary(item, sleep) {
  const sections = parsePatch(item.contents);
  const pick = pickSummary(sections);
  const tr = (x) => translate(x, sleep);
  const titleRu = /^Counter-Strike 2 Update$/i.test(item.title) ? 'Обновление Counter-Strike 2' : await tr(item.title);
  const market = [];
  for (const m of pick.market) market.push(await tr(m));
  const out = [];
  for (const s of pick.sections) {
    const items = [];
    for (const it of s.items) items.push(await tr(it));
    const key = (s.name ?? '').toUpperCase();
    out.push({ name: s.name ? SECTION_RU[key] ?? (await tr(s.name)) : null, items });
  }
  return { titleRu, summary: { market, sections: out, more: pick.more, impact: marketImpact(item.contents) } };
}
