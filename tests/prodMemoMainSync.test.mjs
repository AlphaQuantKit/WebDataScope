import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const MAIN_SCRIPT_URL = new URL('../src/content/platform/prodmemo/prodmemoMain.js', import.meta.url);

function alphaAt(index) {
    return {
        id: `alpha-${index}`,
        dateSubmitted: new Date(Date.parse('2026-08-01T00:00:00.000Z') - index * 60000).toISOString(),
        status: 'ACTIVE',
        stage: 'OS',
        settings: { region: 'USA', universe: 'TOP3000', delay: 1 },
        classifications: [],
    };
}

test('full Alpha sync retries the same page and crosses the 1,000 limit with a time upper bound', async () => {
    const source = await readFile(MAIN_SCRIPT_URL, 'utf8');
    const listeners = [];
    const alphaUrls = [];
    let failedOffset300 = false;
    let reconciledIds = [];
    let resolveStopped;
    const stopped = new Promise((resolve) => { resolveStopped = resolve; });

    async function nativeFetch(url, options = {}) {
        const rawUrl = String(url);
        if (rawUrl.includes('/users/self/consultant/summary')) {
            return {
                ok: true,
                status: 200,
                json: async () => ({ leaderboard: { user: 'test-owner' } }),
            };
        }
        if (rawUrl.includes('/users/self/alphas?')) {
            alphaUrls.push(rawUrl);
            const parsed = new URL(rawUrl);
            const offset = Number(parsed.searchParams.get('offset'));
            const hasTimeUpperBound = rawUrl.includes('dateSubmitted%3C');
            if (!hasTimeUpperBound && offset === 300 && !failedOffset300) {
                failedOffset300 = true;
                throw new TypeError('temporary connection failure');
            }
            const indices = hasTimeUpperBound
                ? Array.from({ length: 501 }, (_, index) => index + 999)
                : Array.from({ length: 1000 }, (_, index) => index);
            return {
                ok: true,
                status: 200,
                url: rawUrl,
                json: async () => ({
                    count: hasTimeUpperBound ? 501 : 1500,
                    results: indices.slice(offset, offset + 100).map(alphaAt),
                }),
            };
        }
        if (rawUrl.includes('/recordsets/pnl')) {
            if (options.signal?.aborted) throw new DOMException('Synchronization stopped', 'AbortError');
            return new Promise((resolve, reject) => {
                options.signal?.addEventListener('abort', () => {
                    reject(new DOMException('Synchronization stopped', 'AbortError'));
                }, { once: true });
            });
        }
        throw new Error(`Unexpected request: ${rawUrl}`);
    }

    const fakeWindow = {
        fetch: nativeFetch,
        addEventListener(type, listener) {
            if (type === 'message') listeners.push(listener);
        },
        postMessage(message) {
            if (message?.type === 'WQP_PRODMEMO_DB_REQUEST') {
                let data = {};
                if (message.action === 'RECONCILE_ALPHAS') {
                    reconciledIds = message.payload.alphaIds;
                } else if (message.action === 'GET_SYNC_STATE') {
                    data = { alphaIds: [], missingPnlIds: [], backfillIds: [], sync: null };
                }
                queueMicrotask(() => dispatch({
                    type: 'WQP_PRODMEMO_DB_RESPONSE',
                    requestId: message.requestId,
                    response: { ok: true, data },
                }));
                if (message.action === 'RECONCILE_ALPHAS') {
                    queueMicrotask(() => dispatch({ type: 'WQP_PRODMEMO_STOP_SYNC' }));
                }
                return;
            }
            if (message?.type === 'WQP_PRODMEMO_SYNC_PROGRESS' && message.payload?.phase === 'stopped') {
                resolveStopped();
            }
        },
    };

    function dispatch(data) {
        listeners.forEach((listener) => listener({ source: fakeWindow, data }));
    }

    const context = vm.createContext({
        window: fakeWindow,
        URLSearchParams,
        AbortController,
        DOMException,
        console,
        queueMicrotask,
        setTimeout(callback, delay) {
            if (delay < 60000) queueMicrotask(callback);
            return Symbol('timer');
        },
        clearTimeout() {},
    });
    vm.runInContext(source, context, { filename: 'prodmemoMain.js' });
    dispatch({ type: 'WQP_PRODMEMO_START_SYNC', mode: 'full' });
    await stopped;

    assert.equal(reconciledIds.length, 1500);
    assert.equal(new Set(reconciledIds).size, 1500);
    assert.ok(alphaUrls.some((url) => url.includes('dateSubmitted%3C')));

    const unfilteredOffsets = alphaUrls
        .filter((url) => !url.includes('dateSubmitted%3C'))
        .map((url) => Number(new URL(url).searchParams.get('offset')));
    assert.equal(Math.max(...unfilteredOffsets), 900);
    assert.deepEqual(
        unfilteredOffsets.slice(unfilteredOffsets.indexOf(300), unfilteredOffsets.indexOf(300) + 2),
        [300, 300],
    );

    const filteredOffsets = alphaUrls
        .filter((url) => url.includes('dateSubmitted%3C'))
        .map((url) => Number(new URL(url).searchParams.get('offset')));
    assert.equal(filteredOffsets[0], 0);
    assert.equal(Math.max(...filteredOffsets), 500);
});

