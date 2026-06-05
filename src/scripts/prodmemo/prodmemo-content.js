// ProdMemo Content Script - 在 ISOLATED world 中运行
// 注意：API 拦截逻辑已整合到 background.js 的 injectFetchInterceptor 中
console.log('[WQScope-ProdMemo] Content script loaded');

let currentAlphaId = null;
let isRendering = false;
let renderTimeout = null;
let activeInterval = null;
let contextValid = true;
let contextWarnedOnce = false;


// 检测扩展上下文是否有效
if (typeof chrome !== 'undefined' && chrome.runtime) {
    chrome.runtime.onMessage.addListener(() => { });
    try {
        chrome.runtime.getURL('');
    } catch (e) {
        contextValid = false;
    }
}

// 监听来自 inject.js 的消息
window.addEventListener('message', async (event) => {
    if (!contextValid) return;
    if (event.source !== window) return;

    // 只处理 ProdMemo 相关消息
    if (!event.data.type || !event.data.type.startsWith('WQSCOPE_PRODMEMO')) return;

    console.log('[WQScope-ProdMemo] Received message:', event.data.type, event.data);

    // 数据捕获
    if (event.data.type === 'WQSCOPE_PRODMEMO_DATA') {
        try {
            if (!chrome.runtime?.id) {
                contextValid = false;
                return;
            }

            const { alphaId, data } = event.data;
            console.log(`[WQScope-ProdMemo] Received data for Alpha ${alphaId}`, data);

            const storageKey = `prod_memo_${alphaId}`;
            await chrome.storage.local.set({
                [storageKey]: {
                    timestamp: Date.now(),
                    result: data
                }
            });

            const currentUrlId = getAlphaFromUrl();
            if (currentUrlId === alphaId || currentUrlId === 'unsubmitted') {
                debouncedRenderMemo(alphaId);
            }
        } catch (error) {
            if (error.message.includes('Extension context invalidated')) {
                contextValid = false;
            }
        }
    }

    // 页面浏览触发
    if (event.data.type === 'WQSCOPE_PRODMEMO_VIEW') {
        const { alphaId } = event.data;

        if (currentAlphaId && currentAlphaId !== alphaId) {
            cleanupCard();
        }

        currentAlphaId = alphaId;
        debouncedRenderMemo(alphaId);
    }

    // 列表视图触发
    if (event.data.type === 'WQSCOPE_PRODMEMO_LIST') {
        const { alphaIds, isDataMap } = event.data;

        if (!contextValid || !chrome.runtime?.id) {
            if (!contextWarnedOnce) {
                contextWarnedOnce = true;
            }
            return;
        }

        const keys = alphaIds.map(id => `prod_memo_${id}`);
        chrome.storage.local.get(keys).then(cachedData => {
            injectListCorrelations(alphaIds, cachedData, isDataMap);
        }).catch(error => {
            console.error('[WQScope-ProdMemo] Error querying cached data for list:', error);
        });
    }
});

// 清理检查
setInterval(() => {
    if (!contextValid) return;

    const urlAlphaId = getAlphaFromUrl();
    const isOnAlphaPage = window.location.href.includes('/alpha/') || window.location.href.includes('/alphas/');

    if (currentAlphaId && !isOnAlphaPage) {
        cleanupCard();
    }
}, 2000);

// 添加 title 属性到截断的 alpha 名称
const titleObserver = new MutationObserver(() => {
    const titleElement = document.querySelector('.alphas-details-content__header-title');
    if (titleElement && !titleElement.hasAttribute('title')) {
        titleElement.setAttribute('title', titleElement.textContent.trim());
    }
});

if (document.body) {
    titleObserver.observe(document.body, {
        childList: true,
        subtree: true
    });
}

