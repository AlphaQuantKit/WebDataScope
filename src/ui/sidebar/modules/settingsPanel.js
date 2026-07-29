import { sendMessage } from './runtimeClient.js';
import { formatBytes, setStatus } from './ui.js';

const ids = {
    form: 'settingsForm',
    dataAnalysis: 'dataAnalysis',
    geniusCombineTag: 'geniusCombineTag',
    geniusAlphaCount: 'geniusAlphaCount',
    apiMonitorEnabled: 'apiMonitorEnabled',
    llmEnabled: 'llmEnabled',
    llmBaseUrl: 'llmBaseUrl',
    llmModel: 'llmModel',
    llmApiKey: 'llmApiKey',
    save: 'saveSettingsBtn',
};

let hasSavedLlmApiKey = false;

function readSettingsFromForm() {
    return {
        dataAnalysisEnabled: document.getElementById(ids.dataAnalysis).checked,
        geniusCombineTag: document.getElementById(ids.geniusCombineTag).checked,
        geniusAlphaCount: parseInt(document.getElementById(ids.geniusAlphaCount).value, 10) || 40,
        apiMonitorEnabled: document.getElementById(ids.apiMonitorEnabled).checked,
    };
}

function writeSettingsToForm(settings) {
    document.getElementById(ids.dataAnalysis).checked = settings.dataAnalysisEnabled !== false;
    document.getElementById(ids.geniusCombineTag).checked = settings.geniusCombineTag === true;
    document.getElementById(ids.geniusAlphaCount).value = settings.geniusAlphaCount || 40;
    document.getElementById(ids.apiMonitorEnabled).checked = settings.apiMonitorEnabled === true;
}

function readLlmConfigFromForm() {
    const rawApiKey = document.getElementById(ids.llmApiKey).value;
    const apiKey = rawApiKey === '********' ? '' : rawApiKey;
    return {
        enabled: document.getElementById(ids.llmEnabled).checked,
        baseUrl: document.getElementById(ids.llmBaseUrl).value.trim(),
        model: document.getElementById(ids.llmModel).value.trim(),
        apiKey,
        keepExistingApiKey: (!apiKey || rawApiKey === '********') && hasSavedLlmApiKey,
    };
}

function writeLlmConfigToForm(config = {}) {
    document.getElementById(ids.llmEnabled).checked = config.enabled === true;
    document.getElementById(ids.llmBaseUrl).value = config.baseUrl || '';
    document.getElementById(ids.llmModel).value = config.model || '';
    const apiKeyInput = document.getElementById(ids.llmApiKey);
    hasSavedLlmApiKey = config.hasApiKey === true;
    apiKeyInput.value = hasSavedLlmApiKey ? '********' : '';
    apiKeyInput.placeholder = hasSavedLlmApiKey ? '留空则保留已保存 Key' : '请输入 API Key（如接口需要）';
}

function bindLlmApiKeyPlaceholder() {
    const apiKeyInput = document.getElementById(ids.llmApiKey);
    if (!apiKeyInput) return;
    apiKeyInput.addEventListener('focus', () => {
        if (apiKeyInput.value === '********') {
            apiKeyInput.value = '';
        }
    });
    apiKeyInput.addEventListener('blur', () => {
        if (!apiKeyInput.value && hasSavedLlmApiKey) {
            apiKeyInput.value = '********';
        }
    });
}

function setDataMeta(text) {
    const el = document.getElementById('dataMeta');
    if (el) el.textContent = text || '';
}

async function notifyIndexedDataUpdated() {
    await sendMessage('WQP_INDEXED_DATA_UPDATED');
}

async function loadDataMeta() {
    try {
        const meta = await sendMessage('WQP_INDEXED_DATA_GET', { responseType: 'meta' });
        if (!meta) {
            setDataMeta('请导入WebData.zip文件');
            return;
        }
        const missing = Array.isArray(meta.missingRequired) && meta.missingRequired.length
            ? `；缺少 ${meta.missingRequired.join(', ')}`
            : '';
        setDataMeta(`当前数据：${meta.sourceName || '-'}，${meta.fileCount || 0} 个文件，${formatBytes(meta.totalBytes || 0)}，${meta.infoDataKeyCount || 0} 个 info 分片${missing}`);
    } catch (_) {
        setDataMeta('请导入WebData.zip文件');
    }
}

async function importDataZip(file) {
    if (!/\.zip$/i.test(file.name)) {
        throw new Error('请选择 zip 文件。');
    }
    if (!globalThis.WQPDataStore) {
        throw new Error('数据存储模块未加载。');
    }

    const meta = await globalThis.WQPDataStore.importZip(file, {
        onProgress: ({ current, total, path }) => {
            setStatus(path.startsWith('preprocess ')
                ? '正在预处理 info_data.bin...'
                : `正在导入 ${current}/${total}: ${path}`);
        },
    });
    await notifyIndexedDataUpdated();
    return meta;
}

export async function initSettingsPanel() {
    const form = document.getElementById(ids.form);
    const saveBtn = document.getElementById(ids.save);
    const importDataZipBtn = document.getElementById('importDataZipBtn');
    const importDataZipFile = document.getElementById('importDataZipFile');
    bindLlmApiKeyPlaceholder();

    setStatus('加载设置...');
    try {
        const settings = await sendMessage('WQP_SETTINGS_GET');
        writeSettingsToForm(settings || {});
        const llmConfig = await sendMessage('WQP_LLM_CONFIG_GET');
        writeLlmConfigToForm(llmConfig || {});
        setStatus('');
    } catch (error) {
        setStatus(`设置加载失败：${error.message}`, 'error');
    }

    await loadDataMeta();

    importDataZipBtn.addEventListener('click', () => {
        importDataZipFile.value = '';
        importDataZipFile.click();
    });

    importDataZipFile.addEventListener('change', async (event) => {
        const file = event.target.files && event.target.files[0];
        if (!file) return;
        importDataZipBtn.disabled = true;
        try {
            const meta = await importDataZip(file);
            const missing = Array.isArray(meta.missingRequired) && meta.missingRequired.length
                ? `，缺少 ${meta.missingRequired.join(', ')}`
                : '';
            setStatus(`导入完成：${meta.fileCount} 个文件，${formatBytes(meta.totalBytes)}，${meta.infoDataKeyCount || 0} 个 info 分片${missing}`, missing ? 'error' : 'success');
            await loadDataMeta();
        } catch (error) {
            setStatus(`导入失败：${error.message}`, 'error');
        } finally {
            importDataZipBtn.disabled = false;
            importDataZipFile.value = '';
        }
    });

    form.addEventListener('submit', async (event) => {
        event.preventDefault();
        saveBtn.disabled = true;
        const settings = readSettingsFromForm();
        const llmConfig = readLlmConfigFromForm();
        try {
            await sendMessage('WQP_SETTINGS_SAVE', { settings });
            if (llmConfig.enabled) {
                setStatus('Testing AI model connection...');
            }
            const savedLlmConfig = await sendMessage('WQP_LLM_CONFIG_SAVE', { config: llmConfig });
            writeLlmConfigToForm(savedLlmConfig || {});
            setStatus(llmConfig.enabled ? 'Settings saved. AI model connection test passed.' : 'Settings saved. AI is disabled.', 'success');
        } catch (error) {
            setStatus(`保存失败：${error.message}`, 'error');
        } finally {
            saveBtn.disabled = false;
        }
    });
}
