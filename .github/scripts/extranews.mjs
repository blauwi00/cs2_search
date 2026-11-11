// Дополнительные новости для канала: Reddit (самое обсуждаемое), файлы игры (датамайн), киберспорт (мажоры и капсулы).
// По умолчанию — пробный режим: только пишем в журнал, что нашли и какой код ответил источник. В Worker отправляется лишь то,
// что перечислено в переменной EXTRA_NEWS (например «reddit,datamine,esports»). Тексты постов и ники не копируем: заголовок, ссылка, рейтинг.
import { translate } from './patchnotes.mjs';
import { scoreNews, IMP_MIN_EXTRA } from './newsscore.mjs';

export const REDDIT_MIN_SCORE = 2000;
export const REDDIT_MIN_COMMENTS = 200;
// Слухи, утечки, торговые объявления и раздачи — не публикуем.
export const BAD_TITLE = /leak|rumou?r|giveaway|wtb\b|wts\b|\btrad(e|ing)\b|\[h\]|\[w\]|\bselling\b|\bbuying\b|scam|unconfirmed|\bgiving away\b/i;
export const ESPORTS_TITLE = /\b(major|champions|grand final|iem|blast|pgl|esl pro league|cologne|austin|katowice|stickers?|capsules?)\b/i;
export const DATAMINE_FILES = /(items_game|csgo_english|loot_lists?|collections?|stickers?|cases?|operation|econ)/i;

const scoreOf = (it) => { const r = scoreNews(it); return { imp: r.imp, why: r.why.join('; ') }; };
const clean = (s, n = 200) => String(s ?? '').replace(/[\u0000-\u001f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);

/** Листинг Reddit (top.json) → кандидаты. Берём самые обсуждаемые не-торговые посты. */
export function pickReddit(listing, limit = 1) {
  const out = [];
  for (const c of listing?.data?.children ?? []) {
    const d = c?.data; if (!d || d.stickied || d.over_18) continue;
    if (!(d.score >= REDDIT_MIN_SCORE) || !(d.num_comments >= REDDIT_MIN_COMMENTS)) continue;
    const title = clean(d.title); if (!title || BAD_TITLE.test(title) || BAD_TITLE.test(String(d.link_flair_text ?? ''))) continue;
    if (!/^[a-z0-9]{3,12}$/.test(String(d.id ?? '')) || !String(d.permalink ?? '').startsWith('/r/')) continue;
    const it = { gid: 'r_' + d.id, source: 'reddit', title, url: 'https://www.reddit.com' + d.permalink, date: Math.floor(d.created_utc), score: d.score, comments: d.num_comments };
    out.push({ ...it, ...scoreOf(it) });
  }
  return out.filter((x) => x.imp >= IMP_MIN_EXTRA).sort((a, b) => b.imp - a.imp || b.score - a.score).slice(0, limit);
}

/** RSS киберспорта (HLTV) → только мажоры, крупные турниры и наклейки/капсулы. */
export function pickEsports(xml, limit = 1) {
  const out = [];
  for (const m of String(xml ?? '').matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const g = (t) => (m[1].match(new RegExp(`<${t}>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?</${t}>`)) ?? [])[1];
    const title = clean(g('title')), link = clean(g('link'), 300), pub = Date.parse(g('pubDate') ?? '');
    if (!title || !ESPORTS_TITLE.test(title) || BAD_TITLE.test(title) || !/^https:\/\/www\.hltv\.org\/news\/(\d+)/.test(link) || !Number.isFinite(pub)) continue;
    const it = { gid: 'e_' + link.match(/news\/(\d+)/)[1], source: 'esports', title, url: link, date: Math.floor(pub / 1000) };
    out.push({ ...it, ...scoreOf(it) });
  }
  return out.filter((x) => x.imp >= IMP_MIN_EXTRA).sort((a, b) => b.imp - a.imp || b.date - a.date).slice(0, limit);
}

/** Коммиты репозитория с изменениями файлов игры → только те, где менялись предметы, названия, коллекции, наклейки, операции. */
export function pickDatamine(commits, limit = 1) {
  const out = [];
  for (const c of commits ?? []) {
    const files = (c.files ?? []).map((f) => String(f.filename ?? '')).filter((f) => DATAMINE_FILES.test(f));
    if (!files.length || !/^[0-9a-f]{7,40}$/.test(String(c.sha ?? ''))) continue;
    // Понятные названия вместо имён файлов.
    const RU = [[/items_game|loot_lists?/i, 'предметы и выпадение'], [/stickers?/i, 'наклейки'], [/collections?/i, 'коллекции'], [/cases?/i, 'кейсы'], [/operation/i, 'операция'], [/csgo_english/i, 'тексты и названия'], [/econ/i, 'предметы']];
    const names = [...new Set(files.map((f) => (RU.find(([re]) => re.test(f)) ?? [0, f.split('/').pop()])[1]))].slice(0, 3);
    const date = Math.floor(Date.parse(c.commit?.committer?.date ?? '') / 1000);
    if (!Number.isFinite(date)) continue;
    const it = { gid: 'd_' + c.sha.slice(0, 12), source: 'datamine', title: `В файлах игры нашли изменения: ${names.join(', ')}`, titleRu: `В файлах игры нашли изменения: ${names.join(', ')}`, url: `https://github.com/SteamDatabase/GameTracking-CS2/commit/${c.sha}`, date, files };
    out.push({ ...it, ...scoreOf(it) });
  }
  return out.filter((x) => x.imp >= IMP_MIN_EXTRA).sort((a, b) => b.imp - a.imp).slice(0, limit);
}

async function getText(url, UA, label, extra = {}) {
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA, ...extra } });
    console.log(`Доп. новости, ${label}: HTTP ${r.status}`);
    return r.ok ? r : null;
  } catch (e) { console.log(`Доп. новости, ${label}: ошибка ${e.message}`); return null; }
}

