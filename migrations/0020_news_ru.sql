-- Краткое содержание обновлений CS2 на русском (сборщик переводит пункты патчноута).
ALTER TABLE news ADD COLUMN title_ru TEXT;
ALTER TABLE news ADD COLUMN summary_ru TEXT;     -- JSON: { sections: [{ name, items: [..] }], more: N, market: [..] }
ALTER TABLE news ADD COLUMN ru_posted_at INTEGER; -- когда опубликовано краткое содержание (для уже вышедших постов на английском)
