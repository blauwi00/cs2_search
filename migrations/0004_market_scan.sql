-- Сканирование всего рынка для «Рекомендаций»: один JSON-снимок, заменяется каждым запуском сборщика.
CREATE TABLE IF NOT EXISTS market_scan (
  id          INTEGER PRIMARY KEY CHECK (id = 1),
  data        TEXT    NOT NULL,
  fetched_at  INTEGER NOT NULL
);

-- Картинки предметов (адреса картинок Steam CDN из открытого каталога ByMykel/CSGO-API).
CREATE TABLE IF NOT EXISTS item_images (
  name  TEXT PRIMARY KEY,
  url   TEXT NOT NULL
);