function getAlphaFromUrl() {
    const match = window.location.href.match(/\/alphas?\/([^/?#]+)/);
    return match ? match[1] : null;
}

function cleanupCard() {
    removeExistingMemo();
    currentAlphaId = null;
    isRendering = false;

    if (renderTimeout) {
        clearTimeout(renderTimeout);
        renderTimeout = null;
    }

    if (activeInterval) {
        clearInterval(activeInterval);
        activeInterval = null;
    }
}

function removeExistingMemo() {
    const existing = document.getElementById('prod-memo-card');
    if (existing) {
        existing.remove();
    }
}

function debouncedRenderMemo(alphaId) {
    if (!contextValid) return;

    if (renderTimeout) {
        clearTimeout(renderTimeout);
    }

    renderTimeout = setTimeout(() => {
        tryRenderMemo(alphaId);
    }, 300);
}

async function tryRenderMemo(alphaId) {
    if (!contextValid) return;

    try {
        if (!chrome.runtime?.id) {
            contextValid = false;
            return;
        }

        if (isRendering) return;
        isRendering = true;

        if (activeInterval) {
            clearInterval(activeInterval);
            activeInterval = null;
        }

        const storageKey = `prod_memo_${alphaId}`;
        const stored = await chrome.storage.local.get(storageKey);
        const cachedData = stored[storageKey];

        if (!cachedData) {
            isRendering = false;
            return;
        }

        const immediateSuccess = injectUI(cachedData);
        if (immediateSuccess) {
            isRendering = false;
            return;
        }

        let attempts = 0;
        const maxAttempts = 15;
        activeInterval = setInterval(() => {
            attempts++;
            const success = injectUI(cachedData);
            if (success) {
                clearInterval(activeInterval);
                activeInterval = null;
                isRendering = false;
            } else if (attempts >= maxAttempts) {
                clearInterval(activeInterval);
                activeInterval = null;
                isRendering = false;
            }
        }, 500);
    } catch (error) {
        if (error.message && error.message.includes('Extension context invalidated')) {
            contextValid = false;
        }
        isRendering = false;
        if (activeInterval) {
            clearInterval(activeInterval);
            activeInterval = null;
        }
    }
}

function injectUI(cachedData) {
    if (document.getElementById('prod-memo-card')) return true;

    let targetContainer = document.querySelector('.correlation__content');

    if (targetContainer) {
        const correlationSections = document.querySelectorAll('.correlation__content');
        for (const section of correlationSections) {
            if (section.textContent.includes('Prod Correlation')) {
                targetContainer = section;
                break;
            }
        }
    }

    if (!targetContainer || !targetContainer.textContent.includes('Prod Correlation')) {
        const allElements = Array.from(document.body.querySelectorAll('*'));
        const targetHeader = allElements.find(el => {
            if (!el.innerText) return false;
            if (el.offsetParent === null) return false;
            const text = el.innerText.toLowerCase();
            const matches = text.includes('prod correlation') || text.includes('production correlation');
            if (!matches) return false;
            if (el.closest('#prod-memo-card')) return false;
            return el.tagName === 'SPAN' || el.classList.contains('correlation__content-status-title') || el.innerText.length < 100;
        });

        if (targetHeader) {
            targetContainer = targetHeader.closest('.correlation__content') || targetHeader.closest('.correlation__content-status') || targetHeader.parentElement;
        }
    }

    if (!targetContainer) return false;

    const card = document.createElement('div');
    card.id = 'prod-memo-card';
    card.className = 'prod-memo-card';

    const maxVal = cachedData.result.max !== undefined ? cachedData.result.max.toFixed(4) : 'N/A';
    const minVal = cachedData.result.min !== undefined ? cachedData.result.min.toFixed(4) : 'N/A';
    const dateStr = new Date(cachedData.timestamp).toLocaleString();

    card.innerHTML = `
        <div class="memo-header">
            <div class="memo-title-group">
                <span class="memo-title">⚡ ProdMemo</span>
                <span class="memo-badge">Cached</span>
            </div>
            <span class="memo-time">${dateStr}</span>
        </div>
        <div class="memo-stats">
            <div class="stat-item">
                <div class="stat-label">Max Correlation</div>
                <div class="stat-value ${parseFloat(maxVal) > 0.7 ? 'negative' : 'positive'}">${maxVal}</div>
            </div>
            <div class="stat-item">
                <div class="stat-label">Min Correlation</div>
                <div class="stat-value ${parseFloat(minVal) < -0.7 ? 'negative' : 'positive'}">${minVal}</div>
            </div>
        </div>
    `;

    targetContainer.appendChild(card);
    return true;
}

// ========== 列表视图注入 ==========

function injectListCorrelations(alphaIds, cachedData, isDataMap = {}) {
    let attempts = 0;
    const maxAttempts = 10;

    const tryInject = () => {
        attempts++;
        const success = injectListCorrelationsOnce(alphaIds, cachedData, isDataMap);
        if (!success && attempts < maxAttempts) {
            setTimeout(tryInject, 300);
        }
    };

    tryInject();
}

function injectListCorrelationsOnce(alphaIds, cachedData, isDataMap = {}) {
    const headerGroups = document.querySelector('.rt-thead.-headerGroups .rt-tr');
    if (!headerGroups) return false;

    // 替换 Book Size 表头
    let bookSizeHeader = headerGroups.querySelector('.table__sort--bookSize');

    if (!bookSizeHeader) {
        const allHeaders = headerGroups.querySelectorAll('.rt-th');
        allHeaders.forEach(header => {
            if (header.textContent.trim().toLowerCase().includes('book size')) {
                bookSizeHeader = header.querySelector('.table__sort') || header;
            }
        });
    }

    if (bookSizeHeader && !bookSizeHeader.classList.contains('prod-corr-replaced')) {
        const sortDiv = bookSizeHeader;
        sortDiv.textContent = 'Prod Corr';
        sortDiv.style.fontWeight = '600';
        sortDiv.style.color = '#fff';
        sortDiv.classList.add('prod-corr-replaced');
        sortDiv.classList.remove('table__sort', 'table__sort--bookSize');
    }

    const bookSizeHeaderCheck = headerGroups.querySelector('.table__sort--bookSize') ||
        headerGroups.querySelector('.prod-corr-replaced');
    if (!bookSizeHeaderCheck) return false;

    const dataRows = document.querySelectorAll('.rt-tbody .rt-tr-group .rt-tr');
    if (dataRows.length === 0) return false;

    dataRows.forEach((row, index) => {
        if (index >= alphaIds.length) return;

        const alphaId = alphaIds[index];
        const data = cachedData[`prod_memo_${alphaId}`];
        const isData = isDataMap[alphaId] || {};

        // 替换 Book Size 单元格 - 整合 Failed RA、Failed PPA 和 Prod Corr
        const bookSizeCell = row.querySelector('.alphas-list-table__cell-content--bookSize');
        if (bookSizeCell) {
            const prodCorrValue = data?.result?.max;
            // const failedRA = isData.failedNumRA ?? 0;
            // const failedPPA = isData.failedNumPPA ?? 0;

            let displayProdCorr = '-';
            let prodCorrColorClass = '';
            if (prodCorrValue !== undefined) {
                displayProdCorr = prodCorrValue.toFixed(4);
                // Prod Corr 使用原来的样式逻辑
                prodCorrColorClass = prodCorrValue > 0.7 ? 'high-corr' : (prodCorrValue > 0.5 ? 'medium-corr' : 'low-corr');
            }

            // Failed RA 和 Failed PPA 的颜色逻辑：有失败为红色，无失败为绿色
            // const failedRAColor = failedRA > 0 ? 'fail-color' : 'pass-color';
            // const failedPPAColor = failedPPA > 0 ? 'fail-color' : 'pass-color';

            // Pyramid 信息
            const pyramids = isData.pyramids || '';

            bookSizeCell.className = `alphas-list-table__cell-content alphas-list-table__cell-content--number alphas-list-table__cell-content--bookSize prod-corr-replaced`;
            // bookSizeCell.innerHTML = `<div><span class="pyramid-badge">${pyramids}</span> <span class="${failedRAColor}">${failedRA}</span> <span class="${failedPPAColor}">${failedPPA}</span> <span class="${prodCorrColorClass}">${displayProdCorr}</span></div>`;
            bookSizeCell.innerHTML = `<div><span class="${prodCorrColorClass}">${displayProdCorr}</span> <span class="pyramid-badge">${pyramids}</span></div>`;
        }

        // IS Checks 图标 - 基于 failedNumRA / failedNumPPA
        const codeBtn = row.querySelector('.alphas-list-table__clickable-icon.code-btn');
        if (codeBtn) {
            const failedRA = isData.failedNumRA ?? 0;
            const failedPPA = isData.failedNumPPA ?? 0;

            let isIcon, isClass, tooltip;

            if (failedRA === 0) {
                // RA 全过 → 绿色通过
                isIcon = '✓';
                isClass = 'is-pass';
                tooltip = 'IS Passed';
            } else if (failedPPA === 0) {
                // RA 有失败但 PPA 全过 → 黄色警告
                isIcon = '⚠';
                isClass = 'is-warn';
                tooltip = `RA Failed(${failedRA}), PPA Passed`;
            } else {
                // RA 和 PPA 都有失败 → 红色失败
                isIcon = '✗';
                isClass = 'is-fail';
                tooltip = `RA Failed(${failedRA}), PPA Failed(${failedPPA})`;
            }

            codeBtn.innerHTML = `<span class="is-check-icon ${isClass}" title="${tooltip}">${isIcon}</span>`;
        }

        // Star 图标替换为 operatorCount
        const starBtn = row.querySelector('.alphas-list-table__clickable-icon.star');
        if (starBtn) {
            const operatorCount = isData.operatorCount;
            const displayOpCount = operatorCount !== null && operatorCount !== undefined ? operatorCount : '-';
            starBtn.innerHTML = `<span class="operator-count-badge" title="Operator Count">${displayOpCount}</span>`;
            starBtn.style.backgroundImage = 'none';
        }

        // Multiplier 显示
        const compareContainer = row.querySelector('.alpha-list-table__container--add-to-compare');
        if (compareContainer) {
            const multiplier = isData.multiplier;
            const displayMultiplier = multiplier !== null && multiplier !== undefined ? `${multiplier.toFixed(1)}x` : '-';
            compareContainer.innerHTML = `<span class="multiplier-badge" title="Multiplier">${displayMultiplier}</span>`;
        }
    });

    return true;
}
