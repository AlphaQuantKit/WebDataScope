export const PROD_MEMO_DB_NAME = 'WQP_ProdMemoDB';
export const PROD_MEMO_DB_VERSION = 5;
const PNL_FINGERPRINT_INDEX = 'byFingerprint';

export const PROD_MEMO_STORES = Object.freeze({
    alphas: 'alphas',
    pnls: 'pnls',
    platformCorrs: 'platformCorrs',
    localCorrs: 'localCorrs',
    syncMeta: 'syncMeta',
    sharedRecords: 'sharedRecords',
    sharedMeta: 'sharedMeta',
    shareKeys: 'shareKeys',
});

let dbPromise = null;

function compactAlphaRecord(alpha) {
    const settings = alpha?.settings || {};
    const isStats = alpha?.is || {};
    return {
        id: alpha.id,
        name: alpha.name ?? null,
        type: alpha.type ?? null,
        status: alpha.status ?? null,
        stage: alpha.stage ?? null,
        dateSubmitted: alpha.dateSubmitted ?? null,
        settings: {
            instrumentType: settings.instrumentType ?? null,
            region: settings.region ?? alpha.region ?? null,
            universe: settings.universe ?? alpha.universe ?? null,
            delay: settings.delay ?? alpha.delay ?? null,
        },
        classifications: (alpha.classifications || []).map((item) => (
            typeof item === 'string' ? item : { id: item?.id, name: item?.name }
        )).filter((item) => typeof item === 'string' || item.id),
        is: {
            sharpe: isStats.sharpe ?? null,
            returns: isStats.returns ?? null,
            turnover: isStats.turnover ?? null,
            fitness: isStats.fitness ?? null,
            margin: isStats.margin ?? null,
        },
        submitted: Boolean(alpha.submitted),
        noLongerSubmitted: Boolean(alpha.noLongerSubmitted),
        source: alpha.source || 'legacy',
        accountWqId: alpha.accountWqId || '',
        syncedAt: alpha.syncedAt ?? null,
        groupKey: alpha.groupKey ?? '',
    };
}

function compactPlatformRecord(record) {
    const compactStat = (stat) => stat ? {
        max: stat.max ?? null,
        min: stat.min ?? null,
        updated: stat.updated ?? null,
        source: stat.source ?? 'platform',
    } : null;
    return {
        alphaId: record.alphaId,
        prod: compactStat(record.prod),
        pool: compactStat(record.pool),
        self: compactStat(record.self),
        updatedAt: record.updatedAt ?? null,
    };
}

function compactStoreRecords(store, compact) {
    const request = store.openCursor();
    request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return;
        cursor.update(compact(cursor.value));
        cursor.continue();
    };
}

export function openProdMemoDatabase() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
        const request = indexedDB.open(PROD_MEMO_DB_NAME, PROD_MEMO_DB_VERSION);
        request.onupgradeneeded = () => {
            const db = request.result;
            const alphaStore = db.objectStoreNames.contains(PROD_MEMO_STORES.alphas)
                ? request.transaction.objectStore(PROD_MEMO_STORES.alphas)
                : db.createObjectStore(PROD_MEMO_STORES.alphas, { keyPath: 'id' });
            const pnlStore = db.objectStoreNames.contains(PROD_MEMO_STORES.pnls)
                ? request.transaction.objectStore(PROD_MEMO_STORES.pnls)
                : db.createObjectStore(PROD_MEMO_STORES.pnls, { keyPath: 'alphaId' });
            if (!pnlStore.indexNames.contains(PNL_FINGERPRINT_INDEX)) {
                pnlStore.createIndex(PNL_FINGERPRINT_INDEX, 'fingerprint', { unique: false });
            }
            const platformStore = db.objectStoreNames.contains(PROD_MEMO_STORES.platformCorrs)
                ? request.transaction.objectStore(PROD_MEMO_STORES.platformCorrs)
                : db.createObjectStore(PROD_MEMO_STORES.platformCorrs, { keyPath: 'alphaId' });
            if (!db.objectStoreNames.contains(PROD_MEMO_STORES.localCorrs)) {
                db.createObjectStore(PROD_MEMO_STORES.localCorrs, { keyPath: ['alphaId', 'corrType'] });
            }
            if (!db.objectStoreNames.contains(PROD_MEMO_STORES.syncMeta)) {
                db.createObjectStore(PROD_MEMO_STORES.syncMeta, { keyPath: 'key' });
            }
            if (!db.objectStoreNames.contains(PROD_MEMO_STORES.sharedRecords)) {
                db.createObjectStore(PROD_MEMO_STORES.sharedRecords, { keyPath: 'alias' });
            }
            if (!db.objectStoreNames.contains(PROD_MEMO_STORES.sharedMeta)) {
                db.createObjectStore(PROD_MEMO_STORES.sharedMeta, { keyPath: 'key' });
            }
            if (!db.objectStoreNames.contains(PROD_MEMO_STORES.shareKeys)) {
                db.createObjectStore(PROD_MEMO_STORES.shareKeys, { keyPath: 'key' });
            }
            if (request.oldVersion < 5) {
                compactStoreRecords(alphaStore, compactAlphaRecord);
                compactStoreRecords(platformStore, compactPlatformRecord);
            }
        };
        request.onsuccess = () => {
            const db = request.result;
            db.onversionchange = () => {
                db.close();
                dbPromise = null;
            };
            resolve(db);
        };
        request.onerror = () => {
            dbPromise = null;
            reject(request.error);
        };
    });
    return dbPromise;
}

