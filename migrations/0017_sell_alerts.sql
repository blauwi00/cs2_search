-- Цель продажи для предметов инвентаря Steam: «скажи, когда станет дороже X» (одно уведомление, потом цель снимается).
CREATE TABLE IF NOT EXISTS sell_alerts (
  telegram_id  INTEGER NOT NULL,
  item_id      INTEGER NOT NULL,
  target_kop   INTEGER NOT NULL,
  created_at   INTEGER NOT NULL,
  notified_at  INTEGER,
  PRIMARY KEY (telegram_id, item_id)
);
CREATE INDEX IF NOT EXISTS idx_sell_alerts_open ON sell_alerts (notified_at, item_id);
