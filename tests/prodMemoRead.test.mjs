import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import * as calculator from '../src/background/services/prodMemoCalculator.js';
import { PROD_MEMO_STORES } from '../src/background/services/prodMemoDb.js';

const dbSource = await readFile(new URL('../src/background/services/prodMemoDb.js', import.meta.url), 'utf8');
const serviceSource = await readFile(new URL('../src/background/services/prodMemoService.js', import.meta.url), 'utf8');
function classic(source) {
    return source.replace(/^import[\s\S]*?from\s+['"][^'"]+['"];\s*/gm, '').replace(/^export\s+/gm, '');
}

function servicePage({ alphas, platformCorrs = [], localCorrs = [], pnlFingerprints = [], shared = [] }) {
    const reads = [];
    const context = vm.createContext({
        ...calculator, PROD_MEMO_STORES, setTimeout,
        chrome: { runtime: {}, storage: { local: { get(key, callback) { callback({ [key]: { completed: true } }); } } } },
        async getRecord(store, key) {
            reads.push(['record', store, key]);
            return (store === 'alphas' ? alphas : platformCorrs).find((row) => (row.id || row.alphaId) === key);
        },
        async getRecords(store, keys) {
            reads.push(['records', store, keys]);
            return localCorrs.filter((row) => keys.some(([id, type]) => row.alphaId === id && row.corrType === type));
        },
        async getLatestSubmittedAt() { return '2026-10-03T00:00:00Z'; },
        async getProdMemoLightSnapshot() {
            reads.push(['personal']);
            return { alphas, platformCorrs, localCorrs, pnlFingerprints, pnlIds: pnlFingerprints.map((row) => row.alphaId), syncMeta: [] };
        },
        async getSharedSnapshotMetadata() { reads.push(['shared']); return shared; },
        async getAllRecords(store) { throw new Error(`Unexpected full record scan: ${store}`); },
    });
    vm.runInContext(classic(serviceSource) + '\nglobalThis.readDetail = getProdMemoDetail;', context);
    return { reads, detail: context.readDetail };
}

const target = { id: 'KP7pELk8', submitted: true, stage: 'OS', settings: { region: 'JPN' }, classifications: [{ id: 'REGULAR:REGULAR' }] };
test('a platform-only card reads the selected Alpha and Corr keys without scanning PnL or shared data', async () => {
    const page = servicePage({ alphas: [target], platformCorrs: [{ alphaId: target.id, prod: { max: 0.42, min: -0.1 } }] });
    const detail = await page.detail(target.id);
    assert.equal(detail.alpha.id, target.id);
    assert.equal(detail.platform.prod.max, 0.42);
    assert.equal(detail.resolved.prod.max, 0.42);
    assert.equal(detail.latestSubmittedAt, '2026-10-03T00:00:00Z');
    assert.equal(page.reads.filter(([type]) => type === 'personal' || type === 'shared').length, 0);
    assert.equal(page.reads.length, 3);
});

test('Self-only local freshness checks do not read the shared reference pool', async () => {
    const targetPnl = { fingerprint: 'target-v1' };
    const record = {
        alphaId: target.id, corrType: 'SELF', algorithmVersion: calculator.PROD_MEMO_ALGORITHM_VERSION,
        inputFingerprint: calculator.calculationFingerprint({ corrType: 'SELF', targetAlpha: target, targetPnl, pnlById: new Map() }),
        result: { available: true, max: 0.31 },
    };
    const page = servicePage({ alphas: [target], localCorrs: [record], pnlFingerprints: [{ alphaId: target.id, fingerprint: 'target-v1' }] });
    const detail = await page.detail(target.id);
    assert.equal(detail.local.self.stale, false);
    assert.equal(detail.resolved.self.max, 0.31);
    assert.equal(page.reads.filter(([type]) => type === 'shared').length, 0);
});

test('Prod lower-bound freshness still includes shared PnL fingerprints and known production Corr', async () => {
    const shared = { alias: 'shared-ref', groupKey: 'JPN|TOP1600|D1', fingerprint: 'shared-v1', prodCorr: 1, updatedAt: 1000 };
    const targetPnl = { fingerprint: 'target-v1' };
    const inputFingerprint = calculator.calculationFingerprint({
        corrType: 'PROD_LOWER_BOUND', targetAlpha: target, targetPnl,
        pnlById: new Map([[target.id, targetPnl], [shared.alias, { fingerprint: shared.fingerprint }]]),
        references: [{ alpha: { id: shared.alias }, platformProdMax: shared.prodCorr, platformUpdated: shared.updatedAt }],
    });
    const page = servicePage({ alphas: [target], shared: [shared], pnlFingerprints: [{ alphaId: target.id, fingerprint: 'target-v1' }], localCorrs: [{
        alphaId: target.id, corrType: 'PROD_LOWER_BOUND', algorithmVersion: calculator.PROD_MEMO_ALGORITHM_VERSION,
        inputFingerprint, result: { available: true, max: 0.46 },
    }] });
    const detail = await page.detail(target.id);
    assert.equal(detail.local.prodLowerBound.stale, false);
    assert.equal(detail.resolved.prod.max, 0.46);
    assert.equal(page.reads.filter(([type]) => type === 'shared').length, 1);
});

