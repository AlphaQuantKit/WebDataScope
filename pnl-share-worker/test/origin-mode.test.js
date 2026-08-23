import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import worker, {
    cleanupObsoleteObjects,
    downloadQuota,
    isExtensionOriginAllowed,
    snapshotAliasLaneBounds,
    snapshotIsConsistent,
    snapshotGzipMembers,
    snapshotLanePlan,
    snapshotLaneRanges,
    snapshotPartCount,
} from '../src/index.js';
import { hmacHex, sha256Hex } from '../src/crypto.js';

const anyChromeExtension = { EXTENSION_ORIGIN_MODE: 'any-chrome-extension' };
const validOriginA = 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const validOriginP = 'chrome-extension://pppppppppppppppppppppppppppppppp';

test('any-chrome-extension accepts valid Chrome extension origins', () => {
    assert.equal(isExtensionOriginAllowed(validOriginA, anyChromeExtension), true);
    assert.equal(isExtensionOriginAllowed(validOriginP, anyChromeExtension), true);
});

test('origin policy fails closed for malformed origins and non-explicit modes', () => {
    const rejected = [
        '',
        'https://example.com',
        'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        'chrome-extension://qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq',
        'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/',
    ];
    for (const origin of rejected) {
        assert.equal(isExtensionOriginAllowed(origin, anyChromeExtension), false, origin);
    }
    assert.equal(isExtensionOriginAllowed(validOriginA, {}), false);
    assert.equal(isExtensionOriginAllowed(validOriginA, { EXTENSION_ORIGIN_MODE: 'unknown' }), false);
});

test('CORS reflects only an allowed Chrome extension origin', async () => {
    const allowed = await worker.fetch(new Request('https://worker.example/v1/share/installations/challenge', {
        method: 'OPTIONS',
        headers: { Origin: validOriginA },
    }), anyChromeExtension, {});
    assert.equal(allowed.status, 204);
    assert.equal(allowed.headers.get('Access-Control-Allow-Origin'), validOriginA);

    const rejected = await worker.fetch(new Request('https://worker.example/v1/share/installations/challenge', {
        method: 'OPTIONS',
        headers: { Origin: 'https://example.com' },
    }), anyChromeExtension, {});
    assert.equal(rejected.status, 204);
    assert.equal(rejected.headers.get('Access-Control-Allow-Origin'), null);
});

test('production stays at concurrency four while staging load tests use sixteen', async () => {
    const config = JSON.parse(await readFile(new URL('../wrangler.jsonc', import.meta.url), 'utf8'));
    assert.equal(config.vars.EXTENSION_ORIGIN_MODE, 'any-chrome-extension');
    assert.equal('EXTENSION_ORIGIN' in config.vars, false);
    assert.equal(config.vars.UPLOAD_ENABLED, 'true');
    assert.equal(config.vars.DOWNLOAD_ENABLED, 'true');
    assert.equal(config.vars.PUBLICATION_ENABLED, 'true');
    assert.equal(config.queues.consumers[0].max_batch_size, 1);
    assert.equal(config.queues.consumers[0].max_concurrency, 4);
    assert.equal(config.env.staging.queues.consumers[0].max_batch_size, 1);
    assert.equal(config.env.staging.queues.consumers[0].max_concurrency, 16);
    assert.equal(config.vars.R2_BUCKET_NAME, 'webdatascope-pnl-share-raw');
    assert.equal(config.env.staging.vars.R2_BUCKET_NAME, 'webdatascope-pnl-share-raw-staging');
    assert.deepEqual(config.triggers.crons, ['17 */2 * * *']);
    assert.deepEqual(config.env.staging.triggers.crons, ['47 */2 * * *']);
});

test('snapshot work uses four non-overlapping alias cursor lanes', () => {
    assert.deepEqual(snapshotAliasLaneBounds(), [
        { laneNumber: 1, afterAlias: '', beforeAlias: 'alpha_4' },
        { laneNumber: 2, afterAlias: 'alpha_4', beforeAlias: 'alpha_8' },
        { laneNumber: 3, afterAlias: 'alpha_8', beforeAlias: 'alpha_c' },
        { laneNumber: 4, afterAlias: 'alpha_c', beforeAlias: null },
    ]);
    assert.deepEqual(snapshotLanePlan([
        { record_count: 8, pnl_point_count: 80 },
        { record_count: 9, pnl_point_count: 90 },
        { record_count: 0, pnl_point_count: 0 },
        { record_count: 1, pnl_point_count: 10 },
    ]).map(({ laneNumber, startPart, endPart }) => ({ laneNumber, startPart, endPart })), [
        { laneNumber: 1, startPart: 1, endPart: 1 },
        { laneNumber: 2, startPart: 2, endPart: 3 },
        { laneNumber: 3, startPart: 0, endPart: 0 },
        { laneNumber: 4, startPart: 4, endPart: 4 },
    ]);
    assert.deepEqual(snapshotLaneRanges(336), [
        { start: 1, end: 84 },
        { start: 85, end: 168 },
        { start: 169, end: 252 },
        { start: 253, end: 336 },
    ]);
    assert.deepEqual(snapshotLaneRanges(3), [
        { start: 1, end: 1 },
        { start: 2, end: 2 },
        { start: 3, end: 3 },
    ]);
});

