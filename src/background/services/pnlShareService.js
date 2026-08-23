import { getLocalValue, removeLocalValue, setLocalValue } from './storageService.js';
import {
    getShareKey,
    putShareKey,
} from './prodMemoDb.js';
import {
    getShareUploadSnapshot,
    getSharedSnapshotMeta,
    saveSharedSnapshot,
} from './prodMemoService.js';
import { getSettings } from './settingsService.js';
import * as bundledPako from '../../vendor/js/pako.min.js';

export const PNL_SHARE_ENDPOINT = 'https://pnl-share.hualabtech.com';
const INSTALLATION_KEY = 'WQP_PNL_SHARE_INSTALLATION_ID';
const ACCESS_KEY = 'WQP_PNL_SHARE_ACCESS_KEY';
const PENDING_UPLOAD_KEY = 'WQP_PNL_SHARE_PENDING_UPLOAD';
const MAX_PART_BYTES = 2 * 1024 * 1024;
// Queue consumers still handle one part at a time; each part contains at most 8 Alpha records.
const TARGET_PART_BYTES = 1536 * 1024;
const MAX_PART_RECORDS = 8;
const RATE_LIMIT_MAX_RETRIES = 4;
const RATE_LIMIT_MAX_DELAY_MS = 60 * 1000;
const UPLOAD_CONCURRENCY = 4;
const PROCESS_CONCURRENCY = 2;
const DIRECT_UPLOAD_MAX_RETRIES = 3;
const UPLOAD_PROGRESS_MESSAGE = 'WQP_PNL_SHARE_UPLOAD_PROGRESS';
let pendingUploadResumePromise = null;

function postUploadProgress(payload) {
    try {
        chrome.runtime.sendMessage({ type: UPLOAD_PROGRESS_MESSAGE, payload }, () => {
            void chrome.runtime.lastError;
        });
    } catch (_) {
        // The sidebar may be closed while an upload is running.
    }
}

function normalizePendingCount(value) {
    const count = Number(value);
    return Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
}

export function normalizePendingUpload(value) {
    if (!value || typeof value !== 'object') return null;
    const sessionId = String(value.sessionId || '').trim();
    const uploadToken = String(value.uploadToken || '').trim();
    const payloadSha256 = String(value.payloadSha256 || '').trim().toLowerCase();
    const parts = Array.isArray(value.parts) ? value.parts.map((item) => ({
        part: Number(item?.part),
        sha256: String(item?.sha256 || '').trim().toLowerCase(),
    })).sort((left, right) => left.part - right.part) : [];
    if (!sessionId || !uploadToken || !/^[a-f0-9]{64}$/.test(payloadSha256) || !parts.length) return null;
    if (parts.some((part, index) => (
        part.part !== index + 1 || !/^[a-f0-9]{64}$/.test(part.sha256)
    ))) return null;
    const state = ['uploading', 'processing', 'failed', 'expired'].includes(value.state)
        ? value.state
        : 'processing';
    return {
        version: 1,
        state,
        sessionId,
        uploadToken,
        parts,
        payloadSha256,
        syncAt: normalizePendingCount(value.syncAt),
        recordCount: normalizePendingCount(value.recordCount),
        partCount: parts.length,
        expiresAt: normalizePendingCount(value.expiresAt),
        createdAt: normalizePendingCount(value.createdAt),
        uploaded: Math.min(parts.length, normalizePendingCount(value.uploaded)),
        processed: Math.min(parts.length, normalizePendingCount(value.processed)),
        failed: normalizePendingCount(value.failed),
        retrying: normalizePendingCount(value.retrying),
        finalizeAuthorized: value.finalizeAuthorized === true,
        lastCheckedAt: normalizePendingCount(value.lastCheckedAt),
        lastError: String(value.lastError || '').slice(0, 500),
        errors: Array.isArray(value.errors) ? value.errors.slice(0, 10).map((item) => ({
            part: normalizePendingCount(item?.part),
            attempts: normalizePendingCount(item?.attempts),
            message: String(item?.message || '').slice(0, 500),
        })) : [],
    };
}

export function publicPendingUpload(value, timestamp = Date.now()) {
    const pending = normalizePendingUpload(value);
    if (!pending) return null;
    const active = ['uploading', 'processing'].includes(pending.state);
    return {
        active,
        state: pending.state,
        syncAt: pending.syncAt,
        recordCount: pending.recordCount,
        partCount: pending.partCount,
        expiresAt: pending.expiresAt,
        createdAt: pending.createdAt,
        uploaded: pending.uploaded,
        processed: pending.processed,
        failed: pending.failed,
        retrying: pending.retrying,
        finalizeAuthorized: pending.finalizeAuthorized,
        lastCheckedAt: pending.lastCheckedAt,
        lastError: pending.lastError,
        errors: pending.errors,
    };
}

