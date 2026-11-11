// Новости не от Valve: отбор в сборщике (слухи и торговля отсекаются), приём в Worker, предпросмотр владельцу, лимиты.
import test from 'node:test';
import assert from 'node:assert/strict';
import { pickReddit, pickEsports, pickDatamine } from '../.github/scripts/extranews.mjs';
import { migratedDb, testEnv, mockFetch, json, fixtureJson, ADMIN } from './helpers.ts';
import { handleIngest } from '../src/ingest.ts';
import { runCycle } from '../src/core/runner.ts';
import { extraPost, valveKind } from '../src/core/insights.ts';
import { setMetaStmt } from '../src/core/channel.ts';

const post = (o: Record<string, unknown>) => ({ data: { id: 'abc123', title: 'Valve announces a new case', score: 3400, num_comments: 520, permalink: '/r/GlobalOffensive/comments/abc123/x/', created_utc: 1762000000, stickied: false, over_18: false, ...o } });

test('Reddit: берём только очень обсуждаемое; слухи, утечки, торговля, закреплённое — нет', () => {
  const r = pickReddit({ data: { children: [
    post({}), post({ id: 'low111', score: 100 }), post({ id: 'few222', num_comments: 10 }),
    post({ id: 'leak33', title: 'Leaked new knife' }), post({ id: 'wts444', title: '[H] knife [W] keys' }),
    post({ id: 'pin555', stickied: true }), post({ id: 'nsf666', over_18: true }), post({ id: 'rum777', title: 'Rumor: new operation' }),
  ] } });
  assert.deepEqual(r.map((x: { gid: string }) => x.gid), ['r_abc123']);
  assert.equal(r[0].url, 'https://www.reddit.com/r/GlobalOffensive/comments/abc123/x/');
});

test('киберспорт: только мажоры, крупные турниры и капсулы; датамайн: только файлы предметов и коллекций', () => {
  const item = (t: string, id: number) => `<item><title><![CDATA[${t}]]></title><link>https://www.hltv.org/news/${id}/x</link><pubDate>Tue, 11 Nov 2026 10:00:00 +0000</pubDate></item>`;
  const e = pickEsports(`<rss>${item('Major stickers capsule revealed', 111)}${item('Team A beat Team B 2-1', 222)}${item('Giveaway: win a Major ticket', 333)}</rss>`, 5);
  assert.deepEqual(e.map((x: { gid: string }) => x.gid), ['e_111']);
  const c = (sha: string, files: string[]) => ({ sha, files: files.map((filename) => ({ filename })), commit: { committer: { date: '2026-11-11T10:00:00Z' } } });
  const dm = pickDatamine([c('a'.repeat(40), ['game/csgo/pak01_dir.vpk']), c('b'.repeat(40), ['game/csgo/scripts/items/items_game.txt', 'x/csgo_english.txt'])], 5);
  assert.equal(dm.length, 1); assert.equal(dm[0].gid, 'd_' + 'b'.repeat(12));
});

test('приём extra_news: чужие адреса и без перевода отбрасываются; первый приём источника только запоминается', async () => {
  const d = migratedDb(); const D = d as unknown as D1Database; const env = testEnv(d, { INGEST_SECRET: 's1' });
  const T = Date.parse('2026-11-11T10:00:00Z') / 1000;
  const ing = (items: unknown[], t = T) => handleIngest(new Request('https://w/ingest', { method: 'POST', headers: { 'X-Ingest-Secret': 's1' }, body: JSON.stringify({ kind: 'extra_news', fetchedAt: t, items }) }), env, t).then((r) => r.json() as Promise<{ stored: number }>);
  const ok = { gid: 'r_abc123', source: 'reddit', title: 'T', titleRu: 'Т', url: 'https://www.reddit.com/r/GlobalOffensive/comments/abc123/x/', date: T - 600, score: 3000, comments: 400 };
  assert.equal((await ing([ok, { ...ok, gid: 'r_evil', url: 'https://evil.example/r/x/comments/1' }, { ...ok, gid: 'r_notr', titleRu: '' }, { ...ok, gid: 'x_bad' }])).stored, 1);
  const first = d.db.prepare("SELECT posted_at, source, score FROM news WHERE gid = 'r_abc123'").get() as { posted_at: number | null; source: string; score: number };
  assert.ok(first.posted_at, 'первый приём источника — запомнили без публикации'); assert.equal(first.source, 'reddit'); assert.equal(first.score, 3000);
  await ing([{ ...ok, gid: 'r_second', date: T - 300 }], T + 60);
  assert.equal((d.db.prepare("SELECT posted_at FROM news WHERE gid = 'r_second'").get() as { posted_at: number | null }).posted_at, null, 'вторая новость ждёт публикации');
  void D;
});

