(function () {
    'use strict';

    function isRegular(checks) {
        return checks?.type === 'REGULAR';
    }

    function prodCorrColor(val) {
        if (val === '-') return '';
        if (val > 0.7) return '#dc2626';
        if (val <= 0.5) return '#16a34a';
        return '#2563eb';
    }

    function renderCheckBadge(el, checks) {
        const { failedNum = 0, failedNumRA = 0, failedNumPPA = 0 } = checks;
        let symbol, bg, title;

        if (failedNum > 0 ) {
            symbol = '✗'; bg = '#dc2626'; title = `RA ${failedNum} FAIL`;
        } else {
            if (failedNumRA === 0 && failedNumPPA === 0) {
                symbol = '✓'; bg = '#16a34a'; title = 'RA PASS';
            } else if (failedNumPPA === 0) {
                symbol = '⚠'; bg = '#ca8a04'; title = `RA ${failedNumRA} FAIL / PPA PASS`;
            } else {
                symbol = '✗'; bg = '#dc2626'; title = `RA ${failedNumRA} / PPA ${failedNumPPA} FAIL`;
            }
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
        document.querySelectorAll('[data-wqp-row-done]').forEach(el => { delete el.dataset.wqpRowDone; });
        scanAll();
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
        const observer = new MutationObserver(scanAll);
        const target = document.body || document.documentElement;
        observer.observe(target, { childList: true, subtree: true });
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
