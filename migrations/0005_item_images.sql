-- Картинки предметов (адреса картинок Steam CDN из открытого каталога ByMykel/CSGO-API).
CREATE TABLE IF NOT EXISTS item_images (
  name  TEXT PRIMARY KEY,
  url   TEXT NOT NULL
);
