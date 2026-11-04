-- Бот для всех: очередь уведомлений (каждому — по его списку, порогам и тихим часам)
-- и скрытые сделки у каждого свои.
CREATE TABLE IF NOT EXISTS outbox (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_id  INTEGER NOT NULL,
  kind         TEXT    NOT NULL,
  ref          TEXT    NOT NULL,
  signal_id    INTEGER,
  text         TEXT    NOT NULL,
  keyboard     TEXT,
  edit_msg_id  INTEGER,            -- не NULL: правка ранее отправленного сообщения
  not_before   INTEGER NOT NULL,
  created_at   INTEGER NOT NULL,
  state        TEXT    NOT NULL DEFAULT 'pending',   -- pending | sent | dropped
  sent_at      INTEGER,
  msg_id       INTEGER,
  UNIQUE (telegram_id, kind, ref, edit_msg_id)
);
CREATE INDEX IF NOT EXISTS idx_outbox_due ON outbox (state, not_before);
CREATE INDEX IF NOT EXISTS idx_outbox_signal ON outbox (signal_id, state);

CREATE TABLE IF NOT EXISTS hidden_signals (
  telegram_id  INTEGER NOT NULL,
  signal_id    INTEGER NOT NULL,
  hidden_at    INTEGER NOT NULL,
  PRIMARY KEY (telegram_id, signal_id)
);
