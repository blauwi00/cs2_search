-- Что пропало из инвентаря Steam между обновлениями — бот предлагает записать это как продажи.
CREATE TABLE IF NOT EXISTS inv_gone (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_id INTEGER NOT NULL,
  item_id     INTEGER NOT NULL,
  qty         INTEGER NOT NULL,
  gone_at     INTEGER NOT NULL,
  status      TEXT NOT NULL DEFAULT 'new'  -- new | sold | skip
);
CREATE INDEX IF NOT EXISTS idx_inv_gone_user ON inv_gone (telegram_id, status);
