import {
    base64UrlToBytes,
    bytesToBase64Url,
    currentKeyVersion,
    decryptBytes,
    decryptBytesWithKey,
    decryptText,
    encryptBytes,
    encryptTextWithKey,
    encryptText,
    hmacHex,
    hmacHexWithKey,
    importEncryptionKey,
    importHmacKey,
    randomBytes,
    sha256Hex,
    verifySignature,
} from './crypto.js';
import { RequestValidationError } from './errors.js';
import {
    MAX_PART_BYTES,
    MAX_RECORDS,
    MAX_UPLOAD_BYTES,
    validateInstallationId,
    validateManifest,
    validateSha256,
    validateShareRecord,
} from './validation.js';
import { adminRequest } from './admin.js';
import { directR2Config, presignR2Url } from './s3.js';

const KEY_TTL_MS = 10 * 24 * 60 * 60 * 1000;
const UPLOAD_TTL_MS = 24 * 60 * 60 * 1000;
const FINALIZE_CLAIM_TIMEOUT_MS = 5 * 60 * 1000;
const FINALIZE_WATCHDOG_DELAY_SECONDS = 15 * 60;
const CHALLENGE_TTL_MS = 10 * 60 * 1000;
const DOWNLOAD_LIMIT = 30;
const MAX_PART_RECORDS = 8;
const SNAPSHOT_PART_RECORDS = 8;
const SNAPSHOT_BUNDLE_PARTS = 32;
const SNAPSHOT_REBUILD_INTERVAL_MS = 2 * 60 * 60 * 1000;
const PNL_ORPHAN_GRACE_MS = 24 * 60 * 60 * 1000;
const SNAPSHOT_ALIAS_LANES = Object.freeze([
    { afterAlias: '', beforeAlias: 'alpha_4' },
    { afterAlias: 'alpha_4', beforeAlias: 'alpha_8' },
    { afterAlias: 'alpha_8', beforeAlias: 'alpha_c' },
    { afterAlias: 'alpha_c', beforeAlias: null },
]);
const DIRECT_URL_BATCH_SIZE = 32;
const DIRECT_UPLOAD_URL_TTL_SECONDS = 60 * 60;
const DIRECT_DOWNLOAD_URL_TTL_SECONDS = 5 * 60;
const DIRECT_UPLOAD_CONTENT_TYPE = 'application/json';
const CHROME_EXTENSION_ORIGIN_PATTERN = /^chrome-extension:\/\/[a-p]{32}$/;

function now() {
    return Date.now();
}

function dayKey(timestamp = now()) {
    return new Date(timestamp).toISOString().slice(0, 10);
}

function downloadQuota(key) {
    const used = Math.max(0, Number(key?.download_count || 0));
    return {
        used,
        remaining: Math.max(0, DOWNLOAD_LIMIT - used),
        limit: DOWNLOAD_LIMIT,
    };
}

function snapshotPartCount(recordCount) {
    return Math.ceil(Math.max(0, Number(recordCount) || 0) / SNAPSHOT_PART_RECORDS);
}

function snapshotBundleCount(partCount) {
    return Math.ceil(Math.max(0, Number(partCount) || 0) / SNAPSHOT_BUNDLE_PARTS);
}

function snapshotAliasLaneBounds() {
    return SNAPSHOT_ALIAS_LANES.map((lane, index) => ({
        laneNumber: index + 1,
        ...lane,
    }));
}

function snapshotLanePlan(laneStats) {
    let nextPart = 1;
    return snapshotAliasLaneBounds().map((lane, index) => {
        const stats = laneStats[index] || {};
        const recordCount = Math.max(0, Number(stats.record_count || 0));
        const pnlPointCount = Math.max(0, Number(stats.pnl_point_count || 0));
        const partCount = snapshotPartCount(recordCount);
        const planned = {
            ...lane,
            recordCount,
            pnlPointCount,
            startPart: partCount ? nextPart : 0,
            endPart: partCount ? nextPart + partCount - 1 : 0,
        };
        nextPart += partCount;
        return planned;
    });
}

function snapshotGzipMembers(snapshot, chunks, totalBytes = snapshot?.byte_count) {
    if (!String(snapshot?.object_key || '').endsWith('.jsonl.gz') || !Array.isArray(chunks)) return null;
    const partBytes = chunks.map((chunk) => Number(chunk.byte_count || 0));
    if (partBytes.some((bytes) => !Number.isSafeInteger(bytes) || bytes < 1)) return null;
    const metaBytes = Number(totalBytes) - partBytes.reduce((sum, bytes) => sum + bytes, 0);
    if (!Number.isSafeInteger(metaBytes) || metaBytes < 1) return null;
    return [metaBytes, ...partBytes];
}

function directUploadObjectKey(sessionId, partNumber) {
    return `direct-uploads/${sessionId}/${partNumber}.json`;
}

function snapshotIsConsistent(snapshot, totals, chunkCount) {
    const recordCount = Number(snapshot?.record_count || 0);
    const pnlPointCount = Number(snapshot?.pnl_point_count || 0);
    const expectedChunkCount = Number(snapshot?.expected_chunk_count ?? snapshotPartCount(recordCount));
    return snapshot?.status === 'published'
        && recordCount === Number(totals?.record_count || 0)
        && pnlPointCount === Number(totals?.pnl_point_count || 0)
        && Number(chunkCount) === expectedChunkCount;
}

function jsonResponse(value, status = 200, extra = {}) {
    return new Response(JSON.stringify(value), {
        status,
        headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'no-store',
            'X-Content-Type-Options': 'nosniff',
            ...extra,
        },
    });
}

function isExtensionOriginAllowed(origin, env) {
    const mode = String(env.EXTENSION_ORIGIN_MODE || '').trim().toLowerCase();
    return mode === 'any-chrome-extension' && CHROME_EXTENSION_ORIGIN_PATTERN.test(origin || '');
}

function corsHeaders(request, env) {
    const origin = request.headers.get('Origin');
    const originAllowed = isExtensionOriginAllowed(origin, env);
    return originAllowed
        ? {
            'Access-Control-Allow-Origin': origin,
            'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Upload-Token, X-Content-SHA256, X-Content-Encoding',
            'Access-Control-Max-Age': '600',
            'Vary': 'Origin',
        }
        : {};
}

function optionsResponse(request, env) {
    return new Response(null, { status: 204, headers: corsHeaders(request, env) });
}

async function readJson(request, maxBytes = 1_048_576) {
    const length = Number(request.headers.get('Content-Length'));
    if (Number.isFinite(length) && length > maxBytes) throw new RequestValidationError('Request body is too large.', 413, 'payload_too_large');
    const bytes = new Uint8Array(await request.arrayBuffer());
    if (bytes.byteLength > maxBytes) throw new RequestValidationError('Request body is too large.', 413, 'payload_too_large');
    try {
        return JSON.parse(new TextDecoder().decode(bytes));
    } catch {
        throw new RequestValidationError('Request body must be valid JSON.');
    }
}

async function readBoundedBytes(request, maxBytes = MAX_PART_BYTES) {
    const length = Number(request.headers.get('Content-Length'));
    if (Number.isFinite(length) && length > maxBytes) throw new RequestValidationError('Part is too large.', 413, 'payload_too_large');
    const bytes = new Uint8Array(await request.arrayBuffer());
    if (bytes.byteLength > maxBytes) throw new RequestValidationError('Part is too large.', 413, 'payload_too_large');
    return bytes;
}

function requireSecret(env, name) {
    if (!env[name]) throw new Error(`Missing Worker secret: ${name}`);
    return String(env[name]);
}

async function accountHash(wqId, env) {
    return hmacHex(requireSecret(env, 'ACCOUNT_HASH_SECRET'), wqId);
}

async function bearerHash(value, env) {
    return hmacHex(requireSecret(env, 'ACCESS_KEY_HASH_SECRET'), value);
}

async function aliasFor(alphaId, env) {
    return `alpha_${await hmacHex(requireSecret(env, 'ALPHA_ALIAS_SECRET'), alphaId)}`;
}

async function signatureFor(operation, value) {
    return `${operation}|${value}`;
}

function requirePluginOrigin(request, env) {
    const origin = request.headers.get('Origin');
    if (!isExtensionOriginAllowed(origin, env)) {
        const error = new Error('Only the configured extension origin may upload.');
        error.status = 403;
        error.code = 'origin_not_allowed';
        throw error;
    }
}

async function enforceRateLimit(request, env, installationId = '') {
    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    const [ipResult, installationResult] = await Promise.all([
        env.SHARE_IP_RATE_LIMITER?.limit({ key: ip }) ?? { success: true },
        installationId
            ? env.SHARE_INSTALL_RATE_LIMITER?.limit({ key: installationId }) ?? { success: true }
            : { success: true },
    ]);
    if (!ipResult.success || !installationResult.success) {
        const error = new Error('Rate limit exceeded.');
        error.status = 429;
        error.code = 'rate_limited';
        error.headers = { 'Retry-After': '60' };
        throw error;
    }
}

async function getInstallation(installationId, env) {
    return env.DB.prepare('SELECT * FROM installations WHERE installation_id = ?').bind(installationId).first();
}

async function verifyInstallationSignature(installation, operation, value, signature) {
    if (!installation || installation.disabled) return false;
    return verifySignature(
        JSON.parse(installation.public_key_jwk),
        await signatureFor(operation, value),
        signature,
    );
}

async function handleChallenge(request, env) {
    requirePluginOrigin(request, env);
    const body = await readJson(request, 16_384);
    const installationId = validateInstallationId(body.installationId);
    await enforceRateLimit(request, env, installationId);
    const challengeId = bytesToBase64Url(randomBytes(18));
    const nonce = bytesToBase64Url(randomBytes(32));
    const expiresAt = now() + CHALLENGE_TTL_MS;
    await env.DB.prepare(`
        INSERT INTO installation_challenges (challenge_id, installation_id, nonce, expires_at)
        VALUES (?, ?, ?, ?)
    `).bind(challengeId, installationId, nonce, expiresAt).run();
    return jsonResponse({ ok: true, challengeId, nonce, expiresAt });
}

async function handleInstallation(request, env) {
    requirePluginOrigin(request, env);
    const body = await readJson(request, 64 * 1024);
    const installationId = validateInstallationId(body.installationId);
    const wqId = String(body.wqId || '').trim();
    const pluginVersion = String(body.pluginVersion || '').trim();
    if (!wqId || wqId.length > 128 || !pluginVersion || pluginVersion.length > 32) {
        throw new RequestValidationError('Invalid installation identity.');
    }
    if (!body.publicKeyJwk || body.publicKeyJwk.kty !== 'EC' || body.publicKeyJwk.crv !== 'P-256') {
        throw new RequestValidationError('Only a P-256 public key is accepted.');
    }
    const challenge = await env.DB.prepare(`
        SELECT * FROM installation_challenges
        WHERE challenge_id = ? AND installation_id = ? AND used_at IS NULL AND expires_at > ?
    `).bind(String(body.challengeId || ''), installationId, now()).first();
    if (!challenge) throw new RequestValidationError('Challenge is missing or expired.', 401, 'challenge_expired');
    const signed = [challenge.nonce, installationId, wqId, pluginVersion].join('|');
    if (!await verifySignature(body.publicKeyJwk, await signatureFor('register', signed), body.signature)) {
        throw new RequestValidationError('Invalid installation signature.', 401, 'invalid_signature');
    }
    const hash = await accountHash(wqId, env);
    const keyVersion = currentKeyVersion(env);
    const encrypted = await encryptText(wqId, requireSecret(env, `WQ_ID_ENCRYPTION_KEY_V${keyVersion}`));
    const timestamp = now();
    await env.DB.batch([
        env.DB.prepare('UPDATE installation_challenges SET used_at = ? WHERE challenge_id = ?').bind(timestamp, challenge.challenge_id),
        env.DB.prepare(`
            INSERT INTO installations (
                installation_id, account_hash, encrypted_wq_id, encryption_iv, key_version,
                public_key_jwk, plugin_version, first_seen_at, last_seen_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(installation_id) DO UPDATE SET
                account_hash = excluded.account_hash,
                encrypted_wq_id = excluded.encrypted_wq_id,
                encryption_iv = excluded.encryption_iv,
                key_version = excluded.key_version,
                public_key_jwk = excluded.public_key_jwk,
                plugin_version = excluded.plugin_version,
                last_seen_at = excluded.last_seen_at,
                disabled = 0
        `).bind(installationId, hash, encrypted.ciphertext, encrypted.iv, keyVersion, JSON.stringify(body.publicKeyJwk), pluginVersion, timestamp, timestamp),
        env.DB.prepare(`
            INSERT INTO contributors (
                account_hash, encrypted_wq_id, encryption_iv, key_version, first_seen_at, last_seen_at
            ) VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(account_hash) DO UPDATE SET
                encrypted_wq_id = excluded.encrypted_wq_id,
                encryption_iv = excluded.encryption_iv,
                key_version = excluded.key_version,
                last_seen_at = excluded.last_seen_at,
                disabled = 0
        `).bind(hash, encrypted.ciphertext, encrypted.iv, keyVersion, timestamp, timestamp),
    ]);
    return jsonResponse({ ok: true, installationId, accountHash: hash });
}

