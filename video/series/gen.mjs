// Генератор роликов серии (9:16) на HyperFrames: сцены по фразам озвучки, субтитры по словам.
// Запуск: node gen.mjs  → папки v2..v6 (каждая — проект HyperFrames: index.html + compositions/ + assets/).
// Озвучка (ElevenLabs) кладётся в vN/assets/voice.mp3; границы фраз (chunks, время голоса) — по паузам в озвучке.
// Правило раскладки: всё содержимое сцен — выше y=1130, ниже (top 1180) — только субтитры, ничего не накладывается.
import { mkdirSync, writeFileSync, copyFileSync, readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROMO = join(HERE, '..', 'promo');
const VOICE_AT = 0.35;
const GSAP = process.env.GSAP_LOCAL ? 'assets/gsap.min.js' : 'https://cdn.jsdelivr.net/npm/gsap@3.12.5/dist/gsap.min.js';
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

// ---------- Сцены ----------
const BASE = `#root { position: absolute; inset: 0; font-family: Inter, sans-serif; color: #f1f3f5; }
    .ttl { position: absolute; top: 200px; left: 60px; right: 60px; text-align: center; font-size: 84px; font-weight: 900; line-height: 1.05; letter-spacing: -1.5px; }
    .ttl b { color: #3ee08f; }`;
const wrap = (id, css, html, js) => `<template>
  <style>
    ${BASE}
    ${css}
  </style>
  <div id="root" data-composition-id="${id}" data-width="1080" data-height="1920">
${html}
  </div>
  <script>
    const tl = gsap.timeline({ paused: true });
${js}
    window.__timelines["${id}"] = tl;
  </script>
</template>
`;
const TITLE_IN = `    tl.fromTo(".ttl", { opacity: 0, y: 30 }, { opacity: 1, y: 0, duration: 0.4, ease: "power3.out" }, 0);\n`;

const S = {
  /** Вопрос крупно + картинка (кейс) с лёгким покачиванием. */
  hook: (id, { title, img = 'case.png', tag, glow = '#ff6b6b' }) => wrap(id,
    `.ttl { top: 230px; font-size: 96px; }
    #gl { position: absolute; left: 290px; top: 520px; width: 500px; height: 500px; border-radius: 50%; background: ${glow}; opacity: .22; filter: blur(90px); }
    #im { position: absolute; left: 290px; top: 540px; width: 500px; height: 400px; object-fit: contain; }
    #tg { position: absolute; left: 0; right: 0; top: 990px; text-align: center; }
    #tg span { display: inline-block; background: ${glow}; color: #fff; font-size: 46px; font-weight: 900; padding: 14px 28px; border-radius: 20px; }`,
    `    <div id="gl" data-layout-ignore></div>
    <div class="ttl">${title}</div>
    <img id="im" src="assets/${img}" alt="">
    ${tag ? `<div id="tg"><span>${esc(tag)}</span></div>` : ''}`,
    `    tl.fromTo(".ttl", { scale: 0.75, opacity: 0 }, { scale: 1, opacity: 1, duration: 0.45, ease: "back.out(1.7)" }, 0);
    tl.fromTo("#im", { scale: 0.6, opacity: 0 }, { scale: 1, opacity: 1, duration: 0.5, ease: "back.out(1.6)" }, 0.2);
    tl.to("#im", { y: -14, duration: 0.9, ease: "sine.inOut", yoyo: true, repeat: 3 }, 0.7);
${tag ? '    tl.fromTo("#tg span", { scale: 0 }, { scale: 1, duration: 0.35, ease: "back.out(2.4)" }, 0.8);\n' : ''}`),

  /** Одно слово/фраза крупно по центру + подпись. */
  big: (id, { text, sub, color = '#3ee08f' }) => wrap(id,
    `#bg { position: absolute; left: 0; right: 0; top: 470px; text-align: center; font-size: 150px; font-weight: 900; letter-spacing: -3px; color: ${color}; }
    #sb { position: absolute; left: 80px; right: 80px; top: 690px; text-align: center; font-size: 48px; font-weight: 700; color: #adb5bd; line-height: 1.25; }`,
    `    <div id="bg">${esc(text)}</div>
    ${sub ? `<div id="sb">${sub}</div>` : ''}`,
    `    tl.fromTo("#bg", { scale: 0.5, opacity: 0 }, { scale: 1, opacity: 1, duration: 0.4, ease: "back.out(2)" }, 0);
${sub ? '    tl.fromTo("#sb", { opacity: 0, y: 20 }, { opacity: 1, y: 0, duration: 0.35 }, 0.3);\n' : ''}`),

  /** Заголовок + до 3 карточек «подпись — значение» по очереди. */
  rows: (id, { title, rows, note }) => wrap(id,
    `.rw { position: absolute; left: 90px; right: 90px; height: 170px; border-radius: 30px; background: rgba(255,255,255,.06); border: 2px solid rgba(255,255,255,.08); }
    .rw .k { position: absolute; left: 40px; top: 28px; font-size: 27px; letter-spacing: 3px; color: #868e96; font-weight: 900; }
    .rw .m { position: absolute; left: 40px; top: 72px; right: 330px; font-size: 40px; font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .rw .v { position: absolute; right: 40px; top: 0; bottom: 0; display: flex; align-items: center; font-size: 54px; font-weight: 900; }
    .rw.g { background: rgba(62,224,143,.12); border-color: rgba(62,224,143,.4); } .rw.g .k, .rw.g .v { color: #3ee08f; }
    .rw.r .v { color: #ff8787; } .rw.s .v { color: #adb5bd; font-size: 44px; }
    #nt { position: absolute; left: 0; right: 0; top: 1060px; text-align: center; font-size: 28px; color: #6c757d; }`,
    `    <div class="ttl">${title}</div>
${rows.map((r, i) => `    <div class="rw ${r.cls || ''}" id="r${i}" style="top:${470 + i * 190}px"><div class="k">${esc(r.k)}</div><div class="m">${esc(r.m)}</div><div class="v">${esc(r.v)}</div></div>`).join('\n')}
    ${note ? `<div id="nt">${esc(note)}</div>` : ''}`,
    TITLE_IN + rows.map((_, i) => `    tl.fromTo("#r${i}", { opacity: 0, x: 120 }, { opacity: 1, x: 0, duration: 0.45, ease: "power3.out" }, ${(0.3 + i * 0.6).toFixed(2)});\n`).join('') +
    (note ? `    tl.fromTo("#nt", { opacity: 0 }, { opacity: 1, duration: 0.3 }, ${(0.5 + rows.length * 0.6).toFixed(2)});\n` : '')),

  /** Заголовок + полосы процентов (комиссии). */
  bars: (id, { title, bars, max }) => wrap(id,
    `.br { position: absolute; left: 90px; right: 90px; height: 92px; }
    .br .n { position: absolute; left: 0; top: 0; width: 330px; height: 92px; display: flex; align-items: center; font-size: 40px; font-weight: 700; }
    .br .t { position: absolute; left: 340px; right: 150px; top: 26px; height: 40px; border-radius: 20px; background: rgba(255,255,255,.07); overflow: hidden; }
    .br .f { height: 100%; border-radius: 20px; background: #3ee08f; transform-origin: left; }
    .br.hi .f { background: #ff8787; } .br .p { position: absolute; right: 0; top: 0; width: 140px; height: 92px; display: flex; align-items: center; justify-content: flex-end; font-size: 44px; font-weight: 900; }`,
    `    <div class="ttl">${title}</div>
${bars.map((b, i) => `    <div class="br ${b.hi ? 'hi' : ''}" id="b${i}" style="top:${470 + i * 112}px"><div class="n">${esc(b.n)}</div><div class="t"><div class="f" style="width:${(b.p / max * 100).toFixed(1)}%"></div></div><div class="p">${esc(b.label)}</div></div>`).join('\n')}`,
    TITLE_IN + bars.map((_, i) => `    tl.fromTo("#b${i}", { opacity: 0 }, { opacity: 1, duration: 0.25 }, ${(0.25 + i * 0.3).toFixed(2)});\n    tl.fromTo("#b${i} .f", { scaleX: 0 }, { scaleX: 1, duration: 0.5, ease: "power2.out" }, ${(0.3 + i * 0.3).toFixed(2)});\n`).join('')),

  /** Заголовок + телефон со скриншотом приложения; по желанию — уведомление сверху. */
  phone: (id, { title, img, banner }) => wrap(id,
    `.ttl { top: 150px; font-size: 64px; }
    #ph { position: absolute; left: 300px; top: ${title ? 300 : 200}px; width: 480px; height: ${title ? 800 : 900}px; border-radius: 64px; background: #000; padding: 16px; box-shadow: 0 60px 120px rgba(0,0,0,.6), 0 0 0 4px #2a2f37; }
    #sc { width: 100%; height: 100%; border-radius: 50px; overflow: hidden; background: #0b1220; }
    #sc img { width: 100%; display: block; }
    #nf { position: absolute; left: 100px; right: 100px; top: ${title ? 360 : 260}px; border-radius: 34px; background: rgba(40,46,56,.97); padding: 24px 28px; box-shadow: 0 30px 60px rgba(0,0,0,.5); display: flex; gap: 22px; align-items: center; }
    #nf .i { width: 84px; height: 84px; border-radius: 20px; overflow: hidden; flex: none; } #nf .i img { width: 100%; height: 100%; }
    #nf .a { font-size: 26px; color: #adb5bd; } #nf .b { font-size: 32px; font-weight: 700; margin-top: 4px; line-height: 1.25; }`,
    `    ${title ? `<div class="ttl">${title}</div>` : ''}
    <div id="ph"><div id="sc"><img src="assets/${img}" alt=""></div></div>
    ${banner ? `<div id="nf" data-layout-allow-occlusion><div class="i"><img src="assets/avatar.png" alt=""></div><div><div class="a">Ценолов · сейчас</div><div class="b">${esc(banner)}</div></div></div>` : ''}`,
    (title ? TITLE_IN : '') + `    tl.fromTo("#ph", { y: 160, opacity: 0 }, { y: 0, opacity: 1, duration: 0.5, ease: "power3.out" }, 0.1);
    tl.fromTo("#sc img", { y: 0 }, { y: -120, duration: 2.6, ease: "sine.inOut" }, 0.9);
${banner ? '    tl.fromTo("#nf", { y: -240, opacity: 0 }, { y: 0, opacity: 1, duration: 0.5, ease: "back.out(1.4)" }, 0.7);\n' : ''}`),

  /** Чек-лист: до 3 пунктов с галочками. */
  checks: (id, { title, items }) => wrap(id,
    `.ck { position: absolute; left: 110px; right: 110px; height: 130px; border-radius: 28px; background: rgba(255,255,255,.06); border: 2px solid rgba(255,255,255,.08); display: flex; align-items: center; gap: 28px; padding: 0 36px; font-size: 44px; font-weight: 800; }
    .ck i { font-style: normal; font-size: 54px; }`,
    `    <div class="ttl">${title}</div>
${items.map((t, i) => `    <div class="ck" id="c${i}" style="top:${480 + i * 160}px"><i>${t[0]}</i><span>${esc(t[1])}</span></div>`).join('\n')}`,
    TITLE_IN + items.map((_, i) => `    tl.fromTo("#c${i}", { opacity: 0, scale: 0.85 }, { opacity: 1, scale: 1, duration: 0.35, ease: "back.out(1.8)" }, ${(0.3 + i * 0.45).toFixed(2)});\n`).join('')),
};

// ---------- Ролики ----------
// chunks: [начало, конец, текст субтитров] — время в файле озвучки; scenes: [номера chunks, сцена].
const VIDEOS = {
  v2: {
    voice: 'v2.mp3',
    chunks: [[0, 1.43, 'Открываешь кейсы в Steam?'], [1.89, 4.54, 'А ты знаешь, окупается ли кейс на самом деле?'], [5.0, 9.02, 'Бот Ценолов считает, сколько в среднем стоит то, что из него выпадает.'], [9.36, 11.25, 'По реальным ценам, с учётом шансов.'], [11.71, 15.43, 'Сравни это с ценой кейса и ключа — и реши, стоит ли крутить.'], [15.76, 17.2, 'Бесплатно, в Телеграме.'], [17.47, 18.6, 'Ссылка в профиле.']],
    scenes: [
      [[0], ['hook', { title: 'ОТКРЫВАЕШЬ<br>КЕЙСЫ?', glow: '#f59f00' }]],
      [[1], ['big', { text: 'ОКУПАЕТСЯ?', sub: 'а ты точно знаешь,<br>сколько стоит кейс на самом деле?', color: '#ffd43b' }]],
      [[2], ['rows', { title: 'Что внутри — <b>в деньгах</b>', rows: [{ k: 'ОБЫЧНЫЕ СКИНЫ', m: 'выпадают чаще всего', v: 'дёшево', cls: 's' }, { k: 'РЕДКИЕ', m: 'выпадают редко', v: 'дороже', cls: 's' }, { k: 'В СРЕДНЕМ', m: 'на одно открытие', v: 'считает бот', cls: 'g' }] }]],
      [[3], ['checks', { title: 'Честный расчёт', items: [['💵', 'реальные цены рынка'], ['🎲', 'шансы выпадения'], ['🧮', 'среднее на открытие']] }]],
      [[4], ['rows', { title: 'Сравни —<br>и реши сам', rows: [{ k: 'ТЫ ПЛАТИШЬ', m: 'кейс + ключ', v: '= цена', cls: 'r' }, { k: 'В СРЕДНЕМ ВЫПАДАЕТ', m: 'по расчёту бота', v: '= сумма', cls: 'g' }], note: 'это среднее, а не обещание выигрыша' }]],
      [[5, 6], ['cta', {}]],
    ],
  },
  v3: {
    voice: 'v3.mp3',
    chunks: [[0, 2.33, 'Сколько на самом деле стоит твой инвентарь?'], [2.81, 5.97, 'Не по ценам в профиле, а сколько ты получишь на руки.'], [6.49, 10.79, 'Ценолов считает стоимость каждого скина и сразу вычитает комиссию Steam.'], [11.23, 14.81, 'И подсказывает, что сейчас выгодно продать, а что — подождать.'], [15.21, 16.59, 'Бесплатно, в Телеграме.'], [16.91, 17.95, 'Ссылка в профиле.']],
    scenes: [
      [[0], ['hook', { title: 'СКОЛЬКО СТОИТ<br>ТВОЙ ИНВЕНТАРЬ?', glow: '#3ee08f' }]],
      [[1], ['rows', { title: 'Цена ≠<br><b>деньги на руки</b>', rows: [{ k: 'ЦЕНА В STEAM', m: 'как в профиле', v: '2 684 ₴', cls: 's' }, { k: 'КОМИССИЯ STEAM', m: 'около 15%', v: '−350 ₴', cls: 'r' }, { k: 'НА РУКИ', m: 'на баланс Steam', v: '2 334 ₴', cls: 'g' }], note: 'пример расчёта' }]],
      [[2], ['phone', { title: 'Каждый скин — <b>после комиссии</b>', img: 'skins.png' }]],
      [[3], ['rows', { title: 'Продать<br>или подождать?', rows: [{ k: 'AK-47 | SLATE', m: 'выше обычной цены', v: 'Продать', cls: 'g' }, { k: 'KILOWATT CASE', m: 'цена как обычно', v: 'Ждать', cls: 's' }], note: 'подсказки бота по ценам за неделю' }]],
      [[4, 5], ['cta', {}]],
    ],
  },
  v4: {
    voice: 'v4.mp3',
    chunks: [[0, 3.45, 'Ждёшь, когда скин подешевеет, и каждый день проверяешь цену?'], [3.85, 4.43, 'Хватит.'], [4.94, 7.1, 'Найди скин в Ценолове и поставь цель —'], [7.32, 8.68, 'например, сорок гривен.'], [9.15, 12.42, 'Как только цена дойдёт до неё, бот сам пришлёт уведомление.'], [12.74, 14.2, 'Бесплатно, в Телеграме.'], [14.47, 15.57, 'Ссылка в профиле.']],
    scenes: [
      [[0], ['hook', { title: 'КАЖДЫЙ ДЕНЬ<br>ПРОВЕРЯЕШЬ ЦЕНУ?', glow: '#74c0fc' }]],
      [[1], ['big', { text: 'ХВАТИТ.', color: '#ff8787' }]],
      [[2, 3], ['phone', { title: '🎯 Поставь <b>цель</b>', img: 'prices.png' }]],
      [[4], ['phone', { img: 'prices.png', banner: '🎯 Kilowatt Case — цена дошла до твоей цели: 40 ₴' }]],
      [[5, 6], ['cta', {}]],
    ],
  },
  v5: {
    voice: 'v5.mp3',
    chunks: [[0, 2.6, 'Купил скин дешевле и продал дороже —'], [2.93, 4.24, 'а денег не прибавилось?'], [4.67, 5.85, 'Всё дело в комиссиях.'], [6.39, 8.66, 'Steam забирает около пятнадцати процентов,'], [8.91, 10.5, 'сайты — от двух до восьми.'], [11.05, 15.03, 'Ценолов считает их за тебя и показывает, сколько ты получишь на самом деле.'], [15.33, 16.74, 'Бесплатно, в Телеграме.'], [16.98, 18.05, 'Ссылка в профиле.']],
    scenes: [
      [[0, 1], ['hook', { title: 'КУПИЛ ДЕШЕВЛЕ,<br>ПРОДАЛ ДОРОЖЕ…', tag: 'а денег не прибавилось?', glow: '#ff6b6b' }]],
      [[2], ['big', { text: 'КОМИССИИ', sub: 'вот куда уходит прибыль', color: '#ff8787' }]],
      [[3, 4], ['bars', { title: 'Сколько <b>забирают</b>', max: 15, bars: [{ n: 'Steam', p: 15, label: '≈15%', hi: true }, { n: 'Skinport', p: 8, label: '8%' }, { n: 'Waxpeer', p: 6, label: '6%' }, { n: 'Market.CSGO', p: 5, label: '5%' }, { n: 'LIS-SKINS', p: 5, label: '5%' }] }]],
      [[5], ['phone', { title: 'Сколько <b>получишь на руки</b>', img: 'ideas.png' }]],
      [[6, 7], ['cta', {}]],
    ],
  },
  v6: {
    voice: 'v6.mp3',
    chunks: [[0, 3.17, 'Лежат деньги на балансе Steam, а вывести их нельзя?'], [3.64, 4.89, 'Впиши баланс в Ценолов.'], [5.23, 9.4, 'Бот подберёт сделки, на которые тебе хватит, и подскажет, где продать дороже.'], [9.73, 10.99, 'Без пароля от Steam.'], [11.26, 12.64, 'Бесплатно, в Телеграме.'], [12.91, 14.03, 'Ссылка в профиле.']],
    scenes: [
      [[0], ['hook', { title: 'ДЕНЬГИ<br>НА БАЛАНСЕ STEAM?', tag: 'вывести нельзя', glow: '#74c0fc' }]],
      [[1], ['phone', { title: '💳 Впиши <b>баланс</b>', img: 'balance.png' }]],
      [[2], ['phone', { title: 'Идеи <b>под твой баланс</b>', img: 'ideas.png' }]],
      [[3], ['checks', { title: 'Безопасно', items: [['🔒', 'без пароля от Steam'], ['🚫', 'бот ничего не покупает сам'], ['✅', 'бесплатно']] }]],
      [[4, 5], ['cta', {}]],
    ],
  },
};

const SHOTS = process.env.SHOTS_DIR || '';
for (const [vid, v] of Object.entries(VIDEOS)) {
  const dir = join(HERE, vid);
  mkdirSync(join(dir, 'compositions'), { recursive: true });
  mkdirSync(join(dir, 'assets', 'sfx'), { recursive: true });
  for (const f of ['avatar.png', 'case.png', 'sfx/whoosh.wav', 'sfx/pop.wav']) copyFileSync(join(PROMO, 'assets', f), join(dir, 'assets', f));
  if (process.env.GSAP_LOCAL) copyFileSync(process.env.GSAP_LOCAL, join(dir, 'assets', 'gsap.min.js'));
  for (const [f, src] of [['skins.png', '4-moi-skiny-steam.png'], ['prices.png', '3-ceny.png'], ['ideas.png', '2-idei.png'], ['balance.png', '7-balans.png']]) {
    if (SHOTS && existsSync(join(SHOTS, src))) copyFileSync(join(SHOTS, src), join(dir, 'assets', f));
  }
  const voicePath = join(dir, 'assets', 'voice.mp3');
  const voiceDur = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', voicePath]).toString().trim());
  const total = +(VOICE_AT + voiceDur + 0.6).toFixed(2);
  // Границы сцен — посередине паузы между фразами.
  const sc = v.scenes.map(([idx, spec], i) => {
    const first = v.chunks[idx[0]], prevEnd = i ? v.chunks[v.scenes[i - 1][0].at(-1)][1] : null;
    const start = i === 0 ? 0 : +(VOICE_AT + (prevEnd + first[0]) / 2).toFixed(2);
    return { id: spec[0] === 'cta' ? 'cta' : `s${i + 1}`, kind: spec[0], spec: spec[1], start };
  });
  sc.forEach((s, i) => { s.end = i < sc.length - 1 ? sc[i + 1].start : total; });
  for (const s of sc) {
    const html = s.kind === 'cta' ? readFileSync(join(PROMO, 'compositions', 'cta.html'), 'utf8') : S[s.kind](s.id, s.spec);
    writeFileSync(join(dir, 'compositions', `${s.id}.html`), html);
  }
  // Слова субтитров: внутри каждой фразы — пропорционально длине слова.
  const words = [];
  for (const [a, b, t] of v.chunks) {
    const ws = t.split(/\s+/).map((w) => w.replace(/[.,?!]/g, '')).filter((w) => w && w !== '—');
    const L = ws.reduce((s, w) => s + w.length + 1, 0);
    let x = a;
    for (const w of ws) { const d = (b - a) * (w.length + 1) / L; words.push({ text: w, start: +x.toFixed(3), end: +(x + d * 0.92).toFixed(3) }); x += d; }
  }
  writeFileSync(join(dir, 'assets', 'words-fallback.json'), JSON.stringify(words, null, 1));
  writeFileSync(join(dir, 'assets', 'transcript.json'), JSON.stringify(words));
  copyFileSync(join(PROMO, 'build-captions.mjs'), join(dir, 'build-captions.mjs'));
  execFileSync('node', ['build-captions.mjs'], { cwd: dir, stdio: 'inherit' });
  const sfx = sc.slice(1).map((s, i) => `  <audio id="w${i}" class="clip" src="assets/sfx/whoosh.wav" data-start="${Math.max(0, s.start - 0.14).toFixed(2)}" data-duration="0.45" data-track-index="4" data-volume="0.3"></audio>`).join('\n');
  writeFileSync(join(dir, 'index.html'), `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<script src="${GSAP}"></script>
<style>
  html, body { margin: 0; background: #0b0e13; }
  #bg { position: absolute; inset: 0; z-index: 0;
    background: radial-gradient(1100px 900px at 85% 5%, rgba(62,224,143,.22), transparent 60%),
                radial-gradient(900px 900px at 0% 100%, rgba(116,192,252,.14), transparent 60%),
                linear-gradient(170deg, #151b24, #0b0e13); }
  #grid { position: absolute; inset: 0; z-index: 1;
    background-image: linear-gradient(rgba(255,255,255,.04) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,.04) 1px, transparent 1px);
    background-size: 60px 60px; -webkit-mask-image: linear-gradient(180deg, #000 0%, transparent 75%); mask-image: linear-gradient(180deg, #000 0%, transparent 75%); }
</style>
</head>
<body>
<!-- Ролик серии «Ценолов» (${vid}), 9:16. Сгенерировано video/series/gen.mjs — правьте генератор, а не этот файл. -->
<div id="main" data-composition-id="main" data-start="0" data-duration="${total}" data-width="1080" data-height="1920">
  <div id="bg" data-layout-ignore></div>
  <div id="grid" data-layout-ignore></div>
${sc.map((s) => `  <div id="${s.id}" data-composition-id="${s.id}" data-composition-src="compositions/${s.id}.html" data-start="${s.start}" data-duration="${(s.end - s.start).toFixed(2)}" data-track-index="1" data-track-kind="graphics" data-width="1080" data-height="1920" style="z-index:2"></div>`).join('\n')}
  <div id="caps" data-composition-id="caps" data-composition-src="compositions/captions.html" data-start="0" data-duration="${total}" data-track-index="2" data-track-kind="captions" data-width="1080" data-height="1920" style="z-index:5"></div>
  <audio id="voice" class="clip" src="assets/voice.mp3" data-start="${VOICE_AT}" data-duration="${voiceDur.toFixed(2)}" data-track-index="3" data-volume="1"></audio>
${sfx}
</div>
<script>
  window.__timelines = window.__timelines || {};
  window.__timelines["main"] = gsap.timeline({ paused: true });
</script>
</body>
</html>
`);
  console.log(vid, 'сцен', sc.length, 'длина', total, 'с');
}
