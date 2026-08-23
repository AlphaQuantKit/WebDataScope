ALTER TABLE shared_alphas ADD COLUMN source_revision INTEGER NOT NULL DEFAULT 0;

ALTER TABLE snapshots ADD COLUMN expected_chunk_count INTEGER NOT NULL DEFAULT 0;

ALTER TABLE snapshot_builds ADD COLUMN source_revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE snapshot_builds ADD COLUMN expected_chunk_count INTEGER NOT NULL DEFAULT 0;

ALTER TABLE snapshot_chunks ADD COLUMN lane_number INTEGER NOT NULL DEFAULT 1;
ALTER TABLE snapshot_chunks ADD COLUMN first_alias TEXT;
ALTER TABLE snapshot_chunks ADD COLUMN last_alias TEXT;

UPDATE snapshots
SET expected_chunk_count = (
    SELECT COUNT(*) FROM snapshot_chunks c WHERE c.snapshot_version = snapshots.version
);

UPDATE snapshot_builds
SET expected_chunk_count = (
    SELECT COUNT(*) FROM snapshot_chunks c WHERE c.snapshot_version = snapshot_builds.version
);

CREATE INDEX IF NOT EXISTS idx_snapshot_chunks_alias_cursor
    ON snapshot_chunks(snapshot_version, lane_number, last_alias);

CREATE TABLE IF NOT EXISTS snapshot_build_lanes (
    snapshot_version INTEGER NOT NULL,
    lane_number INTEGER NOT NULL,
    after_alias TEXT NOT NULL,
    before_alias TEXT,
    record_count INTEGER NOT NULL,
    pnl_point_count INTEGER NOT NULL,
    start_part INTEGER NOT NULL,
    end_part INTEGER NOT NULL,
    PRIMARY KEY (snapshot_version, lane_number),
    FOREIGN KEY (snapshot_version) REFERENCES snapshot_builds(version) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS snapshot_publication_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    source_revision INTEGER NOT NULL DEFAULT 0,
    published_revision INTEGER NOT NULL DEFAULT 0,
    dirty_at INTEGER,
    last_build_started_at INTEGER,
    last_published_at INTEGER
);

UPDATE shared_alphas SET source_revision = 1 WHERE source_revision = 0;

UPDATE snapshot_builds
SET status = 'failed', error = 'Superseded by alias-cursor snapshot builder.'
WHERE status = 'building';

INSERT INTO snapshot_publication_state (
    id, source_revision, published_revision, dirty_at,
    last_build_started_at, last_published_at
)
SELECT
    1,
    CASE WHEN EXISTS (SELECT 1 FROM shared_alphas) THEN 1 ELSE 0 END,
    CASE WHEN EXISTS (
        SELECT 1
        FROM snapshots s
        WHERE s.id = 1
          AND s.status = 'published'
          AND s.object_key LIKE '%.jsonl.gz'
          AND s.record_count = (SELECT COUNT(*) FROM shared_alphas)
          AND s.pnl_point_count = (SELECT COALESCE(SUM(pnl_point_count), 0) FROM shared_alphas)
    ) THEN 1 ELSE 0 END,
    CASE WHEN EXISTS (SELECT 1 FROM shared_alphas)
        AND NOT EXISTS (
            SELECT 1
            FROM snapshots s
            WHERE s.id = 1
              AND s.status = 'published'
              AND s.object_key LIKE '%.jsonl.gz'
              AND s.record_count = (SELECT COUNT(*) FROM shared_alphas)
              AND s.pnl_point_count = (SELECT COALESCE(SUM(pnl_point_count), 0) FROM shared_alphas)
        )
        THEN CAST(strftime('%s', 'now') AS INTEGER) * 1000
        ELSE NULL
    END,
    NULL,
    (SELECT published_at FROM snapshots WHERE id = 1);
