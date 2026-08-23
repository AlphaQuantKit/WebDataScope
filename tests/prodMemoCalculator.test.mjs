import assert from 'node:assert/strict';
import test from 'node:test';
import {
    alphaCorrelationGroupKey,
    alphaGroupKey,
    calculationFingerprint,
    calculateForwardFilledReturns,
    calculateLocalCorrelation,
    calculateProdLowerBound,
    correlationLowerBound,
    normalizePnl,
    pearsonCorrelation,
    rollingWindowStart,
    selectCandidateAlphas,
    trimPnlToRecentYears,
} from '../src/background/services/prodMemoCalculator.js';
import {
    buildCalculationContext,
    extractPlatformCorrelationStats,
    resolvePreferredCorrelation,
    sharedRecordsToCalculationPnls,
} from '../src/background/services/prodMemoService.js';

const settings = (delay = 1, universe = 'TOP3000', region = 'USA') => ({
    region,
    universe,
    delay,
    instrumentType: 'EQUITY',
});

function alpha(id, options = {}) {
    return {
        id,
        name: id,
        settings: options.settings || settings(),
        stage: options.stage || 'OS',
        submitted: options.submitted !== false,
        classifications: options.classifications || [{ id: 'REGULAR:REGULAR' }],
        is: {},
    };
}

function pnl(alphaId, values) {
    return {
        alphaId,
        records: values.map((value, index) => [`2026-01-0${index + 1}`, value]),
    };
}

test('PnL normalization, exact rolling window and forward-fill match the specified preprocessing', () => {
    const source = {
        records: [
            ['2026-08-05T00:00:00Z', 4],
            ['bad', 2],
            ['2022-08-05', 1],
            ['2026-08-05', 5],
        ],
    };
    const normalized = normalizePnl(source);
    assert.deepEqual(normalized, [['2022-08-05', 1], ['2026-08-05', 5]]);
    assert.equal(normalizePnl(source), normalized);
    assert.equal(rollingWindowStart(normalized), '2022-08-05');

    assert.deepEqual(
        trimPnlToRecentYears({
            records: [
                ['2022-08-04', 0],
                ['2022-08-05', 1],
                ['2026-08-05', 2],
            ],
        }),
        [['2022-08-05', 1], ['2026-08-05', 2]],
    );

    const returns = calculateForwardFilledReturns(
        { records: [['2026-01-01', 1], ['2026-01-03', 4]] },
        ['2026-01-01', '2026-01-02', '2026-01-03'],
        '2025-01-01',
        '2026-01-03',
    );
    assert.deepEqual([...returns], [['2026-01-02', 0], ['2026-01-03', 3]]);
});

test('Pearson calculation reports overlap and preserves signed correlation', () => {
    const positive = pearsonCorrelation(
        new Map([['a', 1], ['b', 2], ['c', 3]]),
        new Map([['a', 2], ['b', 4], ['c', 6]]),
    );
    const negative = pearsonCorrelation(
        new Map([['a', 1], ['b', 2], ['c', 3]]),
        new Map([['a', -2], ['b', -4], ['c', -6]]),
    );
    assert.deepEqual(positive, { value: 1, overlapCount: 3 });
    assert.deepEqual(negative, { value: -1, overlapCount: 3 });
});

