export const PROD_MEMO_ALGORITHM_VERSION = 3;

export const POWER_POOL_CLASSIFICATION = 'POWER_POOL:POWER_POOL_ELIGIBLE';
export const REGULAR_CLASSIFICATION = 'REGULAR:REGULAR';

const normalizedPnlCache = new WeakMap();

function finiteNumber(value) {
    if (value === null || value === undefined || value === '') return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
}

export function clampCorrelation(value) {
    const number = finiteNumber(value);
    if (number === null) return null;
    return Math.max(-1, Math.min(1, number));
}

function normalizeText(value) {
    return String(value ?? '').trim().toUpperCase();
}

export function alphaGroupKey(alpha) {
    const region = normalizeText(alpha?.settings?.region ?? alpha?.region);
    const universe = normalizeText(alpha?.settings?.universe ?? alpha?.universe);
    const rawDelay = alpha?.settings?.delay ?? alpha?.delay;
    const delay = Number(rawDelay);
    if (!region || !universe || !Number.isFinite(delay)) return '';
    return `${region}|${universe}|D${delay}`;
}

export function alphaCorrelationGroupKey(alpha) {
    return normalizeText(alpha?.settings?.region ?? alpha?.region);
}

export function normalizePnl(data) {
    if (data && typeof data === 'object' && normalizedPnlCache.has(data)) {
        return normalizedPnlCache.get(data);
    }
    const records = Array.isArray(data?.records) ? data.records : [];
    const byDate = new Map();
    for (const record of records) {
        if (!Array.isArray(record) || record.length < 2 || !record[0]) continue;
        const value = finiteNumber(record[1]);
        if (value === null) continue;
        const date = String(record[0]).slice(0, 10);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
        byDate.set(date, value);
    }
    const normalized = [...byDate.entries()].sort((left, right) => left[0].localeCompare(right[0]));
    if (data && typeof data === 'object') normalizedPnlCache.set(data, normalized);
    return normalized;
}

export function rollingWindowStart(records, years = 4) {
    if (!records.length) return '';
    const end = new Date(`${records.at(-1)[0]}T00:00:00Z`);
    if (Number.isNaN(end.getTime())) return '';
    end.setUTCFullYear(end.getUTCFullYear() - years);
    return end.toISOString().slice(0, 10);
}

export function trimPnlToRecentYears(data, years = 4) {
    const records = normalizePnl(data);
    if (!records.length) return records;
    const startDate = rollingWindowStart(records, years);
    if (!startDate) return records;
    return records.filter(([date]) => date >= startDate);
}

export function collectDates(pnlRecords) {
    const dates = new Set();
    for (const data of pnlRecords) {
        for (const [date] of normalizePnl(data)) dates.add(date);
    }
    return [...dates].sort();
}

export function calculateForwardFilledReturns(data, dates, startDate, endDate = '') {
    const records = normalizePnl(data);
    const returns = new Map();
    let recordIndex = 0;
    let currentValue = null;
    let previousValue = null;

    for (const date of dates) {
        if (endDate && date > endDate) break;
        while (recordIndex < records.length && records[recordIndex][0] <= date) {
            currentValue = records[recordIndex][1];
            recordIndex += 1;
        }
        if (currentValue === null) continue;
        if (previousValue !== null && (!startDate || date > startDate)) {
            returns.set(date, currentValue - previousValue);
        }
        previousValue = currentValue;
    }
    return returns;
}

export function pearsonCorrelation(left, right) {
    let count = 0;
    let sumX = 0;
    let sumY = 0;
    let sumXX = 0;
    let sumYY = 0;
    let sumXY = 0;

    for (const [date, x] of left) {
        if (!right.has(date)) continue;
        const y = right.get(date);
        if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
        count += 1;
        sumX += x;
        sumY += y;
        sumXX += x * x;
        sumYY += y * y;
        sumXY += x * y;
    }

    if (count < 2) return null;
    const covariance = count * sumXY - sumX * sumY;
    const varianceX = count * sumXX - sumX * sumX;
    const varianceY = count * sumYY - sumY * sumY;
    const denominator = Math.sqrt(Math.max(0, varianceX * varianceY));
    if (!Number.isFinite(denominator) || denominator === 0) return null;
    const value = clampCorrelation(covariance / denominator);
    return value === null ? null : { value, overlapCount: count };
}

