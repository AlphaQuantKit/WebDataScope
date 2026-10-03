(function () {
    'use strict';

    const PAGE_CACHE_KEY = 'WQP_ProdMemoCache';
    const REVISION_KEY = 'WQP_ProdMemo_DB_Revision';
    const CARD_ID = 'wqp-prod-memo-card';
    const MAX_RENDER_RETRIES = 20;
    const DETAIL_REQUEST_TIMEOUT_MS = 15000;
    const MAIN_WORLD_DB_ACTIONS = new Set([
        'SAVE_ALPHA_BATCH',
        'SAVE_PNL',
        'RECONCILE_ALPHAS',
        'GET_SYNC_STATE',
        'SET_SYNC_META',
    ]);

    let currentAlphaId = '';
    let renderTimer = null;
    let renderRetryCount = 0;
    let renderGeneration = 0;
    let currentDetail = null;
    let calculationRunning = false;
    let calculationAlphaId = '';
    let calculationStatusMessage = '';
    let calculationStatusMode = '';
    const currentDataRequests = new Map();

    function log(...args) {
        console.log('[WQP ProdMemo]', ...args);
    }

    function dbAction(action, payload = {}, options = {}) {
        return new Promise((resolve, reject) => {
            let settled = false;
            let timeoutId = null;
            function finish(callback, value) {
                if (settled) return;
                settled = true;
                clearTimeout(timeoutId);
                callback(value);
            }
            if (options.timeoutMs) {
                timeoutId = setTimeout(() => finish(reject, new Error('读取本地关联性数据超时，请稍后重试。')), options.timeoutMs);
            }
            try {
                chrome.runtime.sendMessage({ type: 'WQP_PRODMEMO_DB', action, payload }, (response) => {
                    const runtimeError = chrome.runtime.lastError;
                    if (runtimeError) finish(reject, runtimeError);
                    else if (!response?.ok) finish(reject, new Error(response?.error || 'ProdMemo 后台请求失败。'));
                    else finish(resolve, response.data);
                });
            } catch (error) {
                finish(reject, error);
            }
        });
    }

    function normalizeAlphaId(value) {
        return String(value || '').trim();
    }

    function getCurrentAlphaIdFromUrl() {
        // /alphas/<id> is an Alpha List; only /alpha/<id> identifies an Alpha.
        const match = window.location.pathname.match(/^\/alpha\/([^/]+)(?:\/|$)/);
        return normalizeAlphaId(match?.[1]);
    }

    function getCurrentAlphaIdFromPanel() {
        const panel = document.querySelector('.alphas-details--active');
        if (!panel) return null;
        const link = panel.querySelector('a.alphas-details-content__link-lg[href]');
        try {
            if (!link?.href) return '';
            const url = new URL(link.href, window.location.origin);
            if (url.origin !== window.location.origin) return '';
            return normalizeAlphaId(url.pathname.match(/^\/alpha\/([^/]+)(?:\/|$)/)?.[1]);
        } catch (_) {
            return '';
        }
    }

    function getDisplayedAlphaId() {
        return getCurrentAlphaIdFromPanel() ?? getCurrentAlphaIdFromUrl();
    }

    function isAlphaListPage() {
        return /^\/alphas(?:\/|$)/.test(window.location.pathname);
    }

    function syncDisplayedAlpha() {
        const alphaId = getDisplayedAlphaId();
        const card = document.getElementById(CARD_ID);
        if (alphaId) {
            const panel = document.querySelector('.alphas-details--active');
            const wrongMount = card && (panel
                ? !panel.contains(card)
                : Boolean(card.closest('.alphas-details')));
            if (wrongMount) removeCard();
            if (alphaId !== currentAlphaId || ((!card || wrongMount) && renderTimer === null)) scheduleRender(alphaId);
        } else if (isAlphaListPage() || getCurrentAlphaIdFromPanel() !== null) {
            currentAlphaId = '';
            currentDetail = null;
            renderGeneration += 1;
            clearTimeout(renderTimer);
            renderTimer = null;
            removeCard();
        }
    }

    function escapeHtml(value) {
        return String(value ?? '')
            .replaceAll('&', '&amp;')
            .replaceAll('<', '&lt;')
            .replaceAll('>', '&gt;')
            .replaceAll('"', '&quot;')
            .replaceAll("'", '&#39;');
    }

    function formatNumber(value) {
        const number = Number(value);
        return value !== null && value !== undefined && value !== '' && Number.isFinite(number)
            ? number.toFixed(4)
            : '-';
    }

    function formatTime(value) {
        if (!value) return '-';
        const date = new Date(value);
        return Number.isNaN(date.getTime()) ? '-' : date.toLocaleString();
    }

    function formatDateOnly(value) {
        if (!value) return '-';
        const date = new Date(value);
        if (Number.isNaN(date.getTime())) return '-';
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        return `${year}-${month}-${day}`;
    }

    function calendarDayNumber(value) {
        if (!value) return null;
        const date = new Date(value);
        if (Number.isNaN(date.getTime())) return null;
        return Math.floor(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / 86400000);
    }

    function isSubmittedDateCurrent(value, now = Date.now()) {
        const submittedDay = calendarDayNumber(value);
        const currentDay = calendarDayNumber(now);
        return submittedDay !== null
            && currentDay !== null
            && Math.abs(currentDay - submittedDay) <= 1;
    }

    function valueClass(value) {
        const number = Number(value);
        if (!Number.isFinite(number)) return 'is-empty';
        if (number > 0.7) return 'is-bad';
        if (number > 0.5) return 'is-warn';
        return 'is-good';
    }

    function platformMetric(label, stat) {
        const available = stat?.max !== null && stat?.max !== undefined && Number.isFinite(Number(stat.max));
        return `
            <div class="wqp-prod-metric ${available ? '' : 'is-disabled'}">
                <div class="wqp-prod-metric-label">${label}</div>
                <div class="wqp-prod-metric-value ${valueClass(stat?.max)}">${formatNumber(stat?.max)}</div>
                <div class="wqp-prod-metric-sub">min ${formatNumber(stat?.min)}</div>
                <div class="wqp-prod-metric-meta">${available ? escapeHtml(formatTime(stat.updated)) : '未捕获'}</div>
            </div>
        `;
    }

    function localMetric(label, record, options = {}) {
        const result = record?.result;
        const available = result?.available && result.max !== null && result.max !== undefined
            && Number.isFinite(Number(result.max));
        const stale = record?.stale === true;
        const display = available ? `${options.lowerBound ? '≥' : ''}${formatNumber(result.max)}` : '-';
        const details = available
            ? options.lowerBound
                ? `参考 ${result.corrCount ?? 0}/${result.referenceCount ?? 0} · overlap ${result.maxOverlapCount ?? '-'}`
                : `比较 ${result.corrCount ?? 0}/${result.poolSize ?? 0} · overlap ${result.maxOverlapCount ?? '-'}`
            : (result?.reason || '尚未计算');
        const witness = options.lowerBound && result?.witness
            ? `Witness ${escapeHtml(result.witness.alphaId)} · y ${formatNumber(result.witness.correlation)} · c ${formatNumber(result.witness.knownProdMax)}`
            : '';
        return `
            <div class="wqp-prod-metric ${available && !stale ? '' : 'is-disabled'}">
                <div class="wqp-prod-metric-label">${label}${stale ? ' · 已过期' : ''}</div>
                <div class="wqp-prod-metric-value ${valueClass(result?.max)}">${display}</div>
                <div class="wqp-prod-metric-sub">${options.lowerBound ? '条件下限' : `min ${formatNumber(result?.min)}`}</div>
                <div class="wqp-prod-metric-meta">${escapeHtml(details)}</div>
                ${witness ? `<div class="wqp-prod-metric-meta" title="${witness}">${witness}</div>` : ''}
                <div class="wqp-prod-metric-meta">${record ? escapeHtml(formatTime(record.calculatedAt)) : '-'}</div>
            </div>
        `;
    }

    function findCardAnchor() {
        const root = document.querySelector('.alphas-details--active') || document;
        const title = root.querySelector('#alphas-correlation .correlation__title')
            || root.querySelector('.correlation__title');
        if (title && !title.closest('.alphas-details:not(.alphas-details--active)')) {
            return { element: title, placement: 'after' };
        }
        const sections = Array.from(root.querySelectorAll('.correlation__content'));
        const prodSection = sections.find((section) => (
            !section.closest('.alphas-details:not(.alphas-details--active)')
            && /prod(?:uction)? correlation/i.test(section.textContent || '')
        ));
        return prodSection ? { element: prodSection, placement: 'append' } : null;
    }

    function removeCard() {
        document.getElementById(CARD_ID)?.remove();
    }

    function isCurrentRender(alphaId, generation) {
        if (alphaId !== currentAlphaId || generation !== renderGeneration) return false;
        const displayedId = getDisplayedAlphaId();
        return displayedId ? displayedId === alphaId : !isAlphaListPage() && getCurrentAlphaIdFromPanel() === null;
    }

    function detailErrorMessage(error) {
        const message = String(error?.message || error || '');
        if (/Extension context invalidated|Receiving end does not exist|message port closed/i.test(message)) {
            return '插件连接已失效，请刷新当前页面；若仍失败，请到扩展管理页重新加载插件。';
        }
        return /[\u4e00-\u9fff]/.test(message)
            ? `读取关联性数据失败：${message}`
            : '读取关联性数据失败，请重试；若仍失败，请刷新页面或重新加载插件。';
    }

    async function renderCard(alphaId, generation) {
        const normalizedId = normalizeAlphaId(alphaId);
        if (!normalizedId || !isCurrentRender(normalizedId, generation)) return;
        const displayedId = getDisplayedAlphaId();
        if (displayedId && displayedId !== normalizedId) {
            syncDisplayedAlpha();
            return;
        }
        if (!displayedId && isAlphaListPage()) return;
        const anchor = findCardAnchor();
        if (!anchor) {
            if (renderRetryCount < MAX_RENDER_RETRIES) {
                renderRetryCount += 1;
                scheduleRender(normalizedId, 500);
            }
            return;
        }
        renderRetryCount = 0;
        mountCard(normalizedId, anchor, currentDetail || {}, { loading: true });
        try {
            const detail = await dbAction('GET_DETAIL', { alphaId: normalizedId }, { timeoutMs: DETAIL_REQUEST_TIMEOUT_MS });
            if (!isCurrentRender(normalizedId, generation)) return;
            const nextAnchor = findCardAnchor();
            if (!nextAnchor || nextAnchor.element.isConnected === false) {
                scheduleRender(normalizedId, 500);
                return;
            }
            currentDetail = detail || {};
            mountCard(normalizedId, nextAnchor, currentDetail);
        } catch (error) {
            if (!isCurrentRender(normalizedId, generation)) return;
            log('detail load failed', error);
            const nextAnchor = findCardAnchor();
            if (nextAnchor && nextAnchor.element.isConnected !== false) {
                mountCard(normalizedId, nextAnchor, currentDetail || {}, { error: detailErrorMessage(error) });
            }
        }
    }

    function mountCard(normalizedId, anchor, detail, options = {}) {
        const localLower = detail.local?.prodLowerBound;
        const lowerValue = !localLower?.stale && localLower?.result?.available
            ? Number(localLower.result.max)
            : null;
        const warning = Number.isFinite(lowerValue) && lowerValue > 0.7;
        const submittedDateIsCurrent = isSubmittedDateCurrent(detail.latestSubmittedAt);

        removeCard();
        const card = document.createElement('div');
        card.id = CARD_ID;
        card.dataset.alphaId = normalizedId;
        card.innerHTML = `
            <div class="wqp-prod-header">
                <div>
                    <div class="wqp-prod-title">ProdMemo Correlation</div>
                    <div class="wqp-prod-alpha" title="${escapeHtml(normalizedId)}">${escapeHtml(normalizedId)}</div>
                </div>
                <div class="wqp-prod-header-actions">
                    <div class="wqp-prod-date-status ${submittedDateIsCurrent ? 'is-current' : 'is-stale'}"
                        title="${submittedDateIsCurrent ? '本地 Submitted 数据日期正常' : '本地 Submitted 数据可能已过期，请前往侧边栏执行增量同步'}">
                        <span>本地 Submitted 最新 <strong>${formatDateOnly(detail.latestSubmittedAt)}</strong></span>
                        <span>当前日期 <strong>${formatDateOnly(Date.now())}</strong></span>
                    </div>
                    <button id="wqp-prod-calculate-local" class="wqp-prod-calculate" type="button"
                        ${calculationRunning || !currentDetail ? 'disabled' : ''}>
                        ${calculationRunning ? '本地计算中…' : '本地计算 Corr'}
                    </button>
                </div>
            </div>
            ${options.loading ? '<div class="wqp-prod-detail-status" aria-live="polite">正在读取本地关联性数据…</div>' : ''}
            ${options.error ? `
                <div class="wqp-prod-detail-status error" aria-live="polite">
                    <span>${escapeHtml(options.error)}</span>
                    <button id="wqp-prod-retry-detail" class="wqp-prod-retry" type="button">重试</button>
                </div>
            ` : ''}
            <div class="wqp-prod-source-block">
                <div class="wqp-prod-source-title"><span class="wqp-prod-source-badge is-platform">Ⓟ Platform</span> 平台返回</div>
                <div class="wqp-prod-grid">
                    ${platformMetric('Self Corr', detail.platform?.self)}
                    ${platformMetric('Pool Corr', detail.platform?.pool)}
                    ${platformMetric('Prod Corr', detail.platform?.prod)}
                </div>
            </div>
            <div class="wqp-prod-source-block">
                <div class="wqp-prod-source-title"><span class="wqp-prod-source-badge is-local">Ⓛ Local</span> 本地计算</div>
                <div class="wqp-prod-grid">
                    ${localMetric('Self Corr', detail.local?.self)}
                    ${localMetric('Pool Corr', detail.local?.pool)}
                    ${localMetric('Prod Corr Lower Bound', localLower, { lowerBound: true })}
                </div>
            </div>
            <div class="wqp-prod-assumption">Prod 下限仅在平台与本地使用可比较的收益窗口和相关性口径时成立。</div>
            ${warning ? `
                <div class="wqp-prod-warning">
                    本地条件下限 ≥ ${formatNumber(lowerValue)}，已超过 0.7000，建议跳过本次 Prod Corr Check。
                </div>
            ` : ''}
            <div id="wqp-prod-calc-status" class="wqp-prod-calc-status${calculationStatusMode ? ` ${calculationStatusMode}` : ''}" aria-live="polite">${escapeHtml(calculationStatusMessage)}</div>
        `;
        if (anchor.placement === 'after') anchor.element.insertAdjacentElement('afterend', card);
        else anchor.element.appendChild(card);
        card.querySelector('#wqp-prod-calculate-local')?.addEventListener('click', startLocalCalculation);
        card.querySelector('#wqp-prod-retry-detail')?.addEventListener('click', () => scheduleRender(normalizedId, 0));
    }

    function scheduleRender(alphaId, delay = 200) {
        const normalizedId = normalizeAlphaId(alphaId) || currentAlphaId;
        if (!normalizedId) return;
        if (normalizedId !== currentAlphaId) {
            renderRetryCount = 0;
            calculationStatusMessage = '';
            calculationStatusMode = '';
            currentDetail = null;
            removeCard();
        }
        currentAlphaId = normalizedId;
        clearTimeout(renderTimer);
        const generation = ++renderGeneration;
        renderTimer = setTimeout(() => {
            renderTimer = null;
            renderCard(normalizedId, generation).catch((error) => log('render failed', error));
        }, delay);
    }

    function setCalculationStatus(message, mode = '') {
        calculationStatusMessage = message || '';
        calculationStatusMode = mode;
        const element = document.getElementById('wqp-prod-calc-status');
        if (!element) return;
        element.textContent = message || '';
        element.className = `wqp-prod-calc-status${mode ? ` ${mode}` : ''}`;
    }

    async function syncCacheToPage() {
        const data = await dbAction('GET_RESOLVED_CACHE');
        localStorage.setItem(PAGE_CACHE_KEY, JSON.stringify(data.memoData || {}));
        window.postMessage({ type: 'WQP_PRODMEMO_CACHE_SYNCED', count: data.count || 0 }, '*');
    }

    function prepareCurrentAlpha(alphaId) {
        const requestId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
        return new Promise((resolve, reject) => {
            const timeoutId = setTimeout(() => {
                currentDataRequests.delete(requestId);
                reject(new Error('获取当前 Alpha/PnL 超时。'));
            }, 60000);
            currentDataRequests.set(requestId, { resolve, reject, timeoutId });
            window.postMessage({
                type: 'WQP_PRODMEMO_PREPARE_CURRENT',
                requestId,
                alphaId,
            }, '*');
        });
    }

    async function finishLocalCalculation() {
        const alphaId = calculationAlphaId;
        if (!alphaId) return;
        calculationRunning = true;
        if (currentAlphaId === alphaId) {
            scheduleRender(alphaId, 0);
            setCalculationStatus('正在获取当前 Alpha 与 PnL…');
        }
        try {
            await prepareCurrentAlpha(alphaId);
            if (currentAlphaId === alphaId) setCalculationStatus('正在计算 Self、Pool 和 Prod 条件下限…');
            await dbAction('CALCULATE_LOCAL', { alphaId });
            await syncCacheToPage();
            if (currentAlphaId === alphaId) {
                setCalculationStatus('本地 Corr 计算完成。', 'success');
                scheduleRender(alphaId, 0);
            }
        } catch (error) {
            if (currentAlphaId === alphaId) setCalculationStatus(error.message || String(error), 'error');
            log('local calculation failed', error);
        } finally {
            calculationRunning = false;
            calculationAlphaId = '';
            if (currentAlphaId === alphaId) scheduleRender(alphaId, 150);
        }
    }

    function startLocalCalculation() {
        if (!currentAlphaId || calculationRunning) return;
        calculationAlphaId = currentAlphaId;
        finishLocalCalculation();
    }

    function handleSyncProgress(progress) {
        try {
            chrome.runtime.sendMessage({ type: 'WQP_PRODMEMO_SYNC_PROGRESS', payload: progress }, () => {
                void chrome.runtime.lastError;
            });
        } catch (_) {
            // The extension context can disappear during a reload.
        }
    }

    window.addEventListener('message', async (event) => {
        if (event.source !== window || !event.data?.type) return;
        if (event.data.type === 'WQP_PRODMEMO_DB_REQUEST') {
            const { requestId, action, payload } = event.data;
            if (!MAIN_WORLD_DB_ACTIONS.has(action)) {
                window.postMessage({
                    type: 'WQP_PRODMEMO_DB_RESPONSE',
                    requestId,
                    response: { ok: false, error: `不允许的页面桥接操作：${action}` },
                }, '*');
                return;
            }
            try {
                const data = await dbAction(action, payload || {});
                window.postMessage({
                    type: 'WQP_PRODMEMO_DB_RESPONSE',
                    requestId,
                    response: { ok: true, data },
                }, '*');
            } catch (error) {
                window.postMessage({
                    type: 'WQP_PRODMEMO_DB_RESPONSE',
                    requestId,
                    response: { ok: false, error: error.message || String(error) },
                }, '*');
            }
            return;
        }
        if (event.data.type === 'WQP_PRODMEMO_PLATFORM_CORR') {
            dbAction('SAVE_PLATFORM_CORR', {
                alphaId: event.data.alphaId,
                corrType: event.data.corrType,
                data: event.data.data,
            }).then(() => {
                syncCacheToPage();
                if (currentAlphaId === event.data.alphaId) scheduleRender(currentAlphaId);
            }).catch((error) => log('platform Corr save failed', error));
            return;
        }
        if (event.data.type === 'WQP_PRODMEMO_ALPHA_VIEW') {
            const alphaId = getDisplayedAlphaId();
            if (alphaId) scheduleRender(alphaId);
            else if (!isAlphaListPage() && getCurrentAlphaIdFromPanel() === null) scheduleRender(event.data.alphaId);
            return;
        }
        if (event.data.type === 'WQP_PRODMEMO_SYNC_PROGRESS') {
            handleSyncProgress(event.data.payload || {});
            return;
        }
        if (event.data.type === 'WQP_PRODMEMO_CURRENT_READY') {
            const pending = currentDataRequests.get(event.data.requestId);
            if (!pending) return;
            currentDataRequests.delete(event.data.requestId);
            clearTimeout(pending.timeoutId);
            if (event.data.ok) pending.resolve(event.data.alphaId);
            else pending.reject(new Error(event.data.error || '当前 Alpha 数据获取失败。'));
        }
    });

    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        if (message?.type === 'WQP_PRODMEMO_SYNC_START') {
            window.postMessage({ type: 'WQP_PRODMEMO_START_SYNC', mode: message.mode || 'incremental' }, '*');
            sendResponse({ started: true });
            return false;
        }
        if (message?.type === 'WQP_PRODMEMO_SYNC_STOP') {
            window.postMessage({ type: 'WQP_PRODMEMO_STOP_SYNC' }, '*');
            sendResponse({ stopping: true });
            return false;
        }
        return false;
    });

    chrome.storage.onChanged.addListener((changes, namespace) => {
        if (namespace !== 'local' || !changes[REVISION_KEY]) return;
        syncCacheToPage().catch((error) => log('cache sync failed', error));
        if (currentAlphaId) scheduleRender(currentAlphaId);
    });

    const observer = new MutationObserver(syncDisplayedAlpha);

    function initialize() {
        observer.observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'href'] });
        syncCacheToPage().catch((error) => log('initial cache sync failed', error));
        syncDisplayedAlpha();
        let lastUrl = location.href;
        setInterval(() => {
            if (location.href === lastUrl) return;
            lastUrl = location.href;
            const nextAlphaId = getDisplayedAlphaId();
            if (nextAlphaId) scheduleRender(nextAlphaId);
            else {
                currentAlphaId = '';
                currentDetail = null;
                renderGeneration += 1;
                clearTimeout(renderTimer);
                renderTimer = null;
                removeCard();
            }
        }, 800);
    }

    initialize();
})();
