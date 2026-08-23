(function () {
    'use strict';

    if (window.__wqpProdMemoMainInstalled) return;
    window.__wqpProdMemoMainInstalled = true;

    const nativeFetch = window.fetch.bind(window);
    const ALPHA_PAGE_LIMIT = 100;
    const ALPHA_WINDOW_LIMIT = 1000;
    const PNL_BATCH_SIZE = 100;
    const PNL_CONCURRENCY = 3;
    const BACKFILL_CONCURRENCY = 2;
    const RETRY_DELAYS = [1000, 2000, 4000];
    const pendingDatabaseRequests = new Map();
    const referenceRequests = new Map();
    const ACCOUNT_SCOPED_DATABASE_ACTIONS = new Set(['SAVE_ALPHA_BATCH', 'SAVE_PNL', 'GET_SYNC_STATE']);
    let syncRunning = false;
    let syncAbortController = null;
    let activeSyncAccountWqId = '';

    function delay(ms, signal) {
        return new Promise((resolve, reject) => {
            const timeoutId = setTimeout(() => {
                signal?.removeEventListener('abort', onAbort);
                resolve();
            }, ms);
            const onAbort = () => {
                clearTimeout(timeoutId);
                reject(new DOMException('Synchronization stopped', 'AbortError'));
            };
            signal?.addEventListener('abort', onAbort, { once: true });
        });
    }

    function checkStopped(signal) {
        if (signal?.aborted) throw new DOMException('Synchronization stopped', 'AbortError');
    }

    async function withRetries(operation, signal, onRetry) {
        let lastError;
        for (let attempt = 0; attempt <= RETRY_DELAYS.length; attempt += 1) {
            checkStopped(signal);
            try {
                return await operation();
            } catch (error) {
                if (error.fatal || error.name === 'AbortError') throw error;
                lastError = error;
                if (attempt >= RETRY_DELAYS.length) break;
                const waitMs = RETRY_DELAYS[attempt];
                onRetry?.(waitMs, attempt + 1, error);
                await delay(waitMs, signal);
            }
        }
        throw lastError || new Error('请求重试耗尽。');
    }

    async function withPersistentRetries(operation, signal, onRetry) {
        let attempt = 0;
        while (true) {
            checkStopped(signal);
            try {
                return await operation();
            } catch (error) {
                if (error.fatal || error.name === 'AbortError') throw error;
                const waitMs = RETRY_DELAYS[Math.min(attempt, RETRY_DELAYS.length - 1)];
                attempt += 1;
                onRetry?.(waitMs, attempt, error);
                await delay(waitMs, signal);
            }
        }
    }

    function databaseRequest(action, payload = {}) {
        const requestId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
        const requestPayload = activeSyncAccountWqId && ACCOUNT_SCOPED_DATABASE_ACTIONS.has(action)
            ? { ...payload, accountWqId: activeSyncAccountWqId }
            : payload;
        return new Promise((resolve, reject) => {
            const timeoutId = setTimeout(() => {
                pendingDatabaseRequests.delete(requestId);
                reject(new Error(`ProdMemo database request timed out: ${action}`));
            }, 60000);
            pendingDatabaseRequests.set(requestId, { resolve, reject, timeoutId });
            window.postMessage({
                type: 'WQP_PRODMEMO_DB_REQUEST',
                requestId,
                action,
                payload: requestPayload,
            }, '*');
        });
    }

    function postProgress(payload) {
        window.postMessage({ type: 'WQP_PRODMEMO_SYNC_PROGRESS', payload }, '*');
    }

    async function responseJson(response) {
        const text = await response.text();
        if (!text.trim()) return null;
        return JSON.parse(text);
    }

    async function fetchAlphaPage(offset, signal, limit = ALPHA_PAGE_LIMIT, filters = {}) {
        const query = new URLSearchParams({
            limit: String(limit),
            offset: String(offset),
            order: '-dateSubmitted',
            hidden: 'false',
        });
        let url = `https://api.worldquantbrain.com/users/self/alphas?${query.toString()}&status%21=UNSUBMITTED%1FIS-FAIL`;
        if (filters.before) url += `&dateSubmitted%3C${encodeURIComponent(filters.before)}`;
        if (filters.after) url += `&dateSubmitted%3E${encodeURIComponent(filters.after)}`;
        const response = await nativeFetch(url, {
            headers: { accept: 'application/json;version=4.0' },
            credentials: 'include',
            signal,
        });
        if (response.status === 401 || response.status === 403) {
            const error = new Error(`Alpha 同步认证失败：HTTP ${response.status}`);
            error.fatal = true;
            throw error;
        }
        if (!response.ok) {
            const error = new Error(`Alpha 列表请求失败：HTTP ${response.status}`);
            error.fatal = response.status >= 400
                && response.status < 500
                && ![408, 429].includes(response.status);
            throw error;
        }
        const data = await response.json();
        if (!Array.isArray(data.results) || !Number.isFinite(Number(data.count))) {
            throw new Error('Alpha 列表响应格式无效。');
        }
        return data;
    }

    function fetchAlphaPageWithRetries(
        offset,
        signal,
        limit = ALPHA_PAGE_LIMIT,
        filters = {},
        requireResults = false,
    ) {
        return withPersistentRetries(
            async () => {
                const page = await fetchAlphaPage(offset, signal, limit, filters);
                if (requireResults && page.results.length === 0) {
                    throw new Error(`Alpha 页面 offset ${offset} 意外返回空结果。`);
                }
                return page;
            },
            signal,
            (waitMs, attempt, error) => postProgress({
                phase: 'alphas-retry',
                failed: 1,
                message: `Alpha 页面 offset ${offset} 获取失败（第 ${attempt} 次）：${error.message}；${waitMs / 1000} 秒后重试，不会跳过。`,
            }),
        );
    }

    function oldestSubmittedAt(results) {
        let oldest = '';
        let oldestTime = Infinity;
        for (const alpha of results) {
            const timestamp = Date.parse(alpha?.dateSubmitted);
            if (!Number.isFinite(timestamp) || timestamp >= oldestTime) continue;
            oldestTime = timestamp;
            oldest = alpha.dateSubmitted;
        }
        return oldest;
    }

    function nextExclusiveUpperBound(oldest) {
        const timestamp = Date.parse(oldest);
        if (!Number.isFinite(timestamp)) return '';
        // Add 1 ms so records sharing the boundary timestamp are fetched again and de-duplicated.
        return new Date(timestamp + 1).toISOString();
    }

    async function fetchAllSubmittedAlphas(signal) {
        const alphaIds = new Set();
        let completedPages = 0;
        let before = '';
        let windowNumber = 0;

        async function savePage(page, offset, totalPages, windowResults) {
            const submitted = page.results.filter((alpha) => (
                alpha?.id && alpha.dateSubmitted && alpha.status !== 'UNSUBMITTED'
            ));
            await databaseRequest('SAVE_ALPHA_BATCH', { alphas: submitted, submitted: true, silent: true });
            submitted.forEach((alpha) => alphaIds.add(alpha.id));
            windowResults.push(...page.results);
            completedPages += 1;
            postProgress({
                phase: 'alphas',
                current: completedPages,
                total: 0,
                success: alphaIds.size,
                failed: 0,
                message: `Alpha 时间段 ${windowNumber} · 页面 ${Math.floor(offset / ALPHA_PAGE_LIMIT) + 1}/${totalPages} · 已获取 ${alphaIds.size}`,
            });
        }

        while (true) {
            checkStopped(signal);
            windowNumber += 1;
            const filters = before ? { before } : {};
            const firstPage = await fetchAlphaPageWithRetries(0, signal, ALPHA_PAGE_LIMIT, filters);
            if (!firstPage.results.length) break;

            const windowCount = Math.min(Number(firstPage.count), ALPHA_WINDOW_LIMIT);
            const totalPages = Math.max(1, Math.ceil(windowCount / ALPHA_PAGE_LIMIT));
            const windowResults = [];
            const idsBeforeWindow = alphaIds.size;
            await savePage(firstPage, 0, totalPages, windowResults);
            for (let offset = ALPHA_PAGE_LIMIT; offset < windowCount; offset += ALPHA_PAGE_LIMIT) {
                checkStopped(signal);
                const page = await fetchAlphaPageWithRetries(
                    offset,
                    signal,
                    ALPHA_PAGE_LIMIT,
                    filters,
                    true,
                );
                await savePage(page, offset, totalPages, windowResults);
            }

            if (Number(firstPage.count) <= ALPHA_WINDOW_LIMIT) break;
            const oldest = oldestSubmittedAt(windowResults);
            const nextBefore = nextExclusiveUpperBound(oldest);
            if (!nextBefore || nextBefore === before || alphaIds.size === idsBeforeWindow) {
                throw new Error('Alpha 时间分页无法继续推进；为避免漏掉数据，已停止本次 Alpha 补齐。');
            }
            before = nextBefore;
            postProgress({
                phase: 'alphas-window',
                current: completedPages,
                total: 0,
                success: alphaIds.size,
                failed: 0,
                message: `前 1,000 条已获取，继续获取 ${before} 之前提交的 Alpha。`,
            });
        }

        const uniqueIds = [...alphaIds];
        await databaseRequest('RECONCILE_ALPHAS', { alphaIds: uniqueIds });
        return uniqueIds;
    }

    async function fetchMissingSubmittedAlphas(signal, knownIds, missingCount) {
        const addedIds = new Set();
        const seenIds = new Set(knownIds);
        let completedPages = 0;
        let before = '';
        let windowNumber = 0;

        async function collectPage(page, offset, totalPages, windowResults) {
            const newAlphas = page.results.filter((alpha) => (
                alpha?.id
                && alpha.dateSubmitted
                && alpha.status !== 'UNSUBMITTED'
                && !seenIds.has(alpha.id)
            ));
            if (newAlphas.length) {
                await databaseRequest('SAVE_ALPHA_BATCH', {
                    alphas: newAlphas,
                    submitted: true,
                    silent: true,
                });
                newAlphas.forEach((alpha) => {
                    seenIds.add(alpha.id);
                    addedIds.add(alpha.id);
                });
            }
            windowResults.push(...page.results);
            completedPages += 1;
            postProgress({
                phase: 'incremental-alphas',
                mode: 'incremental',
                current: Math.min(addedIds.size, missingCount),
                total: missingCount,
                success: addedIds.size,
                failed: 0,
                message: `Alpha 增量段 ${windowNumber} · 页面 ${Math.floor(offset / ALPHA_PAGE_LIMIT) + 1}/${totalPages} · 已发现 ${addedIds.size}/${missingCount}`,
            });
        }

        while (addedIds.size < missingCount) {
            checkStopped(signal);
            windowNumber += 1;
            const filters = before ? { before } : {};
            const firstPage = await fetchAlphaPageWithRetries(0, signal, ALPHA_PAGE_LIMIT, filters);
            if (!firstPage.results.length) break;
            const windowCount = Math.min(Number(firstPage.count), ALPHA_WINDOW_LIMIT);
            const totalPages = Math.max(1, Math.ceil(windowCount / ALPHA_PAGE_LIMIT));
            const windowResults = [];
            await collectPage(firstPage, 0, totalPages, windowResults);

            for (
                let offset = ALPHA_PAGE_LIMIT;
                offset < windowCount && addedIds.size < missingCount;
                offset += ALPHA_PAGE_LIMIT
            ) {
                checkStopped(signal);
                const page = await fetchAlphaPageWithRetries(
                    offset,
                    signal,
                    ALPHA_PAGE_LIMIT,
                    filters,
                    true,
                );
                await collectPage(page, offset, totalPages, windowResults);
            }
            if (addedIds.size >= missingCount || Number(firstPage.count) <= ALPHA_WINDOW_LIMIT) break;

            const nextBefore = nextExclusiveUpperBound(oldestSubmittedAt(windowResults));
            if (!nextBefore || nextBefore === before) break;
            before = nextBefore;
        }
        return [...addedIds];
    }

    async function requestPnlOnce(alphaId, signal) {
        const response = await nativeFetch(
            `https://api.worldquantbrain.com/alphas/${encodeURIComponent(alphaId)}/recordsets/pnl`,
            {
                headers: { accept: 'application/json;version=2.0' },
                credentials: 'include',
                signal,
            },
        );
        if (response.status === 401 || response.status === 403) {
            const error = new Error(`PnL 同步认证失败：HTTP ${response.status}`);
            error.fatal = true;
            throw error;
        }
        if ([202, 204, 429].includes(response.status) || !response.ok) {
            return { ready: false, reason: `HTTP ${response.status}` };
        }
        try {
            const data = await responseJson(response);
            return data && Array.isArray(data.records) && data.records.length
                ? { ready: true, data }
                : { ready: false, reason: 'PnL 响应为空' };
        } catch (error) {
            return { ready: false, reason: error.message || 'PnL JSON 无效' };
        }
    }

    async function runConcurrent(items, concurrency, worker, signal) {
        let nextIndex = 0;
        async function runWorker() {
            while (true) {
                checkStopped(signal);
                const index = nextIndex++;
                if (index >= items.length) return;
                await worker(items[index], index);
            }
        }
        await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, runWorker));
    }

    async function fetchPnlRound(alphaIds, signal, onSaved) {
        const pending = [];
        await runConcurrent(alphaIds, PNL_CONCURRENCY, async (alphaId) => {
            try {
                const result = await requestPnlOnce(alphaId, signal);
                if (!result.ready) {
                    pending.push(alphaId);
                    return;
                }
                await databaseRequest('SAVE_PNL', { alphaId, data: result.data, silent: true });
                onSaved(alphaId);
            } catch (error) {
                if (error.fatal) {
                    syncAbortController?.abort();
                    throw error;
                }
                if (error.name === 'AbortError') throw error;
                pending.push(alphaId);
            }
        }, signal);
        return pending;
    }

    async function fetchAllPnls(alphaIds, signal, mode) {
        const savedIds = new Set();
        const requestFailedIds = new Set();
        const totalBatches = Math.ceil(alphaIds.length / PNL_BATCH_SIZE);
        for (let start = 0; start < alphaIds.length; start += PNL_BATCH_SIZE) {
            checkStopped(signal);
            const batch = alphaIds.slice(start, start + PNL_BATCH_SIZE);
            const batchNumber = Math.floor(start / PNL_BATCH_SIZE) + 1;
            const onSaved = (alphaId) => savedIds.add(alphaId);
            postProgress({
                phase: 'pnl',
                mode,
                current: start,
                total: alphaIds.length,
                success: savedIds.size,
                failed: 0,
                message: `PnL 批次 ${batchNumber}/${totalBatches}（${batch.length} 个 Alpha）`,
            });
            let pending = await fetchPnlRound(batch, signal, onSaved);
            for (let round = 0; round < RETRY_DELAYS.length && pending.length; round += 1) {
                const waitMs = RETRY_DELAYS[round];
                postProgress({
                    phase: 'pnl-retry',
                    mode,
                    current: start + batch.length - pending.length,
                    total: alphaIds.length,
                    success: savedIds.size,
                    failed: pending.length,
                    message: `${pending.length} 个 PnL 待重试，${waitMs / 1000} 秒后继续。`,
                });
                await delay(waitMs, signal);
                pending = await fetchPnlRound(pending, signal, onSaved);
            }
            pending.forEach((alphaId) => requestFailedIds.add(alphaId));
        }
        const state = await databaseRequest('GET_SYNC_STATE');
        const requested = new Set(alphaIds);
        const failedIds = [...new Set([
            ...requestFailedIds,
            ...state.missingPnlIds.filter((alphaId) => requested.has(alphaId)),
        ])];
        return { success: alphaIds.length - failedIds.length, failedIds };
    }

    async function fetchAlphaDetail(alphaId, signal) {
        const response = await nativeFetch(
            `https://api.worldquantbrain.com/alphas/${encodeURIComponent(alphaId)}`,
            {
                headers: { accept: 'application/json;version=4.0' },
                credentials: 'include',
                signal,
            },
        );
        if (!response.ok) throw new Error(`Alpha ${alphaId} 元数据请求失败：HTTP ${response.status}`);
        return response.json();
    }

    function fetchAlphaDetailWithRetries(alphaId, signal) {
        return withRetries(() => fetchAlphaDetail(alphaId, signal), signal);
    }

    async function fetchPnlWithRetries(alphaId, signal) {
        let lastReason = '';
        for (let attempt = 0; attempt <= RETRY_DELAYS.length; attempt += 1) {
            checkStopped(signal);
            const result = await requestPnlOnce(alphaId, signal);
            if (result.ready) return result.data;
            lastReason = result.reason;
            if (attempt < RETRY_DELAYS.length) await delay(RETRY_DELAYS[attempt], signal);
        }
        throw new Error(`Alpha ${alphaId} PnL 获取失败：${lastReason || '重试耗尽'}`);
    }

    async function ensureAlphaData(alphaId, signal, options = {}) {
        const [alpha, pnl] = await Promise.all([
            fetchAlphaDetailWithRetries(alphaId, signal),
            fetchPnlWithRetries(alphaId, signal),
        ]);
        await databaseRequest('SAVE_ALPHA_BATCH', {
            alphas: [alpha],
            submitted: false,
            silent: options.silent === true,
        });
        await databaseRequest('SAVE_PNL', {
            alphaId,
            data: pnl,
            silent: options.silent === true,
        });
        return { alpha, pnl };
    }

    async function backfillKnownReferences(signal) {
        const state = await databaseRequest('GET_SYNC_STATE');
        const ids = state.backfillIds || [];
        const failedIds = [];
        let completed = 0;
        await runConcurrent(ids, BACKFILL_CONCURRENCY, async (alphaId) => {
            try {
                await ensureAlphaData(alphaId, signal, { silent: true });
            } catch (error) {
                if (error.name === 'AbortError') throw error;
                failedIds.push(alphaId);
            } finally {
                completed += 1;
                postProgress({
                    phase: 'backfill',
                    current: completed,
                    total: ids.length,
                    success: completed - failedIds.length,
                    failed: failedIds.length,
                    message: `历史 Prod 参考回填 ${completed}/${ids.length}`,
                });
            }
        }, signal);
        return { total: ids.length, failedIds };
    }

    async function runFullSync(signal) {
        const alphaIds = await fetchAllSubmittedAlphas(signal);
        const pnlResult = await fetchAllPnls(alphaIds, signal, 'full');
        const backfill = await backfillKnownReferences(signal);
        const finalState = await databaseRequest('GET_SYNC_STATE');
        const finalMissing = new Set(finalState.missingPnlIds);
        pnlResult.failedIds = pnlResult.failedIds.filter((alphaId) => finalMissing.has(alphaId));
        pnlResult.success = alphaIds.length - pnlResult.failedIds.length;
        await databaseRequest('SET_SYNC_META', {
            patch: {
                status: 'completed',
                fullCompleted: true,
                fullSyncedAt: Date.now(),
                alphaCount: alphaIds.length,
                pnlSuccess: pnlResult.success,
                failedIds: pnlResult.failedIds,
                backfillFailedIds: backfill.failedIds,
            },
        });
        return { alphaIds, pnlResult, backfill };
    }

    async function readCurrentWqId(signal) {
        try {
            const response = await nativeFetch('https://api.worldquantbrain.com/users/self/consultant/summary', {
                method: 'GET',
                credentials: 'include',
                cache: 'no-store',
                headers: { accept: 'application/json' },
                signal,
            });
            if (!response.ok) return '';
            const data = await response.json();
            return String(data?.leaderboard?.user || '').trim();
        } catch {
            return '';
        }
    }

    async function runIncrementalSync(signal) {
        let localState = await databaseRequest('GET_SYNC_STATE');
        const accountWqId = activeSyncAccountWqId;
        postProgress({
            phase: 'incremental-check',
            mode: 'incremental',
            message: '正在用小批量请求探测远端 Submitted Alpha 总数。',
        });
        const remoteHead = await fetchAlphaPageWithRetries(0, signal, 1);
        const remoteCount = Number(remoteHead.count);
        const localIds = new Set(localState.alphaIds);
        const localAlphaCount = localIds.size;
        const localSubmittedPnlCount = localAlphaCount - localState.missingPnlIds.length;
        postProgress({
            phase: 'incremental-probe',
            mode: 'incremental',
            current: localAlphaCount,
            total: remoteCount,
            success: localSubmittedPnlCount,
            failed: localState.missingPnlIds.length,
            message: `远端 ${remoteCount} · 本地 Alpha ${localAlphaCount} · 本地 PnL ${localSubmittedPnlCount}`,
        });

        let alphaAction = 'skipped';
        let addedAlphaIds = [];
        if (localAlphaCount !== remoteCount) {
            if (localAlphaCount < remoteCount) {
                alphaAction = 'incremental';
                const missingCount = remoteCount - localAlphaCount;
                postProgress({
                    phase: 'incremental-alphas',
                    mode: 'incremental',
                    current: 0,
                    total: missingCount,
                    message: `Submitted Alpha 少 ${missingCount} 个，开始从最新记录增量补齐。`,
                });
                addedAlphaIds = await fetchMissingSubmittedAlphas(signal, localIds, missingCount);
            } else {
                alphaAction = 'reconciled';
                postProgress({
                    phase: 'incremental-alphas-reconcile',
                    mode: 'incremental',
                    message: `本地 Submitted Alpha 多于远端（${localAlphaCount} / ${remoteCount}），开始校正快照。`,
                });
                await fetchAllSubmittedAlphas(signal);
            }
            localState = await databaseRequest('GET_SYNC_STATE');
            if (localState.alphaIds.length !== remoteCount) {
                alphaAction = 'reconciled';
                postProgress({
                    phase: 'incremental-alphas-reconcile',
                    mode: 'incremental',
                    message: `增量补齐后数量仍不一致（本地 ${localState.alphaIds.length} / 远端 ${remoteCount}），开始完整校正。`,
                });
                const refreshedIds = await fetchAllSubmittedAlphas(signal);
                addedAlphaIds = refreshedIds.filter((alphaId) => !localIds.has(alphaId));
                localState = await databaseRequest('GET_SYNC_STATE');
            }
        } else {
            postProgress({
                phase: 'incremental-alphas-skipped',
                mode: 'incremental',
                success: localAlphaCount,
                message: `Submitted Alpha 数量已一致（${remoteCount}），跳过 Alpha 获取。`,
            });
        }

        const submittedPnlCount = localState.alphaIds.length - localState.missingPnlIds.length;
        const pnlTargets = submittedPnlCount === remoteCount
            ? []
            : [...new Set(localState.missingPnlIds)];
        if (!pnlTargets.length) {
            postProgress({
                phase: 'incremental-pnl-skipped',
                mode: 'incremental',
                success: submittedPnlCount,
                message: `Submitted Alpha 的 PnL 数量已一致（${remoteCount}），跳过 PnL 获取。`,
            });
        } else {
            postProgress({
                phase: 'incremental-pnl',
                mode: 'incremental',
                current: 0,
                total: pnlTargets.length,
                success: 0,
                failed: 0,
                message: `PnL 数量不足（本地 ${submittedPnlCount} / 远端 ${remoteCount}），仅补齐 ${pnlTargets.length} 个缺失 PnL。`,
            });
        }
        const pnlResult = pnlTargets.length
            ? await fetchAllPnls(pnlTargets, signal, 'incremental')
            : { success: 0, failedIds: [] };
        const backfill = await backfillKnownReferences(signal);
        const finalState = await databaseRequest('GET_SYNC_STATE');
        const finalMissing = new Set(finalState.missingPnlIds);
        pnlResult.failedIds = pnlResult.failedIds.filter((alphaId) => finalMissing.has(alphaId));
        pnlResult.success = pnlTargets.length - pnlResult.failedIds.length;
        const finalSubmittedPnlCount = finalState.alphaIds.length - finalState.missingPnlIds.length;
        const countsComplete = finalState.alphaIds.length === remoteCount
            && finalSubmittedPnlCount === remoteCount;
        await databaseRequest('SET_SYNC_META', {
            patch: {
                status: 'completed',
                fullCompleted: countsComplete,
                incrementalSyncedAt: Date.now(),
                remoteCount,
                alphaCount: finalState.alphaIds.length,
                submittedPnlCount: finalSubmittedPnlCount,
                accountWqId,
                alphaAction,
                added: addedAlphaIds.length,
                pnlRequested: pnlTargets.length,
                pnlSuccess: pnlResult.success,
                failedIds: pnlResult.failedIds,
                backfillFailedIds: backfill.failedIds,
            },
        });
        return {
            remoteCount,
            alphaAction,
            addedAlphaIds,
            pnlRequested: pnlTargets.length,
            pnlResult,
            backfill,
            countsComplete,
        };
    }

    async function startSync(requestedMode = 'auto') {
        if (syncRunning) {
            postProgress({ phase: 'busy', mode: requestedMode, message: '已有 ProdMemo 同步任务正在运行，将等待现有任务完成。' });
            return;
        }
        syncRunning = true;
        syncAbortController = new AbortController();
        const signal = syncAbortController.signal;
        let actualMode = requestedMode;
        try {
            if (requestedMode === 'auto') {
                actualMode = 'incremental';
            }
            activeSyncAccountWqId = await readCurrentWqId(signal);
            if (!activeSyncAccountWqId) {
                throw new Error('无法读取当前 WQ ID，请先登录 WorldQuant BRAIN 后再同步。');
            }
            await databaseRequest('SET_SYNC_META', {
                patch: { status: 'running', mode: actualMode, startedAt: Date.now(), lastError: '' },
            });
            postProgress({
                phase: actualMode === 'full' ? 'alphas' : 'incremental-check',
                mode: actualMode,
                current: 0,
                total: 0,
                success: 0,
                failed: 0,
                message: actualMode === 'full' ? '开始全量 Alpha + PnL 同步。' : '开始增量同步。',
            });
            const result = actualMode === 'full'
                ? await runFullSync(signal)
                : await runIncrementalSync(signal);
            postProgress({
                phase: 'completed',
                mode: actualMode,
                result,
                message: actualMode === 'full' ? '全量 Alpha + PnL 同步完成。' : '增量同步完成。',
            });
        } catch (error) {
            const stopped = error.name === 'AbortError';
            await databaseRequest('SET_SYNC_META', {
                patch: {
                    status: stopped ? 'stopped' : 'error',
                    mode: actualMode,
                    lastError: stopped ? '' : (error.message || String(error)),
                },
            }).catch(() => {});
            postProgress({
                phase: stopped ? 'stopped' : 'error',
                mode: actualMode,
                message: stopped ? 'ProdMemo 同步已停止。' : (error.message || String(error)),
            });
        } finally {
            syncRunning = false;
            syncAbortController = null;
            activeSyncAccountWqId = '';
        }
    }

    function ensureReference(alphaId) {
        if (referenceRequests.has(alphaId)) return referenceRequests.get(alphaId);
        const request = ensureAlphaData(alphaId, undefined, { silent: false })
            .catch((error) => console.warn(`[WQP ProdMemo] 无法补齐 Prod 参考 ${alphaId}:`, error))
            .finally(() => referenceRequests.delete(alphaId));
        referenceRequests.set(alphaId, request);
        return request;
    }

    window.addEventListener('message', (event) => {
        if (event.source !== window || !event.data?.type) return;
        if (event.data.type === 'WQP_PRODMEMO_DB_RESPONSE') {
            const pending = pendingDatabaseRequests.get(event.data.requestId);
            if (!pending) return;
            pendingDatabaseRequests.delete(event.data.requestId);
            clearTimeout(pending.timeoutId);
            if (event.data.response?.ok) pending.resolve(event.data.response.data);
            else pending.reject(new Error(event.data.response?.error || 'ProdMemo database request failed'));
            return;
        }
        if (event.data.type === 'WQP_PRODMEMO_START_SYNC') {
            startSync(event.data.mode || 'auto');
            return;
        }
        if (event.data.type === 'WQP_PRODMEMO_STOP_SYNC') {
            if (syncRunning) {
                syncAbortController?.abort();
            } else {
                databaseRequest('SET_SYNC_META', { patch: { status: 'stopped', lastError: '' } }).catch(() => {});
                postProgress({ phase: 'stopped', message: '当前没有运行中的 ProdMemo 同步任务。' });
            }
            return;
        }
        if (event.data.type === 'WQP_PRODMEMO_PREPARE_CURRENT') {
            const { requestId, alphaId } = event.data;
            ensureAlphaData(alphaId)
                .then(() => window.postMessage({
                    type: 'WQP_PRODMEMO_CURRENT_READY', requestId, alphaId, ok: true,
                }, '*'))
                .catch((error) => window.postMessage({
                    type: 'WQP_PRODMEMO_CURRENT_READY', requestId, alphaId, ok: false,
                    error: error.message || String(error),
                }, '*'));
        }
    });

    window.fetch = async function (...args) {
        const response = await nativeFetch(...args);
        try {
            const requestUrl = response.url || (typeof args[0] === 'string' ? args[0] : args[0]?.url || '');
            const corrMatch = requestUrl.match(/\/alphas\/([^/]+)\/correlations\/([^/?#]+)/);
            if (corrMatch && response.ok && response.status !== 204) {
                response.clone().json().then((data) => {
                    window.postMessage({
                        type: 'WQP_PRODMEMO_PLATFORM_CORR',
                        alphaId: corrMatch[1],
                        corrType: corrMatch[2],
                        data,
                    }, '*');
                    if (String(corrMatch[2]).toLowerCase().includes('prod')) ensureReference(corrMatch[1]);
                }).catch(() => {});
            }
            const recordsetsMatch = requestUrl.match(/\/alphas\/([^/]+)\/recordsets(?:[?#]|$)/);
            if (recordsetsMatch) {
                window.postMessage({ type: 'WQP_PRODMEMO_ALPHA_VIEW', alphaId: recordsetsMatch[1] }, '*');
            }
        } catch (error) {
            console.warn('[WQP ProdMemo] Fetch interceptor failed:', error);
        }
        return response;
    };
})();
