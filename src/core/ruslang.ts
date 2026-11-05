// #13: поиск по русским и сленговым названиям («калаш азимов фт», «керамбит допплер», «кейс революция»).
// Запрос переводится в английские слова каталога; неизвестные слова остаются как есть (их ищем отдельно).

const PHRASES: [string, string][] = [
  // Износ
  ['прямо с завода', 'factory new'], ['немного поношенное', 'minimal wear'], ['немного поношенный', 'minimal wear'],
  ['после полевых испытаний', 'field tested'], ['после полевых', 'field tested'], ['полевые испытания', 'field tested'],
  ['закаленное в боях', 'battle scarred'], ['закаленный в боях', 'battle scarred'], ['закалённое в боях', 'battle scarred'],
  ['поношенное', 'well worn'], ['поношенный', 'well worn'],
  // Скины и коллекции (несколько слов)
  ['красная линия', 'redline'], ['неоновая революция', 'neon revolution'], ['неон революшн', 'neon revolution'],
  ['драгон лор', 'dragon lore'], ['дракон лор', 'dragon lore'], ['кровавая паутина', 'crimson web'], ['кримсон веб', 'crimson web'],
  ['мраморный градиент', 'marble fade'], ['марбл фейд', 'marble fade'], ['тигровый зуб', 'tiger tooth'], ['тайгер тус', 'tiger tooth'],
  ['гамма допплер', 'gamma doppler'], ['гамма доплер', 'gamma doppler'], ['дамасская сталь', 'damascus steel'],
  ['черная жемчужина', 'black pearl'], ['чёрная жемчужина', 'black pearl'], ['блэк перл', 'black pearl'],
  ['огненный змей', 'fire serpent'], ['файр серпент', 'fire serpent'], ['дикий лотос', 'wild lotus'],
  ['сны и кошмары', 'dreams nightmares'], ['опасная зона', 'danger zone'], ['расколотая сеть', 'shattered web'],
  ['сломанный клык', 'broken fang'], ['змеиный укус', 'snakebite'], ['поверхностная закалка', 'case hardened'],
  ['кейс хардened', 'case hardened'], ['кейс харденед', 'case hardened'], ['пустынный орел', 'desert eagle'], ['пустынный орёл', 'desert eagle'],
  ['нож бабочка', 'butterfly knife'], ['музыкальный набор', 'music kit'],
];

