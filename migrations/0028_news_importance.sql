-- Важность новости 0–100 и причины (считает сборщик по правилам, без нейросети).
ALTER TABLE news ADD COLUMN importance INTEGER;
ALTER TABLE news ADD COLUMN why TEXT;