test('публикация: первые 3 — владельцу в личку, потом в канал; не больше 1 поста Reddit в сутки; ночью и при выключателе — нет', async () => {
  const d = migratedDb(); const D = d as unknown as D1Database; const env = testEnv(d);
  const T0 = Date.parse('2026-11-12T09:30:00Z') / 1000; // 10:30 по Варшаве
  await D.batch([setMetaStmt(D, 'channel_id', '-1001234'), setMetaStmt(D, 'bot_username', 'cenolow_bot'), setMetaStmt(D, 'announce_done', JSON.stringify(['2026-11-chart']))]);
  const ins = (gid: string, src: string, t: number) => d.db.exec(`INSERT INTO news (gid, title, url, snippet, published_at, title_ru, source, score, comments) VALUES ('${gid}', 'T${gid}', 'https://www.reddit.com/r/GlobalOffensive/comments/${gid}/x/', NULL, ${t}, 'Заголовок ${gid}', '${src}', 3000, 400)`);
  const sent: { method: string; body: Record<string, any> }[] = [];
  const { fetcher } = mockFetch([
    { match: (u) => u.startsWith('https://api.telegram.org/'), respond: (u, init) => { sent.push({ method: u.split('/').pop()!, body: JSON.parse(String(init?.body)) }); return json({ ok: true, result: { message_id: 9 } }); } },
    { match: (u) => u.startsWith('https://bank.gov.ua/'), respond: () => json(fixtureJson('nbu.json')) },
  ]);
  const toAdmin = () => sent.filter((s) => s.method === 'sendMessage' && s.body.chat_id === ADMIN && /Предпросмотр/.test(String(s.body.text)));
  const toChannel = () => sent.filter((s) => s.method === 'sendMessage' && s.body.chat_id === -1001234 && /Заголовок/.test(String(s.body.text)));
  ins('aaa111', 'reddit', T0 - 7200); ins('bbb222', 'esports', T0 - 7100); ins('ccc333', 'datamine', T0 - 7000);
  for (let i = 0; i < 4; i++) await runCycle(env, { now: T0 + i * 400, fetcher });
  assert.equal(toAdmin().length, 3, 'первые три — предпросмотр владельцу');
  assert.equal(toChannel().length, 0, 'в канал ещё ничего');
  assert.match(String(toAdmin()[0]!.body.text), /Рейтинг 3000 · комментариев 400/);
  ins('ddd444', 'reddit', T0 - 600); ins('eee555', 'reddit', T0 - 500);
  for (let i = 0; i < 4; i++) await runCycle(env, { now: T0 + 3600 + i * 400, fetcher });
  assert.equal(toChannel().length, 0, 'в тот же день дневной лимит из 3 уже исчерпан');
  const T1 = T0 + 86400 + 1800;
  for (let i = 0; i < 4; i++) await runCycle(env, { now: T1 + i * 400, fetcher });
  assert.equal(toChannel().length, 1, 'на следующий день — в канал, но Reddit не больше 1 в сутки');
  assert.match(JSON.stringify(toChannel()[0]!.body.reply_markup), /Обсуждение на Reddit/);
  await D.batch([setMetaStmt(D, 'extra_news_off', '1')]);
  for (let i = 0; i < 3; i++) await runCycle(env, { now: T1 + 3 * 3600 + i * 400, fetcher });
  assert.equal(toChannel().length, 1, 'выключатель работает');
});

test('тексты: Reddit — заголовок, оригинал, рейтинг; датамайн — пометка «не подтверждено»; Valve — «Объявление» без слова update', () => {
  const base = { gid: 'r_1', title: 'Orig', url: 'https://x', snippet: null, published_at: 1, title_ru: 'Перевод', score: 3400, comments: 520 };
  assert.match(extraPost({ ...base, source: 'reddit' }), /<b>Перевод<\/b>[\s\S]*Оригинал: Orig[\s\S]*Рейтинг 3400 · комментариев 520/);
  assert.match(extraPost({ ...base, source: 'datamine' }), /Valve это не подтверждала/);
  assert.equal(valveKind({ ...base, title: 'Counter-Strike 2 Update' }), 'Обновление CS2');
  assert.equal(valveKind({ ...base, title: 'New Operation is here' }), 'Объявление Valve');
});