test('snapshot source pagination uses alias cursors instead of OFFSET', async () => {
    const source = await readFile(new URL('../src/index.js', import.meta.url), 'utf8');
    assert.match(source, /WHERE source_revision <= \? AND alias > \?/);
    assert.doesNotMatch(source, /SELECT \* FROM shared_alphas ORDER BY alias ASC LIMIT \? OFFSET \?/);
    assert.match(source, /Math\.min\(Number\(snapshot\.expected_chunk_count \|\| 0\), firstPart/);
    assert.match(source, /source_revision > published_revision/);
    assert.match(source, /last_build_started_at <= \?/);
    assert.doesNotMatch(source, /background\.push\([^)]*queueSnapshotBuild/);
});

test('snapshot cleanup removes only old versions and unreferenced aged PnL objects', async () => {
    const deleted = [];
    const old = new Date(Date.now() - (25 * 60 * 60 * 1000));
    const recent = new Date();
    const env = {
        RAW_BUCKET: {
            async list({ prefix }) {
                if (prefix === 'snapshots/') return {
                    truncated: false,
                    objects: [
                        { key: 'snapshots/v21/part-1.ndjson.gz', uploaded: old },
                        { key: 'snapshots/v22/dataset.jsonl.gz', uploaded: old },
                        { key: 'snapshots/v23/part-1.ndjson.gz', uploaded: recent },
                    ],
                };
                return {
                    truncated: false,
                    objects: [
                        { key: 'pnl/referenced.json', uploaded: old },
                        { key: 'pnl/orphan.json', uploaded: old },
                        { key: 'pnl/recent.json', uploaded: recent },
                    ],
                };
            },
            async delete(keys) { deleted.push(...keys); },
        },
        DB: {
            prepare(sql) {
                return { bind: (...values) => ({ sql, values }) };
            },
            async batch(statements) {
                return statements.map((statement) => ({
                    results: statement.sql.includes('FROM shared_alphas')
                        ? statement.values.filter((value) => value === 'pnl/referenced.json').map((pnl_object_key) => ({ pnl_object_key }))
                        : [],
                }));
            },
        },
    };
    const result = await cleanupObsoleteObjects(env, 22);
    assert.deepEqual(deleted.sort(), [
        'pnl/orphan.json',
        'snapshots/v21/part-1.ndjson.gz',
    ]);
    assert.deepEqual(result, { keepVersion: 22, snapshotObjectsDeleted: 1, pnlObjectsDeleted: 1 });
});

test('published gzip member index covers metadata and every snapshot chunk', () => {
    assert.deepEqual(snapshotGzipMembers({
        object_key: 'snapshots/v7/dataset.jsonl.gz',
        byte_count: 100,
    }, [{ byte_count: 30 }, { byte_count: 40 }]), [30, 30, 40]);
    assert.equal(snapshotGzipMembers({ object_key: 'snapshots/v6' }, []), null);
    assert.equal(snapshotGzipMembers({
        object_key: 'snapshots/v7/dataset.jsonl.gz',
        byte_count: 69,
    }, [{ byte_count: 30 }, { byte_count: 40 }]), null);
});

test('new share keys use a ten-day lifetime', async () => {
    const source = await readFile(new URL('../src/index.js', import.meta.url), 'utf8');
    assert.match(source, /const KEY_TTL_MS = 10 \* 24 \* 60 \* 60 \* 1000;/);
});

test('uploads preauthorize server-side finalize with a 24-hour recovery window', async () => {
    const [source, migration] = await Promise.all([
        readFile(new URL('../src/index.js', import.meta.url), 'utf8'),
        readFile(new URL('../migrations/0009_async_finalize_authorization.sql', import.meta.url), 'utf8'),
    ]);
    assert.match(source, /const UPLOAD_TTL_MS = 24 \* 60 \* 60 \* 1000;/);
    assert.match(source, /finalizeAuthorizedUpload\(String\(message\.body\.sessionId/);
    assert.match(source, /type === 'upload-finalize'/);
    assert.match(source, /finalizeReadyUploads\(env\)/);
    assert.match(migration, /finalize_parts_json TEXT/);
    assert.match(migration, /finalize_authorized_at INTEGER/);
    assert.match(migration, /finalize_claimed_at INTEGER/);
    assert.match(migration, /86400000/);
});

test('share keys use a 30-download lifetime quota instead of a daily reset', () => {
    assert.deepEqual(downloadQuota({ download_count: 0 }), { used: 0, remaining: 30, limit: 30 });
    assert.deepEqual(downloadQuota({ download_count: 7 }), { used: 7, remaining: 23, limit: 30 });
    assert.deepEqual(downloadQuota({ download_count: 30 }), { used: 30, remaining: 0, limit: 30 });
});

test('upload status polling accepts a missing Origin but still requires the upload token', async () => {
    const session = { status: 'open', manifest_json: JSON.stringify({ partCount: 2 }) };
    const secret = 'test-access-key-hash-secret';
    const validTokenHash = await hmacHex(secret, 'upl_test');
    const env = {
        ...anyChromeExtension,
        ACCESS_KEY_HASH_SECRET: secret,
        DB: {
            prepare(sql) {
                return {
                    bind(...values) {
                        if (sql.includes('FROM upload_sessions')) {
                            return { first: async () => (values[1] === validTokenHash ? session : null) };
                        }
                        if (sql.includes('SELECT COUNT(*) AS uploaded')) {
                            return { first: async () => ({ uploaded: 2, processed: 2, failed: 0, retrying: 0, record_count: 16 }) };
                        }
                        if (sql.includes('SELECT part_number')) {
                            return { all: async () => ({ results: [] }) };
                        }
                        throw new Error(`Unexpected SQL in test: ${sql}`);
                    },
                };
            },
        },
    };
    const response = await worker.fetch(new Request('https://worker.example/v1/share/uploads/session/status', {
        headers: { 'X-Upload-Token': 'upl_test' },
    }), env, {});
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
        ok: true,
        status: 'open',
        finalizeAuthorized: false,
        finalizeError: '',
        expiresAt: 0,
        finalizedAt: 0,
        uploaded: 2,
        processed: 2,
        failed: 0,
        retrying: 0,
        recordCount: 16,
        total: 2,
        errors: [],
    });

    const missingToken = await worker.fetch(new Request('https://worker.example/v1/share/uploads/session/status'), env, {});
    assert.equal(missingToken.status, 401);
    assert.equal((await missingToken.json()).error, 'upload_session_invalid');
});

test('disabled downloads return a CORS-readable error', async () => {
    const response = await worker.fetch(new Request('https://worker.example/v1/share/dataset', {
        headers: { Origin: validOriginA },
    }), { ...anyChromeExtension, DOWNLOAD_ENABLED: 'false' }, {});
    assert.equal(response.status, 503);
    assert.equal(response.headers.get('Access-Control-Allow-Origin'), validOriginA);
    assert.deepEqual(await response.json(), { ok: false, error: 'download_disabled' });
});

test('snapshot consistency rejects an empty published snapshot beside non-empty source totals', () => {
    assert.equal(snapshotPartCount(0), 0);
    assert.equal(snapshotPartCount(17), 3);
    assert.equal(snapshotIsConsistent(
        { status: 'published', record_count: 0, pnl_point_count: 0 },
        { record_count: 8, pnl_point_count: 16 },
        0,
    ), false);
    assert.equal(snapshotIsConsistent(
        { status: 'published', record_count: 8, pnl_point_count: 16, expected_chunk_count: 1 },
        { record_count: 8, pnl_point_count: 16 },
        1,
    ), true);
    assert.equal(snapshotIsConsistent(
        { status: 'published', record_count: 17, pnl_point_count: 34, expected_chunk_count: 5 },
        { record_count: 17, pnl_point_count: 34 },
        3,
    ), false);
});

test('admin page includes Alpha search and statistics charts', async () => {
    const adminDigest = await sha256Hex('admin:pass');
    const response = await worker.fetch(new Request('https://worker.example/admin', {
        headers: { Authorization: `Basic ${btoa('admin:pass')}` },
    }), { ADMIN_AUTH_DIGEST: adminDigest }, {});
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, /id="alphaSearch"/);
    assert.match(html, /id="sourceChart"/);
    assert.match(html, /id="pnlChart"/);
    assert.match(html, /id="corrChart"/);
    const script = html.match(/<script nonce="[^"]+">([\s\S]*)<\/script>/)?.[1] || '';
    assert.doesNotThrow(() => new Function(script));
});
