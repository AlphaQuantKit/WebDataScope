CREATE TABLE IF NOT EXISTS snapshot_builds (
    version INTEGER PRIMARY KEY,
    object_prefix TEXT NOT NULL,
    record_count INTEGER NOT NULL,
    pnl_point_count INTEGER NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('building', 'published', 'failed')),
    expected_bundle_count INTEGER NOT NULL DEFAULT 0,
    bundle_queued_at INTEGER,
    assemble_queued_at INTEGER,
    rebuild_requested INTEGER NOT NULL DEFAULT 0,
    source_upload_id TEXT,
    error TEXT,
    created_at INTEGER NOT NULL,
    published_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_snapshot_builds_status
    ON snapshot_builds(status, version DESC);

ALTER TABLE upload_parts ADD COLUMN process_failed_at INTEGER;
