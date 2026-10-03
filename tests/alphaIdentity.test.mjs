import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const prodMemoSource = await readFile(new URL('../src/content/platform/prodmemo/prodmemo.js', import.meta.url), 'utf8');
const assistantSource = await readFile(new URL('../src/content/platform/alpha/alphaDescriptionAssistant.js', import.meta.url), 'utf8');
const origin = 'https://platform.worldquantbrain.com';

function prodMemoPage(path, options = {}) {
    const messages = [];
    const detailRequests = [];
    const pageListeners = [];
    const intervalCallbacks = [];
    const timers = new Map();
    let timerId = 0;
    let observerCallback;
    let currentCard;
    let calculate;
    let retryDetail;
    let detailError = options.detailError;
    let panelOpen = Boolean(options.panelAlphaId);
    let panelAlphaId = options.panelAlphaId || '';
    const pendingDetails = [];
    const location = {};
    function navigate(nextPath) {
        const url = new URL(nextPath, origin);
        Object.assign(location, { href: url.href, pathname: url.pathname, origin: url.origin });
    }
    navigate(path);
    const anchor = { closest() { return null; }, insertAdjacentElement(position, card) { currentCard = card; card.mount = 'page'; } };
    function createPanelAnchor() {
        return { isConnected: true, closest() { return panelOpen ? null : panel; }, insertAdjacentElement(position, card) { currentCard = card; card.mount = 'panel'; } };
    }
    let panelAnchor = createPanelAnchor();
    const panel = {
        contains(card) { return card.mount === 'panel'; },
        querySelector(selector) {
            if (selector === 'a.alphas-details-content__link-lg[href]') return { href: `${origin}/alpha/${panelAlphaId}` };
            if (selector.includes('.correlation__title')) return panelAnchor;
            return null;
        },
        querySelectorAll() { return []; },
    };
    const document = {
        querySelector(selector) {
            if (selector === '.alphas-details--active') return panelOpen ? panel : null;
            return selector === '#alphas-correlation .correlation__title' ? anchor : null;
        },
        querySelectorAll() { return []; },
        getElementById(id) { return id === 'wqp-prod-memo-card' ? currentCard : null; },
        createElement() {
            const card = {
                dataset: {},
                closest(selector) {
                    if (selector === '.alphas-details') return card.mount === 'panel' ? panel : null;
                    return null;
                },
                remove() { if (currentCard === card) currentCard = undefined; },
                querySelector(selector) {
                    if (selector === '#wqp-prod-calculate-local') return { addEventListener(type, handler) { calculate = handler; } };
                    if (selector === '#wqp-prod-retry-detail' && card.innerHTML.includes('id="wqp-prod-retry-detail"')) {
                        return { addEventListener(type, handler) { retryDetail = handler; } };
                    }
                    return null;
                },
            };
            return card;
        },
    };
    const window = {
        location,
        addEventListener(type, callback) { if (type === 'message') pageListeners.push(callback); },
        postMessage(message) { messages.push(message); },
    };
    vm.runInNewContext(prodMemoSource, {
        window, document, location, URL,
        localStorage: { setItem() {} },
        console: { log() {} },
        chrome: {
            runtime: {
                sendMessage(message, callback) {
                    if (message.action === 'GET_DETAIL') {
                        detailRequests.push(message.payload.alphaId);
                        if (options.deferDetail) { pendingDetails.push(callback); return; }
                        if (detailError) { callback({ ok: false, error: detailError }); return; }
                    }
                    callback({ ok: true, data: { local: {}, platform: {}, memoData: {} } });
                },
                onMessage: { addListener() {} },
            },
            storage: { onChanged: { addListener() {} } },
        },
        MutationObserver: class {
            constructor(callback) { observerCallback = callback; }
            observe() {}
        },
        setTimeout(callback, delay) { timers.set(++timerId, { callback, delay }); return timerId; },
        clearTimeout(id) { timers.delete(id); },
        setInterval(callback) { intervalCallbacks.push(callback); },
    });
    return {
        messages, detailRequests, navigate,
        openPanel(alphaId) { panelOpen = true; panelAlphaId = alphaId; observerCallback(); },
        closePanel() { panelOpen = false; observerCallback(); },
        card() { return currentCard; },
        completeDetail(index, data = { local: {}, platform: {} }) { pendingDetails[index]({ ok: true, data }); },
        setDetailError(error) { detailError = error; },
        retry() { retryDetail(); },
        replacePanelAnchor() { panelAnchor.isConnected = false; panelAnchor = createPanelAnchor(); currentCard = undefined; },
        async expireDetailRequests() {
            for (const [id, timer] of [...timers]) {
                if (timer.delay !== 15000) continue;
                timers.delete(id);
                timer.callback();
            }
            await new Promise((resolve) => setImmediate(resolve));
        },
        observe() { observerCallback(); },
        pollUrl() { intervalCallbacks.forEach((callback) => callback()); },
        dispatch(data) { pageListeners.forEach((callback) => callback({ source: window, data })); },
        calculate() { calculate(); },
        async render() {
            for (let iteration = 0; iteration < 10; iteration++) {
                const ready = [...timers].filter(([, timer]) => timer.delay <= 500);
                if (!ready.length) break;
                for (const [id, timer] of ready) { timers.delete(id); timer.callback(); }
                await new Promise((resolve) => setImmediate(resolve));
            }
        },
    };
}