async function handleUploadCreate(request, env) {
    if (String(env.UPLOAD_ENABLED).toLowerCase() !== 'true') return jsonResponse({ ok: false, error: 'upload_disabled' }, 503);
    requirePluginOrigin(request, env);
    const body = await readJson(request, 256 * 1024);
    const installationId = validateInstallationId(body.installationId);
    await enforceRateLimit(request, env, installationId);
    const installation = await getInstallation(installationId, env);
    if (!installation) throw new RequestValidationError('Installation is not registered.', 401, 'installation_required');
    const manifest = validateManifest(body.manifest);
    if (await accountHash(manifest.wqId, env) !== installation.account_hash) {
        throw new RequestValidationError('The live WQ account does not match the registered installation.', 409, 'account_mismatch');
    }
    const signed = `${installationId}|${JSON.stringify(manifest)}`;
    if (!await verifyInstallationSignature(installation, 'upload', signed, body.signature)) {
        throw new RequestValidationError('Invalid upload signature.', 401, 'invalid_signature');
    }
    const sessionId = bytesToBase64Url(randomBytes(18));
    const uploadToken = `upl_${bytesToBase64Url(randomBytes(32))}`;
    const expiresAt = now() + UPLOAD_TTL_MS;
    const directEnabled = Boolean(directR2Config(env));
    const directEncryptionKey = directEnabled ? bytesToBase64Url(randomBytes(32)) : '';
    const directKeyVersion = currentKeyVersion(env);
    const wrappedDirectKey = directEnabled
        ? await encryptText(directEncryptionKey, requireSecret(env, `UPLOAD_ENCRYPTION_KEY_V${directKeyVersion}`))
        : null;
    await env.DB.prepare(`
        INSERT INTO upload_sessions (
            session_id, installation_id, account_hash, upload_token_hash,
            manifest_json, expires_at, status, created_at,
            direct_key_ciphertext, direct_key_iv, direct_key_version
        ) VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?)
    `).bind(
        sessionId,
        installationId,
        installation.account_hash,
        await bearerHash(uploadToken, env),
        JSON.stringify(manifest),
        expiresAt,
        now(),
        wrappedDirectKey?.ciphertext || null,
        wrappedDirectKey?.iv || null,
        directEnabled ? directKeyVersion : null,
    ).run();
    return jsonResponse({
        ok: true,
        sessionId,
        uploadToken,
        expiresAt,
        partSize: MAX_PART_BYTES,
        maxPartRecords: MAX_PART_RECORDS,
        directUpload: directEnabled,
        directEncryptionKey: directEncryptionKey || undefined,
        directUrlBatchSize: directEnabled ? DIRECT_URL_BATCH_SIZE : 0,
    });
}

async function getUploadSession(sessionId, uploadToken, env) {
    const tokenHash = await bearerHash(uploadToken, env);
    return env.DB.prepare(`
        SELECT * FROM upload_sessions
        WHERE session_id = ? AND upload_token_hash = ? AND status = 'open' AND expires_at > ?
    `).bind(sessionId, tokenHash, now()).first();
}

async function getFinalizableUploadSession(sessionId, uploadToken, env) {
    const tokenHash = await bearerHash(uploadToken, env);
    return env.DB.prepare(`
        SELECT * FROM upload_sessions
        WHERE session_id = ? AND upload_token_hash = ?
          AND (status = 'finalized' OR (status = 'open' AND expires_at > ?))
    `).bind(sessionId, tokenHash, now()).first();
}

async function getSessionDirectEncryptionKey(session, env) {
    if (!session?.direct_key_ciphertext || !session?.direct_key_iv || !session?.direct_key_version) return null;
    return decryptText(
        session.direct_key_ciphertext,
        session.direct_key_iv,
        requireSecret(env, `UPLOAD_ENCRYPTION_KEY_V${Number(session.direct_key_version)}`),
    );
}

async function handleDirectUploadUrls(request, env, sessionId) {
    requirePluginOrigin(request, env);
    if (!directR2Config(env)) throw new RequestValidationError('Direct R2 upload is unavailable.', 409, 'direct_upload_unavailable');
    const body = await readJson(request, 64 * 1024);
    const session = await getUploadSession(sessionId, String(body.uploadToken || ''), env);
    if (!session) throw new RequestValidationError('Upload session is missing or expired.', 401, 'upload_session_invalid');
    if (!session.direct_key_ciphertext) throw new RequestValidationError('This session does not support direct upload.', 409, 'direct_upload_unavailable');
    await enforceRateLimit(request, env);
    const manifest = JSON.parse(session.manifest_json);
    const parts = Array.isArray(body.parts) ? [...new Set(body.parts.map(Number))] : [];
    if (!parts.length || parts.length > DIRECT_URL_BATCH_SIZE || parts.some((part) => (
        !Number.isInteger(part) || part < 1 || part > manifest.partCount
    ))) throw new RequestValidationError('Invalid direct upload part list.');
    const uploads = await Promise.all(parts.map(async (part) => {
        const signed = await presignR2Url(env, {
            method: 'PUT',
            objectKey: directUploadObjectKey(sessionId, part),
            contentType: DIRECT_UPLOAD_CONTENT_TYPE,
            expiresSeconds: DIRECT_UPLOAD_URL_TTL_SECONDS,
        });
        return { part, ...signed };
    }));
    return jsonResponse({ ok: true, uploads }, 200, corsHeaders(request, env));
}

async function enqueueUploadParts(env, sessionId, parts) {
    if (!env.SNAPSHOT_QUEUE) throw new Error('Upload processing queue is unavailable.');
    const messages = parts.map((part) => ({ body: { type: 'upload-part', sessionId, part } }));
    for (let start = 0; start < messages.length; start += 100) {
        await env.SNAPSHOT_QUEUE.sendBatch(messages.slice(start, start + 100));
    }
}

async function enqueueUploadFinalize(env, sessionId) {
    if (!env.SNAPSHOT_QUEUE) throw new Error('Upload processing queue is unavailable.');
    await env.SNAPSHOT_QUEUE.send(
        { type: 'upload-finalize', sessionId },
        { delaySeconds: FINALIZE_WATCHDOG_DELAY_SECONDS },
    );
}

async function handleDirectUploadComplete(request, env, sessionId) {
    requirePluginOrigin(request, env);
    const body = await readJson(request, 768 * 1024);
    const session = await getUploadSession(sessionId, String(body.uploadToken || ''), env);
    if (!session) throw new RequestValidationError('Upload session is missing or expired.', 401, 'upload_session_invalid');
    if (!session.direct_key_ciphertext) throw new RequestValidationError('This session does not support direct upload.', 409, 'direct_upload_unavailable');
    await enforceRateLimit(request, env);
    const manifest = JSON.parse(session.manifest_json);
    const parts = Array.isArray(body.parts) ? body.parts.map((item) => ({
        part: Number(item.part),
        sha256: validateSha256(item.sha256, 'part.sha256'),
        bytes: Number(item.bytes),
    })).sort((left, right) => left.part - right.part) : [];
    if (parts.length !== manifest.partCount || parts.some((part, index) => (
        part.part !== index + 1
        || !Number.isInteger(part.bytes)
        || part.bytes < 1
        || part.bytes > MAX_PART_BYTES
    ))) throw new RequestValidationError('Direct upload parts are incomplete.');
    const payloadDigest = await sha256Hex(parts.map((part) => part.sha256).join(':'));
    if (payloadDigest !== manifest.payloadSha256) throw new RequestValidationError('Manifest payload checksum mismatch.', 409, 'checksum_mismatch');
    const installation = await getInstallation(session.installation_id, env);
    const signatureValue = `${sessionId}|${JSON.stringify(parts)}|${manifest.payloadSha256}`;
    if (!await verifyInstallationSignature(installation, 'direct-complete', signatureValue, body.signature)) {
        throw new RequestValidationError('Invalid direct upload signature.', 401, 'invalid_signature');
    }
    const statements = parts.map((part) => env.DB.prepare(`
        INSERT INTO upload_parts (session_id, part_number, object_key, sha256, byte_count)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(session_id, part_number) DO UPDATE SET
            object_key = excluded.object_key,
            sha256 = excluded.sha256,
            byte_count = excluded.byte_count
    `).bind(sessionId, part.part, directUploadObjectKey(sessionId, part.part), part.sha256, part.bytes));
    for (let start = 0; start < statements.length; start += 100) {
        await env.DB.batch(statements.slice(start, start + 100));
    }
    await enqueueUploadParts(env, sessionId, parts.map((part) => part.part));
    return jsonResponse({ ok: true, queued: true, uploaded: parts.length, total: manifest.partCount }, 202, corsHeaders(request, env));
}

async function handleUploadPart(request, env, sessionId, partNumber) {
    requirePluginOrigin(request, env);
    const uploadToken = request.headers.get('X-Upload-Token') || '';
    const session = await getUploadSession(sessionId, uploadToken, env);
    if (!session) throw new RequestValidationError('Upload session is missing or expired.', 401, 'upload_session_invalid');
    await enforceRateLimit(request, env);
    const part = Number(partNumber);
    const manifest = JSON.parse(session.manifest_json);
    if (!Number.isInteger(part) || part < 1 || part > manifest.partCount) throw new RequestValidationError('Invalid part number.');
    const bytes = await readBoundedBytes(request);
    if (bytes.byteLength > MAX_UPLOAD_BYTES) throw new RequestValidationError('Upload is too large.', 413, 'payload_too_large');
    const digest = validateSha256(request.headers.get('X-Content-SHA256') || '', 'X-Content-SHA256');
    if (await sha256Hex(bytes) !== digest) throw new RequestValidationError('Part checksum mismatch.', 400, 'checksum_mismatch');
    const contentEncoding = String(request.headers.get('X-Content-Encoding') || '').trim().toLowerCase();
    if (contentEncoding && contentEncoding !== 'gzip') throw new RequestValidationError('Unsupported part compression.');
    const keyVersion = currentKeyVersion(env);
    const encrypted = await encryptBytes(bytes, requireSecret(env, `UPLOAD_ENCRYPTION_KEY_V${keyVersion}`));
    const objectKey = `uploads/${sessionId}/${part}.json`;
    await env.RAW_BUCKET.put(objectKey, JSON.stringify({ ...encrypted, keyVersion, contentEncoding }), {
        httpMetadata: { contentType: 'application/json' },
    });
    await env.DB.prepare(`
        INSERT INTO upload_parts (session_id, part_number, object_key, sha256, byte_count)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(session_id, part_number) DO UPDATE SET
            object_key = excluded.object_key,
            sha256 = excluded.sha256,
            byte_count = excluded.byte_count
    `).bind(sessionId, part, objectKey, digest, bytes.byteLength).run();
    await enqueueUploadParts(env, sessionId, [part]);
    return jsonResponse({ ok: true, part, sha256: digest, bytes: bytes.byteLength, queued: true });
}

async function handleUploadStatus(request, env, ctx, sessionId) {
    // Chrome extension GET requests can omit Origin. The high-entropy upload
    // token is the authorization boundary for this read-only polling route.
    const uploadToken = request.headers.get('X-Upload-Token') || '';
    let session = await getFinalizableUploadSession(sessionId, uploadToken, env);
    if (!session) throw new RequestValidationError('Upload session is missing or expired.', 401, 'upload_session_invalid');
    await enforceRateLimit(request, env);
    const manifest = JSON.parse(session.manifest_json);
    const [totals, failures] = await Promise.all([
        env.DB.prepare(`
            SELECT COUNT(*) AS uploaded,
                   COALESCE(SUM(CASE WHEN processed_at IS NOT NULL THEN 1 ELSE 0 END), 0) AS processed,
                   COALESCE(SUM(CASE WHEN process_failed_at IS NOT NULL AND processed_at IS NULL THEN 1 ELSE 0 END), 0) AS failed,
                   COALESCE(SUM(CASE WHEN process_error IS NOT NULL AND process_failed_at IS NULL AND processed_at IS NULL THEN 1 ELSE 0 END), 0) AS retrying,
                   COALESCE(SUM(record_count), 0) AS record_count
            FROM upload_parts WHERE session_id = ?
        `).bind(sessionId).first(),
        env.DB.prepare(`
            SELECT part_number, process_attempts, process_error
            FROM upload_parts
            WHERE session_id = ? AND process_error IS NOT NULL AND processed_at IS NULL
            ORDER BY part_number ASC LIMIT 10
        `).bind(sessionId).all(),
    ]);
    if (session.status === 'open'
        && session.finalize_authorized_at
        && Number(totals?.processed || 0) === Number(manifest.partCount || 0)
        && Number(manifest.partCount || 0) > 0) {
        try {
            await finalizeAuthorizedUpload(sessionId, env, ctx);
        } catch (error) {
            console.error(JSON.stringify({
                message: 'status-triggered upload finalize failed',
                sessionId,
                error: String(error?.message || error),
            }));
        }
        session = await env.DB.prepare('SELECT * FROM upload_sessions WHERE session_id = ?').bind(sessionId).first() || session;
    }
    return jsonResponse({
        ok: true,
        status: session.status,
        finalizeAuthorized: Boolean(session.finalize_authorized_at),
        finalizeError: String(session.finalize_error || ''),
        expiresAt: Number(session.expires_at || 0),
        finalizedAt: Number(session.finalized_at || 0),
        uploaded: Number(totals?.uploaded || 0),
        processed: Number(totals?.processed || 0),
        failed: Number(totals?.failed || 0),
        retrying: Number(totals?.retrying || 0),
        recordCount: Number(totals?.record_count || 0),
        total: Number(manifest.partCount || 0),
        errors: (failures.results || []).map((row) => ({
            part: Number(row.part_number),
            attempts: Number(row.process_attempts || 0),
            message: row.process_error,
        })),
    }, 200, corsHeaders(request, env));
}

