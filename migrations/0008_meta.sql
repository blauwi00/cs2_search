-- Служебные значения (например, время версии прайса Steam от CSGO Trader).
CREATE TABLE IF NOT EXISTS meta (
  key    TEXT PRIMARY KEY,
  value  TEXT NOT NULL
);
