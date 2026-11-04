-- Этапы 3–5: инвентарь, журнал реальных сделок, проверка качества сигналов.
-- Суммы — в копейках UAH.

-- Позиция инвентаря = одна покупка (лот). Продажа закрывает лот целиком или частично.
CREATE TABLE IF NOT EXISTS trades (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_id      INTEGER NOT NULL,
  item_id          INTEGER NOT NULL REFERENCES items(id),
  signal_id        INTEGER,                 -- если покупка сделана по сигналу бота
  quantity         INTEGER NOT NULL,
  buy_price_kop    INTEGER NOT NULL,        -- цена за 1 шт.
  buy_fee_kop      INTEGER NOT NULL DEFAULT 0,
  buy_platform     TEXT    NOT NULL,        -- steam, skinport, csfloat, other, gift (получено бесплатно)
  buy_date         TEXT    NOT NULL,        -- YYYY-MM-DD
  target_sell_kop  INTEGER,
  note             TEXT,
  status           TEXT    NOT NULL DEFAULT 'open',  -- open, closed
  sold_quantity    INTEGER NOT NULL DEFAULT 0,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_trades_user ON trades(telegram_id, status);
CREATE INDEX IF NOT EXISTS idx_trades_item ON trades(item_id, status);

CREATE TABLE IF NOT EXISTS trade_sales (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  trade_id         INTEGER NOT NULL REFERENCES trades(id),
  quantity         INTEGER NOT NULL,
  sell_price_kop   INTEGER NOT NULL,        -- цена покупателя за 1 шт.
  received_kop     INTEGER NOT NULL,        -- фактически получено всего (после комиссий)
  fee_kop          INTEGER NOT NULL DEFAULT 0,
  platform         TEXT    NOT NULL,
  wallet           TEXT    NOT NULL,        -- steam_wallet | external_cash
  sell_date        TEXT    NOT NULL,
  created_at       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sales_trade ON trade_sales(trade_id);
CREATE INDEX IF NOT EXISTS idx_sales_date ON trade_sales(sell_date);

-- Проверка сигнала спустя время: сохранялась ли выгода (для статистики качества).
CREATE TABLE IF NOT EXISTS signal_quality (
  signal_id        INTEGER PRIMARY KEY REFERENCES signals(id),
  checked_at       INTEGER NOT NULL,
  horizon_sec      INTEGER NOT NULL,
  spread_then_kop  INTEGER,
  spread_later_kop INTEGER,                 -- NULL = не хватило данных
  outcome          TEXT    NOT NULL         -- held, vanished, reversed, no_data
);

-- Флаг «предмет в инвентаре» для приоритета опроса.
ALTER TABLE watchlist ADD COLUMN source TEXT NOT NULL DEFAULT 'manual';  -- manual | inventory

-- Размах цены Steam за 7 дней (в базисных пунктах): волатильные предметы опрашиваются чаще.
ALTER TABLE items ADD COLUMN volatility_bp INTEGER;