test('opening an Alpha List never requests correlation details for its list ID', async () => {
    const page = prodMemoPage('/alphas/rj7A8wy');
    page.observe();
    await page.render();
    assert.deepEqual(page.detailRequests, []);
});

test('a real Alpha opened inside a list keeps its identity through DOM changes and local calculation', async () => {
    const page = prodMemoPage('/alphas/rj7A8wy');
    page.openPanel('blRwzjbm');
    page.dispatch({ type: 'WQP_PRODMEMO_ALPHA_VIEW', alphaId: 'blRwzjbm' });
    await page.render();
    page.observe();
    await page.render();
    page.calculate();
    assert.ok(page.detailRequests.length > 0);
    assert.ok(page.detailRequests.every((id) => id === 'blRwzjbm'));
    assert.equal(page.messages.find((message) => message.type === 'WQP_PRODMEMO_PREPARE_CURRENT').alphaId, 'blRwzjbm');

    page.openPanel('anotherAlpha');
    page.dispatch({ type: 'WQP_PRODMEMO_ALPHA_VIEW', alphaId: 'blRwzjbm' });
    await page.render();
    page.observe();
    await page.render();
    assert.equal(page.detailRequests.at(-1), 'anotherAlpha');
    assert.ok(!page.detailRequests.includes('rj7A8wy'));
    assert.equal(page.card().dataset.alphaId, 'anotherAlpha');
    assert.equal(page.card().mount, 'panel');
});

test('a cached detail panel renders without an intercepted API request', async () => {
    const page = prodMemoPage('/alphas/listId', { panelAlphaId: 'np7o3mN8' });
    await page.render();
    assert.deepEqual(page.detailRequests, ['np7o3mN8']);
    assert.equal(page.card().dataset.alphaId, 'np7o3mN8');
    assert.equal(page.card().mount, 'panel');
});

test('a visible detail panel takes priority over the direct page and delayed API messages', async () => {
    const page = prodMemoPage('/alpha/pageAlpha', { panelAlphaId: 'panelAlpha' });
    page.dispatch({ type: 'WQP_PRODMEMO_ALPHA_VIEW', alphaId: 'oldAlpha' });
    await page.render();
    assert.deepEqual(page.detailRequests, ['panelAlpha']);
    assert.equal(page.card().mount, 'panel');
    page.closePanel();
    await page.render();
    assert.equal(page.card().dataset.alphaId, 'pageAlpha');
    assert.equal(page.card().mount, 'page');
});

test('closing a panel for the same Alpha restores the card in its direct page', async () => {
    const page = prodMemoPage('/alpha/sameAlpha', { panelAlphaId: 'sameAlpha' });
    await page.render();
    assert.equal(page.card().mount, 'panel');
    page.closePanel();
    await page.render();
    assert.equal(page.card().mount, 'page');
});

