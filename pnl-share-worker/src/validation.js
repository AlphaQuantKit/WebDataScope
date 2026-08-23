import { RequestValidationError } from './errors.js';

export const MAX_PART_BYTES = 2 * 1024 * 1024;
export const MAX_UPLOAD_BYTES = 256 * 1024 * 1024;
export const MAX_RECORDS = 10_000;
export const MAX_PNL_POINTS = 20_000;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH_PATTERN = /^[0-9a-f]{64}$/;

export function requireObject(value, message = 'Body must be an object.') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new RequestValidationError(message);
    return value;
}

export function requireTrimmedString(value, field, maxLength = 256) {
    if (typeof value !== 'string' || value !== value.trim() || value.length === 0 || value.length > maxLength) {
        throw new RequestValidationError(`${field} must be a trimmed string up to ${maxLength} characters.`);
    }
    return value;
}

function rejectControlCharacters(value, field) {
    if (/[\u0000-\u001f\u007f]/.test(value)) throw new RequestValidationError(`${field} contains control characters.`);
    return value;
}

export function validateInstallationId(value) {
    const installationId = requireTrimmedString(value, 'installationId', 36).toLowerCase();
    if (!UUID_PATTERN.test(installationId)) throw new RequestValidationError('Invalid installationId.');
    return installationId;
}

export function validateSha256(value, field = 'sha256') {
    const digest = requireTrimmedString(value, field, 64).toLowerCase();
    if (!HASH_PATTERN.test(digest)) throw new RequestValidationError(`Invalid ${field}.`);
    return digest;
}

export function validateGroupKey(value) {
    const groupKey = requireTrimmedString(value, 'groupKey', 160);
    const parts = groupKey.split('|');
    if (parts.length !== 3 || parts.some((part) => !part || /[\u0000-\u001f\u007f]/.test(part))) {
        throw new RequestValidationError('groupKey must be region|universe|delay.');
    }
    return groupKey;
}

function validatePnl(value) {
    requireObject(value, 'pnl must be an object.');
    if (!Array.isArray(value.records) || value.records.length < 2 || value.records.length > MAX_PNL_POINTS) {
        throw new RequestValidationError(`pnl.records must contain 2-${MAX_PNL_POINTS} records.`);
    }
    let previous = '';
    const records = value.records.map((row) => {
        if (!Array.isArray(row) || row.length < 2 || typeof row[0] !== 'string') {
            throw new RequestValidationError('Invalid PnL record.');
        }
        const date = row[0].slice(0, 10);
        const numeric = Number(row[1]);
        const parsedDate = new Date(`${date}T00:00:00Z`);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)
            || !Number.isFinite(parsedDate.getTime())
            || parsedDate.toISOString().slice(0, 10) !== date
            || date <= previous
            || !Number.isFinite(numeric)) {
            throw new RequestValidationError('PnL dates must be ascending and values finite.');
        }
        previous = date;
        return [date, numeric];
    });
    return records;
}

function validateClassifications(value) {
    if (!Array.isArray(value) || value.length > 32) throw new RequestValidationError('Invalid classifications.');
    return value.map((item) => {
        requireObject(item, 'Classification must be an object.');
        const id = requireTrimmedString(item.id, 'classification.id', 160);
        return {
            id,
            name: item.name == null || String(item.name).trim() === ''
                ? id
                : requireTrimmedString(String(item.name), 'classification.name', 240),
        };
    });
}

export function validateShareRecord(value) {
    requireObject(value, 'Upload record must be an object.');
    const alphaId = rejectControlCharacters(requireTrimmedString(value.alphaId, 'alphaId', 128), 'alphaId');
    const sourceType = value.sourceType === 'submitted' || value.sourceType === 'prod'
        ? value.sourceType : null;
    if (!sourceType) throw new RequestValidationError('sourceType must be submitted or prod.');
    const groupKey = validateGroupKey(value.groupKey);
    const prodCorr = Number(value.prodCorr);
    if (!Number.isFinite(prodCorr) || prodCorr < -1 || prodCorr > 1) throw new RequestValidationError('Invalid prodCorr.');
    const classifications = validateClassifications(value.classifications || []);
    const pnl = validatePnl(value.pnl);
    return {
        alphaId,
        sourceType,
        groupKey,
        prodCorr: sourceType === 'submitted' ? 1 : prodCorr,
        classifications,
        pnl: { records: pnl },
    };
}

export function validateManifest(value) {
    requireObject(value, 'Manifest must be an object.');
    const allowed = new Set([
        'schemaVersion', 'wqId', 'mode', 'status', 'remoteCount', 'alphaCount',
        'submittedPnlCount', 'submittedDate', 'incrementalSyncedAt',
        'failedIds', 'backfillFailedIds', 'recordCount', 'partCount', 'payloadSha256',
    ]);
    Object.keys(value).forEach((key) => {
        if (!allowed.has(key)) throw new RequestValidationError(`Unknown manifest field: ${key}.`);
    });
    if (value.schemaVersion !== 1) throw new RequestValidationError('Unsupported manifest schema.');
    rejectControlCharacters(requireTrimmedString(value.wqId, 'wqId', 128), 'wqId');
    if (value.mode !== 'incremental' || value.status !== 'completed') throw new RequestValidationError('Only completed incremental sync may upload.');
    const remoteCount = Number(value.remoteCount);
    const alphaCount = Number(value.alphaCount);
    const submittedPnlCount = Number(value.submittedPnlCount);
    if (![remoteCount, alphaCount, submittedPnlCount].every((item) => Number.isInteger(item) && item >= 0 && item <= MAX_RECORDS)) {
        throw new RequestValidationError('Invalid sync counts.');
    }
    if (remoteCount !== alphaCount || remoteCount !== submittedPnlCount) throw new RequestValidationError('Sync counts are incomplete.');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value.submittedDate || ''))) throw new RequestValidationError('Invalid submittedDate.');
    if (!Number.isFinite(Number(value.incrementalSyncedAt)) || Number(value.incrementalSyncedAt) <= 0) {
        throw new RequestValidationError('Invalid incrementalSyncedAt.');
    }
    if (!Array.isArray(value.failedIds) || value.failedIds.length || !Array.isArray(value.backfillFailedIds) || value.backfillFailedIds.length) {
        throw new RequestValidationError('Sync contains failed IDs.');
    }
    const recordCount = Number(value.recordCount);
    const partCount = Number(value.partCount);
    if (!Number.isInteger(recordCount) || recordCount < remoteCount || recordCount > MAX_RECORDS) throw new RequestValidationError('Invalid recordCount.');
    if (!Number.isInteger(partCount) || partCount < 1 || partCount > 10_000) throw new RequestValidationError('Invalid partCount.');
    validateSha256(value.payloadSha256, 'payloadSha256');
    return { ...value, remoteCount, alphaCount, submittedPnlCount, recordCount, partCount };
}