async function runIncrementalProbeScenario({
    missingPnlIds,
    localAlphaIds = ['alpha-0', 'alpha-1'],
    remoteAlphas = [alphaAt(0), alphaAt(1)],
}) {
    const source = await readFile(MAIN_SCRIPT_URL, 'utf8');
    const listeners = [];
    const actions = [];
    const fetchUrls = [];
    const state = {
        alphaIds: [...localAlphaIds],
        missingPnlIds: [...missingPnlIds],
        backfillIds: [],
        sync: null,
    };
    let completedResult;
    let resolveCompleted;
    const completed = new Promise((resolve) => { resolveCompleted = resolve; });

    async function nativeFetch(url) {
        const rawUrl = String(url);
        fetchUrls.push(rawUrl);
        if (rawUrl.includes('/users/self/consultant/summary')) {
            return {
                ok: true,
                status: 200,
                json: async () => ({ leaderboard: { user: 'test-owner' } }),
            };
        }
        if (rawUrl.includes('/users/self/alphas?')) {
            const parsed = new URL(rawUrl);
            const offset = Number(parsed.searchParams.get('offset'));
            const limit = Number(parsed.searchParams.get('limit'));
            return {
                ok: true,
                status: 200,
                url: rawUrl,
                json: async () => ({
                    count: remoteAlphas.length,
                    results: remoteAlphas.slice(offset, offset + limit),
                }),
            };
        }
        if (rawUrl.includes('/recordsets/pnl')) {
            return {
                ok: true,
                status: 200,
                url: rawUrl,
                text: async () => JSON.stringify({ records: [['2026-01-01', 1], ['2026-01-02', 2]] }),
            };
        }
        throw new Error(`Unexpected request: ${rawUrl}`);
    }

    const fakeWindow = {
        fetch: nativeFetch,
        addEventListener(type, listener) {
            if (type === 'message') listeners.push(listener);
        },
        postMessage(message) {
            if (message?.type === 'WQP_PRODMEMO_DB_REQUEST') {
                actions.push({ action: message.action, payload: message.payload });
                let data = {};
                if (message.action === 'GET_SYNC_STATE') data = structuredClone(state);
                if (message.action === 'SAVE_ALPHA_BATCH') {
                    for (const alpha of message.payload.alphas) {
                        if (state.alphaIds.includes(alpha.id)) continue;
                        state.alphaIds.push(alpha.id);
                        state.missingPnlIds.push(alpha.id);
                    }
                    data = { saved: message.payload.alphas.length };
                }
                if (message.action === 'SAVE_PNL') {
                    state.missingPnlIds = state.missingPnlIds.filter((id) => id !== message.payload.alphaId);
                    data = { saved: message.payload.data.records.length };
                }
                queueMicrotask(() => dispatch({
                    type: 'WQP_PRODMEMO_DB_RESPONSE',
                    requestId: message.requestId,
                    response: { ok: true, data },
                }));
                return;
            }
            if (message?.type === 'WQP_PRODMEMO_SYNC_PROGRESS' && message.payload?.phase === 'completed') {
                completedResult = message.payload.result;
                resolveCompleted();
            }
        },
    };

    function dispatch(data) {
        listeners.forEach((listener) => listener({ source: fakeWindow, data }));
    }

    vm.runInContext(source, vm.createContext({
        window: fakeWindow,
        URLSearchParams,
        AbortController,
        DOMException,
        console,
        structuredClone,
        queueMicrotask,
        setTimeout() { return Symbol('timer'); },
        clearTimeout() {},
    }), { filename: 'prodmemoMain.js' });
    dispatch({ type: 'WQP_PRODMEMO_START_SYNC', mode: 'incremental' });
    await completed;
    return { actions, fetchUrls, completedResult };
}

