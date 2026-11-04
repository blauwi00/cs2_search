-- CS2 Market Bot — начальная схема (этапы 1–2).
-- Все денежные суммы в UAH хранятся в копейках (INTEGER, *_kop).
-- Исходные цены площадок хранятся в минимальных единицах своей валюты (*_minor) + код валюты.
-- Время — Unix-секунды (INTEGER, UTC).

CREATE TABLE IF NOT EXISTS users (
  telegram_id      INTEGER PRIMARY KEY,
  language         TEXT    NOT NULL DEFAULT 'ru',
  is_admin         INTEGER NOT NULL DEFAULT 0,
  created_at       INTEGER NOT NULL
);

-- Настройки: ключ-значение, чтобы добавлять параметры без новых миграций.
CREATE TABLE IF NOT EXISTS user_settings (
  telegram_id  INTEGER NOT NULL,
  key          TEXT    NOT NULL,
  value        TEXT    NOT NULL,
  updated_at   INTEGER NOT NULL,
  PRIMARY KEY (telegram_id, key)
);

-- Ожидание текстового ввода (поиск, ввод числа в настройках).
CREATE TABLE IF NOT EXISTS user_state (
  telegram_id  INTEGER PRIMARY KEY,
  awaiting     TEXT    NOT NULL,
  payload      TEXT,
  expires_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS items (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  market_hash_name  TEXT    NOT NULL UNIQUE,
  weapon            TEXT,
  skin              TEXT,
  category          TEXT    NOT NULL,      -- case, capsule, sticker, knife, gloves, weapon, agent, patch, other
  wear              TEXT,                  -- FN, MW, FT, WW, BS или NULL
  stattrak          INTEGER NOT NULL DEFAULT 0,
  souvenir          INTEGER NOT NULL DEFAULT 0,
  is_unique_priced  INTEGER NOT NULL DEFAULT 0,  -- цена зависит от экземпляра (паттерн, фаза, float)
  needs_eval        INTEGER NOT NULL DEFAULT 0,  -- котировки обновились, нужен пересчёт сигналов
  created_at        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_items_eval ON items(needs_eval);

CREATE TABLE IF NOT EXISTS watchlist (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_id       INTEGER NOT NULL,
  item_id           INTEGER NOT NULL REFERENCES items(id),
  target_buy_kop    INTEGER,               -- уведомить, если цена Steam ниже
  change_pct_bp     INTEGER,               -- порог изменения в базисных пунктах (1500 = 15%)
  active            INTEGER NOT NULL DEFAULT 1,
  priority          INTEGER NOT NULL DEFAULT 1,  -- 0 низкий, 1 обычный, 2 высокий
  created_at        INTEGER NOT NULL,
  UNIQUE (telegram_id, item_id)
);
CREATE INDEX IF NOT EXISTS idx_watchlist_active ON watchlist(active, item_id);

-- Последнее известное состояние предмета на площадке (одна строка на пару источник+предмет+тип цены).
CREATE TABLE IF NOT EXISTS market_quotes (
  source           TEXT    NOT NULL,       -- steam, skinport, csfloat
  item_id          INTEGER NOT NULL REFERENCES items(id),
  price_type       TEXT    NOT NULL,       -- lowest_listing, median_24h, sale_median_7d ...
  price_minor      INTEGER,                -- NULL = неизвестно
  currency         TEXT    NOT NULL,
  price_kop        INTEGER,                -- в UAH
  fx_rate_id       INTEGER,                -- NULL, если валюта уже UAH
  quantity         INTEGER,                -- число объявлений, если известно
  volume           INTEGER,                -- число продаж за период, если известно
  volume_period    TEXT,
  listing_id       TEXT,
  url              TEXT,
  fetched_at       INTEGER NOT NULL,
  source_updated_at INTEGER,
  quality          TEXT    NOT NULL,       -- ok, partial, stale
  snap_at          INTEGER,                -- время последнего снимка в истории (для экономии записей)
  PRIMARY KEY (source, item_id, price_type)
);

-- История наблюдений. Пишется только при изменении цены или раз в heartbeat-интервал.
CREATE TABLE IF NOT EXISTS price_snapshots (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id      INTEGER NOT NULL REFERENCES items(id),
  source       TEXT    NOT NULL,
  price_type   TEXT    NOT NULL,
  price_minor  INTEGER,
  currency     TEXT    NOT NULL,
  price_kop    INTEGER,
  fx_rate_id   INTEGER,
  quantity     INTEGER,
  volume       INTEGER,
  observed_at  INTEGER NOT NULL,
  quality      TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_snap_item_time ON price_snapshots(item_id, source, price_type, observed_at);
CREATE INDEX IF NOT EXISTS idx_snap_time ON price_snapshots(observed_at);

-- Дневные агрегаты для долгого хранения (сырые снимки старше N дней удаляются).
CREATE TABLE IF NOT EXISTS price_daily (
  item_id      INTEGER NOT NULL,
  source       TEXT    NOT NULL,
  price_type   TEXT    NOT NULL,
  day          TEXT    NOT NULL,           -- YYYY-MM-DD (UTC)
  currency     TEXT    NOT NULL,
  min_minor    INTEGER,
  max_minor    INTEGER,
  avg_minor    INTEGER,
  last_minor   INTEGER,
  samples      INTEGER NOT NULL,
  PRIMARY KEY (item_id, source, price_type, day)
);

CREATE TABLE IF NOT EXISTS exchange_rates (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  base         TEXT    NOT NULL,           -- USD, EUR, PLN
  quote        TEXT    NOT NULL DEFAULT 'UAH',
  rate_micro   INTEGER NOT NULL,           -- UAH за 1 единицу base * 1e6
  rate_date    TEXT    NOT NULL,           -- дата курса НБУ, YYYY-MM-DD
  source       TEXT    NOT NULL,
  fetched_at   INTEGER NOT NULL,
  UNIQUE (base, quote, rate_date, source)
);

CREATE TABLE IF NOT EXISTS signals (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  dedup_key       TEXT    NOT NULL,
  kind            TEXT    NOT NULL,        -- arbitrage_steam, price_drop, price_rise, target_price, anomaly
  item_id         INTEGER NOT NULL,
  state           TEXT    NOT NULL,        -- detected, confirmed, notified, unconfirmed, expired, dismissed
  priority        TEXT    NOT NULL,        -- high, medium, low
  category        TEXT,                    -- verified_spread, estimated, anomaly
  buy_source      TEXT,
  sell_source     TEXT,
  buy_kop         INTEGER,
  sell_kop        INTEGER,
  proceeds_kop    INTEGER,
  spread_kop      INTEGER,
  roi_bp          INTEGER,
  reason          TEXT    NOT NULL,
  snapshot_json   TEXT    NOT NULL,        -- исходные данные на момент обнаружения
  detected_at     INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  notified_at     INTEGER,
  telegram_msg_id INTEGER,
  UNIQUE (dedup_key)
);
CREATE INDEX IF NOT EXISTS idx_signals_state ON signals(state, priority, updated_at);
CREATE INDEX IF NOT EXISTS idx_signals_item ON signals(item_id, kind);

CREATE TABLE IF NOT EXISTS notification_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_id INTEGER NOT NULL,
  kind        TEXT    NOT NULL,
  ref         TEXT,
  sent_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notif_time ON notification_log(telegram_id, sent_at);

CREATE TABLE IF NOT EXISTS source_status (
  source          TEXT PRIMARY KEY,
  status          TEXT    NOT NULL,        -- ok, degraded, down, disabled, rate_limited
  last_ok_at      INTEGER,
  last_error_at   INTEGER,
  last_error      TEXT,
  disabled_reason TEXT,
  down_since      INTEGER,
  alerted_at      INTEGER,
  requests_today  INTEGER NOT NULL DEFAULT 0,
  requests_day    TEXT
);

CREATE TABLE IF NOT EXISTS scheduler_jobs (
  name            TEXT PRIMARY KEY,
  interval_sec    INTEGER NOT NULL,
  next_run_at     INTEGER NOT NULL,
  lock_until      INTEGER NOT NULL DEFAULT 0,
  lock_token      TEXT,
  last_run_at     INTEGER,
  last_ok_at      INTEGER,
  last_error      TEXT,
  fail_count      INTEGER NOT NULL DEFAULT 0,
  started_unfinished INTEGER NOT NULL DEFAULT 0,  -- запусков, оборванных платформой (например, лимит CPU)
  enabled         INTEGER NOT NULL DEFAULT 1,
  cursor          TEXT
);

CREATE TABLE IF NOT EXISTS usage_counters (
  day        TEXT NOT NULL,
  counter    TEXT NOT NULL,
  value      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, counter)
);

CREATE TABLE IF NOT EXISTS system_logs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  at          INTEGER NOT NULL,
  level       TEXT    NOT NULL,            -- info, warn, error
  source      TEXT,
  code        TEXT,
  message     TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_logs_time ON system_logs(at);