test('candidate pools group by region only while preserving classification rules', () => {
    const target = alpha('target');
    const regular = alpha('regular');
    const differentDelay = alpha('delay', { settings: settings(0) });
    const differentUniverse = alpha('universe', { settings: settings(1, 'TOP1000') });
    const differentRegion = alpha('region', { settings: settings(1, 'TOP3000', 'EUR') });
    const powerOnly = alpha('power', {
        stage: 'IS',
        classifications: [{ id: 'POWER_POOL:POWER_POOL_ELIGIBLE' }],
    });
    const powerDifferentUniverseDelay = alpha('power-other-group', {
        settings: settings(0, 'TOP1000'),
        classifications: [{ id: 'POWER_POOL:POWER_POOL_ELIGIBLE' }],
    });
    const powerRegular = alpha('power-regular', {
        classifications: [
            { id: 'POWER_POOL:POWER_POOL_ELIGIBLE' },
            { id: 'REGULAR:REGULAR' },
        ],
    });
    const notSubmitted = alpha('draft', { submitted: false });
    const alphas = [
        target,
        regular,
        differentDelay,
        differentUniverse,
        differentRegion,
        powerOnly,
        powerDifferentUniverseDelay,
        powerRegular,
        notSubmitted,
    ];
    const pnlById = new Map(alphas.map((item) => [item.id, pnl(item.id, [0, 1, 3, 6])]));

    assert.deepEqual(
        selectCandidateAlphas(alphas, pnlById, target, 'SELF').map((item) => item.id),
        ['regular', 'delay', 'universe', 'power', 'power-other-group', 'power-regular'],
    );
    assert.deepEqual(
        selectCandidateAlphas(alphas, pnlById, target, 'POOL').map((item) => item.id),
        ['power', 'power-other-group', 'power-regular'],
    );
    assert.equal(alphaGroupKey(differentDelay), 'USA|TOP3000|D0');
    assert.equal(alphaCorrelationGroupKey(differentDelay), 'USA');
    assert.equal(alphaCorrelationGroupKey(differentUniverse), 'USA');
    assert.equal(alphaCorrelationGroupKey(differentRegion), 'EUR');
});

test('local Self/Pool calculation returns signed extrema and overlap metadata', () => {
    const target = alpha('target');
    const positive = alpha('positive');
    const negative = alpha('negative');
    const targetPnl = pnl('target', [0, 1, 3, 6]);
    const pnlById = new Map([
        ['positive', pnl('positive', [0, 2, 6, 12])],
        ['negative', pnl('negative', [0, -2, -6, -12])],
    ]);
    const result = calculateLocalCorrelation({
        targetAlpha: target,
        targetPnl,
        candidates: [positive, negative],
        pnlById,
        corrType: 'SELF',
    });
    assert.equal(result.available, true);
    assert.equal(result.max, 1);
    assert.equal(result.min, -1);
    assert.equal(result.corrCount, 2);
    assert.equal(result.records[0].overlapCount, 3);
});

test('Prod lower-bound formula selects the maximum witness and uses strict signed math', () => {
    assert.ok(Math.abs(correlationLowerBound(0.5, 0.8) - (-0.11961524227066308)) < 1e-12);
    assert.equal(correlationLowerBound(1, 0.75), 0.75);

    const target = alpha('target');
    const best = alpha('best');
    const other = alpha('other');
    const targetPnl = pnl('target', [0, 1, 3, 6]);
    const pnlById = new Map([
        ['best', pnl('best', [0, 2, 6, 12])],
        ['other', pnl('other', [0, -2, -6, -12])],
    ]);
    const result = calculateProdLowerBound({
        targetAlpha: target,
        targetPnl,
        references: [
            { alpha: best, platformProdMax: 0.75 },
            { alpha: other, platformProdMax: 0.9 },
        ],
        pnlById,
    });
    assert.equal(result.available, true);
    assert.equal(result.max, 0.75);
    assert.equal(result.witness.alphaId, 'best');
    assert.equal(result.witness.overlapCount, 3);
});

test('a target with platform Prod Corr uses itself as the exact lower-bound witness', () => {
    const target = alpha('target');
    const targetPnl = pnl('target', [0, 1, 3, 6]);
    const pnlById = new Map([['target', targetPnl]]);
    const result = calculateProdLowerBound({
        targetAlpha: target,
        targetPnl,
        references: [{ alpha: target, platformProdMax: 0.82 }],
        pnlById,
    });
    assert.equal(result.available, true);
    assert.equal(result.max, 0.82);
    assert.equal(result.witness.alphaId, 'target');
    assert.equal(result.witness.correlation, 1);
});