function base64Url(bytes) {
    let binary = '';
    for (let index = 0; index < bytes.length; index += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
    }
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64UrlBytes(value) {
    const normalized = String(value || '').replace(/-/g, '+').replace(/_/g, '/');
    const binary = atob(normalized + '='.repeat((4 - (normalized.length % 4)) % 4));
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function utf8(value) {
    return new TextEncoder().encode(String(value));
}

async function sha256Hex(value) {
    const bytes = value instanceof Uint8Array ? value : utf8(value);
    return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (item) => item.toString(16).padStart(2, '0')).join('');
}

async function gzipBytes(bytes) {
    if (typeof CompressionStream === 'undefined') return { bytes, encoding: '' };
    const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'));
    return {
        bytes: new Uint8Array(await new Response(stream).arrayBuffer()),
        encoding: 'gzip',
    };
}

async function importDirectEncryptionKey(value) {
    const bytes = base64UrlBytes(value);
    if (bytes.byteLength !== 32) throw new Error('服务端返回的直传加密密钥无效。');
    return crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt']);
}

async function encryptDirectPart(encoded, key) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv },
        key,
        encoded.bytes,
    ));
    return utf8(JSON.stringify({
        sessionEncrypted: true,
        ciphertext: base64Url(ciphertext),
        iv: base64Url(iv),
        contentEncoding: encoded.encoding || '',
    }));
}

async function ensureInstallationId() {
    const existing = await getLocalValue(INSTALLATION_KEY);
    if (typeof existing === 'string' && existing) return existing;
    const installationId = crypto.randomUUID();
    await setLocalValue(INSTALLATION_KEY, installationId);
    return installationId;
}

async function ensureSigningKey() {
    const existing = await getShareKey();
    if (existing?.privateKey && existing.publicKeyJwk) return existing;
    const generated = await crypto.subtle.generateKey(
        { name: 'ECDSA', namedCurve: 'P-256' },
        true,
        ['sign', 'verify'],
    );
    const [publicKeyJwk, privateKeyJwk] = await Promise.all([
        crypto.subtle.exportKey('jwk', generated.publicKey),
        crypto.subtle.exportKey('jwk', generated.privateKey),
    ]);
    const privateKey = await crypto.subtle.importKey(
        'jwk', privateKeyJwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign'],
    );
    const record = { key: 'default', privateKey, publicKeyJwk, createdAt: Date.now() };
    await putShareKey(record);
    return record;
}

async function sign(privateKey, operation, value) {
    const signature = await crypto.subtle.sign(
        { name: 'ECDSA', hash: 'SHA-256' },
        privateKey,
        utf8(`${operation}|${value}`),
    );
    return base64Url(new Uint8Array(signature));
}

function sleep(ms, signal) {
    const delay = Math.max(0, ms);
    if (!signal) return new Promise((resolve) => setTimeout(resolve, delay));
    if (signal.aborted) return Promise.reject(signal.reason || new Error('操作已取消。'));
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            signal.removeEventListener('abort', onAbort);
            resolve();
        }, delay);
        const onAbort = () => {
            clearTimeout(timer);
            reject(signal.reason || new Error('操作已取消。'));
        };
        signal.addEventListener('abort', onAbort, { once: true });
    });
}

function parseRetryAfterMs(value) {
    const raw = String(value || '').trim();
    if (!raw) return 0;
    const seconds = Number(raw);
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
    const timestamp = Date.parse(raw);
    return Number.isNaN(timestamp) ? 0 : Math.max(0, timestamp - Date.now());
}

export async function requestJson(path, options = {}) {
    const {
        retryOnRateLimit = false,
        onRateLimit,
        ...requestOptions
    } = options;
    for (let attempt = 0; attempt <= (retryOnRateLimit ? RATE_LIMIT_MAX_RETRIES : 0); attempt += 1) {
        const response = await fetch(`${PNL_SHARE_ENDPOINT}${path}`, {
            ...requestOptions,
            credentials: 'omit',
            cache: 'no-store',
            redirect: 'error',
            referrerPolicy: 'no-referrer',
            headers: {
                Accept: 'application/json',
                ...(requestOptions.body ? { 'Content-Type': 'application/json' } : {}),
                ...(requestOptions.headers || {}),
            },
        });
        let data = null;
        try { data = await response.json(); } catch { /* Keep the status error below. */ }
        if (response.ok) return data;
        if (response.status === 429 && retryOnRateLimit && attempt < RATE_LIMIT_MAX_RETRIES) {
            const retryAfterMs = parseRetryAfterMs(response.headers.get('Retry-After'));
            const delayMs = Math.min(
                RATE_LIMIT_MAX_DELAY_MS,
                retryAfterMs || Math.min(1000 * (2 ** attempt), RATE_LIMIT_MAX_DELAY_MS),
            );
            onRateLimit?.({ attempt: attempt + 1, maxRetries: RATE_LIMIT_MAX_RETRIES, delayMs });
            await sleep(delayMs, requestOptions.signal);
            continue;
        }
        throw new Error(data?.message || data?.error || `PNL 共享服务 HTTP ${response.status}`);
    }
    throw new Error('PNL 共享服务限流重试次数已用尽。');
}

