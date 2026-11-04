-- Сообщения об ошибках в ценах (из приложения и бота) и пожертвования звёздами Telegram.
CREATE TABLE IF NOT EXISTS feedback (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_id  INTEGER NOT NULL,
  item         TEXT,
  reason       TEXT NOT NULL,
  comment      TEXT,
  context      TEXT,
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_feedback_user ON feedback (telegram_id, created_at);

CREATE TABLE IF NOT EXISTS donations (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_id  INTEGER NOT NULL,
  stars        INTEGER NOT NULL,
  charge_id    TEXT NOT NULL UNIQUE,
  created_at   INTEGER NOT NULL
);
