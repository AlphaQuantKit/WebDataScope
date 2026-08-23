import { webcrypto } from 'node:crypto';
import {
    decodeGzipDatasetBytes,
    splitRecords,
} from '../../src/background/services/pnlShareService.js';

const cryptoApi = globalThis.crypto || webcrypto;
const baseUrl = process.env.PNL_SHARE_TEST_URL || 'http://127.0.0.1:8789';
const directProbeOnly = process.env.PNL_SHARE_DIRECT_PROBE_ONLY === '1';
const processOnly = process.env.PNL_SHARE_PROCESS_ONLY === '1';
const recordCount = Math.max(1, Math.min(20_000, Number(process.env.PNL_SHARE_RECORD_COUNT) || 8));
const statusMaxAttempts = Math.max(1, Number(process.env.PNL_SHARE_STATUS_MAX_ATTEMPTS) || 240);
const statusPollMs = Math.max(50, Number(process.env.PNL_SHARE_STATUS_POLL_MS) || 250);
const startedAt = Date.now();
const origin = 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const encoder = new TextEncoder();

function base64Url(bytes) {
    return Buffer.from(bytes).toString('base64url');
}

function base64UrlBytes(value) {
    return new Uint8Array(Buffer.from(String(value || ''), 'base64url'));
}

async function sha256Hex(value) {
    const bytes = value instanceof Uint8Array ? value : encoder.encode(String(value));
    return Buffer.from(await cryptoApi.subtle.digest('SHA-256', bytes)).toString('hex');
}

async function gzipBytes(bytes) {
    const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function sign(privateKey, operation, value) {
    const signature = await cryptoApi.subtle.sign(
        { name: 'ECDSA', hash: 'SHA-256' },
        privateKey,
        encoder.encode(`${operation}|${value}`),
    );
    return base64Url(new Uint8Array(signature));
}

async function encryptDirectPart(bytes, directEncryptionKey) {
    const key = await cryptoApi.subtle.importKey(
        'raw', base64UrlBytes(directEncryptionKey), 'AES-GCM', false, ['encrypt'],
    );
    const iv = cryptoApi.getRandomValues(new Uint8Array(12));
    const ciphertext = new Uint8Array(await cryptoApi.subtle.encrypt(
        { name: 'AES-GCM', iv }, key, bytes,
    ));
    return JSON.stringify({
        sessionEncrypted: true,
        ciphertext: base64Url(ciphertext),
        iv: base64Url(iv),
        contentEncoding: 'gzip',
    });
}

async function request(path, options = {}) {
    const response = await fetch(`${baseUrl}${path}`, {
        ...options,
        headers: { Origin: origin, ...(options.headers || {}) },
    });
    const data = await response.json();
    if (!response.ok) throw new Error(`${path}: ${data.error || response.status} ${data.message || ''}`);
    return data;
}

const installationId = cryptoApi.randomUUID();
const wqId = `local-e2e-${installationId}`;
const keyPair = await cryptoApi.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'],
);
const publicKeyJwk = await cryptoApi.subtle.exportKey('jwk', keyPair.publicKey);
const challenge = await request('/v1/share/installations/challenge', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ installationId }),
});
const pluginVersion = '1.7.0';
const registrationValue = [challenge.nonce, installationId, wqId, pluginVersion].join('|');
await request('/v1/share/installations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
        challengeId: challenge.challengeId,
        installationId,
        wqId,
        pluginVersion,
        publicKeyJwk,
        signature: await sign(keyPair.privateKey, 'register', registrationValue),
    }),
});