async function decompressBytes(bytes) {
    if (typeof DecompressionStream === 'undefined') throw new Error('Gzip decompression is unavailable.');
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
}

function cachedEncryptionKey(secret, keyCache) {
    if (!keyCache) return importEncryptionKey(secret);
    if (!keyCache.has(secret)) keyCache.set(secret, importEncryptionKey(secret));
    return keyCache.get(secret);
}

async function readEncryptedObject(key, env, options = {}) {
    const object = await env.RAW_BUCKET.get(key);
    if (!object) throw new RequestValidationError('Upload object is missing.', 409, 'upload_part_missing');
    const envelope = JSON.parse(await object.text());
    let encryptionKey = options.key;
    if (envelope.sessionEncrypted === true) {
        if (!options.sessionKey) throw new RequestValidationError('Direct upload encryption key is unavailable.', 409, 'direct_key_missing');
        encryptionKey ||= importEncryptionKey(options.sessionKey);
    } else {
        const secret = requireSecret(env, `UPLOAD_ENCRYPTION_KEY_V${Number(envelope.keyVersion || currentKeyVersion(env))}`);
        encryptionKey ||= cachedEncryptionKey(secret, options.keyCache);
    }
    const encryptedBytes = await decryptBytesWithKey(envelope.ciphertext, envelope.iv, await encryptionKey);
    if (options.raw) return { bytes: encryptedBytes, contentEncoding: envelope.contentEncoding || '' };
    return {
        bytes: envelope.contentEncoding === 'gzip' ? await decompressBytes(encryptedBytes) : encryptedBytes,
        contentEncoding: envelope.contentEncoding || '',
    };
}

function parseUploadRecords(bytes) {
    const records = [];
    const seen = new Set();
    const lines = new TextDecoder().decode(bytes).split('\n').filter(Boolean);
    for (const line of lines) {
        let value;
        try { value = JSON.parse(line); } catch { throw new RequestValidationError('Upload contains invalid NDJSON.'); }
        const record = validateShareRecord(value);
        if (seen.has(record.alphaId)) throw new RequestValidationError('Upload contains duplicate Alpha IDs.');
        seen.add(record.alphaId);
        records.push(record);
        if (records.length > MAX_PART_RECORDS) throw new RequestValidationError('Upload part contains too many Alpha records.');
        if (records.length > MAX_RECORDS) throw new RequestValidationError('Too many Alpha records.');
    }
    return records;
}

async function prepareUploadRecords(records, accountHashValue, env, options = {}) {
    const preparedRecords = [];
    for (const record of records) {
        const alias = options.aliasKey
            ? await hmacHexWithKey(options.aliasKey, record.alphaId).then((value) => `alpha_${value}`)
            : await aliasFor(record.alphaId, env);
        const fingerprint = await sha256Hex(JSON.stringify({
            sourceType: record.sourceType,
            groupKey: record.groupKey,
            prodCorr: record.prodCorr,
            classifications: record.classifications,
            pnl: record.pnl,
        }));
        preparedRecords.push({ ...record, alias, fingerprint, accountHash: accountHashValue });
    }
    return preparedRecords;
}

async function stagedAliasConflict(sessionId, preparedRecords, env) {
    const aliases = preparedRecords.map((record) => record.alias);
    for (let start = 0; start < aliases.length; start += 400) {
        const batch = aliases.slice(start, start + 400);
        const placeholders = batch.map(() => '?').join(',');
        const result = await env.DB.prepare(`
            SELECT alias FROM staged_alphas WHERE session_id = ? AND alias IN (${placeholders})
        `).bind(sessionId, ...batch).all();
        if ((result.results || []).length) throw new RequestValidationError('Upload contains duplicate Alpha IDs.');
    }
}

async function stagePreparedRecords(session, preparedRecords, env, options = {}) {
    const keyVersion = currentKeyVersion(env);
    const timestamp = now();
    const alphaKey = options.alphaKey || await importEncryptionKey(requireSecret(env, `ALPHA_ID_ENCRYPTION_KEY_V${keyVersion}`));
    const uploadKey = options.uploadKey || await importEncryptionKey(requireSecret(env, `UPLOAD_ENCRYPTION_KEY_V${keyVersion}`));
    const statements = [];
    for (const record of preparedRecords) {
        const encryptedAlpha = await encryptTextWithKey(record.alphaId, alphaKey);
        const encryptedPnl = await encryptTextWithKey(JSON.stringify(record.pnl), uploadKey);
        const pnlObjectKey = `pnl/${record.alias}/${record.fingerprint}.json`;
        await env.RAW_BUCKET.put(pnlObjectKey, JSON.stringify({ ...encryptedPnl, keyVersion }), { httpMetadata: { contentType: 'application/json' } });
        statements.push(env.DB.prepare(`
            INSERT INTO staged_alphas (
                session_id, alias, encrypted_alpha_id, alpha_iv, key_version, account_hash,
                source_type, group_key, prod_corr, classifications_json,
                pnl_object_key, pnl_point_count, fingerprint, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(session_id, alias) DO UPDATE SET
                encrypted_alpha_id = excluded.encrypted_alpha_id,
                alpha_iv = excluded.alpha_iv,
                key_version = excluded.key_version,
                account_hash = excluded.account_hash,
                source_type = excluded.source_type,
                group_key = excluded.group_key,
                prod_corr = excluded.prod_corr,
                classifications_json = excluded.classifications_json,
                pnl_object_key = excluded.pnl_object_key,
                pnl_point_count = excluded.pnl_point_count,
                fingerprint = excluded.fingerprint,
                updated_at = excluded.updated_at
        `).bind(
            session.session_id, record.alias, encryptedAlpha.ciphertext, encryptedAlpha.iv, keyVersion, session.account_hash,
            record.sourceType, record.groupKey, record.prodCorr, JSON.stringify(record.classifications),
            pnlObjectKey, record.pnl.records.length, record.fingerprint, timestamp,
        ));
    }
    for (let start = 0; start < statements.length; start += 100) {
        await env.DB.batch(statements.slice(start, start + 100));
    }
}

async function processStoredUploadPart(sessionId, partNumber, env) {
    const session = await env.DB.prepare(`
        SELECT * FROM upload_sessions WHERE session_id = ? AND status = 'open' AND expires_at > ?
    `).bind(sessionId, now()).first();
    if (!session) throw new RequestValidationError('Upload session is missing or expired.', 409, 'upload_session_invalid');
    const part = Number(partNumber);
    const manifest = JSON.parse(session.manifest_json);
    if (!Number.isInteger(part) || part < 1 || part > manifest.partCount) throw new RequestValidationError('Invalid part number.');
    const stored = await env.DB.prepare('SELECT * FROM upload_parts WHERE session_id = ? AND part_number = ?').bind(sessionId, part).first();
    if (!stored) throw new RequestValidationError('Upload part is missing.', 409, 'upload_part_missing');
    if (stored.processed_at) return { ok: true, part, processed: true, recordCount: Number(stored.record_count || 0) };

    await env.DB.prepare(`
        UPDATE upload_parts SET process_attempts = process_attempts + 1, process_error = NULL
        WHERE session_id = ? AND part_number = ?
    `).bind(sessionId, part).run();
    try {
        const keyCache = new Map();
        const sessionKey = await getSessionDirectEncryptionKey(session, env);
        const raw = await readEncryptedObject(stored.object_key, env, { raw: true, keyCache, sessionKey });
        if (await sha256Hex(raw.bytes) !== stored.sha256) throw new RequestValidationError('Stored part checksum mismatch.', 409, 'checksum_mismatch');
        const bytes = raw.contentEncoding === 'gzip' ? await decompressBytes(raw.bytes) : raw.bytes;
        if (bytes.byteLength > MAX_PART_BYTES) throw new RequestValidationError('Decompressed part is too large.', 413, 'payload_too_large');
        const records = parseUploadRecords(bytes);
        const keyVersion = currentKeyVersion(env);
        const [aliasKey, alphaKey, uploadKey] = await Promise.all([
            importHmacKey(requireSecret(env, 'ALPHA_ALIAS_SECRET')),
            cachedEncryptionKey(requireSecret(env, `ALPHA_ID_ENCRYPTION_KEY_V${keyVersion}`), keyCache),
            cachedEncryptionKey(requireSecret(env, `UPLOAD_ENCRYPTION_KEY_V${keyVersion}`), keyCache),
        ]);
        const preparedRecords = await prepareUploadRecords(records, session.account_hash, env, { aliasKey });
        const conflicts = await existingConflicts(preparedRecords, env);
        if (conflicts.length) throw new RequestValidationError('Alpha data conflicts with a different contributor.', 409, 'alpha_conflict');
        await stagePreparedRecords(session, preparedRecords, env, { alphaKey, uploadKey });
        await env.DB.prepare(`
            UPDATE upload_parts SET processed_at = ?, record_count = ?, process_error = NULL, process_failed_at = NULL
            WHERE session_id = ? AND part_number = ?
        `).bind(now(), preparedRecords.length, sessionId, part).run();
        try {
            await env.RAW_BUCKET.delete(stored.object_key);
        } catch (error) {
            console.warn(JSON.stringify({ message: 'upload object cleanup failed', sessionId, part, error: String(error?.message || error) }));
        }
        return { ok: true, part, processed: true, recordCount: preparedRecords.length };
    } catch (error) {
        await env.DB.prepare(`
            UPDATE upload_parts SET process_error = ? WHERE session_id = ? AND part_number = ?
        `).bind(String(error?.message || error).slice(0, 500), sessionId, part).run();
        throw error;
    }
}

async function handleUploadProcess(request, env, sessionId, partNumber) {
    requirePluginOrigin(request, env);
    const uploadToken = request.headers.get('X-Upload-Token') || '';
    const session = await getUploadSession(sessionId, uploadToken, env);
    if (!session) throw new RequestValidationError('Upload session is missing or expired.', 401, 'upload_session_invalid');
    await enforceRateLimit(request, env);
    return jsonResponse(await processStoredUploadPart(sessionId, Number(partNumber), env));
}

async function existingConflicts(records, env) {
    const conflicts = [];
    for (let start = 0; start < records.length; start += 400) {
        const aliases = records.slice(start, start + 400).map((record) => record.alias);
        const placeholders = aliases.map(() => '?').join(',');
        if (!placeholders) continue;
        const result = await env.DB.prepare(`SELECT alias, account_hash, fingerprint FROM shared_alphas WHERE alias IN (${placeholders})`).bind(...aliases).all();
        const byAlias = new Map((result.results || []).map((row) => [row.alias, row]));
        records.slice(start, start + 400).forEach((record, index) => {
            const existing = byAlias.get(aliases[index]);
            if (existing && existing.fingerprint !== record.fingerprint && existing.account_hash !== record.accountHash) {
                conflicts.push(record.alphaId);
            }
        });
    }
    return conflicts;
}

function createAccessKey() {
    const raw = `wqs_${bytesToBase64Url(randomBytes(32))}`;
    const issuedAt = now();
    return { raw, issuedAt, expiresAt: issuedAt + KEY_TTL_MS };
}

async function accessKeyStatements(accountHashValue, accessKey, env) {
    const hash = await bearerHash(accessKey.raw, env);
    const day = dayKey(accessKey.issuedAt);
    return {
        hash,
        statements: [
            env.DB.prepare('UPDATE access_keys SET revoked_at = ? WHERE account_hash = ? AND revoked_at IS NULL').bind(accessKey.issuedAt, accountHashValue),
            env.DB.prepare(`
                INSERT INTO access_keys (key_hash, account_hash, issued_at, expires_at, download_day, download_count)
                VALUES (?, ?, ?, ?, ?, 0)
            `).bind(hash, accountHashValue, accessKey.issuedAt, accessKey.expiresAt, day),
            env.DB.prepare(`
                UPDATE contributors SET active_key_hash = ?, key_expires_at = ?, last_seen_at = ? WHERE account_hash = ?
            `).bind(hash, accessKey.expiresAt, accessKey.issuedAt, accountHashValue),
        ],
    };
}

async function normalizeFinalizeParts(value, manifest) {
    const parts = Array.isArray(value) ? value.map((item) => ({
        part: Number(item.part),
        sha256: validateSha256(item.sha256, 'part.sha256'),
    })).sort((left, right) => left.part - right.part) : [];
    if (!parts.length || parts.length !== Number(manifest.partCount) || parts.some((part, index) => part.part !== index + 1)) {
        throw new RequestValidationError('Upload parts are incomplete.');
    }
    if (await sha256Hex(parts.map((part) => part.sha256).join(':')) !== manifest.payloadSha256) {
        throw new RequestValidationError('Manifest payload checksum mismatch.', 409, 'checksum_mismatch');
    }
    return parts;
}

