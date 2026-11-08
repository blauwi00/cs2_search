# Ролики TikTok с живым интерфейсом

Вместо статичных скриншотов — запись экрана настоящего приложения в движении, наезды камеры, крупные субтитры по словам, сообщения бота в виде чата.

1. `node --disable-warning=ExperimentalWarning server.ts` — локальная копия бота на http://localhost:8787: настоящий `app.html` и API, тестовая база. Перед запуском положи в `work/` файл `prices.tsv` (реальные цены Steam: `название<TAB>ответ priceoverview`) и картинки скинов в `work/img/`.
2. `node rec.cjs prices ideas inv locked buys` — клипы в `work/clips/*.mp4` (1080 по ширине, 30 к/с, палец показывает касания).
3. `node gen.mjs work/build` — проекты HyperFrames (`reklama`, `tradeban`, `vbros`); `node gen.mjs work/build voice` — вариант под озвучку (`assets/voice.mp3`, тайминги фраз из `<ролик>.timing.json`).
4. `npx hyperframes render work/build/reklama -o reklama.mp4 -q delivery --video-frame-format png`.

Цифры в идеях и на площадках — демонстрационные (цены Steam реальные на дату записи), в роликах нет обещаний дохода.
