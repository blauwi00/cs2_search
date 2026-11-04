-- Каталог названий предметов CS2 для поиска (Steam-поиск из Cloudflare недоступен).
-- Одна строка на кусок каталога: названия через перевод строки. Обновляется сборщиком раз в сутки.
CREATE TABLE IF NOT EXISTS catalog_chunks (
  chunk       INTEGER PRIMARY KEY,
  names       TEXT    NOT NULL,
  updated_at  INTEGER NOT NULL
);
