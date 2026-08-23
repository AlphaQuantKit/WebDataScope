import { getLocalValue, setLocalValue } from './storageService.js';

export const DEFAULT_SETTINGS = {
    dataAnalysisEnabled: true,
    geniusAlphaCount: 40,
    geniusCombineTag: true,
    apiMonitorEnabled: true,
    pnlShareEnabled: false,
};

function pickSettings(settings) {
    if (!settings || typeof settings !== 'object') return {};
    const keys = [
        'dataAnalysisEnabled',
        'geniusAlphaCount',
        'geniusCombineTag',
        'apiMonitorEnabled',
        'pnlShareEnabled',
    ];
    return keys.reduce((picked, key) => {
        if (settings[key] !== undefined) picked[key] = settings[key];
        return picked;
    }, {});
}

export async function getSettings() {
    const settings = await getLocalValue('WQP_Settings');
    return { ...DEFAULT_SETTINGS, ...pickSettings(settings) };
}

export async function saveSettings(settings) {
    const normalized = {
        ...DEFAULT_SETTINGS,
        ...pickSettings(settings),
        dataAnalysisEnabled: settings?.dataAnalysisEnabled !== false,
        geniusAlphaCount: parseInt(settings?.geniusAlphaCount, 10) || DEFAULT_SETTINGS.geniusAlphaCount,
        geniusCombineTag: settings?.geniusCombineTag === true,
        apiMonitorEnabled: settings?.apiMonitorEnabled === true,
        pnlShareEnabled: settings?.pnlShareEnabled === true,
    };

    await setLocalValue('WQP_Settings', normalized);
    return normalized;
}

export async function ensureDefaultSettings() {
    const settings = await getLocalValue('WQP_Settings');
    if (!settings) {
        await setLocalValue('WQP_Settings', DEFAULT_SETTINGS);
        return DEFAULT_SETTINGS;
    }
    return { ...DEFAULT_SETTINGS, ...pickSettings(settings) };
}
