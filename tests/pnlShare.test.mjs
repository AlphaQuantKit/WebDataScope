import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { gzipSync } from 'node:zlib';
import {
    evaluateShareUploadEligibility,
    normalizeShareClassifications,
} from '../src/background/services/prodMemoService.js';
import {
    validateManifest,
    validateShareRecord,
} from '../pnl-share-worker/src/validation.js';
import {
    advancePendingUpload,
    decodeGzipDatasetBytes,
    fetchSharedDatasetWithFallback,
    normalizePendingUpload,
    publicPendingUpload,
    requestJson,
    runUploadProcessPipeline,
    splitRecords,
} from '../src/background/services/pnlShareService.js';
import {
    buildSharePythonExample,
    formatShareStatusLines,
    localDownloadedRecordCount,
} from '../src/ui/sidebar/modules/prodMemoPanel.js';

function pendingUpload(overrides = {}) {
    return {
        version: 1,
        state: 'processing',
        sessionId: 'session-test',
        uploadToken: 'upl_secret_token',
        parts: [
            { part: 1, sha256: 'a'.repeat(64) },
            { part: 2, sha256: 'b'.repeat(64) },
        ],
        payloadSha256: 'c'.repeat(64),
        syncAt: 123,
        recordCount: 16,
        expiresAt: 10_000,
        createdAt: 100,
        uploaded: 2,
        processed: 0,
        ...overrides,
    };
}

function sync(count = 2) {
    return {
        mode: 'incremental',
        status: 'completed',
        fullCompleted: true,
        remoteCount: count,
        alphaCount: count,
        submittedPnlCount: count,
        failedIds: [],
        backfillFailedIds: [],
        incrementalSyncedAt: Date.parse('2026-08-17T00:00:00Z'),
    };
}

function submitted(id, dateSubmitted) {
    return {
        id,
        submitted: true,
        source: 'wq-sync',
        dateSubmitted,
    };
}

test('share upload gate does not require the local Submitted date to be today', () => {
    const result = evaluateShareUploadEligibility({
        sync: sync(),
        submittedAlphas: [
            submitted('a', '2026-08-18T01:00:00Z'),
            submitted('b', '2026-08-18T02:00:00Z'),
        ],
        pnlIds: ['a', 'b'],
    });
    assert.equal(result.eligible, true);
    assert.equal(result.countsComplete, true);

    const mixedHistory = evaluateShareUploadEligibility({
        sync: sync(),
        submittedAlphas: [
            submitted('a', '2026-08-17T01:00:00Z'),
            submitted('b', '2026-08-18T02:00:00Z'),
        ],
        pnlIds: ['a', 'b'],
    });
    assert.equal(mixedHistory.eligible, true);

    const wrongDay = evaluateShareUploadEligibility({
        sync: sync(),
        submittedAlphas: [
            submitted('a', '2026-08-17T01:00:00Z'),
            submitted('b', '2026-08-17T02:00:00Z'),
        ],
        pnlIds: ['a', 'b'],
    });
    assert.equal(wrongDay.eligible, true);
    assert.equal(wrongDay.latestSubmittedDate, '2026-08-17');
});

test('share upload gate still rejects incomplete incremental syncs', () => {
    const incomplete = sync();
    incomplete.fullCompleted = false;
    assert.equal(evaluateShareUploadEligibility({
        sync: incomplete,
        submittedAlphas: [
            submitted('a', '2026-08-18T01:00:00Z'),
            submitted('b', '2026-08-18T02:00:00Z'),
        ],
        pnlIds: ['a'],
    }).eligible, false);
});

test('share upload gate accepts only records owned by the synced WQ account', () => {
    const result = evaluateShareUploadEligibility({
        sync: sync(1),
        accountWqId: 'owner-a',
        submittedAlphas: [
            { ...submitted('a', '2026-08-17T01:00:00Z'), accountWqId: 'owner-a' },
            { ...submitted('b', '2026-08-17T02:00:00Z'), accountWqId: 'owner-b' },
        ],
        pnlIds: ['a', 'b'],
    });
    assert.equal(result.eligible, true);
    assert.deepEqual(result.submitted.map((alpha) => alpha.id), ['a']);
});