test('closing a detail panel removes its card and late API messages cannot reopen it', async () => {
    const page = prodMemoPage('/alphas/listId', { panelAlphaId: 'panelAlpha' });
    await page.render();
    page.closePanel();
    page.dispatch({ type: 'WQP_PRODMEMO_ALPHA_VIEW', alphaId: 'panelAlpha' });
    await page.render();
    assert.equal(page.card(), undefined);
    assert.deepEqual(page.detailRequests, ['panelAlpha']);
});

test('a database response for a closed or replaced panel cannot render a stale card', async () => {
    const page = prodMemoPage('/alphas/listId', { panelAlphaId: 'firstAlpha', deferDetail: true });
    await page.render();
    page.openPanel('secondAlpha');
    await page.render();
    page.completeDetail(0);
    await page.render();
    assert.equal(page.card().dataset.alphaId, 'secondAlpha');
    assert.match(page.card().innerHTML, /正在读取本地关联性数据/);
    page.completeDetail(1);
    await page.render();
    assert.equal(page.card().dataset.alphaId, 'secondAlpha');
    page.openPanel('thirdAlpha');
    await page.render();
    page.closePanel();
    page.completeDetail(2);
    await page.render();
    assert.equal(page.card(), undefined);
});

test('a submitted Alpha card appears while its database detail is still pending', async () => {
    const page = prodMemoPage('/alphas/xa2dLAG', { panelAlphaId: 'KP7pELk8', deferDetail: true });
    await page.render();
    assert.equal(page.card().dataset.alphaId, 'KP7pELk8');
    assert.match(page.card().innerHTML, /正在读取本地关联性数据/);
    assert.match(page.card().innerHTML, /id="wqp-prod-calculate-local"[\s\S]*?disabled/);
    page.completeDetail(0, { platform: { prod: { max: 0.42 } } });
    await page.render();
    assert.match(page.card().innerHTML, /0\.4200/);
    assert.doesNotMatch(page.card().innerHTML, /正在读取本地关联性数据/);
});

test('a failed database read leaves a visible Chinese error and can be retried', async () => {
    const page = prodMemoPage('/alphas/xa2dLAG', { panelAlphaId: 'KP7pELk8', detailError: '本地数据库暂时不可用' });
    await page.render();
    assert.equal(page.card().dataset.alphaId, 'KP7pELk8');
    assert.match(page.card().innerHTML, /读取关联性数据失败：本地数据库暂时不可用/);
    assert.match(page.card().innerHTML, /id="wqp-prod-retry-detail"/);
    page.setDetailError('');
    page.retry();
    await page.render();
    assert.doesNotMatch(page.card().innerHTML, /读取关联性数据失败/);
    assert.equal(page.detailRequests.length, 2);
});

test('a timed out read retains its card and an eventual response cannot overwrite the error', async () => {
    const page = prodMemoPage('/alphas/xa2dLAG', { panelAlphaId: 'KP7pELk8', deferDetail: true });
    await page.render();
    await page.expireDetailRequests();
    assert.equal(page.card().dataset.alphaId, 'KP7pELk8');
    assert.match(page.card().innerHTML, /读取本地关联性数据超时/);
    page.completeDetail(0, { platform: { prod: { max: 0.9 } } });
    await page.render();
    assert.match(page.card().innerHTML, /读取本地关联性数据超时/);
    assert.doesNotMatch(page.card().innerHTML, /0\.9000/);
});

test('a replaced React section receives the card when the original anchor disconnects', async () => {
    const page = prodMemoPage('/alphas/xa2dLAG', { panelAlphaId: 'KP7pELk8', deferDetail: true });
    await page.render();
    page.replacePanelAnchor();
    page.completeDetail(0, { platform: { prod: { max: 0.42 } } });
    await page.render();
    assert.equal(page.card().dataset.alphaId, 'KP7pELk8');
    assert.match(page.card().innerHTML, /0\.4200/);
});

test('an older detail response for the same Alpha cannot replace a newer result', async () => {
    const page = prodMemoPage('/alphas/xa2dLAG', { panelAlphaId: 'KP7pELk8', deferDetail: true });
    await page.render();
    page.dispatch({ type: 'WQP_PRODMEMO_ALPHA_VIEW', alphaId: 'KP7pELk8' });
    await page.render();
    page.completeDetail(1, { platform: { prod: { max: 0.25 } } });
    await page.render();
    page.completeDetail(0, { platform: { prod: { max: 0.9 } } });
    await page.render();
    assert.match(page.card().innerHTML, /0\.2500/);
    assert.doesNotMatch(page.card().innerHTML, /0\.9000/);
});