export async function runUploadProcessPipeline(total, options) {
    const count = Number(total);
    const uploadConcurrency = Math.max(1, Math.floor(Number(options?.uploadConcurrency) || UPLOAD_CONCURRENCY));
    const processConcurrency = Math.max(1, Math.floor(Number(options?.processConcurrency) || PROCESS_CONCURRENCY));
    if (!Number.isInteger(count) || count < 0) throw new Error('无效的上传分片数量。');
    if (typeof options?.uploadPart !== 'function' || typeof options?.processPart !== 'function') {
        throw new Error('上传流水线缺少处理函数。');
    }
    if (count === 0) return { uploaded: 0, processed: 0 };

    const controller = new AbortController();
    const uploadedParts = new Uint8Array(count);
    const waiters = Array.from({ length: count }, () => new Set());
    let nextUpload = 0;
    let nextProcess = 0;
    let uploaded = 0;
    let processed = 0;
    let firstError = null;

    const notify = (index) => {
        for (const resolve of waiters[index]) resolve();
        waiters[index].clear();
    };
    const stop = (error) => {
        if (firstError) return;
        firstError = error instanceof Error ? error : new Error(String(error));
        controller.abort(firstError);
        for (let index = 0; index < count; index += 1) notify(index);
    };
    const waitForUpload = async (index) => {
        while (!uploadedParts[index] && !firstError) {
            await new Promise((resolve) => waiters[index].add(resolve));
        }
        if (firstError) throw firstError;
    };
    const uploadWorker = async () => {
        while (!firstError) {
            const index = nextUpload;
            nextUpload += 1;
            if (index >= count) return;
            try {
                await options.uploadPart(index, controller.signal);
                if (firstError) return;
                uploadedParts[index] = 1;
                uploaded += 1;
                notify(index);
                options.onProgress?.({ stage: 'uploaded', index, uploaded, processed, total: count });
            } catch (error) {
                stop(error);
            }
        }
    };
    const processWorker = async () => {
        while (!firstError) {
            const index = nextProcess;
            nextProcess += 1;
            if (index >= count) return;
            try {
                await waitForUpload(index);
                await options.processPart(index, controller.signal);
                if (firstError) return;
                processed += 1;
                options.onProgress?.({ stage: 'processed', index, uploaded, processed, total: count });
            } catch (error) {
                stop(error);
            }
        }
    };

    await Promise.all([
        ...Array.from({ length: Math.min(uploadConcurrency, count) }, () => uploadWorker()),
        ...Array.from({ length: Math.min(processConcurrency, count) }, () => processWorker()),
    ]);
    if (firstError) throw firstError;
    return { uploaded, processed };
}

async function runConcurrent(total, concurrency, task) {
    let next = 0;
    const workers = Array.from({ length: Math.min(Math.max(1, concurrency), total) }, async () => {
        while (true) {
            const index = next;
            next += 1;
            if (index >= total) return;
            await task(index);
        }
    });
    await Promise.all(workers);
}

async function putSignedR2(url, headers, body) {
    let lastError = null;
    for (let attempt = 0; attempt <= DIRECT_UPLOAD_MAX_RETRIES; attempt += 1) {
        try {
            const response = await fetch(url, {
                method: 'PUT',
                credentials: 'omit',
                cache: 'no-store',
                redirect: 'error',
                referrerPolicy: 'no-referrer',
                headers,
                body,
            });
            if (response.ok) return;
            let detail = '';
            try { detail = (await response.text()).slice(0, 300); } catch { /* Keep status only. */ }
            lastError = new Error(`R2 直传 HTTP ${response.status}${detail ? `：${detail}` : ''}`);
            if (response.status < 500 && response.status !== 429) throw lastError;
        } catch (error) {
            lastError = error instanceof Error ? error : new Error(String(error));
        }
        if (attempt < DIRECT_UPLOAD_MAX_RETRIES) await sleep(Math.min(8000, 500 * (2 ** attempt)));
    }
    throw lastError || new Error('R2 直传失败。');
}

async function uploadPartsDirect(session, encodedParts, partHashes, payloadSha256, signingKey, onUploaded) {
    const encryptionKey = await importDirectEncryptionKey(session.directEncryptionKey);
    const batchSize = Math.max(1, Math.min(32, Number(session.directUrlBatchSize) || 32));
    const manifestParts = partHashes.map((sha256, index) => ({
        part: index + 1,
        sha256,
        bytes: encodedParts[index].bytes.byteLength,
    }));
    for (let start = 0; start < encodedParts.length; start += batchSize) {
        const partNumbers = manifestParts.slice(start, start + batchSize).map((part) => part.part);
        const signed = await requestJson(`/v1/share/uploads/${encodeURIComponent(session.sessionId)}/direct-urls`, {
            method: 'POST',
            body: JSON.stringify({ uploadToken: session.uploadToken, parts: partNumbers }),
            retryOnRateLimit: true,
        });
        const byPart = new Map((signed.uploads || []).map((item) => [Number(item.part), item]));
        if (byPart.size !== partNumbers.length) throw new Error('服务端返回的 R2 直传地址不完整。');
        await runConcurrent(partNumbers.length, UPLOAD_CONCURRENCY, async (offset) => {
            const part = partNumbers[offset];
            const target = byPart.get(part);
            if (!target?.url) throw new Error(`缺少分片 ${part} 的 R2 直传地址。`);
            const encrypted = await encryptDirectPart(encodedParts[part - 1], encryptionKey);
            await putSignedR2(target.url, target.headers || { 'Content-Type': 'application/json' }, encrypted);
            onUploaded?.(part);
        });
    }
    const signatureValue = `${session.sessionId}|${JSON.stringify(manifestParts)}|${payloadSha256}`;
    await requestJson(`/v1/share/uploads/${encodeURIComponent(session.sessionId)}/direct-complete`, {
        method: 'POST',
        body: JSON.stringify({
            uploadToken: session.uploadToken,
            parts: manifestParts,
            signature: await sign(signingKey, 'direct-complete', signatureValue),
        }),
        retryOnRateLimit: true,
    });
}

