-- Привязка аккаунта Steam (только SteamID — без паролей, cookies и Steam Guard) и открытый инвентарь Steam.
ALTER TABLE users ADD COLUMN steam_id TEXT;            -- SteamID64
ALTER TABLE users ADD COLUMN steam_vanity TEXT;        -- короткое имя из ссылки /id/<имя>, пока не определён SteamID64
ALTER TABLE users ADD COLUMN steam_verified INTEGER NOT NULL DEFAULT 0;  -- 1 — вход через Steam подтверждён
ALTER TABLE users ADD COLUMN inv_requested_at INTEGER; -- когда пользователь попросил обновить инвентарь
ALTER TABLE users ADD COLUMN inv_synced_at INTEGER;    -- когда сборщик прислал инвентарь
ALTER TABLE users ADD COLUMN inv_status TEXT;          -- ok | private | not_found | rate_limited | error

-- Одноразовые метки входа через Steam (живут 15 минут).
CREATE TABLE IF NOT EXISTS steam_login (
  nonce       TEXT PRIMARY KEY,
  telegram_id INTEGER NOT NULL,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS steam_inventory (
  telegram_id  INTEGER NOT NULL,
  item_id      INTEGER NOT NULL,
  qty          INTEGER NOT NULL,
  marketable   INTEGER NOT NULL DEFAULT 1,
  tradable     INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (telegram_id, item_id)
);
