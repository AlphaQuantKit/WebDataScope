import {
    PROD_MEMO_ALGORITHM_VERSION,
    alphaCorrelationGroupKey,
    alphaGroupKey,
    calculationFingerprint,
    calculateLocalCorrelation,
    calculateProdLowerBound,
    pnlFingerprint,
    selectCandidateAlphas,
    trimPnlToRecentYears,
} from './prodMemoCalculator.js';
import {
    PROD_MEMO_STORES,
    clearStores,
    deleteAlphaCorrRecords,
    getAllRecords,
    getProdMemoLightSnapshot,
    getRecord,
    getRecords,
    getSharedSnapshotMetadata,
    markSubmittedSnapshot,
    putRecord,
    putRecords,
    replaceSharedSnapshot,
} from './prodMemoDb.js';

const LEGACY_PREFIX = 'WQP_ProdMemo_';
const LEGACY_MIGRATION_KEY = 'WQP_ProdMemo_IndexedDB_Migration_v1';
const REVISION_KEY = 'WQP_ProdMemo_DB_Revision';
const SYNC_META_KEY = 'submitted';
const LAST_SHARE_UPLOAD_KEY = 'WQP_PNL_SHARE_LAST_UPLOAD';
// Keep shared PnL aligned with the local Corr calculation window.
const SHARE_PNL_YEARS = 4;

let migrationPromise = null;

function chromeGet(keys) {
    return new Promise((resolve, reject) => {
        chrome.storage.local.get(keys, (items) => {
            if (chrome.runtime.lastError) reject(chrome.runtime.lastError);
            else resolve(items || {});
        });
    });
}

function chromeSet(values) {
    return new Promise((resolve, reject) => {
        chrome.storage.local.set(values, () => {
            if (chrome.runtime.lastError) reject(chrome.runtime.lastError);
            else resolve();
        });
    });
}

async function bumpRevision(reason) {
    await chromeSet({
        [REVISION_KEY]: {
            updatedAt: Date.now(),
            nonce: Math.random().toString(36).slice(2),
            reason,
        },
    });
}

function normalizeAlphaId(value) {
    return String(value || '').trim();
}

function normalizeCorrelationType(value) {
    const text = String(value || 'prod').trim().toLowerCase();
    if (text.includes('self')) return 'self';
    if (text.includes('pool') || text.includes('parent') || text.includes('ppa')) return 'pool';
    return 'prod';
}

function finiteNumber(value) {
    if (value === null || value === undefined || value === '') return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
}

