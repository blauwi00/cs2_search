# Ролики (HyperFrames)

Ролики для TikTok собираются на [HyperFrames](https://github.com/heygen-com/hyperframes) — HTML → MP4.

- `promo/` — промо бота (9:16, 25 с): `index.html` — общая шкала, голос и звуки; `compositions/` — сцены; `assets/` — голос, картинки, эффекты.
- Субтитры: `build-captions.mjs` берёт время слов из распознавания голоса (`npx hyperframes transcribe`), текст — из сценария.
- Рендер — GitHub Actions (`.github/workflows/hyperframes.yml`) при любом изменении в `video/`. Готовый `promo.mp4`, кадры и отчёт проверки — в ветке `video-renders`.

Локально: `cd video/promo && npx hyperframes preview` (просмотр), `npx hyperframes render -o out/promo.mp4`.
