-- Картинки-карточки для постов канала (рисует сборщик на GitHub Actions, хранятся неделю).
CREATE TABLE IF NOT EXISTS cards (
  id          TEXT PRIMARY KEY,            -- слот-дата, например ideas-2026-11-04
  jpg_b64     TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);