export function hasClassification(alpha, classification) {
    return (alpha?.classifications || []).some((item) => (item?.id || item) === classification);
}

export function isPowerPoolAlpha(alpha) {
    return hasClassification(alpha, POWER_POOL_CLASSIFICATION);
}

export function isRegularAlpha(alpha) {
    return hasClassification(alpha, REGULAR_CLASSIFICATION);
}

export function selectCandidateAlphas(alphas, pnlById, targetAlpha, corrType) {
    const targetId = String(targetAlpha?.id || '');
    const groupKey = alphaCorrelationGroupKey(targetAlpha);
    return (alphas || []).filter((alpha) => {
        if (!alpha?.id || alpha.id === targetId || !alpha.submitted) return false;
        if (!groupKey || alphaCorrelationGroupKey(alpha) !== groupKey || !pnlById.has(alpha.id)) return false;
        if (corrType === 'SELF') {
            const selfEligible = alpha.stage === 'OS'
                && (!isPowerPoolAlpha(alpha) || isRegularAlpha(alpha));
            return selfEligible || isPowerPoolAlpha(alpha);
        }
        if (corrType === 'POOL') return isPowerPoolAlpha(alpha);
        return false;
    });
}

function roundCorrelation(value) {
    return Math.round((value + Number.EPSILON) * 10000) / 10000;
}

function officialRecord(alpha, correlation, overlapCount) {
    return {
        alphaId: alpha.id,
        name: alpha.name ?? null,
        instrumentType: alpha.settings?.instrumentType ?? null,
        region: alpha.settings?.region ?? null,
        universe: alpha.settings?.universe ?? null,
        delay: alpha.settings?.delay ?? null,
        correlation: roundCorrelation(correlation),
        overlapCount,
        sharpe: alpha.is?.sharpe ?? null,
        returns: alpha.is?.returns ?? null,
        turnover: alpha.is?.turnover ?? null,
        fitness: alpha.is?.fitness ?? null,
        margin: alpha.is?.margin ?? null,
    };
}

export function calculateLocalCorrelation({ targetAlpha, targetPnl, candidates, pnlById, corrType }) {
    const targetRecords = normalizePnl(targetPnl);
    if (targetRecords.length < 2) {
        return { available: false, reason: '目标 Alpha 的 PnL 数据不足。' };
    }
    if (!candidates.length) {
        return { available: false, reason: `当前 region 没有可用的 ${corrType} 候选。` };
    }

    const endDate = targetRecords.at(-1)[0];
    const startDate = rollingWindowStart(targetRecords);
    const sourcePnls = [targetPnl, ...candidates.map((alpha) => pnlById.get(alpha.id))];
    const dates = collectDates(sourcePnls);
    const targetReturns = calculateForwardFilledReturns(targetPnl, dates, startDate, endDate);
    const correlations = [];

    for (const alpha of candidates) {
        const peerReturns = calculateForwardFilledReturns(pnlById.get(alpha.id), dates, startDate, endDate);
        const correlation = pearsonCorrelation(targetReturns, peerReturns);
        if (correlation) correlations.push({ alpha, ...correlation });
    }
    correlations.sort((left, right) => right.value - left.value);
    if (!correlations.length) {
        return { available: false, reason: '候选 PnL 与目标 PnL 没有足够的共同有效日期。' };
    }

    const values = correlations.map((item) => item.value);
    return {
        available: true,
        max: roundCorrelation(Math.max(...values)),
        min: roundCorrelation(Math.min(...values)),
        records: correlations.slice(0, 5).map((item) => officialRecord(
            item.alpha,
            item.value,
            item.overlapCount,
        )),
        poolSize: candidates.length,
        corrCount: correlations.length,
        maxOverlapCount: Math.max(...correlations.map((item) => item.overlapCount)),
        windowStart: startDate,
        windowEnd: endDate,
    };
}

