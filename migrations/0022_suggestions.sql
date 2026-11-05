-- Предложка: подписчики присылают идеи/новости для канала, владелец решает — публиковать или нет.
CREATE TABLE IF NOT EXISTS suggestions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_id INTEGER NOT NULL,
  text TEXT,
  photo TEXT,                 -- file_id картинки из Telegram (сама картинка у нас не хранится)
  status TEXT NOT NULL DEFAULT 'new', -- new | posted | rejected
  created_at INTEGER NOT NULL,
  decided_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_suggestions_user ON suggestions (telegram_id, created_at);