function requestResult(request) {
    return new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

function transactionDone(transaction) {
    return new Promise((resolve, reject) => {
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error || new Error('ProdMemo IndexedDB transaction aborted'));
    });
}

export async function getAllRecords(storeName) {
    const db = await openProdMemoDatabase();
    const transaction = db.transaction(storeName, 'readonly');
    return requestResult(transaction.objectStore(storeName).getAll());
}

export async function getSharedSnapshotMetadata() {
    const db = await openProdMemoDatabase();
    const transaction = db.transaction(PROD_MEMO_STORES.sharedRecords, 'readonly');
    const request = transaction.objectStore(PROD_MEMO_STORES.sharedRecords).openCursor();
    return new Promise((resolve, reject) => {
        const records = [];
        request.onsuccess = () => {
            const cursor = request.result;
            if (!cursor) {
                resolve(records);
                return;
            }
            const value = cursor.value || {};
            records.push({
                alias: value.alias,
                sourceType: value.sourceType,
                groupKey: value.groupKey,
                prodCorr: value.prodCorr,
                classifications: value.classifications,
                updatedAt: value.updatedAt,
                fingerprint: value.fingerprint || '',
            });
            cursor.continue();
        };
        request.onerror = () => reject(request.error);
    });
}

export async function getRecord(storeName, key) {
    const db = await openProdMemoDatabase();
    const transaction = db.transaction(storeName, 'readonly');
    return requestResult(transaction.objectStore(storeName).get(key));
}

export async function getRecords(storeName, keys) {
    const uniqueKeys = [...new Set(keys || [])];
    if (!uniqueKeys.length) return [];
    const db = await openProdMemoDatabase();
    const transaction = db.transaction(storeName, 'readonly');
    const store = transaction.objectStore(storeName);
    const records = await Promise.all(uniqueKeys.map((key) => requestResult(store.get(key))));
    return records.filter(Boolean);
}

export async function putRecord(storeName, record) {
    const db = await openProdMemoDatabase();
    const transaction = db.transaction(storeName, 'readwrite');
    transaction.objectStore(storeName).put(record);
    await transactionDone(transaction);
    return record;
}

export async function putRecords(storeName, records) {
    if (!records.length) return { saved: 0 };
    const db = await openProdMemoDatabase();
    const transaction = db.transaction(storeName, 'readwrite');
    const store = transaction.objectStore(storeName);
    records.forEach((record) => store.put(record));
    await transactionDone(transaction);
    return { saved: records.length };
}

export async function deleteRecord(storeName, key) {
    const db = await openProdMemoDatabase();
    const transaction = db.transaction(storeName, 'readwrite');
    transaction.objectStore(storeName).delete(key);
    await transactionDone(transaction);
}

export async function clearStores(storeNames) {
    const db = await openProdMemoDatabase();
    const transaction = db.transaction(storeNames, 'readwrite');
    storeNames.forEach((storeName) => transaction.objectStore(storeName).clear());
    await transactionDone(transaction);
}

export async function getShareKey(key = 'default') {
    return getRecord(PROD_MEMO_STORES.shareKeys, key);
}

export async function putShareKey(record) {
    return putRecord(PROD_MEMO_STORES.shareKeys, record);
}