test('direct Alpha pages work and navigating back to a list clears the previous card', async () => {
    const page = prodMemoPage('/alpha/blRwzjbm?tab=correlation');
    await page.render();
    assert.deepEqual(page.detailRequests, ['blRwzjbm']);
    page.navigate('/alphas/rj7A8wy');
    page.pollUrl();
    page.observe();
    await page.render();
    assert.deepEqual(page.detailRequests, ['blRwzjbm']);
});

test('an Alpha-looking query parameter is not a displayed Alpha', async () => {
    const page = prodMemoPage('/simulate?next=/alpha/notDisplayed');
    page.observe();
    await page.render();
    assert.deepEqual(page.detailRequests, []);
});

function assistantPage(path, dialogLinks = []) {
    const location = { href: new URL(path, origin).href, origin };
    const listeners = [];
    const window = { addEventListener(type, callback) { if (type === 'message') listeners.push(callback); } };
    let panelAlphaId = '';
    const panel = { querySelector() { return { href: `${origin}/alpha/${panelAlphaId}` }; } };
    const context = vm.createContext({
        location, window, URL,
        document: {
            documentElement: null,
            addEventListener() {},
            querySelector(selector) { return selector === '.alphas-details--active' && panelAlphaId ? panel : null; },
            querySelectorAll() { return dialogLinks; },
        },
        setTimeout() {}, clearTimeout() {},
    });
    // Expose the real script's private resolver without starting its page observers.
    const instrumented = assistantSource.replace(/\}\)\(\);\s*$/, 'globalThis.resolver = { getAlphaIdFromUrl, getAlphaIdFromDialog, getAlphaId };\n})();');
    vm.runInContext(instrumented, context);
    return {
        resolver: context.resolver,
        openPanel(alphaId) { panelAlphaId = alphaId; },
        closePanel() { panelAlphaId = ''; },
        view(alphaId) { listeners.forEach((callback) => callback({ source: window, data: { type: 'WQP_PRODMEMO_ALPHA_VIEW', alphaId } })); },
    };
}

test('the AI description assistant distinguishes Alpha and Alpha List URLs', () => {
    const { resolver } = assistantPage('/alphas/rj7A8wy');
    assert.equal(resolver.getAlphaIdFromUrl('/alpha/blRwzjbm'), 'blRwzjbm');
    assert.equal(resolver.getAlphaIdFromUrl('/alpha/blRwzjbm?tab=details'), 'blRwzjbm');
    for (const url of ['/alphas/rj7A8wy', '/alphas/unsubmitted', '/alphas/submitted', '/alphas/distribution', '/simulate?next=/alpha/notDisplayed', 'https://example.com/alpha/notBrain', '']) {
        assert.equal(resolver.getAlphaIdFromUrl(url), '', url);
    }
});

test('the AI description assistant uses the Alpha shown within a list', () => {
    const page = assistantPage('/alphas/rj7A8wy');
    page.openPanel('blRwzjbm');
    page.view('blRwzjbm');
    assert.equal(page.resolver.getAlphaId(), 'blRwzjbm');
    const dialog = assistantPage('/alphas/rj7A8wy', [
        { href: `${origin}/alphas/rj7A8wy` },
        { href: 'https://example.com/alpha/notBrain' },
        { href: `${origin}/alpha/blRwzjbm` },
    ]);
    assert.equal(dialog.resolver.getAlphaId(), 'blRwzjbm');
});

test('the AI assistant reads the panel header link and clears a closed list detail', () => {
    const page = assistantPage('/alphas/listId');
    page.openPanel('firstAlpha');
    page.view('staleAlpha');
    assert.equal(page.resolver.getAlphaId(), 'firstAlpha');
    page.openPanel('secondAlpha');
    assert.equal(page.resolver.getAlphaId(), 'secondAlpha');
    page.closePanel();
    assert.equal(page.resolver.getAlphaId(), '');
});
