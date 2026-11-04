-- Сканирование всего рынка для «Рекомендаций»: один JSON-снимок, заменяется каждым запуском сборщика.
CREATE TABLE IF NOT EXISTS market_scan (
  id          INTEGER PRIMARY KEY CHECK (id = 1),
  data        TEXT    NOT NULL,
  fetched_at  INTEGER NOT NULL
);