async function uploadPartsViaWorker(session, encodedParts, partHashes, onUploaded, onRateLimit) {
    await runConcurrent(encodedParts.length, UPLOAD_CONCURRENCY, async (index) => {
        await requestJson(`/v1/share/uploads/${encodeURIComponent(session.sessionId)}/parts/${index + 1}`, {
            method: 'PUT',
            headers: {
                'X-Upload-Token': session.uploadToken,
                'X-Content-SHA256': partHashes[index],
                'Content-Type': 'application/x-ndjson',
                ...(encodedParts[index].encoding ? { 'X-Content-Encoding': encodedParts[index].encoding } : {}),
            },
            body: encodedParts[index].bytes,
            retryOnRateLimit: true,
            onRateLimit,
        });
        onUploaded?.(index + 1);
    });
}

export async function advancePendingUpload(value, dependencies = {}) {
    const pending = normalizePendingUpload(value);
    if (!pending) return { pending: null, finalized: null };
    const timestamp = typeof dependencies.now === 'function' ? dependencies.now() : Date.now();
    const savePending = dependencies.savePending || ((next) => setLocalValue(PENDING_UPLOAD_KEY, next));
    const clearPending = dependencies.clearPending || (() => removeLocalValue(PENDING_UPLOAD_KEY));
    const request = dependencies.request || requestJson;
    const getSigningKey = dependencies.getSigningKey || getShareKey;
    const signValue = dependencies.signValue || sign;
    const saveAccessKey = dependencies.saveAccessKey || ((accessKey) => setLocalValue(ACCESS_KEY, accessKey));
    const saveLastUpload = dependencies.saveLastUpload || ((lastUpload) => setLocalValue('WQP_PNL_SHARE_LAST_UPLOAD', lastUpload));

    if (!['uploading', 'processing', 'expired'].includes(pending.state)) {
        return { pending: publicPendingUpload(pending, timestamp), finalized: null };
    }

    let status;
    try {
        status = await request(`/v1/share/uploads/${encodeURIComponent(pending.sessionId)}/status`, {
            method: 'GET',
            headers: { 'X-Upload-Token': pending.uploadToken },
            retryOnRateLimit: true,
        });
    } catch (error) {
        const message = error?.message || String(error);
        const sessionInvalid = /upload session (?:is )?(?:missing|invalid|expired)|missing or expired/i.test(message);
        const waiting = {
            ...pending,
            state: sessionInvalid ? 'expired' : 'processing',
            lastCheckedAt: timestamp,
            lastError: sessionInvalid ? '上传任务已过期，请重新上传。' : message,
        };
        await savePending(waiting);
        return { pending: publicPendingUpload(waiting, timestamp), finalized: null };
    }

    const updated = {
        ...pending,
        state: 'processing',
        uploaded: Math.min(pending.partCount, normalizePendingCount(status.uploaded)),
        processed: Math.min(pending.partCount, normalizePendingCount(status.processed)),
        failed: normalizePendingCount(status.failed),
        retrying: normalizePendingCount(status.retrying),
        finalizeAuthorized: status.finalizeAuthorized === true,
        expiresAt: normalizePendingCount(status.expiresAt) || pending.expiresAt,
        lastCheckedAt: timestamp,
        lastError: status.finalizeError ? `服务端签发 Key 暂时失败：${String(status.finalizeError).slice(0, 400)}` : '',
        errors: Array.isArray(status.errors) ? status.errors : [],
    };
    if (updated.failed > 0) {
        const first = updated.errors.find((item) => item?.message);
        updated.state = 'failed';
        updated.lastError = `服务端处理失败${first ? `（分片 ${first.part}：${first.message}）` : ''}。`;
        await savePending(updated);
        return { pending: publicPendingUpload(updated, timestamp), finalized: null };
    }
    const total = normalizePendingCount(status.total) || pending.partCount;
    if (total !== pending.partCount) {
        updated.state = 'failed';
        updated.lastError = `服务端分片总数不一致（${total}/${pending.partCount}），请重新上传。`;
        await savePending(updated);
        return { pending: publicPendingUpload(updated, timestamp), finalized: null };
    }
    const needsFinalizeRequest = status.status === 'finalized'
        || updated.finalizeAuthorized !== true
        || (updated.processed === total && total > 0);
    if (!needsFinalizeRequest) {
        await savePending(updated);
        return { pending: publicPendingUpload(updated, timestamp), finalized: null };
    }

    const signingKey = await getSigningKey();
    if (!signingKey?.privateKey) {
        updated.state = 'failed';
        updated.lastError = '本地上传签名密钥已丢失，无法领取 Key，请重新上传。';
        await savePending(updated);
        return { pending: publicPendingUpload(updated, timestamp), finalized: null };
    }
    const finalizeSigned = `${pending.sessionId}|${JSON.stringify(pending.parts)}|${pending.payloadSha256}`;
    let result;
    try {
        result = await request(`/v1/share/uploads/${encodeURIComponent(pending.sessionId)}/finalize`, {
            method: 'POST',
            body: JSON.stringify({
                uploadToken: pending.uploadToken,
                parts: pending.parts,
                signature: await signValue(signingKey.privateKey, 'finalize', finalizeSigned),
            }),
            retryOnRateLimit: true,
        });
    } catch (error) {
        updated.lastError = error?.message || String(error);
        await savePending(updated);
        return { pending: publicPendingUpload(updated, timestamp), finalized: null };
    }
    updated.finalizeAuthorized = result.finalizeAuthorized === true || updated.finalizeAuthorized;
    updated.expiresAt = normalizePendingCount(result.expiresAt) || updated.expiresAt;
    if (!result.key) {
        updated.state = 'processing';
        updated.lastError = '';
        await savePending(updated);
        return { pending: publicPendingUpload(updated, timestamp), finalized: null };
    }
    await saveAccessKey(result.key);
    await saveLastUpload({
        uploadedAt: timestamp,
        syncAt: pending.syncAt,
        recordCount: result.recordCount,
        expiresAt: result.expiresAt,
    });
    await clearPending();
    return {
        pending: null,
        finalized: {
            recordCount: normalizePendingCount(result.recordCount),
            expiresAt: normalizePendingCount(result.expiresAt),
        },
    };
}

