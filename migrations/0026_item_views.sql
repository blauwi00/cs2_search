-- Какие скины люди открывали: по ним бот тоже копит цены площадок по дням (иначе график у нового скина пустой).
CREATE TABLE IF NOT EXISTS item_views (
  item_id INTEGER PRIMARY KEY,
  at      INTEGER NOT NULL
);
