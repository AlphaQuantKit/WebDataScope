ALTER TABLE upload_parts ADD COLUMN processed_at INTEGER;
ALTER TABLE upload_parts ADD COLUMN record_count INTEGER NOT NULL DEFAULT 0;
