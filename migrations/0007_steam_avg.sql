-- Средние цены продаж в Steam (USD, центы) из открытого прайса CSGO Trader (prices.csgotrader.app/latest/steam.json).
-- Обновляется раз в сутки для предметов из списков наблюдения. Позволяет давать подсказки без опроса Steam по каждому предмету.
CREATE TABLE IF NOT EXISTS steam_avg (
  item_id     INTEGER PRIMARY KEY,
  d1          INTEGER,   -- средняя за 24 часа
  d7          INTEGER,
  d30         INTEGER,
  d90         INTEGER,
  updated_at  INTEGER NOT NULL
);
