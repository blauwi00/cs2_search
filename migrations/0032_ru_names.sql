-- Официальные русские названия предметов (Steam, l=russian): базовое английское название (без износа, StatTrak™, Souvenir) -> русское.
-- Пишутся один раз на предмет (INSERT OR IGNORE), домашний сборщик присылает их вместе с живыми ценами.
CREATE TABLE IF NOT EXISTS ru_names (
  en TEXT PRIMARY KEY,
  ru TEXT NOT NULL
);