function localDateKey(value = Date.now()) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    const parts = new Intl.DateTimeFormat('en-CA', {
        year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(date);
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return `${values.year}-${values.month}-${values.day}`;
}

function submittedDateKey(value) {
    if (!value) return '';
    if (typeof value === 'string') {
        const dateOnly = value.trim().match(/^(\d{4}-\d{2}-\d{2})(?:$|T)/);
        if (dateOnly) return dateOnly[1];
    }
    const timestamp = typeof value === 'number' ? value : Date.parse(String(value));
    return Number.isFinite(timestamp) ? localDateKey(timestamp) : '';
}

export function normalizeShareClassifications(value) {
    return (Array.isArray(value) ? value : []).map((item) => {
        if (typeof item === 'string') return { id: item, name: item };
        if (!item || typeof item !== 'object' || !item.id) return null;
        return {
            id: String(item.id).trim(),
            name: item.name == null || String(item.name).trim() === ''
                ? String(item.id).trim()
                : String(item.name).trim(),
        };
    }).filter((item) => item?.id);
}

export function evaluateShareUploadEligibility({
    sync,
    submittedAlphas = [],
    pnlIds = [],
    accountWqId = '',
    lastUpload = null,
}) {
    const submitted = submittedAlphas.filter((alpha) => (
        alpha?.submitted
        && alpha.source === 'wq-sync'
        && (!accountWqId || alpha.accountWqId === accountWqId)
    ));
    const pnlIdSet = new Set(pnlIds);
    const submittedPnlCount = submitted.filter((alpha) => pnlIdSet.has(alpha.id)).length;
    const failedIds = Array.isArray(sync?.failedIds) ? sync.failedIds : [];
    const backfillFailedIds = Array.isArray(sync?.backfillFailedIds) ? sync.backfillFailedIds : [];
    const countsComplete = sync?.mode === 'incremental'
        && sync?.status === 'completed'
        && sync?.fullCompleted === true
        && Number(sync.remoteCount) === submitted.length
        && Number(sync.alphaCount) === submitted.length
        && Number(sync.submittedPnlCount) === submitted.length
        && submittedPnlCount === submitted.length
        && failedIds.length === 0
        && backfillFailedIds.length === 0;
    const latestSubmitted = submitted.reduce((latest, alpha) => {
        const raw = String(alpha.dateSubmitted || '').trim();
        const timestamp = Date.parse(raw);
        return Number.isFinite(timestamp) && timestamp > latest.timestamp
            ? { timestamp, raw }
            : latest;
    }, { timestamp: 0, raw: '' });
    const latestSubmittedDate = latestSubmitted.timestamp ? submittedDateKey(latestSubmitted.raw) : '';
    const syncAfterLastUpload = !Number(lastUpload?.syncAt)
        || Number(sync?.incrementalSyncedAt) > Number(lastUpload.syncAt);
    const countDetails = [
        `mode=${sync?.mode || '无'}`,
        `status=${sync?.status || '无'}`,
        `fullCompleted=${sync?.fullCompleted === true}`,
        `remote=${Number(sync?.remoteCount || 0)}`,
        `可上传Alpha=${submitted.length}`,
        `syncAlpha=${Number(sync?.alphaCount || 0)}`,
        `syncPnL=${Number(sync?.submittedPnlCount || 0)}`,
        `可上传PnL=${submittedPnlCount}`,
        `PnL失败=${failedIds.length}`,
        `回填失败=${backfillFailedIds.length}`,
    ].join('，');
    return {
        eligible: countsComplete && syncAfterLastUpload,
        countsComplete,
        syncAfterLastUpload,
        latestSubmittedDate,
        submitted,
        submittedPnlCount,
        failedIds,
        backfillFailedIds,
        reason: !countsComplete
            ? `请先完成完整的增量同步（Alpha 与 Submitted PnL 数量必须一致且无失败；${countDetails}）。`
            : !syncAfterLastUpload
                ? '本次增量同步没有晚于上次成功上传，请先完成新的增量同步。'
                : '',
    };
}

function extractCorrelationValues(data) {
    const rows = Array.isArray(data?.correlations) ? data.correlations
        : Array.isArray(data?.results) ? data.results
            : Array.isArray(data?.records) ? data.records
                : Array.isArray(data) ? data
                    : [];
    let correlationIndex = 5;
    const properties = data?.schema?.properties;
    if (Array.isArray(properties)) {
        const found = properties.findIndex((property) => property?.name === 'correlation');
        if (found >= 0) correlationIndex = found;
    }
    return rows.map((row) => {
        if (Array.isArray(row)) return finiteNumber(row[correlationIndex]);
        return finiteNumber(row?.correlation ?? row?.value ?? row?.score);
    }).filter((value) => value !== null);
}

export function extractPlatformCorrelationStats(data) {
    if (!data || typeof data !== 'object') return null;
    if (data.result && typeof data.result === 'object'
        && data.maximum === undefined && data.minimum === undefined
        && data.max === undefined && data.min === undefined) {
        return extractPlatformCorrelationStats(data.result);
    }
    const maximum = finiteNumber(data.maximum ?? data.max);
    const minimum = finiteNumber(data.minimum ?? data.min);
    if (maximum !== null || minimum !== null) {
        return {
            max: maximum,
            min: minimum,
        };
    }
    const values = extractCorrelationValues(data);
    if (!values.length) return null;
    return { max: Math.max(...values), min: Math.min(...values) };
}

function normalizePlatformStat(value, defaultUpdated = Date.now(), source = 'platform') {
    if (!value || typeof value !== 'object') return null;
    const rawResult = value.result && typeof value.result === 'object' ? value.result : value;
    const stats = extractPlatformCorrelationStats(rawResult);
    if (!stats || stats.max === null) return null;
    return {
        max: stats.max,
        min: stats.min,
        updated: Number(value.updated || value.timestamp || defaultUpdated) || defaultUpdated,
        source,
    };
}

function normalizeAlpha(alpha, submitted = true, accountWqId = '') {
    if (!alpha?.id) return null;
    const settings = alpha.settings || {};
    const isStats = alpha.is || {};
    const normalized = {
        id: normalizeAlphaId(alpha.id),
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
        submitted: submitted && alpha.status !== 'UNSUBMITTED' && Boolean(alpha.dateSubmitted),
        source: accountWqId ? 'wq-sync' : 'platform-refresh',
        accountWqId,
        syncedAt: Date.now(),
    };
    normalized.groupKey = alphaGroupKey(normalized);
    return normalized;
}

async function savePlatformRecord(alphaId, corrType, stat, options = {}) {
    const normalizedId = normalizeAlphaId(alphaId);
    const normalizedType = normalizeCorrelationType(corrType);
    if (!normalizedId || !stat) throw new Error('平台 Corr 数据无效。');
    const existing = await getRecord(PROD_MEMO_STORES.platformCorrs, normalizedId) || { alphaId: normalizedId };
    const record = {
        ...existing,
        [normalizedType]: stat,
        updatedAt: Date.now(),
    };
    await putRecord(PROD_MEMO_STORES.platformCorrs, record);
    if (options.bump !== false) await bumpRevision('platform-corr');
    return record;
}

async function ensureLegacyMigration() {
    if (migrationPromise) return migrationPromise;
    migrationPromise = (async () => {
        const markerResult = await chromeGet(LEGACY_MIGRATION_KEY);
        if (markerResult[LEGACY_MIGRATION_KEY]?.completed) {
            return markerResult[LEGACY_MIGRATION_KEY];
        }
        const all = await chromeGet(null);
        const legacyEntries = Object.entries(all).filter(([key, value]) => (
            key.startsWith(LEGACY_PREFIX)
            && key !== LEGACY_MIGRATION_KEY
            && key !== REVISION_KEY
            && value && typeof value === 'object'
        ));
        let migrated = 0;
        for (const [key, value] of legacyEntries) {
            const alphaId = normalizeAlphaId(key.slice(LEGACY_PREFIX.length));
            if (!alphaId) continue;
            for (const corrType of ['prod', 'pool', 'self']) {
                const stat = normalizePlatformStat(value[corrType], Date.now(), 'legacy-platform');
                if (!stat) continue;
                await savePlatformRecord(alphaId, corrType, stat, { bump: false });
                migrated += 1;
            }
        }
        const result = {
            completed: true,
            legacyCount: legacyEntries.length,
            migrated,
            migratedAt: Date.now(),
        };
        await chromeSet({ [LEGACY_MIGRATION_KEY]: result });
        if (migrated) await bumpRevision('legacy-migration');
        return result;
    })().catch((error) => {
        migrationPromise = null;
        throw error;
    });
    return migrationPromise;
}

function snapshotMaps(snapshot) {
    const alphaById = new Map(snapshot.alphas.map((record) => [record.id, record]));
    const fingerprintById = new Map((snapshot.pnlFingerprints || []).map((record) => (
        [record.alphaId, record.fingerprint]
    )));
    const pnlRecords = snapshot.pnls || (snapshot.pnlIds || []).map((alphaId) => ({
        alphaId,
        fingerprint: fingerprintById.get(alphaId) || '',
    }));
    return {
        alphaById,
        pnlById: new Map(pnlRecords.map((record) => [record.alphaId, record])),
        platformById: new Map(snapshot.platformCorrs.map((record) => [record.alphaId, record])),
        localByKey: new Map(snapshot.localCorrs.map((record) => [`${record.alphaId}|${record.corrType}`, record])),
    };
}

export function buildCalculationContext(snapshot, alphaId, corrType, maps = snapshotMaps(snapshot)) {
    const targetAlpha = maps.alphaById.get(alphaId);
    const targetPnl = maps.pnlById.get(alphaId);
    if (!targetAlpha || !targetPnl) return { maps, targetAlpha, targetPnl, candidates: [], references: [] };
    const candidates = corrType === 'PROD_LOWER_BOUND'
        ? []
        : selectCandidateAlphas(snapshot.alphas, maps.pnlById, targetAlpha, corrType);
    const targetGroup = alphaCorrelationGroupKey(targetAlpha);
    const references = corrType === 'PROD_LOWER_BOUND'
        ? snapshot.platformCorrs.map((platform) => {
            const alpha = maps.alphaById.get(platform.alphaId);
            return {
                alpha,
                platformProdMax: finiteNumber(platform.prod?.max),
                platformUpdated: platform.prod?.updated,
            };
        }).filter((reference) => (
            reference.alpha?.id
            && alphaCorrelationGroupKey(reference.alpha) === targetGroup
            && reference.platformProdMax !== null
            && maps.pnlById.has(reference.alpha.id)
        ))
        : [];
    return { maps, targetAlpha, targetPnl, candidates, references };
}

function currentFingerprint(snapshot, alphaId, corrType, maps = snapshotMaps(snapshot)) {
    const context = buildCalculationContext(snapshot, alphaId, corrType, maps);
    if (!context.targetAlpha || !context.targetPnl) return '';
    return calculationFingerprint({
        corrType,
        targetAlpha: context.targetAlpha,
        targetPnl: context.targetPnl,
        candidates: context.candidates,
        references: context.references,
        pnlById: context.maps.pnlById,
    });
}

function decorateLocalRecord(snapshot, record, maps = snapshotMaps(snapshot)) {
    const fingerprint = currentFingerprint(snapshot, record.alphaId, record.corrType, maps);
    const stale = record.algorithmVersion !== PROD_MEMO_ALGORITHM_VERSION
        || !fingerprint
        || fingerprint !== record.inputFingerprint;
    return { ...record, stale };
}

export function resolvePreferredCorrelation(platformStat, localRecord, options = {}) {
    const platformMax = finiteNumber(platformStat?.max);
    if (platformMax !== null) {
        return {
            max: platformMax,
            min: finiteNumber(platformStat?.min),
            updated: platformStat.updated,
            source: 'platform',
            icon: 'Ⓟ',
            lowerBound: false,
        };
    }
    const localMax = localRecord && !localRecord.stale && localRecord.result?.available
        ? finiteNumber(localRecord.result.max)
        : null;
    if (localMax === null) return null;
    return {
        max: localMax,
        min: finiteNumber(localRecord.result.min),
        updated: localRecord.calculatedAt,
        source: 'local',
        icon: 'Ⓛ',
        lowerBound: options.lowerBound === true,
    };
}

function formatResolvedMetric(metric) {
    if (!metric) return '';
    const prefix = metric.lowerBound ? '≥' : '';
    return `${prefix}${Number(metric.max).toFixed(4)} ${metric.icon}`;
}

function publicPlatformStat(stat) {
    if (!stat) return null;
    return {
        max: finiteNumber(stat.max),
        min: finiteNumber(stat.min),
        updated: stat.updated,
        source: stat.source,
    };
}

function publicPlatformRecord(platform) {
    if (!platform) return null;
    return {
        alphaId: platform.alphaId,
        updatedAt: platform.updatedAt,
        self: publicPlatformStat(platform.self),
        pool: publicPlatformStat(platform.pool),
        prod: publicPlatformStat(platform.prod),
    };
}

function publicAlphaRecord(alpha) {
    if (!alpha) return null;
    return {
        id: alpha.id,
        groupKey: alpha.groupKey,
        submitted: Boolean(alpha.submitted),
    };
}

async function buildResolvedEntries(alphaIds = null) {
    await ensureLegacyMigration();
    // The list view only needs PnL fingerprints to determine whether local
    // Corr records are stale. Loading every PnL point here blocks the sidebar
    // for large accounts; full PnL is loaded only when a calculation runs.
    const snapshot = await getCalculationSnapshot({ fullPnl: false });
    const maps = snapshotMaps(snapshot);
    const requested = alphaIds ? new Set(alphaIds.map(normalizeAlphaId)) : null;
    const ids = new Set([
        ...snapshot.platformCorrs.map((record) => record.alphaId),
        ...snapshot.localCorrs.map((record) => record.alphaId),
    ]);
    const result = {};
    for (const alphaId of ids) {
        if (requested && !requested.has(alphaId)) continue;
        const platform = maps.platformById.get(alphaId) || null;
        const selfLocal = maps.localByKey.get(`${alphaId}|SELF`);
        const poolLocal = maps.localByKey.get(`${alphaId}|POOL`);
        const prodLocal = maps.localByKey.get(`${alphaId}|PROD_LOWER_BOUND`);
        const decoratedSelf = selfLocal ? decorateLocalRecord(snapshot, selfLocal, maps) : null;
        const decoratedPool = poolLocal ? decorateLocalRecord(snapshot, poolLocal, maps) : null;
        const decoratedProd = prodLocal ? decorateLocalRecord(snapshot, prodLocal, maps) : null;
        const resolved = {
            prod: resolvePreferredCorrelation(platform?.prod, decoratedProd, { lowerBound: true }),
            pool: resolvePreferredCorrelation(platform?.pool, decoratedPool),
            self: resolvePreferredCorrelation(platform?.self, decoratedSelf),
        };
        result[alphaId] = {
            alphaId,
            alpha: publicAlphaRecord(maps.alphaById.get(alphaId)),
            platform: publicPlatformRecord(platform),
            local: {
                self: decoratedSelf,
                pool: decoratedPool,
                prodLowerBound: decoratedProd,
            },
            resolved,
            display: {
                prod: formatResolvedMetric(resolved.prod),
                pool: formatResolvedMetric(resolved.pool),
                self: formatResolvedMetric(resolved.self),
            },
        };
    }
    return { snapshot, entries: result };
}

export async function saveSubmittedAlphaBatch(alphas, submitted = true, options = {}) {
    await ensureLegacyMigration();
    const existing = new Map((await getAllRecords(PROD_MEMO_STORES.alphas)).map((record) => [record.id, record]));
    const records = (alphas || []).map((alpha) => (
        normalizeAlpha(alpha, submitted, String(options.accountWqId || '').trim())
    )).filter(Boolean).map((record) => ({
        ...record,
        submitted: existing.get(record.id)?.submitted || record.submitted,
        noLongerSubmitted: false,
    }));
    const result = await putRecords(PROD_MEMO_STORES.alphas, records);
    if (records.length && options.bump !== false) await bumpRevision('alphas');
    return result;
}

export async function saveAlphaPnl(alphaId, data, options = {}) {
    await ensureLegacyMigration();
    const normalizedId = normalizeAlphaId(alphaId);
    if (!normalizedId || !Array.isArray(data?.records)) throw new Error('PnL 数据无效。');
    const fingerprint = pnlFingerprint(data);
    const accountWqId = String(options.accountWqId || '').trim();
    const existing = await getRecord(PROD_MEMO_STORES.pnls, normalizedId);
    if (existing?.fingerprint === fingerprint) {
        // A same-content PnL can still be a fresh verification from the
        // current WQ session. Older records were stored without ownership
        // metadata, so returning early here left them ineligible for upload
        // forever even after a successful re-fetch.
        const metadataChanged = Boolean(accountWqId)
            && (existing.source !== 'wq-sync' || existing.accountWqId !== accountWqId);
        if (!metadataChanged) {
            return { saved: data.records.length, fingerprint, unchanged: true };
        }
        const refreshed = {
            ...existing,
            source: 'wq-sync',
            accountWqId,
            fetchedAt: Date.now(),
            fingerprint,
        };
        await putRecord(PROD_MEMO_STORES.pnls, refreshed);
        if (options.bump !== false) await bumpRevision('pnl');
        return {
            saved: data.records.length,
            fingerprint,
            unchanged: true,
            metadataUpdated: true,
        };
    }
    const record = {
        ...data,
        alphaId: normalizedId,
        source: accountWqId ? 'wq-sync' : 'platform-refresh',
        accountWqId,
        fetchedAt: Date.now(),
        fingerprint,
    };
    await putRecord(PROD_MEMO_STORES.pnls, record);
    if (options.bump !== false) await bumpRevision('pnl');
    return { saved: data.records.length, fingerprint: record.fingerprint };
}

export async function savePlatformCorrelation(alphaId, corrType, data) {
    await ensureLegacyMigration();
    const stat = normalizePlatformStat({ result: data, timestamp: Date.now() });
    if (!stat) throw new Error('平台 Corr 响应中没有有效的最大值。');
    return savePlatformRecord(alphaId, corrType, stat);
}

export async function calculateLocalCorrs(alphaId) {
    await ensureLegacyMigration();
    const normalizedId = normalizeAlphaId(alphaId);
    const corrTypes = ['SELF', 'POOL', 'PROD_LOWER_BOUND'];
    const lightSnapshot = await getCalculationSnapshot({ fullPnl: false });
    const lightMaps = snapshotMaps(lightSnapshot);
    if (!lightMaps.alphaById.has(normalizedId)) throw new Error(`缺少目标 Alpha 元数据：${normalizedId}`);
    if (!lightMaps.pnlById.has(normalizedId)) throw new Error(`缺少目标 Alpha PnL：${normalizedId}`);

    const descriptors = corrTypes.map((corrType) => {
        const context = buildCalculationContext(lightSnapshot, normalizedId, corrType, lightMaps);
        const inputFingerprint = calculationFingerprint({
            corrType,
            targetAlpha: context.targetAlpha,
            targetPnl: context.targetPnl,
            candidates: context.candidates,
            references: context.references,
            pnlById: context.maps.pnlById,
        });
        const existing = lightMaps.localByKey.get(`${normalizedId}|${corrType}`) || null;
        const fresh = existing?.algorithmVersion === PROD_MEMO_ALGORITHM_VERSION
            && existing.inputFingerprint === inputFingerprint;
        return { corrType, context, inputFingerprint, existing, fresh };
    });

    const staleDescriptors = descriptors.filter((descriptor) => !descriptor.fresh);
    if (!staleDescriptors.length) {
        return Object.fromEntries(descriptors.map(({ corrType, existing }) => (
            [corrType, { ...existing, stale: false, reused: true }]
        )));
    }

    const requiredPnlIds = new Set([normalizedId]);
    staleDescriptors.forEach(({ context }) => {
        context.candidates.forEach((alpha) => requiredPnlIds.add(alpha.id));
        context.references.forEach((reference) => requiredPnlIds.add(reference.alpha.id));
    });
    const requiredIds = [...requiredPnlIds];
    const [personalPnls, sharedRecords] = await Promise.all([
        getRecords(PROD_MEMO_STORES.pnls, requiredIds),
        getRecords(PROD_MEMO_STORES.sharedRecords, requiredIds),
    ]);
    const pnls = [
        ...personalPnls,
        ...sharedRecordsToCalculationPnls(sharedRecords),
    ];
    const snapshot = { ...lightSnapshot, pnls };
    const maps = snapshotMaps(snapshot);
    const changedRecords = [];
    const outputRecords = [];

    for (const descriptor of descriptors) {
        const { corrType, existing, fresh } = descriptor;
        if (fresh) {
            outputRecords.push({ ...existing, stale: false, reused: true });
            continue;
        }
        const context = buildCalculationContext(snapshot, normalizedId, corrType, maps);
        if (!context.targetPnl) throw new Error(`缺少目标 Alpha PnL：${normalizedId}`);
        const inputFingerprint = calculationFingerprint({
            corrType,
            targetAlpha: context.targetAlpha,
            targetPnl: context.targetPnl,
            candidates: context.candidates,
            references: context.references,
            pnlById: context.maps.pnlById,
        });
        const result = corrType === 'PROD_LOWER_BOUND'
            ? calculateProdLowerBound({
                targetAlpha: context.targetAlpha,
                targetPnl: context.targetPnl,
                references: context.references,
                pnlById: context.maps.pnlById,
            })
            : calculateLocalCorrelation({
                targetAlpha: context.targetAlpha,
                targetPnl: context.targetPnl,
                candidates: context.candidates,
                pnlById: context.maps.pnlById,
                corrType,
            });
        const record = {
            alphaId: normalizedId,
            corrType,
            groupKey: alphaCorrelationGroupKey(context.targetAlpha),
            result,
            calculatedAt: Date.now(),
            algorithmVersion: PROD_MEMO_ALGORITHM_VERSION,
            inputFingerprint,
        };
        changedRecords.push(record);
        outputRecords.push({ ...record, stale: false, reused: false });
    }
    if (changedRecords.length) {
        await putRecords(PROD_MEMO_STORES.localCorrs, changedRecords);
        await bumpRevision('local-corr');
    }
    return Object.fromEntries(outputRecords.map((record) => [record.corrType, record]));
}

export async function getProdMemoDetail(alphaId) {
    const normalizedId = normalizeAlphaId(alphaId);
    const { snapshot, entries } = await buildResolvedEntries([normalizedId]);
    const latestSubmittedAt = snapshot.alphas.reduce((latest, alpha) => {
        if (!alpha.submitted || !alpha.dateSubmitted) return latest;
        return !latest || Date.parse(alpha.dateSubmitted) > Date.parse(latest)
            ? alpha.dateSubmitted
            : latest;
    }, '');
    const detail = entries[normalizedId] || {
        alphaId: normalizedId,
        alpha: null,
        platform: null,
        local: { self: null, pool: null, prodLowerBound: null },
        resolved: { prod: null, pool: null, self: null },
        display: { prod: '', pool: '', self: '' },
    };
    return { ...detail, latestSubmittedAt };
}

export async function getResolvedProdMemoCache(alphaIds = null) {
    const { entries } = await buildResolvedEntries(alphaIds);
    const memoData = {};
    Object.entries(entries).forEach(([alphaId, entry]) => {
        memoData[alphaId] = {
            prod: entry.resolved.prod ? { ...entry.resolved.prod, display: entry.display.prod } : null,
            pool: entry.resolved.pool ? { ...entry.resolved.pool, display: entry.display.pool } : null,
            self: entry.resolved.self ? { ...entry.resolved.self, display: entry.display.self } : null,
        };
    });
    return { count: Object.keys(memoData).length, memoData };
}

function statsFromSnapshot(snapshot) {
    const maps = snapshotMaps(snapshot);
    const submittedAlphas = snapshot.alphas.filter((alpha) => alpha.submitted);
    const submittedAlphaIds = new Set(submittedAlphas.map((alpha) => alpha.id));
    const pnlIds = snapshot.pnlIds || snapshot.pnls.map((pnl) => pnl.alphaId);
    const submittedPnlCount = pnlIds.filter((alphaId) => submittedAlphaIds.has(alphaId)).length;
    const validReferenceCount = snapshot.platformCorrs.filter((platform) => (
        finiteNumber(platform.prod?.max) !== null
        && maps.alphaById.has(platform.alphaId)
        && maps.pnlById.has(platform.alphaId)
    )).length;
    const sync = snapshot.syncMeta.find((record) => record.key === SYNC_META_KEY) || null;
    return {
        submittedAlphaCount: submittedAlphas.length,
        submittedPnlCount,
        pnlCount: pnlIds.length,
        platformCorrCount: snapshot.platformCorrs.length,
        localCorrCount: snapshot.localCorrs.length,
        validReferenceCount,
        sync,
    };
}

export async function getProdMemoStats() {
    await ensureLegacyMigration();
    return statsFromSnapshot(await getProdMemoLightSnapshot());
}

export async function getShareUploadSnapshot() {
    await ensureLegacyMigration();
    const snapshot = await getProdMemoLightSnapshot();
    const pnlRecords = await getAllRecords(PROD_MEMO_STORES.pnls);
    const lastUpload = (await chromeGet(LAST_SHARE_UPLOAD_KEY))[LAST_SHARE_UPLOAD_KEY] || null;
    const sync = snapshot.syncMeta.find((record) => record.key === SYNC_META_KEY) || null;
    const accountWqId = String(sync?.accountWqId || '').trim();
    const pnlById = new Map(pnlRecords
        .filter((record) => record.source === 'wq-sync' && record.accountWqId === accountWqId)
        .map((record) => [record.alphaId, record]));
    const eligibility = evaluateShareUploadEligibility({
        sync,
        submittedAlphas: snapshot.alphas,
        pnlIds: [...pnlById.keys()],
        accountWqId,
        lastUpload,
    });
    const submitted = eligibility.submitted;
    const { latestSubmittedDate, failedIds, backfillFailedIds } = eligibility;

    const records = [];
    const seen = new Set();
    for (const alpha of submitted) {
        const pnl = pnlById.get(alpha.id);
        const normalizedPnl = trimPnlToRecentYears(pnl, SHARE_PNL_YEARS);
        if (!alpha.groupKey || !normalizedPnl.length) continue;
        records.push({
            alphaId: alpha.id,
            sourceType: 'submitted',
            groupKey: alpha.groupKey,
            prodCorr: 1,
            classifications: normalizeShareClassifications(alpha.classifications),
            pnl: { records: normalizedPnl },
        });
        seen.add(alpha.id);
    }

    for (const platform of snapshot.platformCorrs) {
        const alpha = snapshot.alphas.find((item) => item.id === platform.alphaId);
        const pnl = pnlById.get(platform.alphaId);
        const prodCorr = finiteNumber(platform.prod?.max);
        const normalizedPnl = trimPnlToRecentYears(pnl, SHARE_PNL_YEARS);
        if (seen.has(platform.alphaId) || !alpha?.groupKey || prodCorr === null || !normalizedPnl.length) continue;
        records.push({
            alphaId: alpha.id,
            sourceType: 'prod',
            groupKey: alpha.groupKey,
            prodCorr,
            classifications: normalizeShareClassifications(alpha.classifications),
            pnl: { records: normalizedPnl },
        });
        seen.add(alpha.id);
    }

    const accountMatched = Boolean(sync?.accountWqId);
    const eligible = Boolean(eligibility.eligible && accountMatched && records.length >= submitted.length);
    return {
        eligible,
        reason: eligibility.reason || (!accountMatched
            ? '本次增量同步没有记录当前 WQ ID，请重新同步后再上传。'
            : records.length < submitted.length
                    ? '存在缺少 groupKey 或 PnL 的 Alpha，无法上传完整快照。'
                    : ''),
        records,
        manifest: {
            mode: sync?.mode || '',
            status: sync?.status || '',
            remoteCount: Number(sync?.remoteCount || 0),
            alphaCount: submitted.length,
            submittedPnlCount: Number(sync?.submittedPnlCount || 0),
            submittedDate: latestSubmittedDate,
            incrementalSyncedAt: Number(sync?.incrementalSyncedAt || 0),
            accountWqId: sync?.accountWqId || '',
            failedIds,
            backfillFailedIds,
        },
    };
}

async function getCalculationSnapshot({ fullPnl = true } = {}) {
    const base = await getProdMemoLightSnapshot();
    const personalPnlRecords = fullPnl
        ? getAllRecords(PROD_MEMO_STORES.pnls)
        : (base.pnlFingerprints || []).map((record) => ({
            alphaId: record.alphaId,
            fingerprint: record.fingerprint || '',
        }));
    const [personalPnls, sharedRecords] = await Promise.all([
        Promise.resolve(personalPnlRecords),
        getSharedSnapshotRecords({ fullPnl }),
    ]);
    const sharedAlphas = sharedRecords.map((record) => {
        const [region = '', universe = '', rawDelay = 'D1'] = String(record.groupKey || '').split('|');
        const delay = Number(String(rawDelay).replace(/^D/i, ''));
        return {
        id: record.alias,
        name: record.alias,
        groupKey: record.groupKey,
        settings: { region, universe, delay },
        classifications: record.classifications || [],
        submitted: false,
        shared: true,
        source: 'shared',
        };
    });
    const sharedPlatforms = sharedRecords.map((record) => ({
        alphaId: record.alias,
        prod: {
            max: finiteNumber(record.prodCorr),
            min: finiteNumber(record.prodCorr),
            updated: record.updatedAt,
            source: 'shared',
        },
        updatedAt: record.updatedAt,
        shared: true,
    }));
    const sharedPnls = sharedRecordsToCalculationPnls(sharedRecords);
    return {
        ...base,
        alphas: [...base.alphas, ...sharedAlphas],
        pnls: [...personalPnls, ...sharedPnls],
        pnlIds: [...base.pnlIds, ...sharedPnls.map((record) => record.alphaId)],
        platformCorrs: [...base.platformCorrs, ...sharedPlatforms],
    };
}

export function sharedRecordsToCalculationPnls(records) {
    return (records || []).map((record) => ({
        alphaId: record.alias,
        records: Array.isArray(record.pnl?.records) ? record.pnl.records : [],
        fingerprint: record.fingerprint || '',
        source: 'shared',
    }));
}

export async function getSharedSnapshotMeta() {
    return getRecord(PROD_MEMO_STORES.sharedMeta, 'active');
}

export async function getSharedSnapshotRecords({ fullPnl = true } = {}) {
    if (!fullPnl) {
        const metadata = await getSharedSnapshotMetadata();
        if (metadata.every((record) => record.fingerprint)) {
            return metadata.map((record) => ({ ...record, pnl: { records: [] } }));
        }
    }
    const records = await getAllRecords(PROD_MEMO_STORES.sharedRecords);
    if (fullPnl) return records;
    return records.map((record) => ({
        ...record,
        pnl: { records: [] },
        fingerprint: record.fingerprint || pnlFingerprint(record.pnl),
    }));
}

export async function saveSharedSnapshot(records, meta = {}) {
    const normalized = (records || []).filter((record) => (
        record && typeof record.alias === 'string' && Array.isArray(record.pnl?.records)
    )).map((record) => ({
        ...record,
        fingerprint: record.fingerprint || pnlFingerprint(record.pnl),
    }));
    return replaceSharedSnapshot(normalized, meta);
}

export async function getProdMemoCache() {
    const { snapshot, entries } = await buildResolvedEntries();
    return {
        count: Object.keys(entries).length,
        memoData: entries,
        stats: statsFromSnapshot(snapshot),
    };
}

export async function getIncrementalSyncState(accountWqId = '') {
    await ensureLegacyMigration();
    const snapshot = await getProdMemoLightSnapshot();
    const owner = String(accountWqId || '').trim();
    const pnlRecords = await getAllRecords(PROD_MEMO_STORES.pnls);
    const pnlIds = new Set(pnlRecords.filter((record) => (
        record.source === 'wq-sync' && owner && record.accountWqId === owner
    )).map((record) => record.alphaId));
    const alphaIds = snapshot.alphas.filter((alpha) => (
        alpha.submitted
        && alpha.source === 'wq-sync'
        && owner
        && alpha.accountWqId === owner
        && alpha.groupKey
    )).map((alpha) => alpha.id);
    const platformProdIds = snapshot.platformCorrs
        .filter((record) => finiteNumber(record.prod?.max) !== null)
        .map((record) => record.alphaId);
    const alphaIdsAll = new Set(snapshot.alphas.filter((record) => (
        record.source === 'wq-sync'
        && owner
        && record.accountWqId === owner
        && record.groupKey
    )).map((record) => record.id));
    return {
        alphaIds,
        missingPnlIds: alphaIds.filter((alphaId) => !pnlIds.has(alphaId)),
        backfillIds: platformProdIds.filter((alphaId) => !alphaIdsAll.has(alphaId) || !pnlIds.has(alphaId)),
        sync: snapshot.syncMeta.find((record) => record.key === SYNC_META_KEY) || null,
    };
}

export async function setProdMemoSyncMeta(patch) {
    await ensureLegacyMigration();
    const existing = await getRecord(PROD_MEMO_STORES.syncMeta, SYNC_META_KEY) || { key: SYNC_META_KEY };
    const record = { ...existing, ...patch, key: SYNC_META_KEY, updatedAt: Date.now() };
    await putRecord(PROD_MEMO_STORES.syncMeta, record);
    await bumpRevision('sync-meta');
    return record;
}

export async function reconcileSubmittedAlphas(alphaIds) {
    await ensureLegacyMigration();
    const result = await markSubmittedSnapshot(alphaIds.map(normalizeAlphaId));
    await bumpRevision('reconcile');
    return result;
}

export async function exportProdMemoCache() {
    await ensureLegacyMigration();
    const snapshot = await getProdMemoLightSnapshot();
    return {
        schemaVersion: 2,
        exportedAt: new Date().toISOString(),
        platformCorrs: Object.fromEntries(snapshot.platformCorrs.map((record) => [record.alphaId, record])),
        localCorrs: snapshot.localCorrs,
    };
}

export async function importProdMemoCache(importedData) {
    await ensureLegacyMigration();
    if (!importedData || typeof importedData !== 'object' || Array.isArray(importedData)) {
        throw new Error('ProdMemo 导入文件必须是 JSON 对象。');
    }
    let importedPlatform = 0;
    let importedLocal = 0;
    let skipped = 0;

    if (Number(importedData.schemaVersion) === 2) {
        for (const [rawAlphaId, value] of Object.entries(importedData.platformCorrs || {})) {
            const alphaId = normalizeAlphaId(rawAlphaId);
            if (!alphaId || !value || typeof value !== 'object') {
                skipped += 1;
                continue;
            }
            for (const corrType of ['prod', 'pool', 'self']) {
                const stat = normalizePlatformStat(value[corrType], Date.now(), value[corrType]?.source || 'imported-platform');
                if (!stat) continue;
                await savePlatformRecord(alphaId, corrType, stat, { bump: false });
                importedPlatform += 1;
            }
        }
        const localRecords = (importedData.localCorrs || []).filter((record) => (
            record?.alphaId && ['SELF', 'POOL', 'PROD_LOWER_BOUND'].includes(record.corrType)
        ));
        await putRecords(PROD_MEMO_STORES.localCorrs, localRecords);
        importedLocal = localRecords.length;
    } else {
        for (const [rawAlphaId, value] of Object.entries(importedData)) {
            const alphaId = normalizeAlphaId(rawAlphaId.replace(/^WQP_ProdMemo_/, ''));
            if (!alphaId || !value || typeof value !== 'object') {
                skipped += 1;
                continue;
            }
            if (value.timestamp && value.result) {
                const stat = normalizePlatformStat(value, Date.now(), 'imported-platform');
                if (stat) {
                    await savePlatformRecord(alphaId, 'prod', stat, { bump: false });
                    importedPlatform += 1;
                } else skipped += 1;
                continue;
            }
            let found = false;
            for (const corrType of ['prod', 'pool', 'self']) {
                const stat = normalizePlatformStat(value[corrType], Date.now(), 'legacy-platform');
                if (!stat) continue;
                await savePlatformRecord(alphaId, corrType, stat, { bump: false });
                importedPlatform += 1;
                found = true;
            }
            if (!found) skipped += 1;
        }
    }
    await bumpRevision('import');
    return { imported: importedPlatform + importedLocal, importedPlatform, importedLocal, skipped };
}

export async function clearProdMemoCache() {
    await ensureLegacyMigration();
    const before = await getProdMemoStats();
    await clearStores([PROD_MEMO_STORES.platformCorrs, PROD_MEMO_STORES.localCorrs]);
    await bumpRevision('clear-corr');
    return { cleared: before.platformCorrCount + before.localCorrCount, count: 0 };
}

export async function clearProdMemoSyncData() {
    await ensureLegacyMigration();
    const before = await getProdMemoStats();
    await clearStores([
        PROD_MEMO_STORES.alphas,
        PROD_MEMO_STORES.pnls,
        PROD_MEMO_STORES.syncMeta,
    ]);
    await bumpRevision('clear-sync');
    return { cleared: before.submittedAlphaCount + before.pnlCount };
}

export async function deleteProdMemoCache(alphaId) {
    await ensureLegacyMigration();
    const normalizedId = normalizeAlphaId(alphaId);
    if (!normalizedId) throw new Error('Alpha ID 不能为空。');
    const beforePlatform = await getRecord(PROD_MEMO_STORES.platformCorrs, normalizedId);
    const beforeLocal = (await getAllRecords(PROD_MEMO_STORES.localCorrs))
        .filter((record) => record.alphaId === normalizedId).length;
    await deleteAlphaCorrRecords(normalizedId);
    await bumpRevision('delete-corr');
    return { alphaId: normalizedId, deleted: (beforePlatform ? 1 : 0) + beforeLocal };
}

export async function runProdMemoAction(action, payload = {}) {
    switch (action) {
        case 'SAVE_ALPHA_BATCH':
            return saveSubmittedAlphaBatch(payload.alphas || [], payload.submitted !== false, {
                bump: !payload.silent,
                accountWqId: payload.accountWqId,
            });
        case 'SAVE_PNL':
            return saveAlphaPnl(payload.alphaId, payload.data, {
                bump: !payload.silent,
                accountWqId: payload.accountWqId,
            });
        case 'SAVE_PLATFORM_CORR':
            return savePlatformCorrelation(payload.alphaId, payload.corrType, payload.data);
        case 'RECONCILE_ALPHAS':
            return reconcileSubmittedAlphas(payload.alphaIds || []);
        case 'GET_SYNC_STATE':
            return getIncrementalSyncState(payload.accountWqId);
        case 'SET_SYNC_META':
            return setProdMemoSyncMeta(payload.patch || {});
        case 'GET_STATS':
            return getProdMemoStats();
        case 'GET_SHARE_UPLOAD_SNAPSHOT':
            return getShareUploadSnapshot();
        case 'GET_SHARED_SNAPSHOT_META':
            return getSharedSnapshotMeta();
        case 'GET_SHARED_SNAPSHOT_RECORDS':
            return getSharedSnapshotRecords();
        case 'SAVE_SHARED_SNAPSHOT':
            return saveSharedSnapshot(payload.records || [], payload.meta || {});
        case 'GET_DETAIL':
            return getProdMemoDetail(payload.alphaId);
        case 'GET_RESOLVED_CACHE':
            return getResolvedProdMemoCache(payload.alphaIds || null);
        case 'CALCULATE_LOCAL':
            return calculateLocalCorrs(payload.alphaId);
        case 'CLEAR_CORRS':
            return clearProdMemoCache();
        case 'CLEAR_SYNC_DATA':
            return clearProdMemoSyncData();
        default:
            throw new Error(`未知的 ProdMemo 操作：${action}`);
    }
}
