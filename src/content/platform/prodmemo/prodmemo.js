(function () {
    'use strict';

    const STORAGE_PREFIX = 'WQP_ProdMemo_';
    const PAGE_CACHE_KEY = 'WQP_ProdMemoCache';
    const CARD_ID = 'wqp-prod-memo-card';
    const SYNC_LIMIT = 1000;
    const MAX_RENDER_RETRIES = 20;

    let currentAlphaId = '';
    let renderTimer = null;
    let renderRetryCount = 0;

    function log(...args) {
        console.log('[WQP ProdMemo]', ...args);
    }

    function normalizeAlphaId(value) {
        return String(value || '').trim();
    }

    function normalizeCorrelationType(type) {
        const text = String(type || 'prod').toLowerCase();
        if (text.includes('pool') || text.includes('parent')) return 'pool';
        if (text.includes('self')) return 'self';
        return 'prod';
    }

    function extractCorrelationStats(data) {
        if (!data || typeof data !== 'object') return { max: null, min: null };

        if (Number.isFinite(Number(data.maximum)) || Number.isFinite(Number(data.minimum))) {
            return {
                max: Number.isFinite(Number(data.maximum)) ? Math.abs(Number(data.maximum)) : null,
                min: Number.isFinite(Number(data.minimum)) ? Math.abs(Number(data.minimum)) : null,
            };
        }

        if (Number.isFinite(Number(data.max)) || Number.isFinite(Number(data.min))) {
            return {
                max: Number.isFinite(Number(data.max)) ? Math.abs(Number(data.max)) : null,
                min: Number.isFinite(Number(data.min)) ? Math.abs(Number(data.min)) : null,
            };
        }

        const rows = Array.isArray(data.correlations) ? data.correlations
            : Array.isArray(data.results) ? data.results
                : Array.isArray(data) ? data
                    : [];
        let max = null;
        let min = null;
        rows.forEach((row) => {
            const raw = row?.correlation ?? row?.value ?? row?.score;
            const value = Number(raw);
            if (!Number.isFinite(value)) return;
            const abs = Math.abs(value);
            max = max === null ? abs : Math.max(max, abs);
            min = min === null ? abs : Math.min(min, abs);
        });
        return { max, min };
    }

    function getCurrentAlphaIdFromUrl() {
        const match = window.location.href.match(/\/alphas?\/([^/?#]+)/);
        const id = normalizeAlphaId(match?.[1]);
        if (!id || ['unsubmitted', 'submitted', 'distribution'].includes(id)) return '';
        return id;
    }

    function isUsableStats(stats) {
        return stats && Number.isFinite(Number(stats.max));
    }

    function formatStat(value) {
        return Number.isFinite(Number(value)) ? Number(value).toFixed(4) : '-';
    }

    function formatStatTime(value) {
        if (!value) return '-';
        const date = new Date(value);
        if (Number.isNaN(date.getTime())) return '-';
        return date.toLocaleString(undefined, {
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
        });
    }

    function valueClass(value) {
        const num = Number(value);
        if (!Number.isFinite(num)) return 'is-empty';
        if (num > 0.7) return 'is-bad';
        if (num > 0.5) return 'is-warn';
        return 'is-good';
    }

    function removeCard() {
        document.getElementById(CARD_ID)?.remove();
    }

    function makeStat(label, stat) {
        const max = stat?.max;
        const min = stat?.min;
        const updated = stat?.updated;
        return `
            <div class="wqp-prod-stat ${isUsableStats(stat) ? '' : 'is-disabled'}">
                <div class="wqp-prod-stat-label">${label}</div>
                <div class="wqp-prod-stat-value ${valueClass(max)}">${formatStat(max)}</div>
                <div class="wqp-prod-stat-sub">min ${formatStat(min)}</div>
                <div class="wqp-prod-stat-time">${formatStatTime(updated)}</div>
            </div>
        `;
    }

    function hasMemoData(memo) {
        return Boolean(memo?.prod || memo?.pool || memo?.self);
    }

    function containsProdCorrelationText(element) {
        const text = String(element?.textContent || element?.innerText || '').toLowerCase();
        return text.includes('prod correlation') || text.includes('production correlation');
    }

    function isVisible(element) {
        return Boolean(element?.offsetParent || element?.getClientRects?.().length);
    }

    function findCardAnchor() {
        const correlationSections = Array.from(document.querySelectorAll('.correlation__content'));
        const prodSection = correlationSections.find((section) => containsProdCorrelationText(section));
        if (prodSection) return prodSection;

        const allElements = Array.from(document.body?.querySelectorAll('*') || []);
        const targetHeader = allElements.find((element) => {
            if (!element.innerText || !isVisible(element)) return false;
            if (element.closest(`#${CARD_ID}`)) return false;
            if (!containsProdCorrelationText(element)) return false;
            return element.tagName === 'SPAN'
                || element.classList.contains('correlation__content-status-title')
                || element.innerText.length < 100;
        });

        if (!targetHeader) return null;
        return targetHeader.closest('.correlation__content')
            || targetHeader.closest('.correlation__content-status')
            || targetHeader.parentElement;
    }

    async function getMemo(alphaId) {
        const key = `${STORAGE_PREFIX}${alphaId}`;
        const data = await chrome.storage.local.get(key);
        return data[key] || null;
    }

    async function renderCard(alphaId) {
        const normalizedId = normalizeAlphaId(alphaId);
        if (!normalizedId) return;
        if (!document.body) {
            document.addEventListener('DOMContentLoaded', () => scheduleRender(normalizedId), { once: true });
            return;
        }

        const memo = await getMemo(normalizedId) || {};
        removeCard();

        const anchor = findCardAnchor();
        if (!anchor) {
            if (renderRetryCount < MAX_RENDER_RETRIES) {
                renderRetryCount += 1;
                scheduleRender(normalizedId, 500);
            } else {
                log('Prod Correlation section not found for card placement');
            }
            return;
        }
        renderRetryCount = 0;

        const card = document.createElement('div');
        card.id = CARD_ID;
        card.dataset.alphaId = normalizedId;
        const hasData = hasMemoData(memo);
        card.innerHTML = `
            <div class="wqp-prod-header">
                <div>
                    <div class="wqp-prod-title">ProdMemo</div>
                    <div class="wqp-prod-alpha" title="${normalizedId}">${normalizedId}</div>
                </div>
            </div>
            <div class="wqp-prod-grid">
                ${makeStat('PC', memo.prod)}
                ${makeStat('PPC', memo.pool)}
                ${makeStat('SC', memo.self)}
            </div>
            ${hasData ? '' : '<div class="wqp-prod-empty">No cached correlation data</div>'}
        `;

        anchor.appendChild(card);
    }

    function scheduleRender(alphaId, delay = 250) {
        const nextAlphaId = normalizeAlphaId(alphaId) || currentAlphaId;
        if (nextAlphaId && nextAlphaId !== currentAlphaId) {
            renderRetryCount = 0;
        }
        currentAlphaId = nextAlphaId;
        if (!currentAlphaId) return;
        clearTimeout(renderTimer);
        renderTimer = setTimeout(() => {
            renderCard(currentAlphaId).catch((error) => log('render failed', error));
        }, delay);
    }

    async function syncCacheToPage() {
        const all = await chrome.storage.local.get(null);
        const entries = Object.entries(all)
            .filter(([key]) => key.startsWith(STORAGE_PREFIX))
            .slice(-SYNC_LIMIT);
        const cache = {};
        entries.forEach(([key, value]) => {
            const alphaId = key.slice(STORAGE_PREFIX.length);
            if (!alphaId || !value) return;
            cache[alphaId] = value;
        });
        localStorage.setItem(PAGE_CACHE_KEY, JSON.stringify(cache));
        window.postMessage({ type: 'WQP_PRODMEMO_CACHE_SYNCED', count: entries.length }, '*');
    }

    // 防抖：合并短时间内多次 syncCacheToPage 调用，避免重复 get(null) + localStorage.setItem 造成内存峰值
    let syncTimer = null;
    function scheduleSyncCache(delay = 500) {
        if (syncTimer) clearTimeout(syncTimer);
        syncTimer = setTimeout(() => {
            syncTimer = null;
            syncCacheToPage().catch((error) => log('debounced cache sync failed', error));
        }, delay);
    }

    async function saveCorrelation(alphaId, type, data) {
        const normalizedId = normalizeAlphaId(alphaId);
        if (!normalizedId) return;

        const subType = normalizeCorrelationType(type);
        const stats = extractCorrelationStats(data);
        if (!isUsableStats(stats)) return;

        const key = `${STORAGE_PREFIX}${normalizedId}`;
        const existing = (await chrome.storage.local.get(key))[key] || {};
        const next = {
            ...existing,
            [subType]: {
                max: stats.max,
                min: stats.min,
                updated: Date.now(),
            },
        };
        await chrome.storage.local.set({ [key]: next });
        // 不再直接调 syncCacheToPage：chrome.storage.set 会触发 onChanged，
        // 由 onChanged 统一触发防抖版 scheduleSyncCache，避免双重全量读取
        if (currentAlphaId === normalizedId || getCurrentAlphaIdFromUrl() === normalizedId) {
            scheduleRender(normalizedId);
        }
        log(`cached ${subType} for ${normalizedId}`, stats);
    }

    function watchUrl() {
        let last = location.href;
        setInterval(() => {
            if (location.href === last) return;
            last = location.href;
            const alphaId = getCurrentAlphaIdFromUrl();
            if (alphaId) scheduleRender(alphaId);
            else removeCard();
        }, 800);
    }

    function watchDialogs() {
        const observer = new MutationObserver(() => {
            const alphaId = getCurrentAlphaIdFromUrl();
            if (alphaId) {
                scheduleRender(alphaId);
                return;
            }
            const link = document.querySelector('[role="dialog"] a[href*="/alpha"]');
            const match = link?.href?.match(/\/alphas?\/([^/?#]+)/);
            if (match?.[1]) scheduleRender(match[1]);
        });
        observer.observe(document.body, { childList: true, subtree: true });
    }

    window.addEventListener('message', (event) => {
        if (event.source !== window || !event.data || typeof event.data.type !== 'string') return;
        if (event.data.type === 'WQP_PRODMEMO_CORRELATION_DATA') {
            saveCorrelation(event.data.alphaId, event.data.subType, event.data.data)
                .catch((error) => log('save failed', error));
        }
        if (event.data.type === 'WQP_PRODMEMO_ALPHA_VIEW') {
            scheduleRender(event.data.alphaId);
        }
    });

    chrome.storage.onChanged.addListener((changes, namespace) => {
        if (namespace !== 'local') return;
        const hasProdMemoChange = Object.keys(changes).some((key) => key.startsWith(STORAGE_PREFIX));
        if (!hasProdMemoChange) return;
        // 防抖：短时间内多次 storage 变化合并为一次全量同步
        scheduleSyncCache();
        if (currentAlphaId) scheduleRender(currentAlphaId);
    });

    syncCacheToPage().catch((error) => log('initial cache sync failed', error));
    const initialAlphaId = getCurrentAlphaIdFromUrl();
    if (initialAlphaId) scheduleRender(initialAlphaId);
    watchUrl();
    if (document.body) watchDialogs();
    else document.addEventListener('DOMContentLoaded', watchDialogs, { once: true });
})();
