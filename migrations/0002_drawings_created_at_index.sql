CREATE INDEX IF NOT EXISTS drawings_created_at_id_idx
ON drawings (created_at DESC, id DESC);