export async function collectExtraNews({ UA, toWorker, now, sleep, enabled }) {
  const on = new Set(String(enabled ?? '').split(',').map((x) => x.trim()).filter(Boolean));
  const send = async (src, items) => {
    console.log(`Доп. новости, ${src}: отобрано ${items.length}${items.length ? ' — ' + items.map((x) => `[${x.imp}] ${x.title.slice(0, 70)} (${x.why})`).join(' | ') : ''}`);
    if (!on.has(src)) { if (items.length) console.log(`Доп. новости, ${src}: пробный режим, в Worker не отправляю (включить: EXTRA_NEWS=${src})`); return; }
    const ready = [];
    for (const it of items) {
      if (it.titleRu) { ready.push(it); continue; }
      try { ready.push({ ...it, titleRu: await translate(it.title, sleep) }); } catch (e) { console.log(`Перевод заголовка не удался (${e.message}) — пост не публикуем`); }
    }
    if (ready.length) console.log(`Доп. новости, ${src}:`, await toWorker('/ingest', { kind: 'extra_news', fetchedAt: now(), items: ready }));
  };
  const rd = await getText('https://www.reddit.com/r/GlobalOffensive/top.json?t=day&limit=25&raw_json=1', 'cenolov-news/1.0 (non-commercial; contact via bot)', 'Reddit');
  if (rd) { try { await send('reddit', pickReddit(await rd.json())); } catch (e) { console.log('Reddit: разбор не удался', e.message); } }
  const es = await getText('https://www.hltv.org/rss/news', UA, 'киберспорт (HLTV)');
  if (es) { try { await send('esports', pickEsports(await es.text())); } catch (e) { console.log('Киберспорт: разбор не удался', e.message); } }
  const gh = await getText('https://api.github.com/repos/SteamDatabase/GameTracking-CS2/commits?per_page=6', UA, 'датамайн (список коммитов)', { Accept: 'application/vnd.github+json' });
  if (gh) {
    try {
      const list = await gh.json(); const full = [];
      for (const c of list.slice(0, 4)) {
        const r = await getText(`https://api.github.com/repos/SteamDatabase/GameTracking-CS2/commits/${c.sha}`, UA, 'датамайн (коммит)', { Accept: 'application/vnd.github+json' });
        if (r) full.push(await r.json());
      }
      await send('datamine', pickDatamine(full));
    } catch (e) { console.log('Датамайн: разбор не удался', e.message); }
  }
}