test('share upload gate rejects the same incremental sync after a successful upload', () => {
    assert.equal(evaluateShareUploadEligibility({
        sync: { ...sync(), incrementalSyncedAt: Date.parse('2026-08-18T03:00:00Z') },
        submittedAlphas: [submitted('a', '2026-08-18T01:00:00Z'), submitted('b', '2026-08-18T02:00:00Z')],
        pnlIds: ['a', 'b'],
        lastUpload: { syncAt: Date.parse('2026-08-18T03:00:00Z') },
    }).eligible, false);
    assert.equal(evaluateShareUploadEligibility({
        sync: { ...sync(), incrementalSyncedAt: Date.parse('2026-08-18T04:00:00Z') },
        submittedAlphas: [submitted('a', '2026-08-18T01:00:00Z'), submitted('b', '2026-08-18T02:00:00Z')],
        pnlIds: ['a', 'b'],
        lastUpload: { syncAt: Date.parse('2026-08-18T03:00:00Z') },
    }).eligible, true);
});

test('classifications are uploaded as id/name objects', () => {
    assert.deepEqual(normalizeShareClassifications([
        { id: 'POWER_POOL:POWER_POOL_ELIGIBLE', name: 'Power Pool Alpha', ignored: true },
        'REGULAR:REGULAR',
        null,
    ]), [
        { id: 'POWER_POOL:POWER_POOL_ELIGIBLE', name: 'Power Pool Alpha' },
        { id: 'REGULAR:REGULAR', name: 'REGULAR:REGULAR' },
    ]);
});

test('large PnL records are split without expanding bytes onto the call stack', () => {
    const record = {
        alphaId: 'large-alpha',
        sourceType: 'submitted',
        groupKey: 'USA|TOP3000|D1',
        prodCorr: 1,
        classifications: [],
        pnl: {
            records: Array.from({ length: 20_000 }, (_, index) => [`2026-01-${index}`, index]),
        },
    };
    const serialized = `${JSON.stringify(record)}\n`;
    assert.ok(Buffer.byteLength(serialized) > 128 * 1024);

    const chunks = splitRecords([record]);

    assert.equal(chunks.length, 1);
    assert.equal(new TextDecoder().decode(chunks[0]), serialized);
});

test('upload chunks keep each Queue job to at most eight Alpha records', () => {
    const records = Array.from({ length: 250 }, (_, index) => ({
        alphaId: `alpha-${index}`,
        pnl: { records: [['2026-08-18', index], ['2026-08-19', index + 1]] },
    }));
    const chunks = splitRecords(records);
    const recordCounts = chunks.map((chunk) => (
        new TextDecoder().decode(chunk).trim().split('\n').length
    ));
    assert.equal(chunks.length, Math.ceil(records.length / 8));
    assert.equal(Math.max(...recordCounts), 8);
    assert.equal(recordCounts.reduce((sum, count) => sum + count, 0), records.length);
});

