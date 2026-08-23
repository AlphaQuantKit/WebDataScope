ALTER TABLE upload_sessions ADD COLUMN finalize_parts_json TEXT;
ALTER TABLE upload_sessions ADD COLUMN finalize_signature TEXT;
ALTER TABLE upload_sessions ADD COLUMN finalize_authorized_at INTEGER;
ALTER TABLE upload_sessions ADD COLUMN finalize_claimed_at INTEGER;
ALTER TABLE upload_sessions ADD COLUMN finalize_error TEXT;

CREATE INDEX IF NOT EXISTS idx_upload_sessions_finalize_ready
    ON upload_sessions(status, finalize_authorized_at, expires_at);

-- Give already-processed legacy sessions one recovery window. Their clients
-- can reopen the extension, submit the original signed finalize request, and
-- receive the same result instead of losing a completed upload immediately.
UPDATE upload_sessions
SET expires_at = MAX(
    expires_at,
    CAST(strftime('%s', 'now') AS INTEGER) * 1000 + 86400000
)
WHERE status = 'open'
  AND EXISTS (
      SELECT 1 FROM upload_parts p
      WHERE p.session_id = upload_sessions.session_id
  )
  AND NOT EXISTS (
      SELECT 1 FROM upload_parts p
      WHERE p.session_id = upload_sessions.session_id
        AND p.processed_at IS NULL
  )
  AND EXISTS (
      SELECT 1 FROM staged_alphas s
      WHERE s.session_id = upload_sessions.session_id
  );
