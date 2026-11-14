-- Живые цены Steam по всем предметам (домашний сборщик, ноутбук): самое дешёвое объявление в ЦЕНТАХ USD и число объявлений.
-- Пишутся только изменения (цена или число объявлений поменялись, либо запись старше 3 суток), чтобы не тратить лимит записей D1.
-- Свежесть данных — по мете steam_live_pass_at (время последнего полного прохода), а не по строке.
CREATE TABLE IF NOT EXISTS steam_live (
  name TEXT PRIMARY KEY,
  cents INTEGER NOT NULL,
  listings INTEGER,
  at INTEGER NOT NULL
);
