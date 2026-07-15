(function () {
    'use strict';

    function isRegular(checks) {
        return checks?.type === 'REGULAR';
    }

    function prodCorrColor(val) {
        if (val === '-') return '';
        if (val >= 0.7) return '#b91c1c';
        if (val < 0.5) return '#b45309';
        return '#15803d';
    }

    function renderCheckBadge(el, checks) {
        // 仅依赖 failedNumRA + failedNumPPA，不再读 failedNum（WQ API 原始字段语义不一致）
        const { failedNum= 0, failedNumRA = 0, failedNumPPA = 0 } = checks;
        let symbol, bg, title;

        // 处理 failedNum > 0 的情况
        if(failedNum > 0) {
            symbol = '✗'; bg = '#dc2626'; title = `${failedNum} FAIL`;
            el.innerHTML = `<span style="display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;border-radius:50%;background:${bg};color:#fff;font-size:14px;font-weight:700;line-height:1;cursor:pointer;margin-top:8px;">${symbol}</span>`;
            el.title = title;
            return;
        }

        if (failedNumRA === 0 && failedNumPPA === 0) {
            symbol = '✓'; bg = '#16a34a'; title = `RA PASS`;
        } else if (failedNumPPA === 0) {
            symbol = '⚠'; bg = '#ca8a04'; title = `RA ${failedNumRA} FAIL / PPA PASS`;
        } else {
            symbol = '✗'; bg = '#dc2626'; title = `RA ${failedNumRA} / PPA ${failedNumPPA} FAIL`;
        }

        el.innerHTML = `<span style="display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;border-radius:50%;background:${bg};color:#fff;font-size:14px;font-weight:700;line-height:1;cursor:pointer;margin-top:8px;">${symbol}</span>`;
        el.title = title;
    }

    function renderPyramidBadge(el, val) {
        el.innerHTML = `<span style="display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;border-radius:50%;background:#6366f1;color:#fff;font-size:11px;font-weight:700;line-height:1;cursor:pointer;margin-top:8px;">${val}</span>`;
        el.title = `Pyramid Multiplier: ${val}`;
    }

    function renderOperatorBadge(el, val) {
        el.innerHTML = `<span style="display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;border-radius:50%;background:#0891b2;color:#fff;font-size:11px;font-weight:700;line-height:1;cursor:pointer;margin-top:8px;">${val}</span>`;
        el.title = `Operator Count: ${val}`;
    }

    function renderBookSize(cell, checks) {
        const wqppys = checks.WQPPYS || '-';
        const raw = checks.maxProdCorr;
        const prodCorrNum = raw !== null && raw !== undefined && raw !== '' ? Number(raw) : NaN;
        const prodCorr = Number.isFinite(prodCorrNum) ? prodCorrNum.toFixed(2) : '-';
        const color = prodCorrColor(prodCorr);
        cell.innerHTML = `${wqppys} <span style="color:${color};font-weight:600;">${prodCorr}</span>`;
    }

    function processRow(row) {
        if (row.dataset.wqpRowDone) return;

        const idEl = row.querySelector('.alpha-id-cell__value');
        if (!idEl) return;
        const alphaId = idEl.textContent?.trim();
        if (!alphaId) return;

        const checks = window.__wqp_alpha_checks?.get(alphaId);
        if (checks === undefined) return;

        row.dataset.wqpRowDone = '1';

        const codeBtn = row.querySelector('.alphas-list-table__clickable-icon.code-btn');
        if (codeBtn) renderCheckBadge(codeBtn, checks);

        if (isRegular(checks)) {
            const compareEl = row.querySelector('.alpha-list-table__container--add-to-compare');
            if (compareEl && checks.pyramidMultiplier != null) renderPyramidBadge(compareEl, checks.pyramidMultiplier);

            const starEl = row.querySelector('.alphas-list-table__clickable-icon.star');
            if (starEl && checks.operatorCount != null) renderOperatorBadge(starEl, checks.operatorCount);
        }

        const bookSizeCell = row.querySelector('.alphas-list-table__cell-content--bookSize');
        if (bookSizeCell) renderBookSize(bookSizeCell, checks);
    }

    function scanAll() {
        document.querySelectorAll('.rt-tr-group:not([data-wqp-row-done])').forEach(processRow);
    }

    function onDataUpdated() {
        // 数据已更新：清除所有已处理标记，重新扫描
        document.querySelectorAll('[data-wqp-row-done]').forEach(el => { delete el.dataset.wqpRowDone; });
        scanAll();
        // 兜底轮询：捕获 React 异步渲染的延迟 rows
        // Map 干净后，不存在 "alphaId 找不到导致 done 永远不设" 的死循环，1.2s 足够
        let attempts = 0;
        const stable = setInterval(() => {
            const pending = document.querySelectorAll('.rt-tr-group:not([data-wqp-row-done])').length;
            attempts++;
            if (pending === 0 || attempts >= 6) {
                clearInterval(stable);
                if (pending > 0) console.warn(`[WQP] ${pending} 行未在 1.2s 内处理`);
                return;
            }
            scanAll();
        }, 200);
    }

    function refreshBookSize() {
        document.querySelectorAll('.rt-tr-group[data-wqp-row-done]').forEach(row => {
            const idEl = row.querySelector('.alpha-id-cell__value');
            const alphaId = idEl?.textContent?.trim();
            if (!alphaId) return;
            const checks = window.__wqp_alpha_checks?.get(alphaId);
            if (checks === undefined) return;
            const bookSizeCell = row.querySelector('.alphas-list-table__cell-content--bookSize');
            if (bookSizeCell) renderBookSize(bookSizeCell, checks);
        });
    }

    function start() {
        // 防抖：合并短时间内多次 DOM 变化，避免高频回调（如虚拟滚动、tooltip、loading 动画）
        let debounceTimer = null;
        const observer = new MutationObserver((mutations) => {
            // 触发条件：addedNodes 含 .rt-tr-group（行新增），或任意 mutation 触及行内节点
            const relevant = mutations.some(m => {
                if ([...m.addedNodes].some(n =>
                    n.nodeType === 1 && (
                        n.classList?.contains('rt-tr-group') ||
                        n.querySelector?.('.rt-tr-group')
                    )
                )) return true;
                // 检查 target 本身或其祖先是否是 .rt-tr-group
                let el = m.target;
                while (el && el.nodeType === 1) {
                    if (el.classList?.contains('rt-tr-group')) return true;
                    el = el.parentElement;
                }
                return false;
            });
            if (!relevant) return;
            if (debounceTimer) return;
            debounceTimer = setTimeout(() => {
                debounceTimer = null;
                scanAll();
            }, 100);
        });
        const target = document.body || document.documentElement;
        observer.observe(target, {
            childList: true,
            subtree: true,
            characterData: true,
            attributes: false
        });
        scanAll();
    }

    if (document.body) {
        start();
    } else {
        document.addEventListener('DOMContentLoaded', start);
    }

    window.addEventListener('__wqp_alpha_checks_updated', onDataUpdated);
    window.addEventListener('storage', (e) => {
        if (e.key === 'WQP_ProdMemoCache') refreshBookSize();
    });
})();