async function resumePendingUpload() {
    if (pendingUploadResumePromise) return pendingUploadResumePromise;
    pendingUploadResumePromise = (async () => {
        const raw = await getLocalValue(PENDING_UPLOAD_KEY);
        const pending = normalizePendingUpload(raw);
        if (!pending) {
            if (raw !== undefined) await removeLocalValue(PENDING_UPLOAD_KEY);
            return { pending: null, finalized: null };
        }
        return advancePendingUpload(pending);
    })();
    try {
        return await pendingUploadResumePromise;
    } finally {
        pendingUploadResumePromise = null;
    }
}

async function getLiveWqIdentity() {
    const response = await fetch('https://api.worldquantbrain.com/users/self/consultant/summary', {
        method: 'GET',
        credentials: 'include',
        cache: 'no-store',
        headers: { Accept: 'application/json' },
    });
    if (!response.ok) throw new Error(`无法读取当前 WQ 账号（HTTP ${response.status}）。`);
    const data = await response.json();
    const wqId = String(data?.leaderboard?.user || '').trim();
    if (!wqId) throw new Error('无法读取当前 WQ ID，请先登录 WorldQuant BRAIN。');
    return { wqId };
}

async function registerInstallation(installationId, key, identity) {
    const challenge = await requestJson('/v1/share/installations/challenge', {
        method: 'POST',
        body: JSON.stringify({ installationId }),
    });
    const pluginVersion = chrome.runtime.getManifest().version;
    const signed = [challenge.nonce, installationId, identity.wqId, pluginVersion].join('|');
    const signature = await sign(key.privateKey, 'register', signed);
    return requestJson('/v1/share/installations', {
        method: 'POST',
        body: JSON.stringify({
            challengeId: challenge.challengeId,
            nonce: challenge.nonce,
            installationId,
            wqId: identity.wqId,
            pluginVersion,
            publicKeyJwk: key.publicKeyJwk,
            signature,
        }),
    });
}

function joinByteParts(parts, byteLength) {
    const joined = new Uint8Array(byteLength);
    let offset = 0;
    for (const part of parts) {
        joined.set(part, offset);
        offset += part.byteLength;
    }
    return joined;
}

export function splitRecords(records) {
    const chunks = [];
    let current = [];
    let currentBytes = 0;
    for (const record of records) {
        const line = `${JSON.stringify(record)}\n`;
        const bytes = utf8(line);
        if (bytes.byteLength > MAX_PART_BYTES) throw new Error(`Alpha ${record.alphaId} 的上传记录超过单片大小限制。`);
        if (current.length && (
            current.length >= MAX_PART_RECORDS
            || currentBytes + bytes.byteLength > TARGET_PART_BYTES
        )) {
            chunks.push(joinByteParts(current, currentBytes));
            current = [];
            currentBytes = 0;
        }
        current.push(bytes);
        currentBytes += bytes.byteLength;
    }
    if (current.length) chunks.push(joinByteParts(current, currentBytes));
    return chunks;
}

