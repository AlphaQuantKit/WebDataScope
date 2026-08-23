ALTER TABLE upload_sessions ADD COLUMN direct_key_ciphertext TEXT;
ALTER TABLE upload_sessions ADD COLUMN direct_key_iv TEXT;
ALTER TABLE upload_sessions ADD COLUMN direct_key_version INTEGER;

ALTER TABLE upload_parts ADD COLUMN process_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE upload_parts ADD COLUMN process_error TEXT;

ALTER TABLE snapshots ADD COLUMN bundle_queued_at INTEGER;
ALTER TABLE snapshots ADD COLUMN assemble_queued_at INTEGER;
ALTER TABLE snapshots ADD COLUMN expected_bundle_count INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS snapshot_bundles (
    snapshot_version INTEGER NOT NULL,
    bundle_number INTEGER NOT NULL,
    object_key TEXT NOT NULL,
    first_part INTEGER NOT NULL,
    last_part INTEGER NOT NULL,
    byte_count INTEGER NOT NULL,
    sha256 TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (snapshot_version, bundle_number)
);

CREATE INDEX IF NOT EXISTS idx_snapshot_bundles_version
    ON snapshot_bundles(snapshot_version, bundle_number);
