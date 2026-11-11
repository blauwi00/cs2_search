-- История для приложения: стоимость инвентаря по дням и цены на площадках по дням (суточные точки, не каждые 10 минут).
CREATE TABLE IF NOT EXISTS inv_value_daily (
  telegram_id INTEGER NOT NULL,
  day         TEXT NOT NULL,              -- YYYY-MM-DD по Варшаве
  total_usd_c INTEGER NOT NULL,           -- стоимость по средним продажам Steam, USD-центы
  top         TEXT,                       -- {"item_id":[цена_за_шт_в_USD-центах, кол-во]} для самых дорогих позиций
  PRIMARY KEY (telegram_id, day)
);
CREATE TABLE IF NOT EXISTS site_price_daily (
  item_id INTEGER NOT NULL,
  day     TEXT NOT NULL,
  json    TEXT NOT NULL,                  -- {"csgomarket":1084,"waxpeer":980,...} в центах USD
  PRIMARY KEY (item_id, day)
);