test('production upload preauthorizes finalize before sending any upload parts', async () => {
    const source = await readFile(new URL('../src/background/services/pnlShareService.js', import.meta.url), 'utf8');
    assert.match(source, /\/status/);
    assert.match(source, /\/direct-urls/);
    assert.doesNotMatch(source, /\/process\//);
    assert.doesNotMatch(source, /waitForUploadProcessing/);
    const uploadSource = source.slice(source.indexOf('export async function uploadSharedData'), source.indexOf('function appendDatasetLine'));
    assert.doesNotMatch(uploadSource, /\/status/);
    assert.match(uploadSource, /\/finalize/);
    assert.ok(uploadSource.indexOf('/finalize') < uploadSource.indexOf('uploadPartsDirect('));
    assert.ok(uploadSource.indexOf('/finalize') < uploadSource.indexOf('uploadPartsViaWorker('));
    assert.match(uploadSource, /finalizeAuthorized: true/);
    assert.match(uploadSource, /已有共享上传任务正在处理/);
    assert.match(uploadSource, /queued: true/);
});

test('pending upload normalization keeps recovery secrets local and exposes only safe progress', () => {
    const normalized = normalizePendingUpload(pendingUpload());
    const visible = publicPendingUpload(normalized, 1_000);

    assert.equal(normalized.uploadToken, 'upl_secret_token');
    assert.equal(normalized.parts.length, 2);
    assert.equal(visible.active, true);
    assert.equal(visible.partCount, 2);
    assert.equal('uploadToken' in visible, false);
    assert.equal('parts' in visible, false);
    assert.equal('payloadSha256' in visible, false);
    assert.equal('sessionId' in visible, false);
});

test('incomplete pending upload updates progress without finalizing', async () => {
    const requests = [];
    const saved = [];
    const result = await advancePendingUpload(pendingUpload(), {
        now: () => 1_000,
        request: async (path) => {
            requests.push(path);
            return { ok: true, uploaded: 2, processed: 1, failed: 0, retrying: 0, total: 2, finalizeAuthorized: true, errors: [] };
        },
        savePending: async (value) => saved.push(value),
    });

    assert.equal(requests.length, 1);
    assert.match(requests[0], /\/status$/);
    assert.equal(result.finalized, null);
    assert.equal(result.pending.processed, 1);
    assert.equal(saved.length, 1);
});

test('missing or expired server session becomes retryable instead of blocking uploads', async () => {
    const saved = [];
    const result = await advancePendingUpload(pendingUpload(), {
        now: () => 1_000,
        request: async () => { throw new Error('Upload session is missing or expired.'); },
        savePending: async (value) => saved.push(value),
    });

    assert.equal(result.pending.active, false);
    assert.equal(result.pending.state, 'expired');
    assert.match(result.pending.lastError, /重新上传/);
    assert.equal(saved[0].state, 'expired');
});

test('completed pending upload finalizes once, saves the Key, and clears the task', async () => {
    const requests = [];
    const savedKeys = [];
    const lastUploads = [];
    let clearCount = 0;
    const result = await advancePendingUpload(pendingUpload(), {
        now: () => 1_000,
        request: async (path, options) => {
            requests.push({ path, method: options.method });
            if (path.endsWith('/status')) {
                return { ok: true, status: 'finalized', uploaded: 2, processed: 2, failed: 0, retrying: 0, total: 2, finalizeAuthorized: true, errors: [] };
            }
            return { ok: true, key: 'wqs_recovered', recordCount: 16, expiresAt: 9_000 };
        },
        getSigningKey: async () => ({ privateKey: { test: true } }),
        signValue: async () => 'test-signature',
        saveAccessKey: async (value) => savedKeys.push(value),
        saveLastUpload: async (value) => lastUploads.push(value),
        clearPending: async () => { clearCount += 1; },
    });

    assert.deepEqual(requests.map((item) => item.method), ['GET', 'POST']);
    assert.equal(requests.filter((item) => item.path.endsWith('/finalize')).length, 1);
    assert.deepEqual(savedKeys, ['wqs_recovered']);
    assert.deepEqual(lastUploads, [{ uploadedAt: 1_000, syncAt: 123, recordCount: 16, expiresAt: 9_000 }]);
    assert.equal(clearCount, 1);
    assert.equal(result.pending, null);
    assert.deepEqual(result.finalized, { recordCount: 16, expiresAt: 9_000 });
});

test('a locally expired upload still probes the server and recovers its Key', async () => {
    const requests = [];
    const savedKeys = [];
    const result = await advancePendingUpload(pendingUpload({ state: 'expired', expiresAt: 500 }), {
        now: () => 1_000,
        request: async (path) => {
            requests.push(path);
            if (path.endsWith('/status')) {
                return {
                    ok: true,
                    status: 'finalized',
                    uploaded: 2,
                    processed: 2,
                    failed: 0,
                    retrying: 0,
                    total: 2,
                    finalizeAuthorized: true,
                    expiresAt: 20_000,
                    errors: [],
                };
            }
            return { ok: true, status: 'finalized', finalizeAuthorized: true, key: 'wqs_late', recordCount: 16, expiresAt: 30_000 };
        },
        getSigningKey: async () => ({ privateKey: { test: true } }),
        signValue: async () => 'test-signature',
        saveAccessKey: async (value) => savedKeys.push(value),
        saveLastUpload: async () => {},
        clearPending: async () => {},
    });

    assert.equal(requests.length, 2);
    assert.match(requests[0], /\/status$/);
    assert.match(requests[1], /\/finalize$/);
    assert.deepEqual(savedKeys, ['wqs_late']);
    assert.equal(result.pending, null);
});

test('a 202 finalize response remains resumable without trying to save a missing Key', async () => {
    const saved = [];
    const savedKeys = [];
    const result = await advancePendingUpload(pendingUpload(), {
        now: () => 1_000,
        request: async (path) => path.endsWith('/status')
            ? { ok: true, status: 'open', uploaded: 2, processed: 2, failed: 0, retrying: 0, total: 2, finalizeAuthorized: true, errors: [] }
            : { ok: true, status: 'finalizing', pending: true, finalizeAuthorized: true, expiresAt: 20_000 },
        getSigningKey: async () => ({ privateKey: { test: true } }),
        signValue: async () => 'test-signature',
        savePending: async (value) => saved.push(value),
        saveAccessKey: async (value) => savedKeys.push(value),
    });

    assert.equal(result.pending.active, true);
    assert.equal(result.pending.finalizeAuthorized, true);
    assert.equal(saved.at(-1).expiresAt, 20_000);
    assert.deepEqual(savedKeys, []);
});

test('a legacy incomplete upload submits finalize authorization before processing finishes', async () => {
    const requests = [];
    const saved = [];
    await advancePendingUpload(pendingUpload({ finalizeAuthorized: false }), {
        now: () => 1_000,
        request: async (path) => {
            requests.push(path);
            return path.endsWith('/status')
                ? { ok: true, status: 'open', uploaded: 2, processed: 1, failed: 0, retrying: 0, total: 2, finalizeAuthorized: false, errors: [] }
                : { ok: true, status: 'authorized', pending: true, finalizeAuthorized: true, expiresAt: 20_000 };
        },
        getSigningKey: async () => ({ privateKey: { test: true } }),
        signValue: async () => 'test-signature',
        savePending: async (value) => saved.push(value),
    });

    assert.deepEqual(requests.map((path) => path.split('/').at(-1)), ['status', 'finalize']);
    assert.equal(saved.at(-1).finalizeAuthorized, true);
});

test('share status renders upload, key quota, and server totals as three lines', () => {
    const lines = formatShareStatusLines({
        enabled: true,
        uploadEligible: true,
        uploadRecords: 2716,
        hasKey: true,
        remote: {
            key: { remaining: 29, limit: 30, expiresAt: Date.parse('2026-08-29T10:10:51Z') },
            snapshot: { status: 'published', recordCount: 2687 },
        },
    });
    assert.equal(lines.length, 3);
    assert.equal(lines[0], '上传条件满足：2716 条');
    assert.match(lines[1], /^Key 剩余 29 \/ 30 次下载，到期 /);
    assert.equal(lines[2], '当前可下载 2687 条');
});

test('share status distinguishes the downloadable snapshot from a newer build', () => {
    const lines = formatShareStatusLines({
        enabled: true,
        uploadEligible: false,
        uploadReason: '本次增量同步没有晚于上次成功上传，请先完成新的增量同步。',
        hasKey: true,
        remote: {
            key: { remaining: 30, limit: 30 },
            snapshot: { status: 'published', recordCount: 2716 },
            building: { version: 9, recordCount: 3713 },
        },
    });

    assert.equal(lines[2], '当前可下载 2716 条；新版 3713 条构建中');
});

test('local download summary uses the verified IndexedDB snapshot count', () => {
    assert.equal(localDownloadedRecordCount({ localSnapshot: { recordCount: 2716 } }), 2716);
    assert.equal(localDownloadedRecordCount({ localSnapshot: null }), 0);
    assert.equal(localDownloadedRecordCount({ localSnapshot: { recordCount: -1 } }), 0);
});

test('share status explains that an async upload can outlive the sidebar', () => {
    const lines = formatShareStatusLines({
        enabled: true,
        uploadEligible: false,
        uploadReason: '已有共享上传任务正在处理。',
        hasKey: false,
        pendingUpload: publicPendingUpload(pendingUpload({ processed: 1 }), 1_000),
        remote: null,
    });

    assert.equal(lines.length, 2);
    assert.equal(lines[0], '上传任务处理中：1/2 个分片；服务端已接管，可以关闭侧边栏或浏览器，稍后回来领取 Key。');
    assert.equal(lines[1], '尚未获得共享 key。');
});

test('Python download example embeds the current key and verifies snapshot completeness first', () => {
    const example = buildSharePythonExample('wqs_example_key');

    assert.match(example, /KEY = "wqs_example_key"/);
    assert.match(example, /\/v1\/share\/stats/);
    assert.match(example, /snapshot\.get\("status"\) != "published"/);
    assert.match(example, /snapshot\.get\("recordCount"\) != totals\.get\("recordCount"\)/);
    assert.match(example, /snapshot\.get\("pnlPointCount"\) != totals\.get\("pnlPointCount"\)/);
    assert.match(example, /\/v1\/share\/download-url/);
    assert.match(example, /\/v1\/share\/dataset/);
    assert.match(example, /except requests\.RequestException:/);
});

test('shared download falls back when the direct R2 body fails after fetch succeeds', async () => {
    const calls = [];
    const records = [{ alias: 'fallback-record' }];
    const result = await fetchSharedDatasetWithFallback({
        direct: true,
        downloadUrl: 'https://bucket.account.r2.cloudflarestorage.com/signed',
        datasetUrl: '/v1/share/dataset',
    }, 'wqs_test_key', {
        endpoint: 'https://worker.example',
        fetchImpl: async (url, init) => {
            calls.push({ url, init });
            return { ok: true, status: 200, kind: url.includes('r2.cloudflarestorage.com') ? 'direct' : 'fallback' };
        },
        decodeImpl: async (response) => {
            if (response.kind === 'direct') throw new TypeError('Failed to fetch');
            return records;
        },
    });
    assert.equal(result, records);
    assert.deepEqual(calls.map((call) => call.url), [
        'https://bucket.account.r2.cloudflarestorage.com/signed',
        'https://worker.example/v1/share/dataset',
    ]);
    assert.equal(calls[1].init.headers.Authorization, 'Bearer wqs_test_key');
});

test('shared download decodes concatenated gzip members used by published snapshots', () => {
    const first = {
        alias: 'alpha_first',
        sourceType: 'submitted',
        groupKey: 'USA|TOP3000|D1',
        prodCorr: 1,
        classifications: [],
        pnl: { records: [['2026-01-01', 1], ['2026-01-02', 2]] },
        updatedAt: 1,
    };
    const second = {
        alias: 'alpha_second',
        sourceType: 'prod',
        groupKey: 'USA|TOP3000|D1',
        prodCorr: 0.4,
        classifications: [],
        pnl: { records: [['2026-01-01', 3], ['2026-01-02', 4]] },
        updatedAt: 2,
    };
    const members = [
        gzipSync(`{"type":"meta","recordCount":2}\n${JSON.stringify(first)}\n`),
        gzipSync(`${JSON.stringify(second)}\n`),
    ];
    const compressed = Buffer.concat(members);
    const records = decodeGzipDatasetBytes(
        new Uint8Array(compressed),
        members.map((member) => member.byteLength),
    );
    assert.deepEqual(records.map((record) => record.alias), ['alpha_first', 'alpha_second']);
    assert.deepEqual(records[1].pnl.records, second.pnl.records);
    assert.throws(() => decodeGzipDatasetBytes(new Uint8Array(compressed), [compressed.byteLength - 1]), /大小不一致/);
});

test('shared download reports both direct and Worker network failures', async () => {
    await assert.rejects(() => fetchSharedDatasetWithFallback({
        direct: true,
        downloadUrl: 'https://bucket.account.r2.cloudflarestorage.com/signed',
    }, 'wqs_test_key', {
        endpoint: 'https://worker.example',
        fetchImpl: async (url) => {
            throw new TypeError(url.includes('r2.cloudflarestorage.com') ? 'Failed to fetch' : 'Worker offline');
        },
    }), /R2 直连失败：Failed to fetch；Worker 兼容下载失败：Worker offline/);
});

test('rate-limited upload requests wait for Retry-After and retry only when enabled', async () => {
    const originalFetch = globalThis.fetch;
    const originalSetTimeout = globalThis.setTimeout;
    const calls = [];
    const progress = [];
    globalThis.setTimeout = (callback) => {
        callback();
        return 0;
    };
    globalThis.fetch = async (_url, init) => {
        calls.push(init.method);
        if (calls.length === 1) {
            return new Response(JSON.stringify({ ok: false, error: 'rate_limited' }), {
                status: 429,
                headers: { 'Retry-After': '0' },
            });
        }
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
    };
    try {
        const result = await requestJson('/v1/share/uploads/session/process/1', {
            method: 'POST',
            retryOnRateLimit: true,
            onRateLimit: (value) => progress.push(value),
        });
        assert.deepEqual(result, { ok: true });
        assert.deepEqual(calls, ['POST', 'POST']);
        assert.equal(progress.length, 1);
    } finally {
        globalThis.fetch = originalFetch;
        globalThis.setTimeout = originalSetTimeout;
    }
});

test('upload/process pipeline overlaps both stages and respects concurrency limits', async () => {
    const total = 12;
    const uploadedParts = new Set();
    const processedParts = new Set();
    const progressTotals = [];
    let activeUploads = 0;
    let activeProcesses = 0;
    let maxUploads = 0;
    let maxProcesses = 0;
    let overlapped = false;
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

    const result = await runUploadProcessPipeline(total, {
        uploadConcurrency: 4,
        processConcurrency: 2,
        uploadPart: async (index) => {
            activeUploads += 1;
            maxUploads = Math.max(maxUploads, activeUploads);
            await wait(4);
            uploadedParts.add(index);
            activeUploads -= 1;
        },
        processPart: async (index) => {
            assert.equal(uploadedParts.has(index), true, `part ${index + 1} processed before upload`);
            activeProcesses += 1;
            maxProcesses = Math.max(maxProcesses, activeProcesses);
            if (uploadedParts.size < total) overlapped = true;
            await wait(6);
            processedParts.add(index);
            activeProcesses -= 1;
        },
        onProgress: ({ uploaded, processed }) => progressTotals.push(uploaded + processed),
    });

    assert.deepEqual(result, { uploaded: total, processed: total });
    assert.equal(uploadedParts.size, total);
    assert.equal(processedParts.size, total);
    assert.equal(maxUploads, 4);
    assert.equal(maxProcesses, 2);
    assert.equal(overlapped, true);
    assert.deepEqual(progressTotals, [...progressTotals].sort((left, right) => left - right));
});

test('upload/process pipeline stops scheduling after the first failure', async () => {
    let uploadCalls = 0;
    let processCalls = 0;
    await assert.rejects(() => runUploadProcessPipeline(20, {
        uploadConcurrency: 4,
        processConcurrency: 2,
        uploadPart: async (index) => {
            uploadCalls += 1;
            if (index === 3) throw new Error('upload failed');
        },
        processPart: async () => {
            processCalls += 1;
        },
    }), /upload failed/);
    assert.ok(uploadCalls < 20);
    assert.ok(processCalls < 20);
});

test('each Alpha keeps its own classifications instead of using a shared fixed value', () => {
    const powerPoolAlpha = normalizeShareClassifications([
        { id: 'POWER_POOL:POWER_POOL_ELIGIBLE', name: 'Power Pool Alpha' },
    ]);
    const regularAlpha = normalizeShareClassifications([
        { id: 'REGULAR:REGULAR', name: 'Regular Alpha' },
    ]);

    assert.deepEqual(powerPoolAlpha, [
        { id: 'POWER_POOL:POWER_POOL_ELIGIBLE', name: 'Power Pool Alpha' },
    ]);
    assert.deepEqual(regularAlpha, [
        { id: 'REGULAR:REGULAR', name: 'Regular Alpha' },
    ]);
    assert.notDeepEqual(powerPoolAlpha, regularAlpha);
});

test('Worker validation preserves classifications and forces submitted prodCorr to one', () => {
    const record = validateShareRecord({
        alphaId: 'abc123',
        sourceType: 'submitted',
        groupKey: 'USA|TOP3000|D1',
        prodCorr: 0.12,
        classifications: [{ id: 'POWER_POOL:POWER_POOL_ELIGIBLE', name: 'Power Pool Alpha' }],
        pnl: { records: [['2026-08-17', 1], ['2026-08-18', 2]] },
    });
    assert.equal(record.prodCorr, 1);
    assert.deepEqual(record.classifications, [{ id: 'POWER_POOL:POWER_POOL_ELIGIBLE', name: 'Power Pool Alpha' }]);
});

test('Worker manifest requires complete counts and empty failure lists', () => {
    const manifest = validateManifest({
        schemaVersion: 1,
        wqId: 'user',
        mode: 'incremental',
        status: 'completed',
        remoteCount: 2,
        alphaCount: 2,
        submittedPnlCount: 2,
        submittedDate: '2026-08-18',
        incrementalSyncedAt: 1,
        failedIds: [],
        backfillFailedIds: [],
        recordCount: 2,
        partCount: 1,
        payloadSha256: 'a'.repeat(64),
    });
    assert.equal(manifest.remoteCount, 2);
    assert.throws(() => validateManifest({ ...manifest, submittedPnlCount: 1 }), /incomplete/);
});
