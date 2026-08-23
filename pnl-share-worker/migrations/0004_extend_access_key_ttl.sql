UPDATE access_keys
SET expires_at = issued_at + (10 * 24 * 60 * 60 * 1000)
WHERE revoked_at IS NULL
  AND expires_at = issued_at + (7 * 24 * 60 * 60 * 1000);

UPDATE contributors
SET key_expires_at = (
    SELECT access_keys.expires_at
    FROM access_keys
    WHERE access_keys.key_hash = contributors.active_key_hash
)
WHERE active_key_hash IS NOT NULL
  AND EXISTS (
      SELECT 1
      FROM access_keys
      WHERE access_keys.key_hash = contributors.active_key_hash
        AND access_keys.revoked_at IS NULL
  );
