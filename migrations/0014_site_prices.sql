-- Цены одного предмета на всех площадках (USD-центы), собирает сборщик раз в несколько часов.
CREATE TABLE IF NOT EXISTS site_prices (
  name        TEXT PRIMARY KEY,
  json        TEXT NOT NULL,               -- {"skinport":1084,"buff163":980,...} в центах USD
  updated_at  INTEGER NOT NULL
);
