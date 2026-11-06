-- Продажи «в ожидании»: предмет выставлен/отправлен на сайт, деньги ещё не пришли. В прибыль не идут, пока не подтвердишь.
CREATE TABLE IF NOT EXISTS pending_sales (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_id    INTEGER NOT NULL,
  trade_id       INTEGER NOT NULL,
  quantity       INTEGER NOT NULL,
  sell_price_kop INTEGER NOT NULL,   -- цена за 1 шт.
  received_kop   INTEGER NOT NULL,   -- ожидается получить всего
  platform       TEXT NOT NULL,
  created_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pending_sales_user ON pending_sales (telegram_id);