async function replayFinalizedUpload(session, env) {
    if (!session.key_ciphertext || !session.key_iv || !session.result_json) {
        throw new RequestValidationError('Finalize result is unavailable for replay.', 409, 'finalize_result_missing');
    }
    try {
        const replayKeyVersion = Number(session.key_version || currentKeyVersion(env));
        const replaySecret = requireSecret(env, `UPLOAD_ENCRYPTION_KEY_V${replayKeyVersion}`);
        const replayKey = await decryptText(session.key_ciphertext, session.key_iv, replaySecret);
        const replayEnvelope = JSON.parse(session.result_json);
        const replayResult = JSON.parse(await decryptText(replayEnvelope.ciphertext, replayEnvelope.iv, replaySecret));
        if (replayResult.sessionId !== session.session_id) throw new Error('Finalize replay session mismatch.');
        return { ...replayResult, status: 'finalized', finalizeAuthorized: true, key: replayKey, replayed: true };
    } catch {
        throw new RequestValidationError('Finalize result is unavailable for replay.', 409, 'finalize_result_missing');
    }
}

function pendingFinalizeResult(session, status = 'authorized') {
    return {
        ok: true,
        status,
        pending: true,
        finalizeAuthorized: Boolean(session.finalize_authorized_at),
        expiresAt: Number(session.expires_at || 0),
    };
}

async function finalizeAuthorizedUpload(sessionId, env, ctx) {
    let session = await env.DB.prepare('SELECT * FROM upload_sessions WHERE session_id = ?').bind(sessionId).first();
    if (!session) throw new RequestValidationError('Upload session is missing.', 404, 'upload_session_invalid');
    if (session.status === 'finalized') return replayFinalizedUpload(session, env);
    if (session.status !== 'open' || Number(session.expires_at) <= now()) return pendingFinalizeResult(session, session.status);
    if (!session.finalize_authorized_at || !session.finalize_parts_json) return pendingFinalizeResult(session, 'awaiting_authorization');

    const manifest = JSON.parse(session.manifest_json);
    let authorizedParts;
    try {
        authorizedParts = await normalizeFinalizeParts(JSON.parse(session.finalize_parts_json), manifest);
    } catch (error) {
        throw new RequestValidationError(error.message || 'Stored finalize authorization is invalid.', 409, 'finalize_authorization_invalid');
    }
    const stored = await env.DB.prepare('SELECT * FROM upload_parts WHERE session_id = ? ORDER BY part_number ASC').bind(sessionId).all();
    const storedParts = stored.results || [];
    if (storedParts.length !== authorizedParts.length) return pendingFinalizeResult(session, 'awaiting_parts');
    if (storedParts.some((part, index) => (
        Number(part.part_number) !== authorizedParts[index].part || part.sha256 !== authorizedParts[index].sha256
    ))) {
        const error = new RequestValidationError('Uploaded parts do not match finalize authorization.', 409, 'checksum_mismatch');
        await env.DB.prepare('UPDATE upload_sessions SET finalize_error = ? WHERE session_id = ? AND status = \'open\'')
            .bind(error.message, sessionId).run();
        throw error;
    }
    if (storedParts.some((part) => part.process_failed_at && !part.processed_at)) return pendingFinalizeResult(session, 'failed');
    if (storedParts.some((part) => !part.processed_at)) return pendingFinalizeResult(session, 'processing');

    const claimTimestamp = now();
    const claim = await env.DB.prepare(`
        UPDATE upload_sessions
        SET finalize_claimed_at = ?, finalize_error = NULL
        WHERE session_id = ? AND status = 'open' AND finalize_authorized_at IS NOT NULL
          AND (finalize_claimed_at IS NULL OR finalize_claimed_at < ?)
    `).bind(claimTimestamp, sessionId, claimTimestamp - FINALIZE_CLAIM_TIMEOUT_MS).run();
    const claimChanges = Number(claim?.meta?.changes ?? claim?.changes ?? 0);
    if (claimChanges !== 1) {
        session = await env.DB.prepare('SELECT * FROM upload_sessions WHERE session_id = ?').bind(sessionId).first();
        if (session?.status === 'finalized') return replayFinalizedUpload(session, env);
        return pendingFinalizeResult(session || {}, 'finalizing');
    }

    try {
        const totals = await env.DB.prepare(`
            SELECT COUNT(*) AS record_count,
                   COALESCE(SUM(CASE WHEN source_type = 'submitted' THEN 1 ELSE 0 END), 0) AS submitted_count,
                   COALESCE(SUM(pnl_point_count), 0) AS pnl_point_count
            FROM staged_alphas WHERE session_id = ?
        `).bind(sessionId).first();
        const recordCount = Number(totals?.record_count || 0);
        const submittedCount = Number(totals?.submitted_count || 0);
        const pnlPointCount = Number(totals?.pnl_point_count || 0);
        if (recordCount !== Number(manifest.recordCount) || recordCount > MAX_RECORDS) {
            throw new RequestValidationError('Manifest recordCount mismatch.');
        }
        if (submittedCount !== Number(manifest.remoteCount)) {
            throw new RequestValidationError('Submitted Alpha count mismatch.');
        }
        const totalBytes = storedParts.reduce((sum, part) => sum + Number(part.byte_count || 0), 0);
        const accountHashValue = session.account_hash;
        const keyVersion = currentKeyVersion(env);
        const timestamp = now();
        const accessKey = createAccessKey();
        const accessKeyBatch = await accessKeyStatements(accountHashValue, accessKey, env);
        const resultPayload = {
            ok: true,
            sessionId,
            expiresAt: accessKey.expiresAt,
            recordCount,
            bytes: totalBytes,
            aliasMap: [],
        };
        const resultSecret = requireSecret(env, `UPLOAD_ENCRYPTION_KEY_V${keyVersion}`);
        const encryptedResult = await encryptText(JSON.stringify(resultPayload), resultSecret);
        const encryptedAccessKey = await encryptText(accessKey.raw, resultSecret);
        await env.DB.batch([
            env.DB.prepare(`
                INSERT INTO shared_alphas (
                    alias, encrypted_alpha_id, alpha_iv, key_version, account_hash,
                    source_type, group_key, prod_corr, classifications_json,
                    pnl_object_key, pnl_point_count, fingerprint, updated_at, source_revision
                )
                SELECT alias, encrypted_alpha_id, alpha_iv, key_version, account_hash,
                       source_type, group_key, prod_corr, classifications_json,
                       pnl_object_key, pnl_point_count, fingerprint, updated_at, ?
                FROM staged_alphas WHERE session_id = ?
                ON CONFLICT(alias) DO UPDATE SET
                    encrypted_alpha_id = excluded.encrypted_alpha_id,
                    alpha_iv = excluded.alpha_iv,
                    key_version = excluded.key_version,
                    account_hash = excluded.account_hash,
                    source_type = excluded.source_type,
                    group_key = excluded.group_key,
                    prod_corr = excluded.prod_corr,
                    classifications_json = excluded.classifications_json,
                    pnl_object_key = excluded.pnl_object_key,
                    pnl_point_count = excluded.pnl_point_count,
                    fingerprint = excluded.fingerprint,
                    updated_at = excluded.updated_at,
                    source_revision = excluded.source_revision
            `).bind(timestamp, sessionId),
            env.DB.prepare(`
                UPDATE upload_sessions
                SET status = 'finalized', finalized_at = ?, finalize_error = NULL,
                    key_ciphertext = ?, key_iv = ?, key_version = ?, result_json = ?
                WHERE session_id = ? AND status = 'open' AND finalize_claimed_at = ?
            `).bind(timestamp, encryptedAccessKey.ciphertext, encryptedAccessKey.iv, keyVersion, JSON.stringify(encryptedResult), sessionId, claimTimestamp),
            env.DB.prepare(`
                INSERT INTO upload_audit (upload_id, account_hash, status, record_count, pnl_point_count, created_at, finalized_at)
                VALUES (?, ?, 'accepted', ?, ?, ?, ?)
            `).bind(sessionId, accountHashValue, recordCount, pnlPointCount, timestamp, timestamp),
            env.DB.prepare('DELETE FROM staged_alphas WHERE session_id = ?').bind(sessionId),
            env.DB.prepare(`
                UPDATE snapshot_publication_state
                SET source_revision = MAX(source_revision, ?), dirty_at = COALESCE(dirty_at, ?)
                WHERE id = 1
            `).bind(timestamp, timestamp),
            ...accessKeyBatch.statements,
        ]);
        const cleanup = cleanupUploadSessionObjects(sessionId, manifest.partCount, env);
        if (ctx?.waitUntil) ctx.waitUntil(cleanup);
        else await cleanup;
        return {
            ...resultPayload,
            status: 'finalized',
            finalizeAuthorized: true,
            finalizedAt: timestamp,
            key: accessKey.raw,
            replayed: false,
        };
    } catch (error) {
        await env.DB.prepare(`
            UPDATE upload_sessions
            SET finalize_claimed_at = NULL, finalize_error = ?
            WHERE session_id = ? AND status = 'open' AND finalize_claimed_at = ?
        `).bind(String(error?.message || error).slice(0, 500), sessionId, claimTimestamp).run();
        throw error;
    }
}

async function handleUploadFinalize(request, env, ctx, sessionId) {
    requirePluginOrigin(request, env);
    const body = await readJson(request, 512 * 1024);
    let session = await getFinalizableUploadSession(sessionId, String(body.uploadToken || ''), env);
    if (!session) throw new RequestValidationError('Upload session is missing or expired.', 401, 'upload_session_invalid');
    await enforceRateLimit(request, env, session.installation_id);
    const manifest = JSON.parse(session.manifest_json);
    const parts = await normalizeFinalizeParts(body.parts, manifest);
    const installation = await getInstallation(session.installation_id, env);
    const signatureValue = `${sessionId}|${JSON.stringify(parts)}|${manifest.payloadSha256}`;
    if (!await verifyInstallationSignature(installation, 'finalize', signatureValue, body.signature)) {
        throw new RequestValidationError('Invalid finalize signature.', 401, 'invalid_signature');
    }
    if (session.status === 'finalized') {
        const replay = await replayFinalizedUpload(session, env);
        const { replayed, ...payload } = replay;
        return jsonResponse(payload, 201, { 'X-Idempotent-Replay': 'true', ...corsHeaders(request, env) });
    }

    const partsJson = JSON.stringify(parts);
    if (session.finalize_parts_json && session.finalize_parts_json !== partsJson) {
        throw new RequestValidationError('Finalize authorization does not match the existing request.', 409, 'finalize_authorization_mismatch');
    }
    const wasAuthorized = Boolean(session.finalize_authorized_at);
    const authorizedAt = Number(session.finalize_authorized_at || now());
    const expiresAt = Math.max(Number(session.expires_at || 0), now() + UPLOAD_TTL_MS);
    await env.DB.prepare(`
        UPDATE upload_sessions
        SET finalize_parts_json = ?, finalize_signature = ?, finalize_authorized_at = ?,
            finalize_error = NULL, expires_at = ?
        WHERE session_id = ? AND status = 'open'
    `).bind(partsJson, String(body.signature || ''), authorizedAt, expiresAt, sessionId).run();
    session = { ...session, finalize_parts_json: partsJson, finalize_authorized_at: authorizedAt, finalize_error: null, expires_at: expiresAt };
    if (!wasAuthorized) await enqueueUploadFinalize(env, sessionId);

    const result = await finalizeAuthorizedUpload(sessionId, env, ctx);
    const { replayed, ...payload } = result;
    return jsonResponse(payload, result.status === 'finalized' ? 201 : 202, {
        ...(replayed ? { 'X-Idempotent-Replay': 'true' } : {}),
        ...corsHeaders(request, env),
    });
}

async function authenticateKey(request, env) {
    const header = request.headers.get('Authorization') || '';
    if (!header.startsWith('Bearer ')) throw new RequestValidationError('Bearer key required.', 401, 'key_required');
    const raw = header.slice(7).trim();
    if (!/^wqs_[A-Za-z0-9_-]{40,80}$/.test(raw)) throw new RequestValidationError('Invalid key.', 401, 'invalid_key');
    const hash = await bearerHash(raw, env);
    const row = await env.DB.prepare(`
        SELECT k.*, c.disabled AS contributor_disabled
        FROM access_keys k JOIN contributors c ON c.account_hash = k.account_hash
        WHERE k.key_hash = ?
    `).bind(hash).first();
    if (!row || row.revoked_at || Number(row.contributor_disabled)) throw new RequestValidationError('Key is revoked or invalid.', 403, 'key_revoked');
    if (Number(row.expires_at) <= now()) throw new RequestValidationError('Key has expired.', 403, 'key_expired');
    return { ...row, hash };
}

