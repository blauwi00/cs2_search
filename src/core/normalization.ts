export type Wear = 'FN' | 'MW' | 'FT' | 'WW' | 'BS';
export type Category =
  | 'case' | 'capsule' | 'sticker' | 'knife' | 'gloves' | 'weapon' | 'agent' | 'patch'
  | 'graffiti' | 'music_kit' | 'key' | 'pin' | 'other';

export interface ParsedItem {
  marketHashName: string;
  weapon: string | null;
  skin: string | null;
  wear: Wear | null;
  stattrak: boolean;
  souvenir: boolean;
  category: Category;
  /** Цена сильно зависит от конкретного экземпляра (паттерн, фаза, процент Fade, float). */
  uniquePriced: boolean;
}

const WEAR_MAP: Record<string, Wear> = {
  'Factory New': 'FN', 'Minimal Wear': 'MW', 'Field-Tested': 'FT', 'Well-Worn': 'WW', 'Battle-Scarred': 'BS',
};

export const WEAR_RU: Record<Wear, string> = {
  FN: 'Прямо с завода', MW: 'Немного поношенное', FT: 'После полевых испытаний', WW: 'Поношенное', BS: 'Закалённое в боях',
};

/** Скины, у которых цена экземпляра зависит от паттерна/фазы — агрегированная цена для них ненадёжна. */
const PATTERN_SENSITIVE = [
  'Case Hardened', 'Doppler', 'Gamma Doppler', 'Fade', 'Marble Fade', 'Crimson Web', 'Slaughter',
  'Heat Treated', 'Lore', 'Autotronic', 'Black Pearl', 'Ruby', 'Sapphire', 'Emerald',
];

/** Агенты: "Имя | Фракция". Если фракция не распознана — категория 'other', это безопасно. */
const AGENT_FACTIONS = ['The Professionals', 'FBI', 'SEAL Frogman', 'NSWC SEAL', 'Guerrilla Warfare', 'Sabre',
  'Phoenix', 'Elite Crew', 'SWAT', 'Gendarmerie Nationale', 'KSK', 'Brazilian 1st Battalion', 'NZSAS',
  'USAF TACP', 'SAS', 'TACP Cavalry', 'Sabre Footsoldier'];

const GLOVE_PREFIXES = ['Sport Gloves', 'Driver Gloves', 'Hand Wraps', 'Moto Gloves', 'Specialist Gloves',
  'Hydra Gloves', 'Bloodhound Gloves', 'Broken Fang Gloves'];

/** Нормализует market_hash_name. Сравнение ведётся по точной строке; разбор нужен для категорий и защиты от ошибок. */
export function parseMarketHashName(raw: string): ParsedItem {
  const name = raw.trim();
  let rest = name;
  let stattrak = false;
  let souvenir = false;

  // Порядок префиксов: "★ StatTrak™ Karambit | ..." — звезда идёт первой.
  const star = rest.startsWith('★');
  if (star) rest = rest.slice(1).trim();
  if (rest.startsWith('StatTrak™')) { stattrak = true; rest = rest.slice('StatTrak™'.length).trim(); }
  if (rest.startsWith('Souvenir ')) { souvenir = true; rest = rest.slice('Souvenir '.length).trim(); }

  let wear: Wear | null = null;
  const wm = rest.match(/\s\((Factory New|Minimal Wear|Field-Tested|Well-Worn|Battle-Scarred)\)$/);
  if (wm) { wear = WEAR_MAP[wm[1]]; rest = rest.slice(0, wm.index).trim(); }

  let weapon: string | null = null;
  let skin: string | null = null;
  const bar = rest.indexOf(' | ');
  if (bar >= 0) { weapon = rest.slice(0, bar).trim(); skin = rest.slice(bar + 3).trim(); }
  else { weapon = rest || null; }

  let category: Category = 'other';
  const lower = name.toLowerCase();
  if (star && weapon && GLOVE_PREFIXES.some((g) => weapon!.startsWith(g))) category = 'gloves';
  else if (star) category = 'knife';
  else if (lower.startsWith('sticker |') || weapon === 'Sticker') category = 'sticker';
  else if (weapon === 'Patch' || lower.startsWith('patch |')) category = 'patch';
  else if (weapon === 'Sealed Graffiti' || weapon === 'Graffiti') category = 'graffiti';
  else if (lower.startsWith('music kit')) category = 'music_kit';
  else if (/\bcapsule\b/i.test(name) || /\bsticker capsule\b/i.test(name)) category = 'capsule';
  else if (/\bcase key\b/i.test(name)) category = 'key';
  else if (/\bcase\b/i.test(name) && bar < 0) category = 'case';
  else if (/\bpin\b/i.test(name) && bar < 0) category = 'pin';
  else if (wear) category = 'weapon';
  else if (bar >= 0 && !wear && skin !== null && AGENT_FACTIONS.some((f) => skin!.startsWith(f))) category = 'agent';

  const uniquePriced = (category === 'knife' || category === 'gloves')
    || (skin !== null && PATTERN_SENSITIVE.some((p) => skin!.startsWith(p)));

  return { marketHashName: name, weapon, skin, wear, stattrak, souvenir, category, uniquePriced };
}

export const CATEGORY_RU: Record<Category, string> = {
  case: 'Кейс', capsule: 'Капсула', sticker: 'Наклейка', knife: 'Нож', gloves: 'Перчатки', weapon: 'Оружие',
  agent: 'Агент', patch: 'Нашивка', graffiti: 'Граффити', music_kit: 'Набор музыки', key: 'Ключ', pin: 'Значок', other: 'Другое',
};