export async function getShareStatus() {
    const settings = await getSettings();
    const localMeta = await getSharedSnapshotMeta();
    const pendingResult = settings.pnlShareEnabled === true
        ? await resumePendingUpload()
        : { pending: publicPendingUpload(await getLocalValue(PENDING_UPLOAD_KEY)), finalized: null };
    const upload = settings.pnlShareEnabled === true && !pendingResult.pending?.active ? await getShareUploadSnapshot() : {
        eligible: false,
        reason: settings.pnlShareEnabled === true ? '已有共享上传任务正在处理。' : '共享功能已关闭。',
        records: [],
        manifest: null,
    };
    const accessKey = await getLocalValue(ACCESS_KEY);
    let remote = null;
    let remoteError = '';
    if (settings.pnlShareEnabled === true && accessKey) {
        try {
            remote = await requestJson('/v1/share/stats', { headers: { Authorization: `Bearer ${accessKey}` } });
        } catch (error) {
            remoteError = error.message;
        }
    }
    return {
        enabled: settings.pnlShareEnabled === true,
        uploadEligible: upload.eligible,
        uploadReason: upload.reason,
        uploadRecords: upload.records?.length || 0,
        localSnapshot: localMeta || null,
        remote,
        remoteError,
        hasKey: Boolean(accessKey),
        accessKey: accessKey || '',
        pendingUpload: pendingResult.pending,
        completedUpload: pendingResult.finalized,
    };
}

export async function uploadSharedData() {
    postUploadProgress({ phase: 'preparing', current: 0, total: 0, percent: 0, message: '正在准备共享上传…' });
    const settings = await getSettings();
    if (settings.pnlShareEnabled !== true) throw new Error('请先在设置中开启 PNL / Prod Corr 共享。');
    const existing = await resumePendingUpload();
    if (existing.pending?.active) {
        throw new Error(`已有共享上传任务正在处理（${existing.pending.processed}/${existing.pending.partCount} 个分片），请稍后回来领取 Key。`);
    }
    const upload = await getShareUploadSnapshot();
    if (!upload.eligible) throw new Error(upload.reason || '当前同步结果不满足上传条件。');
    postUploadProgress({
        phase: 'preparing',
        current: 0,
        total: upload.records.length,
        percent: 1,
        message: `已准备 ${upload.records.length} 条共享记录。`,
    });
    const identity = await getLiveWqIdentity();
    if (identity.wqId !== upload.manifest.accountWqId) {
        throw new Error('当前 WQ ID 与本次增量同步账号不一致，请在当前账号下重新同步。');
    }
    const installationId = await ensureInstallationId();
    const key = await ensureSigningKey();
    postUploadProgress({ phase: 'registering', current: 0, total: 0, percent: 3, message: '正在验证安装身份…' });
    await registerInstallation(installationId, key, identity);

    const chunks = splitRecords(upload.records);
    const encodedParts = [];
    const partHashes = [];
    for (let index = 0; index < chunks.length; index += 1) {
        const encoded = await gzipBytes(chunks[index]);
        encodedParts.push(encoded);
        partHashes.push(await sha256Hex(encoded.bytes));
        postUploadProgress({
            phase: 'compressing',
            current: index + 1,
            total: chunks.length,
            percent: 5 + Math.round(((index + 1) / chunks.length) * 5),
            message: `正在压缩并校验分片 ${index + 1}/${chunks.length}…`,
        });
    }
    const manifest = {
        schemaVersion: 1,
        wqId: identity.wqId,
        mode: upload.manifest.mode,
        status: upload.manifest.status,
        remoteCount: upload.manifest.remoteCount,
        alphaCount: upload.manifest.alphaCount,
        submittedPnlCount: upload.manifest.submittedPnlCount,
        submittedDate: upload.manifest.submittedDate,
        incrementalSyncedAt: upload.manifest.incrementalSyncedAt,
        failedIds: upload.manifest.failedIds,
        backfillFailedIds: upload.manifest.backfillFailedIds,
        recordCount: upload.records.length,
        partCount: chunks.length,
        payloadSha256: await sha256Hex(partHashes.join(':')),
    };
    const uploadSigned = `${installationId}|${JSON.stringify(manifest)}`;
    const session = await requestJson('/v1/share/uploads', {
        method: 'POST',
        body: JSON.stringify({ installationId, manifest, signature: await sign(key.privateKey, 'upload', uploadSigned) }),
    });
    const parts = partHashes.map((sha256, index) => ({ part: index + 1, sha256 }));
    const finalizeSigned = `${session.sessionId}|${JSON.stringify(parts)}|${manifest.payloadSha256}`;
    const authorization = await requestJson(`/v1/share/uploads/${encodeURIComponent(session.sessionId)}/finalize`, {
        method: 'POST',
        body: JSON.stringify({
            uploadToken: session.uploadToken,
            parts,
            signature: await sign(key.privateKey, 'finalize', finalizeSigned),
        }),
        retryOnRateLimit: true,
    });
    if (authorization.finalizeAuthorized !== true) {
        throw new Error('服务端未接受自动签发 Key 授权，请重新上传。');
    }
    let pendingUpload = normalizePendingUpload({
        version: 1,
        state: 'uploading',
        sessionId: session.sessionId,
        uploadToken: session.uploadToken,
        parts,
        payloadSha256: manifest.payloadSha256,
        syncAt: upload.manifest.incrementalSyncedAt,
        recordCount: upload.records.length,
        expiresAt: authorization.expiresAt || session.expiresAt,
        finalizeAuthorized: true,
        createdAt: Date.now(),
    });
    await setLocalValue(PENDING_UPLOAD_KEY, pendingUpload);
    const uploadedParts = new Set();
    let uploadedCount = 0;
    let processedCount = 0;
    const pipelinePercent = () => Math.min(96, 12
        + Math.round((uploadedCount / chunks.length) * 50)
        + Math.round((processedCount / chunks.length) * 34));
    const markUploaded = (part) => {
        uploadedParts.add(part);
        uploadedCount = uploadedParts.size;
        postUploadProgress({
            phase: 'pipeline',
            current: processedCount,
            total: chunks.length,
            percent: pipelinePercent(),
            message: `上传处理中：${uploadedCount}/${chunks.length} 个分片…`,
        });
    };
    const rateLimited = (stage, { attempt, maxRetries, delayMs }) => {
        postUploadProgress({
            phase: 'pipeline',
            current: processedCount,
            total: chunks.length,
            percent: pipelinePercent(),
            message: `${stage}触发限流，等待 ${Math.ceil(delayMs / 1000)} 秒后重试（${attempt}/${maxRetries}）；已上传 ${uploadedCount}/${chunks.length} 个分片…`,
        });
    };
    postUploadProgress({
        phase: 'pipeline',
        current: 0,
        total: chunks.length,
        percent: 12,
        message: `开始 ${UPLOAD_CONCURRENCY} 路上传 ${chunks.length} 个分片；服务端已接管自动处理和 Key 签发…`,
    });
    try {
        let directMode = session.directUpload === true && Boolean(session.directEncryptionKey);
        if (directMode) {
            try {
                await uploadPartsDirect(
                    session,
                    encodedParts,
                    partHashes,
                    manifest.payloadSha256,
                    key.privateKey,
                    markUploaded,
                );
            } catch (error) {
                directMode = false;
                postUploadProgress({
                    phase: 'pipeline',
                    current: processedCount,
                    total: chunks.length,
                    percent: pipelinePercent(),
                    message: `R2 直传不可用（${error.message || String(error)}），正在切换兼容上传…`,
                });
            }
        }
        if (!directMode) {
            await uploadPartsViaWorker(
                session,
                encodedParts,
                partHashes,
                markUploaded,
                (retry) => rateLimited('上传', retry),
            );
        }
    } catch (error) {
        pendingUpload = {
            ...pendingUpload,
            state: 'failed',
            uploaded: uploadedCount,
            lastError: error?.message || String(error),
        };
        await setLocalValue(PENDING_UPLOAD_KEY, pendingUpload);
        throw error;
    }
    pendingUpload = {
        ...pendingUpload,
        state: 'processing',
        uploaded: chunks.length,
        lastCheckedAt: Date.now(),
        lastError: '',
    };
    await setLocalValue(PENDING_UPLOAD_KEY, pendingUpload);
    postUploadProgress({
        phase: 'queued',
        current: 0,
        total: chunks.length,
        percent: 65,
        message: '分片上传完成，服务端已接管；现在可以关闭侧边栏或浏览器，稍后回来领取 Key。',
    });
    return {
        ok: true,
        queued: true,
        recordCount: upload.records.length,
        partCount: chunks.length,
        expiresAt: authorization.expiresAt || session.expiresAt,
    };
}