const WORDS: Record<string, string> = {
  // Оружие
  'ак': 'ak 47', 'ак47': 'ak 47', 'калаш': 'ak 47', 'калашников': 'ak 47', 'акм': 'ak 47',
  'авп': 'awp', 'авик': 'awp', 'слон': 'awp', 'слона': 'awp',
  'м4': 'm4a4', 'м4а4': 'm4a4', 'эмка': 'm4a1 s', 'м4а1': 'm4a1 s', 'м4а1с': 'm4a1 s',
  'дигл': 'desert eagle', 'дигла': 'desert eagle', 'дезерт': 'desert eagle',
  'юсп': 'usp s', 'усп': 'usp s', 'глок': 'glock 18', 'глока': 'glock 18',
  'п250': 'p250', 'п2000': 'p2000', 'файвсевен': 'five seven', 'тек9': 'tec 9', 'тек': 'tec 9',
  'беретты': 'dual berettas', 'беретта': 'dual berettas', 'дуалы': 'dual berettas', 'ревик': 'r8 revolver', 'револьвер': 'r8 revolver',
  'мп9': 'mp9', 'мп7': 'mp7', 'мп5': 'mp5 sd', 'мак10': 'mac 10', 'мак': 'mac 10', 'уми': 'ump 45', 'юмп': 'ump 45',
  'п90': 'p90', 'бизон': 'pp bizon', 'фамас': 'famas', 'галил': 'galil ar', 'ауг': 'aug', 'сиг': 'sg 553',
  'скаут': 'ssg 08', 'муха': 'ssg 08', 'нова': 'nova', 'обрез': 'sawed off', 'маг7': 'mag 7', 'негев': 'negev', 'зевс': 'zeus x27',
  // Ножи и перчатки
  'нож': 'knife', 'ножи': 'knife', 'керамбит': 'karambit', 'карамбит': 'karambit', 'бабочка': 'butterfly', 'батерфляй': 'butterfly',
  'штык': 'bayonet', 'байонет': 'bayonet', 'м9': 'm9 bayonet', 'фальшион': 'falchion', 'тычки': 'shadow daggers', 'тычковые': 'shadow daggers',
  'боуи': 'bowie', 'охотничий': 'huntsman', 'наваха': 'navaja', 'стилет': 'stiletto', 'урсус': 'ursus', 'талон': 'talon',
  'паракорд': 'paracord', 'скелет': 'skeleton', 'скелетон': 'skeleton', 'кукри': 'kukri', 'флип': 'flip', 'гут': 'gut',
  'перчатки': 'gloves', 'перчатка': 'gloves', 'перчи': 'gloves', 'обмотки': 'hand wraps',
  // Прочее
  'кейс': 'case', 'кейсы': 'case', 'капсула': 'capsule', 'наклейка': 'sticker', 'наклейки': 'sticker', 'стикер': 'sticker',
  'брелок': 'charm', 'брелки': 'charm', 'граффити': 'graffiti', 'нашивка': 'patch', 'ключ': 'key', 'значок': 'pin',
  'сувенир': 'souvenir', 'сувенирный': 'souvenir', 'статтрек': 'stattrak', 'стат': 'stattrak', 'ст': 'stattrak',
  // Износ сокращённо
  'фн': 'factory new', 'мв': 'minimal wear', 'фт': 'field tested', 'вв': 'well worn', 'бс': 'battle scarred',
  'fn': 'factory new', 'mw': 'minimal wear', 'ft': 'field tested', 'ww': 'well worn', 'bs': 'battle scarred', 'st': 'stattrak',
  // Скины (одно слово)
  'азимов': 'asiimov', 'азимова': 'asiimov', 'редлайн': 'redline', 'вулкан': 'vulcan', 'гипербист': 'hyper beast', 'хайпербист': 'hyper beast',
  'медуза': 'medusa', 'градиент': 'fade', 'фейд': 'fade', 'допплер': 'doppler', 'доплер': 'doppler', 'паутина': 'crimson web',
  'дамаск': 'damascus steel', 'ультрафиолет': 'ultraviolet', 'изумруд': 'emerald', 'рубин': 'ruby', 'сапфир': 'sapphire',
  'хаул': 'howl', 'вой': 'howl', 'гидропоника': 'hydroponic', 'ягуар': 'jaguar', 'кошмар': 'nightmare', 'призрак': 'phantom',
  'нео': 'neo noir', 'нуар': 'neo noir', 'принт': 'printstream', 'принтстрим': 'printstream', 'кибер': 'cyber security',
  'ночь': 'night', 'урбан': 'urban', 'сафари': 'safari mesh', 'буря': 'storm', 'лес': 'forest',
  // Команды (наклейки)
  'нави': 'natus vincere', 'фейз': 'faze', 'спирит': 'spirit', 'виталити': 'vitality', 'джитуб': 'g2', 'г2': 'g2',
  // Кейсы
  'революция': 'revolution', 'киловатт': 'kilowatt', 'разлом': 'fracture', 'фрактур': 'fracture', 'призма': 'prisma', 'хрома': 'chroma',
  'спектр': 'spectrum', 'гамма': 'gamma', 'клатч': 'clutch', 'горизонт': 'horizon', 'отдача': 'recoil', 'рекойл': 'recoil',
  'галерея': 'gallery', 'лихорадка': 'fever', 'фивер': 'fever', 'грёзы': 'dreams', 'грезы': 'dreams',
};

/** Перевод запроса: { query — для поиска, unknown — русские слова, которых нет в словаре }. */
export function translateQuery(q: string): { query: string; unknown: string[] } {
  let s = ` ${q.toLowerCase().replace(/ё/g, 'е').replace(/[|()™★]/g, ' ').replace(/[-_]/g, ' ').replace(/\s+/g, ' ').trim()} `;
  // «ак-47»/«ак 47» → один токен; «м4 а1» → м4а1
  s = s.replace(/ ак 47 /g, ' ак47 ').replace(/ м4 а1 ?с? /g, ' м4а1 ').replace(/ м4 а4 /g, ' м4а4 ').replace(/ p ?250 /g, ' p250 ');
  for (const [ru, en] of PHRASES) s = s.split(` ${ru.replace(/ё/g, 'е')} `).join(` ${en} `);
  const unknown: string[] = [];
  const out = s.trim().split(' ').filter(Boolean).map((w) => {
    if (WORDS[w]) return WORDS[w];
    if (/[а-я]/.test(w)) unknown.push(w);
    return w;
  });
  return { query: out.join(' '), unknown };
}
