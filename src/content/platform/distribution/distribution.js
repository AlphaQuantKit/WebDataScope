(function (global) {
    'use strict';

    const DIVERSITY_URL = 'https://api.worldquantbrain.com/users/self/activities/diversity?grouping=region,delay,dataCategory';
    const CARD_ID = 'wqp-alpha-distribution';

    function finiteNumber(value, fallback = 0) {
        if (value === null || value === undefined || value === '') return fallback;
        const number = Number(value);
        return Number.isFinite(number) ? number : fallback;
    }

    function uniqueValuesInOrder(values) {
        return [...new Set(values.filter(Boolean).map((value) => String(value)))];
    }

    function combineCheck(left, right) {
        const rank = { PASS: 0, WARN: 1, FAIL: 2 };
        const normalizedLeft = String(left || '').toUpperCase();
        const normalizedRight = String(right || '').toUpperCase();
        if (!normalizedLeft) return normalizedRight;
        if (!normalizedRight) return normalizedLeft;
        return (rank[normalizedRight] ?? 2) > (rank[normalizedLeft] ?? 2)
            ? normalizedRight
            : normalizedLeft;
    }

    function percentageGradient(value) {
        const ratio = Math.max(0, Math.min(1, finiteNumber(value)));
        const lightness = Math.round((94 - ratio * 55) * 10) / 10;
        return {
            ratio,
            lightness,
            backgroundColor: `hsl(178 50% ${lightness}%)`,
            color: ratio >= 0.65 ? '#fff' : '#21494b',
        };
    }

    function ratioToTotal(value, total) {
        const normalizedTotal = finiteNumber(total);
        return normalizedTotal > 0 ? finiteNumber(value) / normalizedTotal : 0;
    }

    function resolveCellAppearance(check, ratio) {
        const normalizedCheck = String(check || '').trim().toUpperCase();
        if (normalizedCheck === 'FAIL') {
            return { mode: 'fail', backgroundColor: 'rgba(226, 49, 32, 1)', color: '#fff' };
        }
        if (normalizedCheck === 'WARN') {
            return { mode: 'warn', backgroundColor: 'rgba(245, 158, 11, 1)', color: '#fff' };
        }
        return { mode: 'gradient', ...percentageGradient(ratio) };
    }

    function normalizeDiversityData(payload) {
        const rows = Array.isArray(payload?.alphas) ? payload.alphas : [];
        const regionSet = new Set();
        const delaysByRegion = new Map();
        const categoriesById = new Map();
        const totals = new Map();
        const cells = new Map();
        const rowTotals = new Map();

        rows.forEach((row) => {
            const region = String(row?.region || '').trim().toUpperCase();
            const rawDelay = row?.delay;
            if (rawDelay === null || rawDelay === undefined || rawDelay === '') return;
            const delay = Number(rawDelay);
            if (!region || ![0, 1].includes(delay)) return;
            regionSet.add(region);
            if (!delaysByRegion.has(region)) delaysByRegion.set(region, new Set());
            delaysByRegion.get(region).add(delay);

            const groupKey = `${region}|${delay}`;
            const categoryId = String(row?.dataCategory?.id || '').trim().toLowerCase();
            if (!categoryId) {
                totals.set(groupKey, Math.max(
                    totals.get(groupKey) || 0,
                    finiteNumber(row?.alphaCount),
                ));
                return;
            }

            const categoryName = String(row?.dataCategory?.name || categoryId).trim();
            categoriesById.set(categoryId, categoryName || categoryId);
            const cellKey = `${groupKey}|${categoryId}`;
            const existing = cells.get(cellKey);
            cells.set(cellKey, {
                region,
                delay,
                categoryId,
                categoryName: categoryName || categoryId,
                alphaCount: finiteNumber(existing?.alphaCount) + finiteNumber(row?.alphaCount),
                check: combineCheck(existing?.check, row?.dataDiversity?.check),
                limit: row?.dataDiversity?.limit ?? existing?.limit ?? null,
            });
        });

        for (const [cellKey, cell] of cells) {
            const groupKey = `${cell.region}|${cell.delay}`;
            if (!totals.has(groupKey)) {
                totals.set(groupKey, Math.max(
                    totals.get(groupKey) || 0,
                    cell.alphaCount,
                ));
            }
            cells.set(cellKey, {
                ...cell,
                ratio: totals.get(groupKey) > 0 ? cell.alphaCount / totals.get(groupKey) : 0,
            });
            rowTotals.set(
                cell.categoryId,
                finiteNumber(rowTotals.get(cell.categoryId)) + cell.alphaCount,
            );
        }

        const regions = uniqueValuesInOrder([...regionSet]);
        const categories = [...categoriesById.entries()]
            .map(([id, name]) => ({ id, name }))
            .sort((left, right) => left.name.localeCompare(right.name));
        const columns = regions.flatMap((region) => (
            [...(delaysByRegion.get(region) || [])]
                .map((delay, index) => ({ region, delay, firstInRegion: index === 0 }))
        ));

        return {
            totalAlphaCount: finiteNumber(payload?.count),
            regions,
            categories,
            columns,
            delaysByRegion,
            totals,
            rowTotals,
            grandTotal: [...totals.values()].reduce((sum, value) => sum + finiteNumber(value), 0),
            cells,
        };
    }

    const modelApi = Object.freeze({
        normalizeDiversityData,
        percentageGradient,
        ratioToTotal,
        resolveCellAppearance,
        uniqueValuesInOrder,
    });
    global.WQPDistributionModel = modelApi;

    if (typeof document === 'undefined' || typeof fetch === 'undefined') return;
    if (global.__wqpAlphaDistributionInstalled) return;
    global.__wqpAlphaDistributionInstalled = true;

    function createElement(tagName, className = '', text = '') {
        const element = document.createElement(tagName);
        if (className) element.className = className;
        if (text !== '') element.textContent = text;
        return element;
    }

    function formatPercent(value) {
        const percentage = finiteNumber(value) * 100;
        if (percentage === 0) return '0%';
        if (percentage < 1) return '<1%';
        return `${Math.round(percentage)}%`;
    }

    function createTotalValue(count, total, className) {
        const value = createElement('div', className);
        value.append(
            createElement('span', 'wqp-distribution-total-count', String(count)),
            createElement('span', 'wqp-distribution-total-ratio', formatPercent(ratioToTotal(count, total))),
        );
        return value;
    }

    function createHeader(model) {
        const header = createElement('div', 'wqp-distribution-header');
        const heading = createElement('div');
        heading.append(
            createElement('div', 'wqp-distribution-title', 'Alpha Distribution'),
            createElement('div', 'wqp-distribution-subtitle', 'Region / Delay 按接口返回顺序展示'),
        );
        const summary = createElement('div', 'wqp-distribution-summary');
        summary.append(
            createElement('strong', '', String(model.totalAlphaCount)),
            document.createTextNode(' Alphas'),
        );
        header.append(heading, summary);
        return header;
    }

    function createLegend() {
        const legend = createElement('div', 'wqp-distribution-legend');
        [
            ['is-gradient', '其他：按百分比梯度'],
            ['is-warn', 'WARN'],
            ['is-fail', 'FAIL'],
            ['is-empty', '无 Alpha / 无数据'],
        ].forEach(([className, label]) => {
            const item = createElement('span', 'wqp-distribution-legend-item');
            item.append(
                createElement('span', `wqp-distribution-legend-color ${className}`),
                document.createTextNode(label),
            );
            legend.appendChild(item);
        });
        return legend;
    }

    function createValueCell(model, category, column) {
        const tableCell = createElement('td', column.firstInRegion ? 'is-region-start' : '');
        const key = `${column.region}|${column.delay}|${category.id}`;
        const record = model.cells.get(key);
        const value = createElement('div', 'wqp-distribution-value');

        if (!record) {
            value.classList.add('is-empty');
            value.append(
                createElement('span', 'wqp-distribution-count', '0'),
                createElement('span', 'wqp-distribution-ratio', '—'),
            );
            value.title = `${category.name} · ${column.region} · Delay ${column.delay}: 0 Alpha`;
        } else {
            const appearance = resolveCellAppearance(record.check, record.ratio);
            value.classList.add(`is-${appearance.mode}`);
            value.style.backgroundColor = appearance.backgroundColor;
            value.style.color = appearance.color;
            value.append(
                createElement('span', 'wqp-distribution-count', String(record.alphaCount)),
                createElement('span', 'wqp-distribution-ratio', formatPercent(record.ratio)),
            );
            const groupTotal = model.totals.get(`${column.region}|${column.delay}`) || 0;
            const limit = record.limit === null ? '' : ` · limit ${record.limit}`;
            value.title = [
                `${category.name} · ${column.region} · Delay ${column.delay}`,
                `${record.alphaCount}/${groupTotal} (${formatPercent(record.ratio)})`,
                `${record.check || 'UNKNOWN'}${limit}`,
            ].join('\n');
        }
        value.setAttribute('aria-label', value.title.replaceAll('\n', ', '));
        tableCell.appendChild(value);
        return tableCell;
    }

    function createDistributionTable(model) {
        const shell = createElement('div', 'wqp-distribution-table-shell');
        const table = createElement('table', 'wqp-distribution-table');
        const columns = document.createElement('colgroup');
        columns.appendChild(createElement('col', 'wqp-distribution-category-column'));
        model.columns.forEach(() => columns.appendChild(createElement('col', 'wqp-distribution-data-column')));
        columns.appendChild(createElement('col', 'wqp-distribution-row-total-column'));
        const head = document.createElement('thead');
        const regionRow = document.createElement('tr');
        const categoryHeader = createElement('th', 'wqp-distribution-category-header', 'Category');
        regionRow.appendChild(categoryHeader);
        model.regions.forEach((region) => {
            const regionHeader = createElement('th', 'wqp-distribution-region-header', region);
            regionHeader.colSpan = model.delaysByRegion.get(region)?.size || 1;
            regionRow.appendChild(regionHeader);
        });
        const rowTotalHeader = createElement('th', 'wqp-distribution-row-total-header', 'TOTAL');
        rowTotalHeader.rowSpan = 2;
        rowTotalHeader.scope = 'col';
        rowTotalHeader.title = '每个 Data Category 跨全部 Region / Delay 的 Alpha 总数';
        regionRow.appendChild(rowTotalHeader);

        const delayRow = document.createElement('tr');
        delayRow.appendChild(createElement('th', 'wqp-distribution-delay-spacer'));
        model.columns.forEach((column) => {
            const delayHeader = createElement(
                'th',
                `wqp-distribution-delay-header${column.firstInRegion ? ' is-region-start' : ''}`,
                String(column.delay),
            );
            delayHeader.title = `${column.region} · Delay ${column.delay}`;
            delayRow.appendChild(delayHeader);
        });
        head.append(regionRow, delayRow);

        const body = document.createElement('tbody');
        model.categories.forEach((category) => {
            const row = document.createElement('tr');
            const nameCell = createElement('th', 'wqp-distribution-category', category.name);
            nameCell.scope = 'row';
            nameCell.title = category.id;
            row.appendChild(nameCell);
            model.columns.forEach((column) => row.appendChild(createValueCell(model, category, column)));
            const rowTotal = model.rowTotals.get(category.id) || 0;
            const rowTotalCell = createElement('td', 'wqp-distribution-row-total-cell');
            const rowTotalValue = createTotalValue(rowTotal, model.totalAlphaCount, 'wqp-distribution-row-total');
            rowTotalValue.title = `${category.name}: ${rowTotal}/${model.totalAlphaCount} (${formatPercent(ratioToTotal(rowTotal, model.totalAlphaCount))})`;
            rowTotalValue.setAttribute('aria-label', rowTotalValue.title);
            rowTotalCell.appendChild(rowTotalValue);
            row.appendChild(rowTotalCell);
            body.appendChild(row);
        });

        const foot = document.createElement('tfoot');
        const totalRow = document.createElement('tr');
        totalRow.appendChild(createElement('th', 'wqp-distribution-category wqp-distribution-total-label', 'TOTAL'));
        model.columns.forEach((column) => {
            const totalCell = createElement('td', column.firstInRegion ? 'is-region-start' : '');
            const columnTotal = model.totals.get(`${column.region}|${column.delay}`) || 0;
            const totalValue = createTotalValue(columnTotal, model.totalAlphaCount, 'wqp-distribution-total');
            totalValue.title = `${column.region} · Delay ${column.delay}: ${columnTotal}/${model.totalAlphaCount} (${formatPercent(ratioToTotal(columnTotal, model.totalAlphaCount))})`;
            totalValue.setAttribute('aria-label', totalValue.title);
            totalCell.appendChild(totalValue);
            totalRow.appendChild(totalCell);
        });
        const grandTotalCell = createElement('td', 'wqp-distribution-row-total-cell');
        const grandTotal = createTotalValue(model.grandTotal, model.totalAlphaCount, 'wqp-distribution-total wqp-distribution-grand-total');
        grandTotal.title = `全部 Region / Delay: ${model.grandTotal}/${model.totalAlphaCount} (${formatPercent(ratioToTotal(model.grandTotal, model.totalAlphaCount))})`;
        grandTotal.setAttribute('aria-label', grandTotal.title);
        grandTotalCell.appendChild(grandTotal);
        totalRow.appendChild(grandTotalCell);
        foot.appendChild(totalRow);

        table.append(columns, head, body, foot);
        shell.appendChild(table);
        return shell;
    }

    function renderLoading(card) {
        card.replaceChildren();
        const loading = createElement('div', 'wqp-distribution-state');
        loading.append(
            createElement('span', 'wqp-distribution-spinner'),
            document.createTextNode('正在加载 Alpha Distribution…'),
        );
        card.appendChild(loading);
    }

    function renderError(card, error) {
        card.replaceChildren();
        const state = createElement('div', 'wqp-distribution-state is-error');
        state.appendChild(createElement('div', '', `Alpha Distribution 加载失败：${error.message || String(error)}`));
        const retryButton = createElement('button', 'wqp-distribution-retry', '重新加载');
        retryButton.type = 'button';
        retryButton.addEventListener('click', () => loadDistribution(card));
        state.appendChild(retryButton);
        card.appendChild(state);
    }

    function renderDistribution(card, payload) {
        const model = normalizeDiversityData(payload);
        if (!model.columns.length || !model.categories.length) {
            throw new Error('接口没有返回可展示的 Region、Delay 或 Data Category。');
        }
        card.replaceChildren(
            createHeader(model),
            createLegend(),
            createDistributionTable(model),
        );
    }

    async function requestDiversity() {
        const response = await fetch(DIVERSITY_URL, {
            method: 'GET',
            credentials: 'include',
            headers: { accept: 'application/json;version=2.0' },
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        if (!Array.isArray(data?.alphas)) throw new Error('接口响应格式无效。');
        return data;
    }

    async function loadDistribution(card) {
        renderLoading(card);
        try {
            renderDistribution(card, await requestDiversity());
        } catch (error) {
            console.error('[WQP Distribution]', error);
            renderError(card, error);
        }
    }

    function waitForAnchor(timeoutMs = 30000) {
        return new Promise((resolve, reject) => {
            const current = document.querySelector('.card__wrapper');
            if (current) {
                resolve(current);
                return;
            }
            const observer = new MutationObserver(() => {
                const element = document.querySelector('.card__wrapper');
                if (!element) return;
                observer.disconnect();
                clearTimeout(timeoutId);
                resolve(element);
            });
            observer.observe(document.documentElement, { childList: true, subtree: true });
            const timeoutId = setTimeout(() => {
                observer.disconnect();
                reject(new Error('未找到 Distribution 页面容器。'));
            }, timeoutMs);
        });
    }

    async function initialize() {
        const normalizedPath = location.pathname.replace(/\/+$/, '');
        if (!normalizedPath.endsWith('/alphas/distribution')) return;
        try {
            const wrapper = await waitForAnchor();
            wrapper.querySelectorAll('.alpha_distribution').forEach((element) => element.remove());
            const card = createElement('section', 'card__content alpha_distribution');
            card.id = CARD_ID;
            const insertionPoint = wrapper.children[1] || null;
            wrapper.insertBefore(card, insertionPoint);
            await loadDistribution(card);
        } catch (error) {
            console.error('[WQP Distribution]', error);
        }
    }

    initialize();
})(typeof globalThis === 'undefined' ? window : globalThis);
