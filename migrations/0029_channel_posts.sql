-- Какие сообщения бот отправил в канал (чтобы потом править их текст и подпись). Раньше номера не сохранялись.
CREATE TABLE IF NOT EXISTS channel_posts (
  msg_id  INTEGER PRIMARY KEY,
  at      INTEGER NOT NULL,
  head    TEXT,            -- первая строка поста (для поиска)
  photo   INTEGER NOT NULL DEFAULT 0
);