function databasePage(initial = {}) {
    const data = new Map(Object.values(PROD_MEMO_STORES).map((name) => [name, structuredClone(initial[name] || [])]));
    const batches = [];
    let abortNextRead = false;
    const keyOf = (store, row) => store === 'alphas' ? row.id : store === 'sharedRecords' ? row.alias : row.key;
    function request(run) {
        const value = {};
        queueMicrotask(() => { value.result = run(); value.onsuccess?.(); });
        return value;
    }
    const db = {
        close() {},
        transaction(names, mode) {
            const tx = {
                objectStore(name) {
                    return {
                        getAll(range, count) {
                            batches.push({ store: name, count });
                            if (abortNextRead) {
                                abortNextRead = false;
                                queueMicrotask(() => { tx.error = new Error('read aborted'); tx.onabort?.(); });
                                return {};
                            }
                            return request(() => data.get(name).filter((row) => !range || keyOf(name, row) > range.lower).slice(0, count));
                        },
                        put(row) {
                            const records = data.get(name);
                            const index = records.findIndex((item) => keyOf(name, item) === keyOf(name, row));
                            if (index >= 0) records[index] = structuredClone(row);
                            else records.push(structuredClone(row));
                            records.sort((a, b) => keyOf(name, a) < keyOf(name, b) ? -1 : 1);
                        },
                        clear() { data.set(name, []); },
                        delete(key) { data.set(name, data.get(name).filter((row) => keyOf(name, row) !== key)); },
                    };
                },
            };
            if (mode === 'readwrite') queueMicrotask(() => tx.oncomplete?.());
            return tx;
        },
    };
    const context = vm.createContext({
        pnlFingerprint: calculator.pnlFingerprint,
        indexedDB: { open() { return request(() => db); } },
        IDBKeyRange: { lowerBound(lower, open) { assert.equal(open, true); return { lower }; } },
    });
    vm.runInContext(classic(dbSource) + '\nglobalThis.api = { getSharedSnapshotMetadata, getLatestSubmittedAt, replaceSharedSnapshot, putRecord, putRecords, clearStores, deleteRecord };', context);
    return { api: context.api, data, batches, abortRead() { abortNextRead = true; } };
}

test('shared metadata reads use bounded batches and reuse one read across card switches', async () => {
    const records = Array.from({ length: 300 }, (_, index) => ({ alias: `ref-${String(index).padStart(4, '0')}`, fingerprint: `pnl-${index}`, pnl: { records: [['2026-10-01', index]] } }));
    const page = databasePage({ sharedRecords: records });
    const [first, concurrent] = await Promise.all([page.api.getSharedSnapshotMetadata(), page.api.getSharedSnapshotMetadata()]);
    assert.equal(first.length, 300);
    assert.equal(first, concurrent);
    assert.ok(first.every((row) => !('pnl' in row)));
    assert.equal(page.batches.length, 3);
    assert.ok(page.batches.every((batch) => batch.count === 128));
    await page.api.getSharedSnapshotMetadata();
    assert.equal(page.batches.length, 3);
    await page.api.replaceSharedSnapshot([{ alias: 'new-ref', fingerprint: 'new-v1', pnl: { records: [] } }]);
    const updated = await page.api.getSharedSnapshotMetadata();
    assert.equal(updated.length, 1);
    assert.equal(updated[0].alias, 'new-ref');
    assert.equal(page.batches.length, 4);
});

test('legacy shared fingerprints are derived during the metadata pass without changing stored PnL', async () => {
    const pnl = { records: [['2026-09-01', 1], ['2026-09-02', 3]] };
    const page = databasePage({ sharedRecords: [{ alias: 'legacy-ref', pnl }] });
    const metadata = await page.api.getSharedSnapshotMetadata();
    assert.equal(metadata[0].fingerprint, calculator.pnlFingerprint(pnl));
    assert.equal(page.data.get('sharedRecords')[0].fingerprint, undefined);
    assert.deepEqual(page.data.get('sharedRecords')[0].pnl, pnl);
});

test('an aborted shared metadata read rejects and can be retried', async () => {
    const page = databasePage({ sharedRecords: [{ alias: 'ref', fingerprint: 'v1' }] });
    page.abortRead();
    await assert.rejects(page.api.getSharedSnapshotMetadata(), /read aborted/);
    const retried = await page.api.getSharedSnapshotMetadata();
    assert.equal(retried[0].alias, 'ref');
});

test('the cached Submitted date stays current after Alpha writes and clearing', async () => {
    const page = databasePage({ alphas: [{ id: 'first', submitted: true, dateSubmitted: '2026-10-01' }] });
    assert.equal(await page.api.getLatestSubmittedAt(), '2026-10-01');
    await page.api.getLatestSubmittedAt();
    assert.equal(page.batches.length, 1);
    await page.api.putRecord('alphas', { id: 'second', submitted: true, dateSubmitted: '2026-10-03' });
    assert.equal(await page.api.getLatestSubmittedAt(), '2026-10-03');
    await page.api.clearStores(['alphas']);
    assert.equal(await page.api.getLatestSubmittedAt(), '');
});
