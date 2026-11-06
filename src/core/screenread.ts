// Чтение скриншотов сайтов («предметы в продаже», история продаж) встроенной нейросетью Cloudflare (Workers AI, бесплатный лимит).
// Нейросеть только переписывает текст карточек; сопоставление с предметами Steam — здесь, по словарю локализации игры
// (русское название → английское) и по инвентарю пользователя. Ничего не записывается без проверки человеком.

export const VISION_MODEL = '@cf/meta/llama-3.2-11b-vision-instruct';

export const VISION_PROMPT = `This is a phone screenshot of a CS2 skin marketplace (the text may be in Russian).
List EVERY item card you can see, top to bottom, left to right. For each card copy the text exactly as written:
- "type": the small line above the big name (weapon or item type), e.g. "MP5-SD", "Автомат «Галиль»", "StatTrak™ Tec-9", "Сувенирный P250", "Контейнер"
- "name": the big bold item name
- "wear": the first words of the grey line under the name if it is a wear/quality (e.g. "После полевых испытаний", "Field-Tested"), else ""
- "price": the big main price exactly as written, e.g. "3,47" (NOT the smaller reference price)
- "currency": e.g. "PLN", "EUR", "USD", "UAH"
- "float": the float number if shown (e.g. "0.347"), else ""
Answer ONLY with a JSON array, no other text:
[{"type":"","name":"","wear":"","price":"","currency":"","float":""}]`;

export interface ReadRow { type: string; name: string; wear: string; price: string; currency: string; float: string }

/** Достаём JSON-массив из ответа нейросети (она иногда добавляет текст вокруг). */
export function parseVision(text: string): ReadRow[] {
  const a = text.indexOf('['), b = text.lastIndexOf(']');
  if (a < 0) return [];
  let arr: unknown;
  try { if (b <= a) throw new Error('cut'); arr = JSON.parse(text.slice(a, b + 1)); } catch {
    // Обрезанный ответ: берём целые объекты.
    const objs = text.slice(a).match(/\{[^{}]*\}/g) ?? [];
    arr = objs.map((o) => { try { return JSON.parse(o); } catch { return null; } }).filter(Boolean);
  }
  if (!Array.isArray(arr)) return [];
  const s = (v: unknown, n = 120) => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '').replace(/\s+/g, ' ').trim().slice(0, n);
  return arr.slice(0, 40).map((r: Record<string, unknown>) => ({
    type: s(r?.type), name: s(r?.name), wear: s(r?.wear, 60), price: s(r?.price, 20), currency: s(r?.currency, 8).toUpperCase(), float: s(r?.float, 12),
  })).filter((r) => r.name);
}

/** «3,47» / «1 234,50» / «0.31» → 347 (сотые доли валюты). */
export function parsePriceMinor(p: string): number | null {
  const t = p.replace(/[^\d.,]/g, '');
  if (!t) return null;
  const m = t.match(/^(\d{1,3}(?:[ .]?\d{3})*|\d+)(?:[.,](\d{1,2}))?$/);
  const norm = m ? m[1].replace(/[ .]/g, '') + '.' + (m[2] ?? '0') : t.replace(',', '.');
  const v = Number(norm);
  return Number.isFinite(v) && v > 0 && v < 1e7 ? Math.round(v * 100) : null;
}

export const WEAR_RU: [string, string][] = [
  ['прямо с завода', 'Factory New'], ['немного поношенное', 'Minimal Wear'], ['после полевых испытаний', 'Field-Tested'],
  ['поношенное', 'Well-Worn'], ['закалённое в боях', 'Battle-Scarred'], ['закаленное в боях', 'Battle-Scarred'],
];
const WEAR_EN = ['Factory New', 'Minimal Wear', 'Field-Tested', 'Well-Worn', 'Battle-Scarred'];

export interface NamesRu { w: Record<string, string>; p: Record<string, string[]>; c: Record<string, string> }

function wearOf(w: string): string | null {
  const l = w.toLowerCase();
  for (const e of WEAR_EN) if (l.startsWith(e.toLowerCase())) return e;
  // «поношенное» — только если это не «немного поношенное»
  for (const [r, e] of WEAR_RU) if (l.startsWith(r)) return e;
  return null;
}

const norm = (s: string) => s.toLowerCase().replace(/[«»"'`’]/g, '').replace(/ё/g, 'е').replace(/\s+/g, ' ').trim();

/** Возможные английские названия (market_hash_name) для строки со скриншота. */
export function candidates(r: ReadRow, dict: NamesRu | null): string[] {
  const d = dict ?? { w: {}, p: {}, c: {} };
  const type = r.type.replace(/\s+/g, ' ').trim();
  const st = /stattrak/i.test(type);
  const souv = /^(сувенирн|souvenir)/i.test(type);
  const knife = type.startsWith('★') || r.name.startsWith('★');
  let weapon = type.replace(/stattrak(™|tm)?/i, '').replace(/^(сувенирн\S*|souvenir)\s*/i, '').replace(/^★\s*/, '').trim();
  const nameNorm = norm(r.name);
  // Кейсы и контейнеры: одно название без износа.
  const caseHit = Object.entries(d.c).find(([ru]) => norm(ru) === nameNorm);
  if (caseHit || /^(контейнер|container|case|кейс)$/i.test(weapon)) return caseHit ? [caseHit[1]] : [r.name];
  const wEntry = Object.entries(d.w).find(([ru]) => norm(ru) === norm(weapon));
  if (wEntry) weapon = wEntry[1];
  const paints = Object.entries(d.p).find(([ru]) => norm(ru) === nameNorm)?.[1] ?? [r.name];
  const wear = wearOf(r.wear);
  const out: string[] = [];
  for (const p of paints) {
    const base = `${knife ? '★ ' : ''}${st ? (knife ? 'StatTrak™ ' : 'StatTrak™ ') : ''}${souv ? 'Souvenir ' : ''}${weapon} | ${p}`;
    out.push(wear ? `${base} (${wear})` : base);
  }
  return out;
}

/** Ищем среди известных названий (инвентарь, покупки) — сначала точное, потом без учёта регистра. */
export function matchName(cands: string[], known: string[]): string | null {
  for (const c of cands) if (known.includes(c)) return c;
  const low = new Map(known.map((k) => [k.toLowerCase(), k]));
  for (const c of cands) { const k = low.get(c.toLowerCase()); if (k) return k; }
  // Без износа (если нейросеть не прочитала износ) — единственный подходящий предмет.
  for (const c of cands) {
    const base = c.replace(/ \([^)]*\)$/, '').toLowerCase();
    const hits = known.filter((k) => k.toLowerCase().replace(/ \([^)]*\)$/, '') === base);
    if (hits.length === 1) return hits[0];
  }
  return null;
}