const today = new Date().toISOString().slice(0, 10);
const previous = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
const records = Array.from({ length: recordCount }, (_, index) => ({
    alphaId: `alpha-${installationId}-${index}`,
    sourceType: 'submitted',
    groupKey: 'USA|TOP3000|D1',
    prodCorr: 0.25,
    classifications: [{ id: 'POWER_POOL:POWER_POOL_ELIGIBLE', name: 'Power Pool Alpha' }],
    pnl: { records: [[previous, index + 1], [today, index + 2]] },
}));
const chunks = splitRecords(records);
const compressedParts = await Promise.all(chunks.map((chunk) => gzipBytes(chunk)));
const partHashes = await Promise.all(compressedParts.map((bytes) => sha256Hex(bytes)));
const manifest = {
    schemaVersion: 1,
    wqId,
    mode: 'incremental',
    status: 'completed',
    remoteCount: records.length,
    alphaCount: records.length,
    submittedPnlCount: records.length,
    submittedDate: today,
    incrementalSyncedAt: Date.now(),
    failedIds: [],
    backfillFailedIds: [],
    recordCount: records.length,
    partCount: compressedParts.length,
    payloadSha256: await sha256Hex(partHashes.join(':')),
};
const upload = await request('/v1/share/uploads', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
        installationId,
        manifest,
        signature: await sign(keyPair.privateKey, 'upload', `${installationId}|${JSON.stringify(manifest)}`),
    }),
});
const parts = partHashes.map((sha256, index) => ({ part: index + 1, sha256 }));
const authorization = await request(`/v1/share/uploads/${upload.sessionId}/finalize`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
        uploadToken: upload.uploadToken,
        parts,
        signature: await sign(keyPair.privateKey, 'finalize', `${upload.sessionId}|${JSON.stringify(parts)}|${manifest.payloadSha256}`),
    }),
});
if (authorization.pending !== true || authorization.finalizeAuthorized !== true) {
    throw new Error('Finalize authorization was not accepted before upload.');
}
if (upload.directUpload) {
    if (!upload.directEncryptionKey) throw new Error('Direct upload session is missing its encryption key.');
    const directParts = partHashes.map((sha256, index) => ({
        part: index + 1,
        sha256,
        bytes: compressedParts[index].byteLength,
    }));
    const batchSize = Math.max(1, Number(upload.directUrlBatchSize) || 32);
    for (let start = 0; start < directParts.length; start += batchSize) {
        const current = directParts.slice(start, start + batchSize);
        const urls = await request(`/v1/share/uploads/${upload.sessionId}/direct-urls`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ uploadToken: upload.uploadToken, parts: current.map((item) => item.part) }),
        });
        const byPart = new Map((urls.uploads || []).map((item) => [Number(item.part), item]));
        await Promise.all(current.map(async ({ part }) => {
            const target = byPart.get(part);
            if (!target?.url) throw new Error(`Missing direct URL for part ${part}.`);
            if (part === 1) {
                const preflight = await fetch(target.url, {
                    method: 'OPTIONS',
                    headers: {
                        Origin: origin,
                        'Access-Control-Request-Method': 'PUT',
                        'Access-Control-Request-Headers': 'content-type',
                    },
                });
                const allowedOrigin = preflight.headers.get('Access-Control-Allow-Origin');
                if (!preflight.ok || !['*', origin].includes(allowedOrigin)) {
                    throw new Error(`Direct R2 CORS preflight failed: ${preflight.status}/${allowedOrigin || 'none'}`);
                }
            }
            const response = await fetch(target.url, {
                method: 'PUT',
                redirect: 'error',
                headers: { Origin: origin, ...(target.headers || { 'Content-Type': 'application/json' }) },
                body: await encryptDirectPart(compressedParts[part - 1], upload.directEncryptionKey),
            });
            if (!response.ok) throw new Error(`Direct R2 PUT ${part} failed: ${response.status}`);
        }));
    }
    if (directProbeOnly) {
        process.stdout.write(`${JSON.stringify({
            ok: true,
            mode: 'direct-r2-probe',
            installationId,
            sessionId: upload.sessionId,
            objectKey: `direct-uploads/${upload.sessionId}/1.json`,
        })}\n`);
        process.exit(0);
    }
    const directSignatureValue = `${upload.sessionId}|${JSON.stringify(directParts)}|${manifest.payloadSha256}`;
    await request(`/v1/share/uploads/${upload.sessionId}/direct-complete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            uploadToken: upload.uploadToken,
            parts: directParts,
            signature: await sign(keyPair.privateKey, 'direct-complete', directSignatureValue),
        }),
    });
} else {
    if (directProbeOnly) throw new Error('Direct R2 mode is not enabled.');
    await Promise.all(compressedParts.map((bytes, index) => (
        request(`/v1/share/uploads/${upload.sessionId}/parts/${index + 1}`, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/x-ndjson',
                'X-Upload-Token': upload.uploadToken,
                'X-Content-SHA256': partHashes[index],
                'X-Content-Encoding': 'gzip',
            },
            body: bytes,
        })
    )));
}
let uploadStatus = null;
for (let attempt = 0; attempt < statusMaxAttempts; attempt += 1) {
    uploadStatus = await request(`/v1/share/uploads/${upload.sessionId}/status`, {
        headers: { 'X-Upload-Token': upload.uploadToken },
    });
    if (uploadStatus.failed) throw new Error(`Queue processing failed: ${JSON.stringify(uploadStatus.errors)}`);
    if (uploadStatus.status === 'finalized') break;
    await new Promise((resolve) => setTimeout(resolve, statusPollMs));
}
if (!uploadStatus || uploadStatus.status !== 'finalized') throw new Error('Queue auto-finalize timed out.');
if (uploadStatus.finalizeAuthorized !== true || uploadStatus.processed !== uploadStatus.total) {
    throw new Error('Auto-finalized upload status is inconsistent.');
}
if (processOnly) {
    process.stdout.write(`${JSON.stringify({
        ok: true,
        mode: upload.directUpload ? 'direct-r2' : 'worker-fallback',
        recordCount: records.length,
        partCount: compressedParts.length,
        uploaded: uploadStatus.uploaded,
        processed: uploadStatus.processed,
        durationMs: Date.now() - startedAt,
    })}\n`);
    process.exit(0);
}
const finalized = await request(`/v1/share/uploads/${upload.sessionId}/finalize`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
        uploadToken: upload.uploadToken,
        parts,
        signature: await sign(keyPair.privateKey, 'finalize', `${upload.sessionId}|${JSON.stringify(parts)}|${manifest.payloadSha256}`),
    }),
});
if (!/^wqs_[A-Za-z0-9_-]+$/.test(finalized.key) || finalized.recordCount !== records.length) {
    throw new Error('Finalize response is invalid.');
}
const replayed = await request(`/v1/share/uploads/${upload.sessionId}/finalize`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
        uploadToken: upload.uploadToken,
        parts,
        signature: await sign(keyPair.privateKey, 'finalize', `${upload.sessionId}|${JSON.stringify(parts)}|${manifest.payloadSha256}`),
    }),
});
if (replayed.key !== finalized.key || replayed.sessionId !== finalized.sessionId || replayed.recordCount !== finalized.recordCount) {
    throw new Error('Finalize replay did not return the original result.');
}
const stats = await request('/v1/share/stats', {
    headers: { Authorization: `Bearer ${finalized.key}` },
});
if (stats.totals.recordCount < 1 || stats.key.remaining !== 30) {
    throw new Error('Stats response is invalid.');
}
const scheduledTime = Date.now() + (2 * 60 * 60 * 1000);
const scheduled = await fetch(`${baseUrl}/cdn-cgi/local/scheduled?cron=17+*%2F2+*+*+*&time=${scheduledTime}`);
if (!scheduled.ok) throw new Error(`Scheduled snapshot trigger failed: ${scheduled.status}`);
let publishedStats = null;
for (let attempt = 0; attempt < 120; attempt += 1) {
    const response = await fetch(`${baseUrl}/v1/share/stats`, {
        headers: { Origin: origin, Authorization: `Bearer ${finalized.key}` },
    });
    if (response.ok) {
        const candidate = await response.json();
        if (candidate.snapshot?.status === 'published'
            && candidate.snapshot.recordCount === candidate.totals.recordCount
            && candidate.snapshot.pnlPointCount === candidate.totals.pnlPointCount) {
            publishedStats = candidate;
            break;
        }
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
}
if (!publishedStats) throw new Error('Snapshot did not become consistent after rebuild.');
const downloadRoute = await request('/v1/share/download-url', {
    method: 'POST',
    headers: { Authorization: `Bearer ${finalized.key}` },
});
const beforeDataset = await request('/v1/share/stats', { headers: { Authorization: `Bearer ${finalized.key}` } });
if (downloadRoute.direct && beforeDataset.key.remaining !== 29) {
    throw new Error('Direct URL lookup did not consume exactly one download quota.');
}
if (!downloadRoute.direct && beforeDataset.key.remaining !== 30) {
    throw new Error('Fallback URL lookup consumed download quota.');
}
const dataset = downloadRoute.direct
    ? await fetch(downloadRoute.downloadUrl, { redirect: 'error', headers: { Origin: origin } })
    : await fetch(`${baseUrl}${downloadRoute.datasetUrl}`, { headers: { Authorization: `Bearer ${finalized.key}` } });
if (!dataset.ok) throw new Error(`Dataset download failed: ${dataset.status}`);
if (downloadRoute.direct && !['*', origin].includes(dataset.headers.get('Access-Control-Allow-Origin'))) {
    throw new Error('Direct R2 GET response is missing an allowed CORS origin.');
}
const bytes = new Uint8Array(await dataset.arrayBuffer());
if (bytes[0] !== 0x1f || bytes[1] !== 0x8b) throw new Error('Dataset is not gzip encoded.');
const downloadedRecords = decodeGzipDatasetBytes(bytes, downloadRoute.gzipMembers);
const downloadedPoints = downloadedRecords.reduce((sum, record) => sum + record.pnl.records.length, 0);
if (downloadedRecords.length !== publishedStats.snapshot.recordCount
    || downloadedPoints !== publishedStats.snapshot.pnlPointCount) {
    throw new Error(`Indexed gzip decode mismatch: ${downloadedRecords.length}/${downloadedPoints}.`);
}
const afterFirst = await request('/v1/share/stats', { headers: { Authorization: `Bearer ${finalized.key}` } });
if (afterFirst.key.remaining !== 29) throw new Error('Download quota was not decremented exactly once.');
if (!downloadRoute.direct) {
    for (let index = 0; index < 29; index += 1) {
        const repeated = await fetch(`${baseUrl}/v1/share/dataset`, { headers: { Authorization: `Bearer ${finalized.key}` } });
        if (!repeated.ok) throw new Error(`Quota request ${index + 2} failed: ${repeated.status}`);
        await repeated.arrayBuffer();
    }
    const overflow = await fetch(`${baseUrl}/v1/share/dataset`, { headers: { Authorization: `Bearer ${finalized.key}` } });
    if (overflow.status !== 429) throw new Error(`Expected 429 after 30 downloads, got ${overflow.status}.`);
}
process.stdout.write(`E2E passed: mode=${upload.directUpload ? 'direct-r2' : 'worker-fallback'}, records=${stats.totals.recordCount}, gzipBytes=${bytes.byteLength}\n`);
