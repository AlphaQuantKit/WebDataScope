ALTER TABLE upload_sessions ADD COLUMN key_ciphertext TEXT;
ALTER TABLE upload_sessions ADD COLUMN key_iv TEXT;
ALTER TABLE upload_sessions ADD COLUMN key_version INTEGER;
ALTER TABLE upload_sessions ADD COLUMN result_json TEXT;
