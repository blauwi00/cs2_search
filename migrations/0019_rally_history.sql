-- История цен дешёвых предметов из прохода «Разгона» — для будущих бэктестов (по дням).
CREATE TABLE IF NOT EXISTS rally_history (
  name     TEXT    NOT NULL,
  day      TEXT    NOT NULL,
  min_kop  INTEGER NOT NULL,     -- самое дешёвое объявление за день (минимум наблюдений)
  sum_kop  INTEGER NOT NULL,     -- сумма наблюдений (для средней)
  n        INTEGER NOT NULL,
  volume   INTEGER,              -- продаж за сутки (последнее наблюдение)
  PRIMARY KEY (name, day)
);
