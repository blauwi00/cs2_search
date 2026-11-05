-- «Разгон баланса»: кандидаты из Steam (сборщик), журнал сделок (реальные и симуляция), item_nameid для ордеров Steam.
CREATE TABLE IF NOT EXISTS rally_scan (
  id          INTEGER PRIMARY KEY CHECK (id = 1),
  data        TEXT    NOT NULL,      -- JSON: [{name,img,sa,steam,orders}]
  fetched_at  INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS rally_trades (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_id       INTEGER NOT NULL,
  mode              TEXT    NOT NULL,            -- real | sim
  name              TEXT    NOT NULL,
  img               TEXT,
  qty               INTEGER NOT NULL,
  buy_kop           INTEGER NOT NULL,            -- цена покупки за 1 шт. (сколько списалось с баланса)
  bought_at         INTEGER NOT NULL,
  unlock_at         INTEGER NOT NULL,            -- когда можно продать (оценка: +7 дней, можно поправить)
  target_kop        INTEGER,                     -- плановая цена продажи (цена покупателя) за 1 шт.
  predicted_net_kop INTEGER,                     -- прогноз: сколько придёт за 1 шт. после комиссии
  risk              TEXT,
  status            TEXT    NOT NULL DEFAULT 'open',  -- open | sold | cancelled
  sold_qty          INTEGER NOT NULL DEFAULT 0,
  sold_price_kop    INTEGER,                     -- цена покупателя за 1 шт. при продаже
  sold_net_kop      INTEGER,                     -- получено всего после комиссии
  sold_at           INTEGER,
  sold_note         TEXT,
  parent_id         INTEGER,                     -- частичная продажа: проданная часть — отдельная запись
  n_target          INTEGER NOT NULL DEFAULT 0,
  n_unlock          INTEGER NOT NULL DEFAULT 0,
  n_change          INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_rally_user ON rally_trades (telegram_id, mode, status);
CREATE INDEX IF NOT EXISTS idx_rally_open ON rally_trades (status, unlock_at);
CREATE TABLE IF NOT EXISTS item_nameids (
  name    TEXT PRIMARY KEY,
  nameid  INTEGER NOT NULL,
  at      INTEGER NOT NULL
);
