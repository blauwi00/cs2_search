-- Выборки «дешёвые предметы Steam» идут по цене: индекс, чтобы не читать всю таблицу.
CREATE INDEX IF NOT EXISTS steam_live_cents ON steam_live (cents);