export function calculateProdLowerBound({ targetAlpha, targetPnl, references, pnlById }) {
    const targetRecords = normalizePnl(targetPnl);
    if (targetRecords.length < 2) {
        return { available: false, reason: '目标 Alpha 的 PnL 数据不足。' };
    }
    if (!references.length) {
        return { available: false, reason: '当前 region 没有完整的已知 Prod Corr 参考曲线。' };
    }

    const endDate = targetRecords.at(-1)[0];
    const startDate = rollingWindowStart(targetRecords);
    const dates = collectDates([targetPnl, ...references.map((item) => pnlById.get(item.alpha.id))]);
    const targetReturns = calculateForwardFilledReturns(targetPnl, dates, startDate, endDate);
    const bounds = [];

    for (const reference of references) {
        const knownReturns = calculateForwardFilledReturns(
            pnlById.get(reference.alpha.id),
            dates,
            startDate,
            endDate,
        );
        const correlation = pearsonCorrelation(targetReturns, knownReturns);
        const knownProdMax = clampCorrelation(reference.platformProdMax);
        if (!correlation || knownProdMax === null) continue;
        const y = clampCorrelation(correlation.value);
        const lower = correlationLowerBound(y, knownProdMax);
        if (!Number.isFinite(lower)) continue;
        bounds.push({
            alphaId: reference.alpha.id,
            correlation: y,
            knownProdMax,
            lowerBound: clampCorrelation(lower),
            overlapCount: correlation.overlapCount,
        });
    }
    bounds.sort((left, right) => right.lowerBound - left.lowerBound);
    if (!bounds.length) {
        return { available: false, reason: '参考曲线与目标 PnL 没有足够的共同有效日期。' };
    }

    const witness = bounds[0];
    return {
        available: true,
        max: roundCorrelation(witness.lowerBound),
        min: roundCorrelation(Math.min(...bounds.map((item) => item.lowerBound))),
        referenceCount: references.length,
        corrCount: bounds.length,
        maxOverlapCount: Math.max(...bounds.map((item) => item.overlapCount)),
        witness: {
            ...witness,
            correlation: roundCorrelation(witness.correlation),
            knownProdMax: roundCorrelation(witness.knownProdMax),
            lowerBound: roundCorrelation(witness.lowerBound),
        },
        records: bounds.slice(0, 5).map((item) => ({
            ...item,
            correlation: roundCorrelation(item.correlation),
            knownProdMax: roundCorrelation(item.knownProdMax),
            lowerBound: roundCorrelation(item.lowerBound),
        })),
        windowStart: startDate,
        windowEnd: endDate,
    };
}

export function correlationLowerBound(correlation, knownProdMax) {
    const y = clampCorrelation(correlation);
    const c = clampCorrelation(knownProdMax);
    if (y === null || c === null) return null;
    return clampCorrelation(
        y * c
        - Math.sqrt(Math.max(0, 1 - c * c))
        * Math.sqrt(Math.max(0, 1 - y * y)),
    );
}

function hashText(source) {
    let hash = 2166136261;
    for (let index = 0; index < source.length; index += 1) {
        hash ^= source.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16);
}

export function pnlFingerprint(data) {
    if (typeof data?.fingerprint === 'string' && data.fingerprint) return data.fingerprint;
    const records = normalizePnl(data);
    if (!records.length) return 'empty';
    const source = records.map(([date, value]) => `${date}:${value}`).join('|');
    return `${records.length}:${records.at(-1)[0]}:${hashText(source)}`;
}

export function calculationFingerprint({ corrType, targetAlpha, targetPnl, candidates = [], pnlById, references = [] }) {
    const parts = [
        `v${PROD_MEMO_ALGORITHM_VERSION}`,
        corrType,
        targetAlpha?.id || '',
        alphaCorrelationGroupKey(targetAlpha),
        pnlFingerprint(targetPnl),
    ];
    if (corrType === 'PROD_LOWER_BOUND') {
        references.forEach((item) => {
            parts.push([
                item.alpha.id,
                pnlFingerprint(pnlById.get(item.alpha.id)),
                Number(item.platformProdMax),
                Number(item.platformUpdated || 0),
            ].join(':'));
        });
    } else {
        candidates.forEach((alpha) => {
            parts.push(`${alpha.id}:${pnlFingerprint(pnlById.get(alpha.id))}`);
        });
    }
    return hashText(parts.sort().join('|'));
}
