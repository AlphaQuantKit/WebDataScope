CREATE TABLE IF NOT EXISTS snapshot_chunks (
    snapshot_version INTEGER NOT NULL,
    part_number INTEGER NOT NULL,
    object_key TEXT NOT NULL,
    record_count INTEGER NOT NULL,
    pnl_point_count INTEGER NOT NULL,
    byte_count INTEGER NOT NULL,
    sha256 TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (snapshot_version, part_number)
);

CREATE INDEX IF NOT EXISTS idx_snapshot_chunks_version
    ON snapshot_chunks(snapshot_version, part_number);
