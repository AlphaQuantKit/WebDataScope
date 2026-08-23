PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS installation_challenges (
    challenge_id TEXT PRIMARY KEY,
    installation_id TEXT NOT NULL,
    nonce TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    used_at INTEGER
);

CREATE TABLE IF NOT EXISTS installations (
    installation_id TEXT PRIMARY KEY,
    account_hash TEXT NOT NULL,
    encrypted_wq_id TEXT NOT NULL,
    encryption_iv TEXT NOT NULL,
    key_version INTEGER NOT NULL,
    public_key_jwk TEXT NOT NULL,
    plugin_version TEXT NOT NULL,
    first_seen_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    disabled INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS upload_sessions (
    session_id TEXT PRIMARY KEY,
    installation_id TEXT NOT NULL,
    account_hash TEXT NOT NULL,
    upload_token_hash TEXT NOT NULL,
    manifest_json TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('open', 'finalized', 'rejected', 'expired')),
    created_at INTEGER NOT NULL,
    finalized_at INTEGER,
    FOREIGN KEY (installation_id) REFERENCES installations(installation_id)
);

CREATE TABLE IF NOT EXISTS upload_parts (
    session_id TEXT NOT NULL,
    part_number INTEGER NOT NULL,
    object_key TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    byte_count INTEGER NOT NULL,
    PRIMARY KEY (session_id, part_number),
    FOREIGN KEY (session_id) REFERENCES upload_sessions(session_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS staged_alphas (
    session_id TEXT NOT NULL,
    alias TEXT NOT NULL,
    encrypted_alpha_id TEXT NOT NULL,
    alpha_iv TEXT NOT NULL,
    key_version INTEGER NOT NULL,
    account_hash TEXT NOT NULL,
    source_type TEXT NOT NULL,
    group_key TEXT NOT NULL,
    prod_corr REAL NOT NULL,
    classifications_json TEXT NOT NULL,
    pnl_object_key TEXT NOT NULL,
    pnl_point_count INTEGER NOT NULL,
    fingerprint TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (session_id, alias),
    FOREIGN KEY (session_id) REFERENCES upload_sessions(session_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS contributors (
    account_hash TEXT PRIMARY KEY,
    encrypted_wq_id TEXT NOT NULL,
    encryption_iv TEXT NOT NULL,
    key_version INTEGER NOT NULL,
    active_key_hash TEXT,
    key_expires_at INTEGER,
    disabled INTEGER NOT NULL DEFAULT 0,
    first_seen_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS access_keys (
    key_hash TEXT PRIMARY KEY,
    account_hash TEXT NOT NULL,
    issued_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    revoked_at INTEGER,
    download_day TEXT NOT NULL,
    download_count INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (account_hash) REFERENCES contributors(account_hash)
);

CREATE TABLE IF NOT EXISTS shared_alphas (
    alias TEXT PRIMARY KEY,
    encrypted_alpha_id TEXT NOT NULL,
    alpha_iv TEXT NOT NULL,
    key_version INTEGER NOT NULL,
    account_hash TEXT NOT NULL,
    source_type TEXT NOT NULL CHECK (source_type IN ('submitted', 'prod')),
    group_key TEXT NOT NULL,
    prod_corr REAL NOT NULL,
    classifications_json TEXT NOT NULL,
    pnl_object_key TEXT NOT NULL,
    pnl_point_count INTEGER NOT NULL,
    fingerprint TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (account_hash) REFERENCES contributors(account_hash)
);

CREATE TABLE IF NOT EXISTS snapshots (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    version INTEGER NOT NULL,
    object_key TEXT NOT NULL,
    record_count INTEGER NOT NULL,
    pnl_point_count INTEGER NOT NULL,
    byte_count INTEGER NOT NULL,
    sha256 TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('building', 'published', 'failed')),
    published_at INTEGER
);

CREATE TABLE IF NOT EXISTS upload_audit (
    upload_id TEXT PRIMARY KEY,
    account_hash TEXT NOT NULL,
    status TEXT NOT NULL,
    reason TEXT,
    record_count INTEGER NOT NULL DEFAULT 0,
    pnl_point_count INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    finalized_at INTEGER
);

CREATE TABLE IF NOT EXISTS admin_audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    action TEXT NOT NULL,
    target TEXT,
    created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_installations_account ON installations(account_hash);
CREATE INDEX IF NOT EXISTS idx_sessions_account ON upload_sessions(account_hash);
CREATE INDEX IF NOT EXISTS idx_parts_session ON upload_parts(session_id);
CREATE INDEX IF NOT EXISTS idx_staged_session ON staged_alphas(session_id);
CREATE INDEX IF NOT EXISTS idx_keys_account ON access_keys(account_hash);
CREATE INDEX IF NOT EXISTS idx_alphas_account ON shared_alphas(account_hash);
CREATE INDEX IF NOT EXISTS idx_alphas_group ON shared_alphas(group_key);
CREATE INDEX IF NOT EXISTS idx_upload_audit_created ON upload_audit(created_at DESC);
