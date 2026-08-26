CREATE TABLE IF NOT EXISTS drawing_crops (
  drawing_id TEXT PRIMARY KEY NOT NULL
    REFERENCES drawings(id) ON DELETE CASCADE,
  x REAL NOT NULL CHECK (x >= 0),
  y REAL NOT NULL CHECK (y >= 0),
  width REAL NOT NULL CHECK (width >= 12),
  height REAL NOT NULL CHECK (height >= 16.981),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  CHECK (x + width <= 595.001),
  CHECK (y + height <= 842.001),
  CHECK (abs(width * 842.0 - height * 595.0) <= 1.0)
) STRICT;
