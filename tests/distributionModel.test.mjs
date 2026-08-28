import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

await import('../src/content/platform/distribution/distribution.js');

const {
    normalizeDiversityData,
    percentageGradient,
    ratioToTotal,
    resolveCellAppearance,
    uniqueValuesInOrder,
} = globalThis.WQPDistributionModel;

test('distribution model groups Region/Delay columns in API response order', () => {
    const model = normalizeDiversityData({
        count: 20,
        alphas: [
            { region: 'GLB', delay: 1, alphaCount: 4, dataCategory: { id: 'model', name: 'Model' }, dataDiversity: { check: 'PASS', limit: 0.3 } },
            { region: 'USA', delay: 1, alphaCount: 6, dataCategory: { id: 'model', name: 'Model' }, dataDiversity: { check: 'WARN', limit: 0.3 } },
            { region: 'USA', delay: 0, alphaCount: 2, dataCategory: { id: 'analyst', name: 'Analyst' }, dataDiversity: { check: 'PASS', limit: 0.3 } },
            { region: 'USA', delay: 0, alphaCount: 5, dataCategory: { id: null, name: null } },
            { region: 'USA', delay: 1, alphaCount: 10, dataCategory: { id: null, name: null } },
            { region: 'GLB', delay: 1, alphaCount: 5, dataCategory: { id: null, name: null } },
            { region: 'USA', delay: null, alphaCount: 15, dataCategory: { id: null, name: null } },
        ],
    });

    assert.deepEqual(model.regions, ['GLB', 'USA']);
    assert.deepEqual(
        model.columns.map(({ region, delay }) => `${region}:${delay}`),
        ['GLB:1', 'USA:1', 'USA:0'],
    );
    assert.deepEqual(model.categories.map(({ id }) => id), ['analyst', 'model']);
    assert.equal(model.totals.get('USA|0'), 5);
    assert.equal(model.rowTotals.get('analyst'), 2);
    assert.equal(model.rowTotals.get('model'), 10);
    assert.equal(model.grandTotal, 20);
    assert.equal(model.cells.get('USA|0|analyst').ratio, 0.4);
    assert.equal(model.cells.get('USA|1|model').check, 'WARN');
});

test('distribution model combines duplicate cells and keeps the most severe check', () => {
    const model = normalizeDiversityData({
        alphas: [
            { region: 'AMR', delay: 1, alphaCount: 2, dataCategory: { id: 'news', name: 'News' }, dataDiversity: { check: 'PASS' } },
            { region: 'AMR', delay: 1, alphaCount: 3, dataCategory: { id: 'news', name: 'News' }, dataDiversity: { check: 'FAIL' } },
            { region: 'AMR', delay: 1, alphaCount: 10, dataCategory: { id: null, name: null } },
        ],
    });
    const cell = model.cells.get('AMR|1|news');
    assert.equal(cell.alphaCount, 5);
    assert.equal(cell.check, 'FAIL');
    assert.equal(cell.ratio, 0.5);
    assert.equal(model.rowTotals.get('news'), 5);
    assert.equal(model.grandTotal, 10);
});

test('API ordering removes duplicates without reordering values', () => {
    assert.deepEqual(
        uniqueValuesInOrder(['ZZZ', 'USA', 'ZZZ', 'AAA']),
        ['ZZZ', 'USA', 'AAA'],
    );
});

test('FAIL is red, WARN is orange, and all other checks use a clipped percentage gradient', () => {
    assert.deepEqual(resolveCellAppearance('FAIL', 0.9), {
        mode: 'fail',
        backgroundColor: 'rgba(226, 49, 32, 1)',
        color: '#fff',
    });
    assert.deepEqual(resolveCellAppearance('WARN', 0.9), {
        mode: 'warn',
        backgroundColor: 'rgba(245, 158, 11, 1)',
        color: '#fff',
    });
    assert.equal(resolveCellAppearance('PASS', 0.5).mode, 'gradient');
    assert.equal(resolveCellAppearance('UNKNOWN', 0.5).mode, 'gradient');
    assert.equal(percentageGradient(-1).ratio, 0);
    assert.equal(percentageGradient(2).ratio, 1);
    assert.ok(percentageGradient(0.8).lightness < percentageGradient(0.2).lightness);
});

test('both TOTAL directions use the overall Alpha count as percentage denominator', () => {
    assert.equal(ratioToTotal(5, 20), 0.25);
    assert.equal(ratioToTotal(10, 20), 0.5);
    assert.equal(ratioToTotal(20, 20), 1);
    assert.equal(ratioToTotal(5, 0), 0);
});

test('distribution table renders a right-side row total and a bottom-right grand total', async () => {
    const source = await readFile(new URL('../src/content/platform/distribution/distribution.js', import.meta.url), 'utf8');
    const styles = await readFile(new URL('../src/content/platform/distribution/distribution.css', import.meta.url), 'utf8');
    assert.match(source, /rowTotalHeader\.rowSpan = 2/);
    assert.match(source, /model\.rowTotals\.get\(category\.id\)/);
    assert.match(source, /wqp-distribution-grand-total/);
    assert.match(source, /createTotalValue\(columnTotal, model\.totalAlphaCount/);
    assert.match(source, /createTotalValue\(rowTotal, model\.totalAlphaCount/);
    assert.match(styles, /\.wqp-distribution-row-total-header/);
    assert.match(styles, /td\.wqp-distribution-row-total-cell/);
    assert.match(styles, /\.wqp-distribution-total-ratio/);
});