test('incremental probe skips both Alpha and PnL when their local counts match remote count', async () => {
    const result = await runIncrementalProbeScenario({ missingPnlIds: [] });
    assert.equal(result.fetchUrls.filter((url) => url.includes('/users/self/alphas?')).length, 1);
    assert.equal(result.fetchUrls.filter((url) => url.includes('/recordsets/pnl')).length, 0);
    assert.equal(result.actions.some((item) => item.action === 'SAVE_ALPHA_BATCH'), false);
    assert.equal(result.actions.some((item) => item.action === 'SAVE_PNL'), false);
    assert.equal(result.completedResult.alphaAction, 'skipped');
    assert.equal(result.completedResult.pnlRequested, 0);
});

test('incremental probe skips Alpha but fetches only missing PnL when just the PnL count is lower', async () => {
    const result = await runIncrementalProbeScenario({ missingPnlIds: ['alpha-1'] });
    assert.equal(result.fetchUrls.filter((url) => url.includes('/users/self/alphas?')).length, 1);
    assert.equal(result.fetchUrls.filter((url) => url.includes('/recordsets/pnl')).length, 1);
    assert.equal(result.actions.some((item) => item.action === 'SAVE_ALPHA_BATCH'), false);
    assert.deepEqual(
        result.actions.filter((item) => item.action === 'SAVE_PNL').map((item) => item.payload.alphaId),
        ['alpha-1'],
    );
    assert.equal(result.completedResult.alphaAction, 'skipped');
    assert.equal(result.completedResult.pnlRequested, 1);
});

test('incremental probe fetches only the missing Alpha and then its missing PnL', async () => {
    const result = await runIncrementalProbeScenario({
        localAlphaIds: ['alpha-1'],
        missingPnlIds: [],
    });
    assert.equal(result.fetchUrls.filter((url) => url.includes('/users/self/alphas?')).length, 2);
    assert.deepEqual(
        result.actions.filter((item) => item.action === 'SAVE_ALPHA_BATCH')
            .flatMap((item) => item.payload.alphas.map((alpha) => alpha.id)),
        ['alpha-0'],
    );
    assert.deepEqual(
        result.actions.filter((item) => item.action === 'SAVE_PNL').map((item) => item.payload.alphaId),
        ['alpha-0'],
    );
    assert.equal(result.completedResult.alphaAction, 'incremental');
    assert.equal(result.completedResult.pnlRequested, 1);
    assert.ok(result.actions.filter((item) => (
        ['GET_SYNC_STATE', 'SAVE_ALPHA_BATCH', 'SAVE_PNL'].includes(item.action)
    )).every((item) => item.payload.accountWqId === 'test-owner'));
});