function appendDatasetLine(line, records) {
    if (!line.trim()) return;
    const value = JSON.parse(line);
    if (value.type === 'meta' || !value.alias || !value.pnl?.records || !value.groupKey) return;
    records.push({
        alias: String(value.alias),
        sourceType: value.sourceType === 'submitted' ? 'submitted' : 'prod',
        groupKey: String(value.groupKey),
        prodCorr: Number(value.sourceType === 'submitted' ? 1 : value.prodCorr),
        classifications: Array.isArray(value.classifications) ? value.classifications : [],
        pnl: { records: value.pnl.records },
        updatedAt: Number(value.updatedAt || Date.now()),
    });
}

export function decodeGzipDatasetBytes(bytes, gzipMembers = null) {
    const pakoApi = globalThis.pako || bundledPako.default || bundledPako;
    if (!pakoApi?.Inflate) throw new Error('本地 gzip 解压组件不可用。');
    const records = [];
    let pending = '';
    const consumeText = (chunk) => {
        pending += chunk;
        let newline = pending.indexOf('\n');
        while (newline >= 0) {
            appendDatasetLine(pending.slice(0, newline), records);
            pending = pending.slice(newline + 1);
            newline = pending.indexOf('\n');
        }
    };
    if (Array.isArray(gzipMembers) && gzipMembers.length) {
        const sizes = gzipMembers.map(Number);
        if (sizes.some((size) => !Number.isSafeInteger(size) || size < 1)
            || sizes.reduce((sum, size) => sum + size, 0) !== bytes.byteLength) {
            throw new Error('gzip 分段索引与下载文件大小不一致。');
        }
        let offset = 0;
        for (const size of sizes) {
            consumeText(pakoApi.ungzip(bytes.subarray(offset, offset + size), { to: 'string' }));
            offset += size;
        }
    } else {
        const inflator = new pakoApi.Inflate({ to: 'string', chunkSize: 64 * 1024 });
        inflator.onData = consumeText;
        const ok = inflator.push(bytes, true);
        if (!ok || inflator.err) throw new Error(inflator.msg || 'gzip 解压失败。');
    }
    appendDatasetLine(pending, records);
    return records;
}

