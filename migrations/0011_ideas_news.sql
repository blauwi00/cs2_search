-- Честная история идей: что бот предложил в «Идеях дня» и что с этим стало через сутки.
CREATE TABLE IF NOT EXISTS idea_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  day           TEXT    NOT NULL,           -- дата по Варшаве
  name          TEXT    NOT NULL,
  buy_at        TEXT    NOT NULL,
  sell_at       TEXT    NOT NULL,
  pay_kop       INTEGER NOT NULL,
  sell_kop      INTEGER,
  get_kop       INTEGER NOT NULL,
  profit_kop    INTEGER NOT NULL,
  roi_bp        INTEGER NOT NULL,
  wallet        TEXT    NOT NULL,
  created_at    INTEGER NOT NULL,
  checked_at    INTEGER,
  get_kop_24    INTEGER,                    -- сколько получил бы через сутки, продав там же
  profit_kop_24 INTEGER,
  outcome       TEXT                        -- plus | minus | gone (нет данных через сутки)
);
CREATE INDEX IF NOT EXISTS idx_idea_day ON idea_log (day);
CREATE INDEX IF NOT EXISTS idx_idea_check ON idea_log (checked_at, created_at);

-- Новости CS2 из Steam (объявления разработчиков) — для постов «Обновление CS2».
CREATE TABLE IF NOT EXISTS news (
  gid           TEXT PRIMARY KEY,
  title         TEXT NOT NULL,
  url           TEXT NOT NULL,
  snippet       TEXT,
  published_at  INTEGER NOT NULL,
  posted_at     INTEGER
);