async function handleStats(request, env) {
    await enforceRateLimit(request, env);
    const key = await authenticateKey(request, env);
    const { used, remaining, limit } = downloadQuota(key);
    const [snapshot, sourceTotals, chunkTotals, activeBuild, publicationState] = await Promise.all([
        env.DB.prepare('SELECT * FROM snapshots WHERE id = 1').first(),
        env.DB.prepare('SELECT COUNT(*) AS record_count, COALESCE(SUM(pnl_point_count), 0) AS pnl_point_count FROM shared_alphas').first(),
        env.DB.prepare('SELECT COUNT(*) AS count FROM snapshot_chunks WHERE snapshot_version = (SELECT version FROM snapshots WHERE id = 1)').first(),
        env.DB.prepare("SELECT * FROM snapshot_builds WHERE status = 'building' ORDER BY version DESC LIMIT 1").first(),
        env.DB.prepare('SELECT * FROM snapshot_publication_state WHERE id = 1').first(),
    ]);
    const hasPendingRevision = Number(publicationState?.source_revision || 0)
        > Number(publicationState?.published_revision || 0);
    const pendingBuild = activeBuild || (hasPendingRevision ? {
        version: Number(snapshot?.version || 0) + 1,
        record_count: Number(sourceTotals?.record_count || 0),
        pnl_point_count: Number(sourceTotals?.pnl_point_count || 0),
        created_at: Number(publicationState?.dirty_at || 0),
        scheduled: true,
    } : null);
    return jsonResponse({
        ok: true,
        snapshot: snapshot ? {
            version: Number(snapshot.version),
            status: snapshot.status,
            recordCount: Number(snapshot.record_count),
            pnlPointCount: Number(snapshot.pnl_point_count),
            bytes: Number(snapshot.byte_count),
            sha256: snapshot.sha256,
            publishedAt: Number(snapshot.published_at || 0),
            chunkCount: Number(chunkTotals?.count || 0),
            expectedChunkCount: Number(snapshot.expected_chunk_count ?? snapshotPartCount(snapshot.record_count)),
        } : null,
        totals: {
            // Keep the legacy completeness contract stable while a newer snapshot is building.
            recordCount: Number(snapshot?.record_count ?? sourceTotals?.record_count ?? 0),
            pnlPointCount: Number(snapshot?.pnl_point_count ?? sourceTotals?.pnl_point_count ?? 0),
        },
        sourceTotals: {
            recordCount: Number(sourceTotals?.record_count || 0),
            pnlPointCount: Number(sourceTotals?.pnl_point_count || 0),
        },
        building: pendingBuild ? {
            version: Number(pendingBuild.version),
            recordCount: Number(pendingBuild.record_count),
            pnlPointCount: Number(pendingBuild.pnl_point_count),
            createdAt: Number(pendingBuild.created_at || 0),
            scheduled: Boolean(pendingBuild.scheduled),
        } : null,
        key: {
            expiresAt: Number(key.expires_at),
            used,
            remaining,
            limit,
        },
    }, 200, corsHeaders(request, env));
}

async function consumeDownload(key, env) {
    const result = await env.DB.prepare(`
        UPDATE access_keys
        SET download_count = download_count + 1
        WHERE key_hash = ? AND revoked_at IS NULL AND expires_at > ?
          AND download_count < ?
        RETURNING download_count
    `).bind(key.hash, now(), DOWNLOAD_LIMIT).first();
    if (!result) {
        const error = new Error('Download limit reached.');
        error.status = 429;
        error.code = 'download_limit';
        throw error;
    }
    return result;
}

async function handleDataset(request, env, ctx) {
    if (String(env.DOWNLOAD_ENABLED).toLowerCase() !== 'true') {
        return jsonResponse({ ok: false, error: 'download_disabled' }, 503, corsHeaders(request, env));
    }
    await enforceRateLimit(request, env);
    const key = await authenticateKey(request, env);
    const [snapshot, sourceTotals, chunkRows] = await Promise.all([
        env.DB.prepare('SELECT * FROM snapshots WHERE id = 1').first(),
        env.DB.prepare('SELECT COUNT(*) AS record_count, COALESCE(SUM(pnl_point_count), 0) AS pnl_point_count FROM shared_alphas').first(),
        env.DB.prepare('SELECT part_number, object_key FROM snapshot_chunks WHERE snapshot_version = (SELECT version FROM snapshots WHERE id = 1) ORDER BY part_number ASC').all(),
    ]);
    const chunks = chunkRows?.results || [];
    const publishedTotals = snapshot ? {
        record_count: snapshot.record_count,
        pnl_point_count: snapshot.pnl_point_count,
    } : null;
    if (!snapshot || !snapshotIsConsistent(snapshot, publishedTotals, chunks.length)) {
        return jsonResponse({
            ok: false,
            error: 'snapshot_not_ready',
            message: '共享快照正在构建，请稍后重试。',
            snapshot: snapshot ? {
                status: snapshot.status,
                recordCount: Number(snapshot.record_count || 0),
                pnlPointCount: Number(snapshot.pnl_point_count || 0),
                chunkCount: chunks.length,
                expectedChunkCount: snapshotPartCount(snapshot.record_count),
            } : null,
            totals: {
                recordCount: Number(sourceTotals?.record_count || 0),
                pnlPointCount: Number(sourceTotals?.pnl_point_count || 0),
            },
        }, 503, corsHeaders(request, env));
    }
    if (request.method === 'GET') await consumeDownload(key, env);
    const headers = new Headers(corsHeaders(request, env));
    headers.set('Content-Type', 'application/gzip');
    headers.set('Content-Disposition', `attachment; filename="wq-pnl-prod-corr-v${snapshot.version}.jsonl.gz"`);
    headers.set('Cache-Control', 'no-store');
    headers.set('ETag', `"${snapshot.sha256}"`);
    const finalObject = String(snapshot.object_key || '').endsWith('.jsonl.gz');
    if (finalObject) {
        const object = request.method === 'HEAD'
            ? await env.RAW_BUCKET.head(snapshot.object_key)
            : await env.RAW_BUCKET.get(snapshot.object_key);
        if (!object) return jsonResponse({ ok: false, error: 'snapshot_not_ready', message: '共享快照文件尚未就绪。' }, 503, corsHeaders(request, env));
        headers.set('Content-Length', String(object.size));
        if (request.method === 'HEAD') return new Response(null, { status: 200, headers });
        return new Response(object.body, { status: 200, headers });
    }
    if (request.method === 'HEAD') return new Response(null, { status: 200, headers });

    const { readable, writable } = new TransformStream();
    const compressed = readable.pipeThrough(new CompressionStream('gzip'));
    const pump = (async () => {
        const writer = writable.getWriter();
        try {
            const encoder = new TextEncoder();
            await writer.write(encoder.encode(`{"type":"meta","schemaVersion":1,"recordCount":${snapshot.record_count}}\n`));
            for (const chunk of chunks) {
                const object = await env.RAW_BUCKET.get(chunk.object_key);
                if (!object) throw new Error(`Snapshot chunk is missing: ${chunk.part_number}`);
                if (object.body?.getReader) {
                    const reader = object.body.getReader();
                    try {
                        while (true) {
                            const next = await reader.read();
                            if (next.done) break;
                            await writer.write(next.value);
                        }
                    } finally {
                        reader.releaseLock();
                    }
                } else {
                    await writer.write(new Uint8Array(await object.arrayBuffer()));
                }
            }
            await writer.close();
        } catch (error) {
            await writer.abort(error);
            throw error;
        }
    })();
    if (ctx?.waitUntil) ctx.waitUntil(pump);
    else await pump;
    return new Response(compressed, { status: 200, headers });
}

async function handleDownloadUrl(request, env) {
    if (String(env.DOWNLOAD_ENABLED).toLowerCase() !== 'true') {
        return jsonResponse({ ok: false, error: 'download_disabled' }, 503, corsHeaders(request, env));
    }
    await enforceRateLimit(request, env);
    const key = await authenticateKey(request, env);
    const [snapshot, chunkRows] = await Promise.all([
        env.DB.prepare('SELECT * FROM snapshots WHERE id = 1').first(),
        env.DB.prepare(`
            SELECT part_number, byte_count FROM snapshot_chunks
            WHERE snapshot_version = (SELECT version FROM snapshots WHERE id = 1)
            ORDER BY part_number ASC
        `).all(),
    ]);
    const chunks = chunkRows?.results || [];
    const publishedTotals = snapshot ? {
        record_count: snapshot.record_count,
        pnl_point_count: snapshot.pnl_point_count,
    } : null;
    if (!snapshot || !snapshotIsConsistent(snapshot, publishedTotals, chunks.length)) {
        return jsonResponse({ ok: false, error: 'snapshot_not_ready', message: '共享快照正在构建，请稍后重试。' }, 503, corsHeaders(request, env));
    }
    const finalObject = String(snapshot.object_key || '').endsWith('.jsonl.gz');
    const gzipMembers = finalObject ? snapshotGzipMembers(snapshot, chunks) : null;
    if (finalObject && !gzipMembers) {
        return jsonResponse({ ok: false, error: 'snapshot_not_ready', message: '共享快照解压索引尚未就绪。' }, 503, corsHeaders(request, env));
    }
    if (!finalObject || !directR2Config(env)) {
        return jsonResponse({
            ok: true,
            direct: false,
            datasetUrl: '/v1/share/dataset',
            version: Number(snapshot.version),
            sha256: snapshot.sha256,
            bytes: Number(snapshot.byte_count || 0),
            ...(gzipMembers ? { gzipMembers } : {}),
        }, 200, corsHeaders(request, env));
    }
    const object = await env.RAW_BUCKET.head(snapshot.object_key);
    if (!object) return jsonResponse({ ok: false, error: 'snapshot_not_ready', message: '共享快照文件尚未就绪。' }, 503, corsHeaders(request, env));
    const verifiedGzipMembers = snapshotGzipMembers(snapshot, chunks, object.size);
    if (!verifiedGzipMembers) return jsonResponse({ ok: false, error: 'snapshot_not_ready', message: '共享快照文件大小校验失败。' }, 503, corsHeaders(request, env));
    await consumeDownload(key, env);
    const signed = await presignR2Url(env, {
        method: 'GET',
        objectKey: snapshot.object_key,
        expiresSeconds: DIRECT_DOWNLOAD_URL_TTL_SECONDS,
    });
    return jsonResponse({
        ok: true,
        direct: true,
        downloadUrl: signed.url,
        expiresAt: signed.expiresAt,
        version: Number(snapshot.version),
        sha256: snapshot.sha256,
        bytes: Number(object.size),
        gzipMembers: verifiedGzipMembers,
    }, 200, corsHeaders(request, env));
}