test('downloaded shared PnL is used only as a Prod lower-bound reference', () => {
    const target = alpha('target');
    const shared = {
        ...alpha('alpha_shared', {
            submitted: false,
            settings: settings(0, 'TOP1000'),
        }),
        shared: true,
        source: 'shared',
    };
    const [sharedPnl] = sharedRecordsToCalculationPnls([{
        alias: shared.id,
        pnl: pnl(shared.id, [0, 2, 6, 12]),
        fingerprint: 'shared-fingerprint',
    }]);
    const targetPnl = pnl(target.id, [0, 1, 3, 6]);
    const pnlById = new Map([
        [target.id, targetPnl],
        [shared.id, sharedPnl],
    ]);

    assert.deepEqual(selectCandidateAlphas([shared], pnlById, target, 'SELF'), []);
    assert.deepEqual(selectCandidateAlphas([shared], pnlById, target, 'POOL'), []);
    assert.notEqual(alphaGroupKey(shared), alphaGroupKey(target));
    assert.equal(alphaCorrelationGroupKey(shared), alphaCorrelationGroupKey(target));

    const snapshot = {
        alphas: [target, shared],
        pnls: [targetPnl, sharedPnl],
        platformCorrs: [{
            alphaId: shared.id,
            prod: { max: 0.75, updated: 1, source: 'shared' },
            shared: true,
        }],
        localCorrs: [],
    };
    assert.deepEqual(buildCalculationContext(snapshot, target.id, 'SELF').candidates, []);
    assert.deepEqual(buildCalculationContext(snapshot, target.id, 'POOL').candidates, []);
    assert.deepEqual(
        buildCalculationContext(snapshot, target.id, 'PROD_LOWER_BOUND').references.map((item) => item.alpha.id),
        [shared.id],
    );

    const result = calculateProdLowerBound({
        targetAlpha: target,
        targetPnl,
        references: [{ alpha: shared, platformProdMax: 0.75 }],
        pnlById,
    });
    assert.equal(sharedPnl.source, 'shared');
    assert.equal(result.available, true);
    assert.equal(result.witness.alphaId, shared.id);
    assert.equal(result.max, 0.75);
});

test('calculation fingerprints change when PnL or known Prod Corr changes', () => {
    const target = alpha('target');
    const reference = alpha('reference');
    const targetPnl = pnl('target', [0, 1, 3, 6]);
    const pnlById = new Map([['reference', pnl('reference', [0, 2, 6, 12])]]);
    const makeFingerprint = (platformProdMax) => calculationFingerprint({
        corrType: 'PROD_LOWER_BOUND',
        targetAlpha: target,
        targetPnl,
        references: [{ alpha: reference, platformProdMax, platformUpdated: 1 }],
        pnlById,
    });
    assert.notEqual(makeFingerprint(0.7), makeFingerprint(0.8));
    const before = makeFingerprint(0.8);
    pnlById.set('reference', pnl('reference', [0, 2, 7, 13]));
    assert.notEqual(before, makeFingerprint(0.8));
});

test('platform correlation extraction preserves signs and supports record schemas', () => {
    assert.deepEqual(extractPlatformCorrelationStats({ max: 0.8, min: -0.4 }), { max: 0.8, min: -0.4 });
    assert.deepEqual(extractPlatformCorrelationStats({
        schema: { properties: [{ name: 'id' }, { name: 'correlation' }] },
        records: [['a', -0.2], ['b', 0.7]],
    }), { max: 0.7, min: -0.2 });
});

test('list resolution prefers each platform metric and rejects stale local fallbacks', () => {
    const local = {
        stale: false,
        calculatedAt: 2,
        result: { available: true, max: 0.65, min: -0.2 },
    };
    assert.deepEqual(resolvePreferredCorrelation({ max: 0.72, min: -0.4, updated: 1 }, local), {
        max: 0.72,
        min: -0.4,
        updated: 1,
        source: 'platform',
        icon: 'Ⓟ',
        lowerBound: false,
    });
    assert.deepEqual(resolvePreferredCorrelation(null, local, { lowerBound: true }), {
        max: 0.65,
        min: -0.2,
        updated: 2,
        source: 'local',
        icon: 'Ⓛ',
        lowerBound: true,
    });
    assert.equal(resolvePreferredCorrelation(null, { ...local, stale: true }), null);
});
