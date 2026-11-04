-- Имя для бегущей строки «Топ поддержки» (имя из Telegram на момент оплаты; скрывается настройкой donor_top = 0).
ALTER TABLE donations ADD COLUMN name TEXT;