async function decodeDataset(response, gzipMembers = null) {
    const compressed = new Uint8Array(await response.arrayBuffer());
    return decodeGzipDatasetBytes(compressed, gzipMembers);
}

export async function fetchSharedDatasetWithFallback(download, accessKey, options = {}) {
    const fetchImpl = options.fetchImpl || fetch;
    const decodeImpl = options.decodeImpl || decodeDataset;
    const endpoint = options.endpoint || PNL_SHARE_ENDPOINT;
    const datasetUrl = String(download.datasetUrl || '/v1/share/dataset');
    let records = null;
    let directFailure = '';
    if (download.direct === true && download.downloadUrl) {
        try {
            const directResponse = await fetchImpl(download.downloadUrl, {
                method: 'GET',
                credentials: 'omit',
                cache: 'no-store',
                redirect: 'error',
                referrerPolicy: 'no-referrer',
                headers: { Accept: 'application/gzip' },
            });
            if (!directResponse.ok) throw new Error(`R2 HTTP ${directResponse.status}`);
            // Body streaming/decompression can fail after fetch() has already returned OK.
            records = await decodeImpl(directResponse, download.gzipMembers);
        } catch (error) {
            directFailure = error?.message || String(error);
        }
    }
    if (records !== null) return records;

    let response;
    try {
        response = await fetchImpl(datasetUrl.startsWith('http') ? datasetUrl : `${endpoint}${datasetUrl}`, {
            method: 'GET',
            credentials: 'omit',
            cache: 'no-store',
            redirect: 'error',
            referrerPolicy: 'no-referrer',
            headers: { Authorization: `Bearer ${accessKey}`, Accept: 'application/gzip' },
        });
    } catch (error) {
        const fallbackFailure = error?.message || String(error);
        throw new Error(`R2 直连失败：${directFailure || '未启用'}；Worker 兼容下载失败：${fallbackFailure}`);
    }
    if (!response.ok) {
        let error = `共享数据下载失败：HTTP ${response.status}`;
        try { const data = await response.json(); error = data.message || data.error || error; } catch { /* keep status */ }
        throw new Error(directFailure ? `R2 直连失败：${directFailure}；${error}` : error);
    }
    try {
        return await decodeImpl(response, download.gzipMembers);
    } catch (error) {
        const fallbackFailure = error?.message || String(error);
        throw new Error(`共享数据读取失败：${fallbackFailure}${directFailure ? `（R2 直连先前失败：${directFailure}）` : ''}`);
    }
}

export async function downloadSharedData() {
    const settings = await getSettings();
    if (settings.pnlShareEnabled !== true) throw new Error('请先在设置中开启 PNL / Prod Corr 共享。');
    const accessKey = await getLocalValue(ACCESS_KEY);
    if (!accessKey) throw new Error('还没有共享 key，请先完成一次上传。');
    const meta = await requestJson('/v1/share/stats', { headers: { Authorization: `Bearer ${accessKey}` } });
    const snapshot = meta.snapshot;
    const totals = meta.totals || {};
    if (!snapshot || snapshot.status !== 'published'
        || Number(snapshot.recordCount) !== Number(totals.recordCount)
        || Number(snapshot.pnlPointCount) !== Number(totals.pnlPointCount)) {
        throw new Error('共享快照正在构建，请稍后重试。');
    }
    const download = await requestJson('/v1/share/download-url', {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessKey}` },
    });
    const records = await fetchSharedDatasetWithFallback(download, accessKey);
    const pnlPointCount = records.reduce((sum, record) => sum + record.pnl.records.length, 0);
    if (records.length !== Number(snapshot.recordCount) || pnlPointCount !== Number(snapshot.pnlPointCount)) {
        throw new Error(`共享下载校验失败：收到 ${records.length} 条，服务端应为 ${snapshot.recordCount} 条。`);
    }
    await saveSharedSnapshot(records, {
        version: snapshot.version || 0,
        recordCount: records.length,
        pnlPointCount,
        sha256: snapshot.sha256 || '',
        downloadedAt: Date.now(),
    });
    return {
        recordCount: records.length,
        pnlPointCount,
        snapshot,
        remaining: meta.key?.remaining,
    };
}

export const PNL_SHARE_STORAGE_KEYS = Object.freeze({ INSTALLATION_KEY, ACCESS_KEY });
