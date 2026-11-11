-- Новости не только Valve: источник, рейтинг и число комментариев (Reddit). У старых строк источник — valve.
ALTER TABLE news ADD COLUMN source TEXT NOT NULL DEFAULT 'valve';
ALTER TABLE news ADD COLUMN score INTEGER;
ALTER TABLE news ADD COLUMN comments INTEGER;