async function compressBytes(bytes) {
    if (typeof CompressionStream === 'undefined') return bytes;
    const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function copyObjectBody(writer, objectKey, env) {
    const object = await env.RAW_BUCKET.get(objectKey);
    if (!object?.body) throw new Error(`Snapshot object is missing: ${objectKey}`);
    const reader = object.body.getReader();
    let copied = 0;
    try {
        while (true) {
            const next = await reader.read();
            if (next.done) break;
            await writer.write(next.value);
            copied += next.value.byteLength;
        }
    } finally {
        reader.releaseLock();
    }
    return copied;
}

async function writeCombinedObject(env, objectKey, {
    prefixes = [],
    sourceKeys = [],
    expectedBytes = 0,
} = {}) {
    if (!Number.isSafeInteger(expectedBytes) || expectedBytes < 1) throw new Error('Combined snapshot size is invalid.');
    const stream = typeof globalThis.FixedLengthStream === 'function'
        ? new globalThis.FixedLengthStream(expectedBytes)
        : new TransformStream();
    const { readable, writable } = stream;
    const pump = (async () => {
        const writer = writable.getWriter();
        let copied = 0;
        try {
            for (const prefix of prefixes) {
                await writer.write(prefix);
                copied += prefix.byteLength;
            }
            for (const sourceKey of sourceKeys) copied += await copyObjectBody(writer, sourceKey, env);
            if (copied !== expectedBytes) throw new Error(`Combined snapshot size mismatch: ${copied}/${expectedBytes}.`);
            await writer.close();
        } catch (error) {
            await writer.abort(error);
            throw error;
        }
    })();
    const put = env.RAW_BUCKET.put(objectKey, readable, {
        httpMetadata: { contentType: 'application/gzip' },
        customMetadata: { format: 'concatenated-gzip-members' },
    });
    const [stored] = await Promise.all([put, pump]);
    return stored;
}

async function publishEmptySnapshot(env, version) {
    const build = await env.DB.prepare('SELECT * FROM snapshot_builds WHERE version = ?').bind(version).first();
    if (!build || build.status !== 'building') return { published: build?.status === 'published' };
    const meta = new TextEncoder().encode('{"type":"meta","schemaVersion":1,"recordCount":0}\n');
    const compressed = await compressBytes(meta);
    const objectKey = `snapshots/v${version}/dataset.jsonl.gz`;
    await env.RAW_BUCKET.put(objectKey, compressed, { httpMetadata: { contentType: 'application/gzip' } });
    const digest = await sha256Hex(compressed);
    const timestamp = now();
    await env.DB.batch([
        env.DB.prepare(`
            INSERT INTO snapshots (
                id, version, object_key, record_count, pnl_point_count,
                byte_count, sha256, status, published_at, expected_chunk_count
            ) VALUES (1, ?, ?, 0, 0, ?, ?, 'published', ?, 0)
            ON CONFLICT(id) DO UPDATE SET
                version = excluded.version, object_key = excluded.object_key,
                record_count = 0, pnl_point_count = 0,
                byte_count = excluded.byte_count, sha256 = excluded.sha256,
                status = 'published', published_at = excluded.published_at,
                bundle_queued_at = NULL, assemble_queued_at = NULL,
                expected_bundle_count = 0, expected_chunk_count = 0
        `).bind(version, objectKey, compressed.byteLength, digest, timestamp),
        env.DB.prepare(`
            UPDATE snapshot_builds SET status = 'published', published_at = ?, error = NULL
            WHERE version = ? AND status = 'building'
        `).bind(timestamp, version),
        env.DB.prepare(`
            UPDATE snapshot_publication_state
            SET published_revision = MAX(published_revision, ?),
                dirty_at = CASE WHEN source_revision <= ? THEN NULL ELSE dirty_at END,
                last_published_at = ?
            WHERE id = 1
        `).bind(Number(build.source_revision || 0), Number(build.source_revision || 0), timestamp),
    ]);
    await queueSnapshotCleanup(env, version);
    return { published: true, version, objectKey, byteCount: compressed.byteLength, sha256: digest };
}

async function readSnapshotLanePlan(env, sourceRevision) {
    const statements = snapshotAliasLaneBounds().map((lane) => {
        const beforeClause = lane.beforeAlias ? ' AND alias < ?' : '';
        const statement = env.DB.prepare(`
            SELECT COUNT(*) AS record_count,
                   COALESCE(SUM(pnl_point_count), 0) AS pnl_point_count
            FROM shared_alphas
            WHERE source_revision <= ? AND alias > ?${beforeClause}
        `);
        return lane.beforeAlias
            ? statement.bind(sourceRevision, lane.afterAlias, lane.beforeAlias)
            : statement.bind(sourceRevision, lane.afterAlias);
    });
    const results = await env.DB.batch(statements);
    return snapshotLanePlan(results.map((result) => result.results?.[0] || {}));
}

async function loadSnapshotBuildLanes(env, version) {
    const result = await env.DB.prepare(`
        SELECT lane_number, after_alias, before_alias, record_count, pnl_point_count,
               start_part, end_part
        FROM snapshot_build_lanes
        WHERE snapshot_version = ? ORDER BY lane_number ASC
    `).bind(version).all();
    return (result.results || []).map((lane) => ({
        laneNumber: Number(lane.lane_number),
        afterAlias: lane.after_alias,
        beforeAlias: lane.before_alias || null,
        recordCount: Number(lane.record_count || 0),
        pnlPointCount: Number(lane.pnl_point_count || 0),
        startPart: Number(lane.start_part || 0),
        endPart: Number(lane.end_part || 0),
    }));
}

async function startSnapshotBuild(env, uploadId = '', { sourceRevision = null } = {}) {
    const active = await env.DB.prepare(`
        SELECT * FROM snapshot_builds WHERE status = 'building' ORDER BY version DESC LIMIT 1
    `).first();
    if (active) {
        const lanes = await loadSnapshotBuildLanes(env, active.version);
        return {
            version: Number(active.version),
            recordCount: Number(active.record_count),
            pnlPointCount: Number(active.pnl_point_count),
            totalParts: Number(active.expected_chunk_count || 0),
            objectPrefix: active.object_prefix,
            sourceRevision: Number(active.source_revision || 0),
            lanes,
            alreadyBuilding: true,
        };
    }
    const [publicationState, previous] = await Promise.all([
        env.DB.prepare('SELECT source_revision FROM snapshot_publication_state WHERE id = 1').first(),
        env.DB.prepare(`
            SELECT MAX(version) AS version FROM (
                SELECT version FROM snapshots
                UNION ALL
                SELECT version FROM snapshot_builds
            )
        `).first(),
    ]);
    const capturedRevision = Math.max(0, Number(sourceRevision ?? publicationState?.source_revision ?? 0));
    const lanes = await readSnapshotLanePlan(env, capturedRevision);
    const recordCount = lanes.reduce((sum, lane) => sum + lane.recordCount, 0);
    const pnlPointCount = lanes.reduce((sum, lane) => sum + lane.pnlPointCount, 0);
    const version = Number(previous?.version || 0) + 1;
    const totalParts = lanes.reduce((sum, lane) => (
        sum + (lane.startPart ? lane.endPart - lane.startPart + 1 : 0)
    ), 0);
    const objectPrefix = `snapshots/v${version}`;
    const timestamp = now();
    await env.DB.batch([
        env.DB.prepare('DELETE FROM snapshot_chunks WHERE snapshot_version = ?').bind(version),
        env.DB.prepare('DELETE FROM snapshot_bundles WHERE snapshot_version = ?').bind(version),
        env.DB.prepare(`
            INSERT INTO snapshot_builds (
                version, object_prefix, record_count, pnl_point_count,
                status, expected_bundle_count, source_upload_id, created_at,
                source_revision, expected_chunk_count
            ) VALUES (?, ?, ?, ?, 'building', ?, ?, ?, ?, ?)
        `).bind(
            version, objectPrefix, recordCount, pnlPointCount,
            snapshotBundleCount(totalParts), uploadId || null, timestamp,
            capturedRevision, totalParts,
        ),
        ...lanes.map((lane) => env.DB.prepare(`
            INSERT INTO snapshot_build_lanes (
                snapshot_version, lane_number, after_alias, before_alias,
                record_count, pnl_point_count, start_part, end_part
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).bind(
            version, lane.laneNumber, lane.afterAlias, lane.beforeAlias,
            lane.recordCount, lane.pnlPointCount, lane.startPart, lane.endPart,
        )),
    ]);
    if (!totalParts) return publishEmptySnapshot(env, version);
    return { version, recordCount, pnlPointCount, totalParts, objectPrefix, sourceRevision: capturedRevision, lanes };
}

async function completeSnapshotChunksIfReady(env, version, totalParts, { enqueueBundles = true } = {}) {
    const chunks = await env.DB.prepare(`
        SELECT part_number, object_key, record_count, pnl_point_count, byte_count, sha256
        FROM snapshot_chunks WHERE snapshot_version = ? ORDER BY part_number ASC
    `).bind(version).all();
    const rows = chunks.results || [];
    if (rows.length !== totalParts) return { published: false, chunks: rows };
    const recordCount = rows.reduce((sum, row) => sum + Number(row.record_count || 0), 0);
    const pnlPointCount = rows.reduce((sum, row) => sum + Number(row.pnl_point_count || 0), 0);
    const snapshot = await env.DB.prepare(`
        SELECT record_count, pnl_point_count FROM snapshot_builds WHERE version = ? AND status = 'building'
    `).bind(version).first();
    if (!snapshot || recordCount !== Number(snapshot.record_count) || pnlPointCount !== Number(snapshot.pnl_point_count)) {
        const message = 'Snapshot chunk totals do not match the build target.';
        await env.DB.prepare(`
            UPDATE snapshot_builds SET status = 'failed', error = ? WHERE version = ? AND status = 'building'
        `).bind(message, version).run();
        return { published: false, failed: true, chunks: rows, recordCount, pnlPointCount };
    }
    const bundleCount = snapshotBundleCount(totalParts);
    const claimed = await env.DB.prepare(`
        UPDATE snapshot_builds
        SET bundle_queued_at = ?, expected_bundle_count = ?
        WHERE version = ? AND status = 'building' AND bundle_queued_at IS NULL
        RETURNING version
    `).bind(now(), bundleCount, version).first();
    if (claimed && enqueueBundles && env.SNAPSHOT_QUEUE) {
        const messages = Array.from({ length: bundleCount }, (_, index) => ({
            body: { type: 'snapshot-bundle', version, bundle: index + 1 },
        }));
        await env.SNAPSHOT_QUEUE.sendBatch(messages);
    }
    return { published: false, chunks: rows, recordCount, pnlPointCount, bundlesQueued: Boolean(claimed), bundleCount };
}

async function buildSnapshotPart(env, version, partNumber, {
    enqueueNext = true,
    enqueueBundles = true,
    endPart = null,
    laneNumber = null,
    afterAlias = null,
} = {}) {
    const snapshot = await env.DB.prepare('SELECT * FROM snapshot_builds WHERE version = ?').bind(version).first();
    if (!snapshot || snapshot.status !== 'building') return {
        published: snapshot?.status === 'published',
        failed: snapshot?.status === 'failed',
    };
    const totalParts = Number(snapshot.expected_chunk_count || 0);
    if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > totalParts) {
        throw new Error(`Invalid snapshot part ${partNumber}/${totalParts}.`);
    }
    const lane = Number.isInteger(Number(laneNumber)) && Number(laneNumber) > 0
        ? await env.DB.prepare(`
            SELECT * FROM snapshot_build_lanes
            WHERE snapshot_version = ? AND lane_number = ?
        `).bind(version, Number(laneNumber)).first()
        : await env.DB.prepare(`
            SELECT * FROM snapshot_build_lanes
            WHERE snapshot_version = ? AND start_part <= ? AND end_part >= ?
            LIMIT 1
        `).bind(version, partNumber, partNumber).first();
    if (!lane) throw new Error(`Snapshot lane is missing for part ${partNumber}.`);
    const existing = await env.DB.prepare(
        'SELECT part_number, last_alias FROM snapshot_chunks WHERE snapshot_version = ? AND part_number = ?',
    ).bind(version, partNumber).first();
    let pageLastAlias = existing?.last_alias || '';
    if (!existing) {
        let cursor = typeof afterAlias === 'string' ? afterAlias : '';
        if (!cursor && partNumber === Number(lane.start_part)) cursor = String(lane.after_alias || '');
        if (!cursor && partNumber > Number(lane.start_part)) {
            const previous = await env.DB.prepare(`
                SELECT last_alias FROM snapshot_chunks
                WHERE snapshot_version = ? AND lane_number = ? AND part_number = ?
            `).bind(version, Number(lane.lane_number), partNumber - 1).first();
            cursor = String(previous?.last_alias || '');
        }
        if (!cursor && partNumber > Number(lane.start_part)) {
            throw new Error(`Snapshot cursor is missing before part ${partNumber}.`);
        }
        const beforeAlias = String(lane.before_alias || '');
        const statement = env.DB.prepare(`
            SELECT * FROM shared_alphas
            WHERE source_revision <= ? AND alias > ?${beforeAlias ? ' AND alias < ?' : ''}
            ORDER BY alias ASC LIMIT ?
        `);
        const rows = beforeAlias
            ? await statement.bind(Number(snapshot.source_revision || 0), cursor, beforeAlias, SNAPSHOT_PART_RECORDS).all()
            : await statement.bind(Number(snapshot.source_revision || 0), cursor, SNAPSHOT_PART_RECORDS).all();
        const expectedRecords = partNumber < Number(lane.end_part)
            ? SNAPSHOT_PART_RECORDS
            : Number(lane.record_count) - ((Number(lane.end_part) - Number(lane.start_part)) * SNAPSHOT_PART_RECORDS);
        if ((rows.results || []).length !== expectedRecords) {
            throw new Error(`Snapshot cursor page ${partNumber} changed: ${(rows.results || []).length}/${expectedRecords}.`);
        }
        const output = [];
        let pointCount = 0;
        for (const row of rows.results || []) {
            const encrypted = await env.RAW_BUCKET.get(row.pnl_object_key);
            if (!encrypted) throw new Error(`Snapshot PNL object is missing for ${row.alias}.`);
            const envelope = JSON.parse(await encrypted.text());
            const pnl = JSON.parse(await decryptText(
                envelope.ciphertext,
                envelope.iv,
                requireSecret(env, `UPLOAD_ENCRYPTION_KEY_V${row.key_version}`),
            ));
            const classifications = JSON.parse(row.classifications_json || '[]');
            pointCount += Array.isArray(pnl.records) ? pnl.records.length : 0;
            output.push(JSON.stringify({
                alias: row.alias,
                sourceType: row.source_type,
                groupKey: row.group_key,
                prodCorr: Number(row.prod_corr),
                classifications,
                pnl,
                updatedAt: Number(row.updated_at),
            }));
        }
        const firstAlias = String(rows.results[0]?.alias || '');
        pageLastAlias = String(rows.results.at(-1)?.alias || '');
        const raw = new TextEncoder().encode(`${output.join('\n')}\n`);
        const compressed = await compressBytes(raw);
        const digest = await sha256Hex(compressed);
        const objectKey = `snapshots/v${version}/part-${partNumber}.ndjson.gz`;
        await env.RAW_BUCKET.put(objectKey, compressed, { httpMetadata: { contentType: 'application/gzip' } });
        await env.DB.prepare(`
            INSERT INTO snapshot_chunks (
                snapshot_version, part_number, object_key, record_count,
                pnl_point_count, byte_count, sha256, created_at,
                lane_number, first_alias, last_alias
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(snapshot_version, part_number) DO NOTHING
        `).bind(
            version, partNumber, objectKey, output.length, pointCount,
            compressed.byteLength, digest, now(), Number(lane.lane_number), firstAlias, pageLastAlias,
        ).run();
    }
    const completed = await completeSnapshotChunksIfReady(env, version, totalParts, { enqueueBundles });
    const laneEnd = Math.min(totalParts, Number(endPart) || Number(lane.end_part));
    if (!completed.published && !completed.failed && enqueueNext && env.SNAPSHOT_QUEUE && partNumber < laneEnd) {
        await env.SNAPSHOT_QUEUE.send({
            type: 'snapshot-part',
            version,
            part: partNumber + 1,
            endPart: laneEnd,
            laneNumber: Number(lane.lane_number),
            afterAlias: pageLastAlias,
        });
    }
    return { ...completed, version, part: partNumber, totalParts, lastAlias: pageLastAlias };
}

async function completeSnapshotBundlesIfReady(env, version, { enqueueAssembly = true } = {}) {
    const snapshot = await env.DB.prepare('SELECT * FROM snapshot_builds WHERE version = ?').bind(version).first();
    if (!snapshot || snapshot.status !== 'building') return {
        published: snapshot?.status === 'published',
        failed: snapshot?.status === 'failed',
    };
    const expected = Number(snapshot.expected_bundle_count || 0);
    const bundles = await env.DB.prepare(`
        SELECT * FROM snapshot_bundles WHERE snapshot_version = ? ORDER BY bundle_number ASC
    `).bind(version).all();
    const rows = bundles.results || [];
    if (rows.length !== expected) return { published: false, bundleCount: rows.length, expectedBundleCount: expected };
    const claimed = await env.DB.prepare(`
        UPDATE snapshot_builds SET assemble_queued_at = ?
        WHERE version = ? AND status = 'building' AND assemble_queued_at IS NULL
        RETURNING version
    `).bind(now(), version).first();
    if (claimed && enqueueAssembly && env.SNAPSHOT_QUEUE) {
        await env.SNAPSHOT_QUEUE.send({ type: 'snapshot-assemble', version });
    }
    return { published: false, bundleCount: rows.length, expectedBundleCount: expected, assemblyQueued: Boolean(claimed) };
}

async function buildSnapshotBundle(env, version, bundleNumber, { enqueueAssembly = true } = {}) {
    const snapshot = await env.DB.prepare('SELECT * FROM snapshot_builds WHERE version = ?').bind(version).first();
    if (!snapshot || snapshot.status !== 'building') return {
        published: snapshot?.status === 'published',
        failed: snapshot?.status === 'failed',
    };
    const expected = Number(snapshot.expected_bundle_count || 0);
    if (!Number.isInteger(bundleNumber) || bundleNumber < 1 || bundleNumber > expected) {
        throw new Error(`Invalid snapshot bundle ${bundleNumber}/${expected}.`);
    }
    const existing = await env.DB.prepare(`
        SELECT bundle_number FROM snapshot_bundles WHERE snapshot_version = ? AND bundle_number = ?
    `).bind(version, bundleNumber).first();
    if (!existing) {
        const firstPart = ((bundleNumber - 1) * SNAPSHOT_BUNDLE_PARTS) + 1;
        const lastPart = Math.min(Number(snapshot.expected_chunk_count || 0), firstPart + SNAPSHOT_BUNDLE_PARTS - 1);
        const chunks = await env.DB.prepare(`
            SELECT part_number, object_key, byte_count, sha256
            FROM snapshot_chunks
            WHERE snapshot_version = ? AND part_number BETWEEN ? AND ?
            ORDER BY part_number ASC
        `).bind(version, firstPart, lastPart).all();
        const rows = chunks.results || [];
        if (rows.length !== lastPart - firstPart + 1) throw new Error(`Snapshot bundle ${bundleNumber} has missing chunks.`);
        const objectKey = `snapshots/v${version}/bundle-${bundleNumber}.jsonl.gz`;
        const byteCount = rows.reduce((sum, row) => sum + Number(row.byte_count || 0), 0);
        await writeCombinedObject(env, objectKey, {
            sourceKeys: rows.map((row) => row.object_key),
            expectedBytes: byteCount,
        });
        const digest = await sha256Hex(rows.map((row) => row.sha256).join(':'));
        await env.DB.prepare(`
            INSERT INTO snapshot_bundles (
                snapshot_version, bundle_number, object_key, first_part,
                last_part, byte_count, sha256, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(snapshot_version, bundle_number) DO NOTHING
        `).bind(version, bundleNumber, objectKey, firstPart, lastPart, byteCount, digest, now()).run();
    }
    return completeSnapshotBundlesIfReady(env, version, { enqueueAssembly });
}

async function assembleSnapshotFile(env, version) {
    const snapshot = await env.DB.prepare('SELECT * FROM snapshot_builds WHERE version = ?').bind(version).first();
    if (!snapshot || snapshot.status !== 'building') return {
        published: snapshot?.status === 'published',
        failed: snapshot?.status === 'failed',
    };
    const bundles = await env.DB.prepare(`
        SELECT * FROM snapshot_bundles WHERE snapshot_version = ? ORDER BY bundle_number ASC
    `).bind(version).all();
    const rows = bundles.results || [];
    if (rows.length !== Number(snapshot.expected_bundle_count || 0)) throw new Error('Snapshot bundles are incomplete.');
    const meta = new TextEncoder().encode(`{"type":"meta","schemaVersion":1,"recordCount":${snapshot.record_count}}\n`);
    const compressedMeta = await compressBytes(meta);
    const objectKey = `snapshots/v${version}/dataset.jsonl.gz`;
    const byteCount = compressedMeta.byteLength + rows.reduce((sum, row) => sum + Number(row.byte_count || 0), 0);
    const stored = await writeCombinedObject(env, objectKey, {
        prefixes: [compressedMeta],
        sourceKeys: rows.map((row) => row.object_key),
        expectedBytes: byteCount,
    });
    if (stored && Number(stored.size) !== byteCount) throw new Error('Final snapshot object size mismatch.');
    const metaDigest = await sha256Hex(compressedMeta);
    const digest = await sha256Hex([metaDigest, ...rows.map((row) => row.sha256)].join(':'));
    const timestamp = now();
    await env.DB.batch([
        env.DB.prepare(`
            INSERT INTO snapshots (
                id, version, object_key, record_count, pnl_point_count,
                byte_count, sha256, status, published_at, expected_chunk_count
            ) VALUES (1, ?, ?, ?, ?, ?, ?, 'published', ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                version = excluded.version, object_key = excluded.object_key,
                record_count = excluded.record_count, pnl_point_count = excluded.pnl_point_count,
                byte_count = excluded.byte_count, sha256 = excluded.sha256,
                status = 'published', published_at = excluded.published_at,
                bundle_queued_at = NULL, assemble_queued_at = NULL,
                expected_bundle_count = excluded.expected_bundle_count,
                expected_chunk_count = excluded.expected_chunk_count
        `).bind(
            version, objectKey, Number(snapshot.record_count), Number(snapshot.pnl_point_count),
            byteCount, digest, timestamp, Number(snapshot.expected_chunk_count || 0),
        ),
        env.DB.prepare(`
            UPDATE snapshot_builds SET status = 'published', published_at = ?, error = NULL
            WHERE version = ? AND status = 'building'
        `).bind(timestamp, version),
        env.DB.prepare(`
            UPDATE snapshot_publication_state
            SET published_revision = MAX(published_revision, ?),
                dirty_at = CASE WHEN source_revision <= ? THEN NULL ELSE dirty_at END,
                last_published_at = ?
            WHERE id = 1
        `).bind(Number(snapshot.source_revision || 0), Number(snapshot.source_revision || 0), timestamp),
    ]);
    await queueSnapshotCleanup(env, version);
    return { published: true, version, objectKey, byteCount, sha256: digest };
}

function snapshotLaneRanges(totalParts, laneCount = SNAPSHOT_ALIAS_LANES.length) {
    const lanes = Math.max(1, Math.min(Math.floor(Number(laneCount) || 1), totalParts));
    const base = Math.floor(totalParts / lanes);
    const remainder = totalParts % lanes;
    const ranges = [];
    let start = 1;
    for (let lane = 0; lane < lanes; lane += 1) {
        const size = base + (lane < remainder ? 1 : 0);
        ranges.push({ start, end: start + size - 1 });
        start += size;
    }
    return ranges;
}

async function seedSnapshotLanes(env, build, uploadId = '') {
    const messages = (build.lanes || []).filter((lane) => lane.startPart > 0).map((lane) => ({
        body: {
            type: 'snapshot-part',
            version: build.version,
            part: lane.startPart,
            endPart: lane.endPart,
            laneNumber: lane.laneNumber,
            afterAlias: lane.afterAlias,
            uploadId,
        },
    }));
    await env.SNAPSHOT_QUEUE.sendBatch(messages);
    return messages.length;
}

async function queueSnapshotBuild(env, uploadId = '', options = {}) {
    const build = await startSnapshotBuild(env, uploadId, options);
    if (build.published) return build;
    if (build.alreadyBuilding) return { ...build, queued: true, coalesced: true };
    if (!build.totalParts) return { ...build, published: true };
    if (env.SNAPSHOT_QUEUE) {
        const lanes = await seedSnapshotLanes(env, build, uploadId);
        return { ...build, queued: true, lanes };
    }
    return rebuildSnapshot(env, build);
}

async function rebuildSnapshot(env, startedBuild = null, options = {}) {
    const build = startedBuild || await startSnapshotBuild(env, '', options);
    if (build.published) return build;
    if (build.alreadyBuilding) return { ...build, queued: true, coalesced: true };
    for (const lane of build.lanes || []) {
        let cursor = lane.afterAlias;
        for (let part = lane.startPart; part > 0 && part <= lane.endPart; part += 1) {
            const result = await buildSnapshotPart(env, build.version, part, {
                enqueueNext: false,
                enqueueBundles: false,
                laneNumber: lane.laneNumber,
                afterAlias: cursor,
            });
            cursor = result.lastAlias;
        }
    }
    const bundleCount = snapshotBundleCount(build.totalParts);
    for (let bundle = 1; bundle <= bundleCount; bundle += 1) {
        await buildSnapshotBundle(env, build.version, bundle, { enqueueAssembly: false });
    }
    const result = await assembleSnapshotFile(env, build.version);
    return { ...build, ...result };
}

async function ensureSnapshotDirtyState(env) {
    const [snapshot, totals, state] = await Promise.all([
        env.DB.prepare('SELECT * FROM snapshots WHERE id = 1').first(),
        env.DB.prepare('SELECT COUNT(*) AS record_count, COALESCE(SUM(pnl_point_count), 0) AS pnl_point_count FROM shared_alphas').first(),
        env.DB.prepare('SELECT * FROM snapshot_publication_state WHERE id = 1').first(),
    ]);
    const recordCount = Number(totals?.record_count || 0);
    const pnlPointCount = Number(totals?.pnl_point_count || 0);
    const snapshotMissingOrStale = recordCount > 0 && (
        !snapshot
        || snapshot.status !== 'published'
        || !String(snapshot.object_key || '').endsWith('.jsonl.gz')
        || Number(snapshot.record_count || 0) !== recordCount
        || Number(snapshot.pnl_point_count || 0) !== pnlPointCount
    );
    const alreadyDirty = Number(state?.source_revision || 0) > Number(state?.published_revision || 0);
    if (!snapshotMissingOrStale || alreadyDirty) return state;
    const timestamp = now();
    const revision = Math.max(timestamp, Number(state?.source_revision || 0) + 1);
    return env.DB.prepare(`
        UPDATE snapshot_publication_state
        SET source_revision = ?, dirty_at = COALESCE(dirty_at, ?)
        WHERE id = 1
        RETURNING *
    `).bind(revision, timestamp).first();
}

async function queueScheduledSnapshotBuild(env, scheduledTime = now()) {
    if (String(env.PUBLICATION_ENABLED).toLowerCase() !== 'true') return { queued: false, disabled: true };
    await ensureSnapshotDirtyState(env);
    const timestamp = Number.isFinite(Number(scheduledTime)) ? Number(scheduledTime) : now();
    const claimed = await env.DB.prepare(`
        UPDATE snapshot_publication_state
        SET last_build_started_at = ?
        WHERE id = 1
          AND source_revision > published_revision
          AND (last_build_started_at IS NULL OR last_build_started_at <= ?)
          AND NOT EXISTS (SELECT 1 FROM snapshot_builds WHERE status = 'building')
        RETURNING source_revision
    `).bind(timestamp, timestamp - SNAPSHOT_REBUILD_INTERVAL_MS).first();
    if (!claimed) return { queued: false, coalesced: true };
    try {
        return await queueSnapshotBuild(env, 'scheduled-snapshot', {
            sourceRevision: Number(claimed.source_revision || 0),
        });
    } catch (error) {
        await env.DB.prepare(`
            UPDATE snapshot_publication_state SET last_build_started_at = NULL
            WHERE id = 1 AND last_build_started_at = ?
              AND NOT EXISTS (SELECT 1 FROM snapshot_builds WHERE status = 'building')
        `).bind(timestamp).run();
        throw error;
    }
}

async function queueSnapshotCleanup(env, keepVersion) {
    if (env.SNAPSHOT_QUEUE) {
        await env.SNAPSHOT_QUEUE.send(
            { type: 'snapshot-cleanup', keepVersion },
            { delaySeconds: DIRECT_DOWNLOAD_URL_TTL_SECONDS },
        );
        return { queued: true };
    }
    return cleanupObsoleteObjects(env, keepVersion);
}

async function deleteR2Keys(bucket, keys) {
    for (let start = 0; start < keys.length; start += 1000) {
        await bucket.delete(keys.slice(start, start + 1000));
    }
}

async function referencedPnlKeys(env, keys) {
    const referenced = new Set();
    for (let start = 0; start < keys.length; start += 100) {
        const page = keys.slice(start, start + 100);
        const placeholders = page.map(() => '?').join(',');
        const [shared, staged] = await env.DB.batch([
            env.DB.prepare(`SELECT pnl_object_key FROM shared_alphas WHERE pnl_object_key IN (${placeholders})`).bind(...page),
            env.DB.prepare(`SELECT pnl_object_key FROM staged_alphas WHERE pnl_object_key IN (${placeholders})`).bind(...page),
        ]);
        for (const row of [...(shared.results || []), ...(staged.results || [])]) {
            if (row.pnl_object_key) referenced.add(row.pnl_object_key);
        }
    }
    return referenced;
}

async function cleanupObsoleteObjects(env, keepVersion) {
    const version = Number(keepVersion);
    if (!Number.isSafeInteger(version) || version < 1) throw new Error('Snapshot cleanup version is invalid.');
    let snapshotObjectsDeleted = 0;
    let cursor;
    do {
        const listed = await env.RAW_BUCKET.list({
            prefix: 'snapshots/',
            limit: 1000,
            ...(cursor ? { cursor } : {}),
        });
        const stale = (listed.objects || []).map((object) => object.key).filter((key) => {
            const match = String(key).match(/^snapshots\/v(\d+)\//);
            return match && Number(match[1]) < version;
        });
        await deleteR2Keys(env.RAW_BUCKET, stale);
        snapshotObjectsDeleted += stale.length;
        cursor = listed.truncated ? listed.cursor : undefined;
    } while (cursor);

    await env.DB.batch([
        env.DB.prepare('DELETE FROM snapshot_chunks WHERE snapshot_version < ?').bind(version),
        env.DB.prepare('DELETE FROM snapshot_bundles WHERE snapshot_version < ?').bind(version),
        env.DB.prepare('DELETE FROM snapshot_build_lanes WHERE snapshot_version < ?').bind(version),
        env.DB.prepare("DELETE FROM snapshot_builds WHERE version < ? AND status <> 'building'").bind(version),
    ]);

    const pnlCutoff = now() - PNL_ORPHAN_GRACE_MS;
    let pnlObjectsDeleted = 0;
    cursor = undefined;
    do {
        const listed = await env.RAW_BUCKET.list({
            prefix: 'pnl/',
            limit: 1000,
            ...(cursor ? { cursor } : {}),
        });
        const candidates = (listed.objects || []).filter((object) => (
            object.uploaded instanceof Date && object.uploaded.getTime() < pnlCutoff
        )).map((object) => object.key);
        const referenced = await referencedPnlKeys(env, candidates);
        const stale = candidates.filter((key) => !referenced.has(key));
        await deleteR2Keys(env.RAW_BUCKET, stale);
        pnlObjectsDeleted += stale.length;
        cursor = listed.truncated ? listed.cursor : undefined;
    } while (cursor);

    const result = { keepVersion: version, snapshotObjectsDeleted, pnlObjectsDeleted };
    console.log(JSON.stringify({ message: 'snapshot cleanup completed', ...result }));
    return result;
}

async function cleanupExpiredUploads(env) {
    const timestamp = now();
    const sessions = await env.DB.prepare(`
        SELECT session_id, manifest_json FROM upload_sessions
        WHERE status = 'open' AND expires_at < ? LIMIT 1000
    `).bind(timestamp).all();
    for (const session of sessions.results || []) {
        let partCount = 0;
        try { partCount = Number(JSON.parse(session.manifest_json).partCount || 0); } catch { /* Invalid expired sessions are still removable. */ }
        await cleanupUploadSessionObjects(session.session_id, partCount, env);
        await env.DB.batch([
            env.DB.prepare("UPDATE upload_sessions SET status = 'expired', finalized_at = ? WHERE session_id = ?").bind(timestamp, session.session_id),
            env.DB.prepare('DELETE FROM upload_parts WHERE session_id = ?').bind(session.session_id),
            env.DB.prepare('DELETE FROM staged_alphas WHERE session_id = ?').bind(session.session_id),
        ]);
    }
    await env.DB.prepare('DELETE FROM installation_challenges WHERE expires_at < ?').bind(timestamp - 24 * 60 * 60 * 1000).run();
    return { expiredSessions: sessions.results?.length || 0 };
}

async function finalizeReadyUploads(env) {
    const sessions = await env.DB.prepare(`
        SELECT s.session_id
        FROM upload_sessions s
        WHERE s.status = 'open' AND s.expires_at > ? AND s.finalize_authorized_at IS NOT NULL
          AND EXISTS (SELECT 1 FROM upload_parts p WHERE p.session_id = s.session_id)
          AND NOT EXISTS (
              SELECT 1 FROM upload_parts p
              WHERE p.session_id = s.session_id AND p.processed_at IS NULL
          )
        LIMIT 100
    `).bind(now()).all();
    let finalized = 0;
    for (const row of sessions.results || []) {
        try {
            const result = await finalizeAuthorizedUpload(row.session_id, env);
            if (result.status === 'finalized') finalized += 1;
        } catch (error) {
            console.error(JSON.stringify({
                message: 'scheduled upload finalize failed',
                sessionId: row.session_id,
                error: String(error?.message || error),
            }));
        }
    }
    return { checked: sessions.results?.length || 0, finalized };
}

async function cleanupUploadSessionObjects(sessionId, partCount, env) {
    const parts = await env.DB.prepare('SELECT object_key FROM upload_parts WHERE session_id = ?').bind(sessionId).all();
    const keys = new Set((parts.results || []).map((row) => row.object_key).filter(Boolean));
    const total = Math.max(0, Math.min(MAX_RECORDS, Number(partCount) || 0));
    for (let part = 1; part <= total; part += 1) keys.add(directUploadObjectKey(sessionId, part));
    const values = [...keys];
    for (let start = 0; start < values.length; start += 1000) {
        await env.RAW_BUCKET.delete(values.slice(start, start + 1000));
    }
}

export {
    cleanupObsoleteObjects,
    downloadQuota,
    isExtensionOriginAllowed,
    queueScheduledSnapshotBuild,
    rebuildSnapshot,
    snapshotAliasLaneBounds,
    snapshotIsConsistent,
    snapshotPartCount,
    snapshotGzipMembers,
    snapshotLanePlan,
    snapshotLaneRanges,
    queueSnapshotBuild,
};

export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);
        try {
            if (request.method === 'OPTIONS') return optionsResponse(request, env);
            if (url.pathname === '/robots.txt') return new Response('User-agent: *\nDisallow: /\n', { headers: { 'Content-Type': 'text/plain', 'X-Robots-Tag': 'noindex, nofollow' } });
            if (url.pathname.startsWith('/admin') || url.pathname.startsWith('/api/admin/')) {
                return await adminRequest(request, env, url);
            }
            if (url.pathname === '/v1/share/installations/challenge' && request.method === 'POST') return await handleChallenge(request, env);
            if (url.pathname === '/v1/share/installations' && request.method === 'POST') return await handleInstallation(request, env);
            if (url.pathname === '/v1/share/uploads' && request.method === 'POST') return await handleUploadCreate(request, env);
            const directUrlsMatch = url.pathname.match(/^\/v1\/share\/uploads\/([^/]+)\/direct-urls$/);
            if (directUrlsMatch && request.method === 'POST') return await handleDirectUploadUrls(request, env, directUrlsMatch[1]);
            const directCompleteMatch = url.pathname.match(/^\/v1\/share\/uploads\/([^/]+)\/direct-complete$/);
            if (directCompleteMatch && request.method === 'POST') return await handleDirectUploadComplete(request, env, directCompleteMatch[1]);
            const statusMatch = url.pathname.match(/^\/v1\/share\/uploads\/([^/]+)\/status$/);
            if (statusMatch && request.method === 'GET') return await handleUploadStatus(request, env, ctx, statusMatch[1]);
            const partMatch = url.pathname.match(/^\/v1\/share\/uploads\/([^/]+)\/parts\/(\d+)$/);
            if (partMatch && request.method === 'PUT') return await handleUploadPart(request, env, partMatch[1], partMatch[2]);
            const processMatch = url.pathname.match(/^\/v1\/share\/uploads\/([^/]+)\/process\/(\d+)$/);
            if (processMatch && request.method === 'POST') return await handleUploadProcess(request, env, processMatch[1], processMatch[2]);
            const finalizeMatch = url.pathname.match(/^\/v1\/share\/uploads\/([^/]+)\/finalize$/);
            if (finalizeMatch && request.method === 'POST') return await handleUploadFinalize(request, env, ctx, finalizeMatch[1]);
            if (url.pathname === '/v1/share/stats' && request.method === 'GET') return await handleStats(request, env);
            if (url.pathname === '/v1/share/download-url' && request.method === 'POST') return await handleDownloadUrl(request, env);
            if (url.pathname === '/v1/share/dataset' && ['GET', 'HEAD'].includes(request.method)) return await handleDataset(request, env, ctx);
            return jsonResponse({ ok: false, error: 'not_found' }, 404);
        } catch (error) {
            if (error instanceof RequestValidationError || Number.isInteger(error?.status)) {
                return jsonResponse({ ok: false, error: error.code || 'request_failed', message: error.message }, error.status || 400, {
                    ...(error.headers || {}),
                    ...corsHeaders(request, env),
                });
            }
            console.error(JSON.stringify({
                message: 'request failed',
                method: request.method,
                path: url.pathname,
                error: String(error?.message || error),
            }));
            return jsonResponse({ ok: false, error: 'internal_error' }, 500, corsHeaders(request, env));
        }
    },
    async queue(batch, env) {
        for (const message of batch.messages) {
            const type = String(message.body?.type || '');
            try {
                if (type === 'upload-part') {
                    await processStoredUploadPart(String(message.body.sessionId || ''), Number(message.body.part), env);
                    await finalizeAuthorizedUpload(String(message.body.sessionId || ''), env);
                } else if (type === 'upload-finalize') {
                    const result = await finalizeAuthorizedUpload(String(message.body.sessionId || ''), env);
                    if (result.pending && ['processing', 'finalizing'].includes(result.status)) {
                        await enqueueUploadFinalize(env, String(message.body.sessionId || ''));
                    }
                } else if (String(env.PUBLICATION_ENABLED).toLowerCase() !== 'true') {
                    message.ack();
                    continue;
                } else if (type === 'snapshot-part') {
                    await buildSnapshotPart(env, Number(message.body.version), Number(message.body.part), {
                        endPart: Number(message.body.endPart) || null,
                        laneNumber: Number(message.body.laneNumber) || null,
                        afterAlias: typeof message.body.afterAlias === 'string' ? message.body.afterAlias : null,
                    });
                } else if (type === 'snapshot-bundle') {
                    await buildSnapshotBundle(env, Number(message.body.version), Number(message.body.bundle));
                } else if (type === 'snapshot-assemble') {
                    await assembleSnapshotFile(env, Number(message.body.version));
                } else if (type === 'snapshot-cleanup') {
                    await cleanupObsoleteObjects(env, Number(message.body.keepVersion));
                } else if (type === 'snapshot-start') {
                    await queueScheduledSnapshotBuild(env);
                } else if (type === 'rebuild') {
                    await queueScheduledSnapshotBuild(env);
                } else {
                    console.warn(JSON.stringify({ message: 'unknown queue message', type }));
                }
                message.ack();
            } catch (error) {
                const detail = String(error?.message || error).slice(0, 500);
                const attempts = Number(message.attempts || 1);
                const permanentUploadError = type === 'upload-part'
                    && error instanceof RequestValidationError
                    && Number(error.status || 400) < 500;
                const exhaustedUploadError = type === 'upload-part' && attempts >= 5;
                const exhaustedFinalizeError = type === 'upload-finalize' && attempts >= 5;
                const exhaustedSnapshotBuildError = ['snapshot-part', 'snapshot-bundle', 'snapshot-assemble'].includes(type)
                    && attempts >= 5;
                console.error(JSON.stringify({
                    message: 'queue message failed',
                    type,
                    attempts,
                    error: detail,
                    sessionId: message.body?.sessionId,
                    part: message.body?.part,
                    version: message.body?.version,
                }));
                if (permanentUploadError || exhaustedUploadError || exhaustedFinalizeError || exhaustedSnapshotBuildError) {
                    if (type === 'upload-part') {
                        await env.DB.prepare(`
                            UPDATE upload_parts SET process_error = ?, process_failed_at = ?
                            WHERE session_id = ? AND part_number = ? AND processed_at IS NULL
                        `).bind(detail, now(), String(message.body.sessionId || ''), Number(message.body.part)).run();
                    } else {
                        await env.DB.prepare(`
                            UPDATE snapshot_builds SET status = 'failed', error = ?
                            WHERE version = ? AND status = 'building'
                        `).bind(detail, Number(message.body.version)).run();
                    }
                    message.ack();
                } else {
                    message.retry({ delaySeconds: Math.min(60, 2 ** Math.min(attempts, 5)) });
                }
            }
        }
    },
    async scheduled(controller, env, ctx) {
        ctx.waitUntil(Promise.all([
            cleanupExpiredUploads(env),
            finalizeReadyUploads(env),
            queueScheduledSnapshotBuild(env, controller.scheduledTime),
        ]));
    },
};