export async function replaceSharedSnapshot(records, meta = {}) {
    const db = await openProdMemoDatabase();
    const transaction = db.transaction([
        PROD_MEMO_STORES.sharedRecords,
        PROD_MEMO_STORES.sharedMeta,
    ], 'readwrite');
    transaction.objectStore(PROD_MEMO_STORES.sharedRecords).clear();
    const recordStore = transaction.objectStore(PROD_MEMO_STORES.sharedRecords);
    (records || []).forEach((record) => recordStore.put(record));
    const metaStore = transaction.objectStore(PROD_MEMO_STORES.sharedMeta);
    metaStore.clear();
    metaStore.put({
        key: 'active',
        ...meta,
        updatedAt: Date.now(),
    });
    await transactionDone(transaction);
    return { saved: records?.length || 0, meta };
}

export async function countRecords(storeName) {
    const db = await openProdMemoDatabase();
    const transaction = db.transaction(storeName, 'readonly');
    return requestResult(transaction.objectStore(storeName).count());
}

export async function getProdMemoSnapshot() {
    const db = await openProdMemoDatabase();
    const storeNames = Object.values(PROD_MEMO_STORES);
    const transaction = db.transaction(storeNames, 'readonly');
    const requests = storeNames.map((storeName) => requestResult(transaction.objectStore(storeName).getAll()));
    const values = await Promise.all(requests);
    return Object.fromEntries(storeNames.map((storeName, index) => [storeName, values[index]]));
}

function keyCursorEntries(request) {
    return new Promise((resolve, reject) => {
        const entries = [];
        request.onsuccess = () => {
            const cursor = request.result;
            if (!cursor) {
                resolve(entries);
                return;
            }
            entries.push({ alphaId: cursor.primaryKey, fingerprint: cursor.key });
            cursor.continue();
        };
        request.onerror = () => reject(request.error);
    });
}

export async function getProdMemoLightSnapshot() {
    const db = await openProdMemoDatabase();
    const storeNames = [
        PROD_MEMO_STORES.alphas,
        PROD_MEMO_STORES.pnls,
        PROD_MEMO_STORES.platformCorrs,
        PROD_MEMO_STORES.localCorrs,
        PROD_MEMO_STORES.syncMeta,
    ];
    const transaction = db.transaction(storeNames, 'readonly');
    const alphaRequest = requestResult(transaction.objectStore(PROD_MEMO_STORES.alphas).getAll());
    const pnlStore = transaction.objectStore(PROD_MEMO_STORES.pnls);
    const pnlIdsRequest = requestResult(pnlStore.getAllKeys());
    const pnlFingerprintsRequest = keyCursorEntries(pnlStore.index(PNL_FINGERPRINT_INDEX).openKeyCursor());
    const platformRequest = requestResult(transaction.objectStore(PROD_MEMO_STORES.platformCorrs).getAll());
    const localRequest = requestResult(transaction.objectStore(PROD_MEMO_STORES.localCorrs).getAll());
    const syncRequest = requestResult(transaction.objectStore(PROD_MEMO_STORES.syncMeta).getAll());
    const [alphas, pnlIds, pnlFingerprints, platformCorrs, localCorrs, syncMeta] = await Promise.all([
        alphaRequest,
        pnlIdsRequest,
        pnlFingerprintsRequest,
        platformRequest,
        localRequest,
        syncRequest,
    ]);
    return { alphas, pnlIds, pnlFingerprints, platformCorrs, localCorrs, syncMeta };
}

export async function deleteAlphaCorrRecords(alphaId) {
    const db = await openProdMemoDatabase();
    const transaction = db.transaction([
        PROD_MEMO_STORES.platformCorrs,
        PROD_MEMO_STORES.localCorrs,
    ], 'readwrite');
    transaction.objectStore(PROD_MEMO_STORES.platformCorrs).delete(alphaId);
    const localStore = transaction.objectStore(PROD_MEMO_STORES.localCorrs);
    for (const corrType of ['SELF', 'POOL', 'PROD_LOWER_BOUND']) {
        localStore.delete([alphaId, corrType]);
    }
    await transactionDone(transaction);
}

export async function markSubmittedSnapshot(alphaIds) {
    const keepIds = new Set(alphaIds || []);
    const records = await getAllRecords(PROD_MEMO_STORES.alphas);
    const db = await openProdMemoDatabase();
    const transaction = db.transaction(PROD_MEMO_STORES.alphas, 'readwrite');
    const store = transaction.objectStore(PROD_MEMO_STORES.alphas);
    let marked = 0;
    records.forEach((record) => {
        if (record.submitted && !keepIds.has(record.id)) {
            store.put({ ...record, submitted: false, noLongerSubmitted: true });
            marked += 1;
        }
    });
    await transactionDone(transaction);
    return { marked };
}
