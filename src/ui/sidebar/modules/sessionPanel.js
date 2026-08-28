import { sendMessage } from './runtimeClient.js';
import { setStatus } from './ui.js';

const ids = {
    form: 'sessionForm',
    enabled: 'sessionEnabled',
    keepAliveInterval: 'sessionKeepAliveInterval',
    preemptiveLoginEnabled: 'sessionPreemptiveLoginEnabled',
    preemptiveBeforeExpiry: 'sessionPreemptiveBeforeExpiry',
    autoLoginEnabled: 'sessionAutoLoginEnabled',
    email: 'sessionEmail',
    password: 'sessionPassword',
    save: 'saveSessionBtn',
    check: 'checkSessionBtn',
    login: 'loginSessionBtn',
    clearLogs: 'clearSessionLogsBtn',
    status: 'sessionStatusBox',
    log: 'sessionLog',
};

let hasSavedPassword = false;

function formatTime(value) {
    if (!value) return '-';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '-';
    return date.toLocaleString();
}

export function formatExpiryTime(expiry, source, now = Date.now()) {
    if (!expiry) return `-（${expirySourceLabel(source)}）`;
    const date = new Date(expiry);
    if (Number.isNaN(date.getTime())) return `-（${expirySourceLabel(source)}）`;
    const remainingMs = Number(expiry) - now;
    let remainingText = '已过期';
    if (remainingMs > 0) {
        const totalMinutes = Math.floor(remainingMs / 60000);
        const hours = Math.floor(totalMinutes / 60);
        const minutes = totalMinutes % 60;
        remainingText = hours > 0 ? `剩余 ${hours}小时${minutes}分` : `剩余 ${minutes}分钟`;
    }
    return `${date.toLocaleString()}（${remainingText}，${expirySourceLabel(source)}）`;
}

function statusLabel(status) {
    const labels = {
        valid: '有效',
        expired: '已过期',
        disabled: '未启用',
        'no-tabs': '无 Brain 标签页',
        'login-failed': '重登失败',
        unknown: '未知',
    };
    return labels[status] || status || '未知';
}

function expirySourceLabel(source) {
    const labels = {
        authentication: 'Authentication',
        token: 'JWT',
        synthetic: '估算',
        unknown: '未知',
    };
    return labels[source] || source || '未知';
}

function getEl(id) {
    return document.getElementById(id);
}

function readConfigFromForm() {
    const password = getEl(ids.password).value;
    return {
        enabled: getEl(ids.enabled).checked,
        keepAliveInterval: parseFloat(getEl(ids.keepAliveInterval).value) || 5,
        preemptiveLoginEnabled: getEl(ids.preemptiveLoginEnabled).checked,
        preemptiveBeforeExpiryHours: parseFloat(getEl(ids.preemptiveBeforeExpiry).value) || 0.5,
        autoLoginEnabled: getEl(ids.autoLoginEnabled).checked,
        authEmail: getEl(ids.email).value.trim(),
        authPassword: password,
        keepExistingPassword: !password && hasSavedPassword,
    };
}

function writeConfigToForm(config = {}) {
    getEl(ids.enabled).checked = config.enabled !== false;
    getEl(ids.keepAliveInterval).value = config.keepAliveInterval || 5;
    getEl(ids.preemptiveLoginEnabled).checked = config.preemptiveLoginEnabled === true;
    getEl(ids.preemptiveBeforeExpiry).value = config.preemptiveBeforeExpiryHours || 0.5;
    getEl(ids.autoLoginEnabled).checked = config.autoLoginEnabled === true;
    getEl(ids.email).value = config.authEmail || '';
    getEl(ids.password).value = '';
    hasSavedPassword = config.hasPassword === true;
    getEl(ids.password).placeholder = hasSavedPassword ? '已保存；留空则保留' : '未保存';
}

function renderStatus(data = {}) {
    const config = data.config || {};
    const state = data.state || {};
    const statusBox = getEl(ids.status);
    if (statusBox) {
        statusBox.innerHTML = '';
        [
            ['状态', `${statusLabel(state.status)}${state.isLoginInProgress ? '（重登中）' : ''}`],
            ['用户', state.userId || '-'],
            ['最近检查', formatTime(state.lastChecked)],
            ['过期时间', formatExpiryTime(state.sessionExpiry, state.sessionExpirySource)],
            ['最近 Token', `${state.hasToken ? '已捕获' : '未捕获'} / ${formatTime(state.lastTokenTime)}`],
            ['最近重登', `${formatTime(state.lastLoginTime)} / ${state.lastLoginSuccess === true ? '成功' : state.lastLoginSuccess === false ? '失败' : '未触发'}`],
            ['自动重登', `${config.autoLoginEnabled ? '启用' : '关闭'}${config.hasPassword ? '，已保存密码' : ''}`],
        ].forEach(([label, value]) => {
            const row = document.createElement('div');
            const strong = document.createElement('strong');
            strong.textContent = `${label}：`;
            row.appendChild(strong);
            row.append(document.createTextNode(value));
            statusBox.appendChild(row);
        });
        if (state.lastError) {
            const row = document.createElement('div');
            row.className = 'status-error';
            const strong = document.createElement('strong');
            strong.textContent = '错误：';
            row.appendChild(strong);
            row.append(document.createTextNode(state.lastError));
            statusBox.appendChild(row);
        }
    }

    const logList = getEl(ids.log);
    if (logList) {
        logList.innerHTML = '';
        (state.debugLogs || []).forEach((line) => {
            const item = document.createElement('li');
            item.textContent = line;
            logList.appendChild(item);
        });
    }
}

async function refreshSessionPanel() {
    const data = await sendMessage('WQP_SESSION_GET');
    writeConfigToForm(data.config || {});
    renderStatus(data);
    return data;
}

async function runAction(buttonId, messageType, successMessage) {
    const button = getEl(buttonId);
    if (button) button.disabled = true;
    try {
        const data = await sendMessage(messageType);
        renderStatus(data);
        setStatus(successMessage, 'success');
    } catch (error) {
        setStatus(error.message, 'error');
    } finally {
        if (button) button.disabled = false;
    }
}

export async function initSessionPanel() {
    const form = getEl(ids.form);
    const saveBtn = getEl(ids.save);

    try {
        await refreshSessionPanel();
    } catch (error) {
        setStatus(`Session 设置加载失败：${error.message}`, 'error');
    }

    form.addEventListener('submit', async (event) => {
        event.preventDefault();
        saveBtn.disabled = true;
        try {
            const data = await sendMessage('WQP_SESSION_SAVE', { config: readConfigFromForm() });
            writeConfigToForm(data.config || {});
            renderStatus(data);
            setStatus('Session 设置已保存。', 'success');
        } catch (error) {
            setStatus(`Session 设置保存失败：${error.message}`, 'error');
        } finally {
            saveBtn.disabled = false;
        }
    });

    getEl(ids.check).addEventListener('click', () => {
        runAction(ids.check, 'WQP_SESSION_CHECK_NOW', 'Session 检查完成。');
    });

    getEl(ids.login).addEventListener('click', () => {
        runAction(ids.login, 'WQP_SESSION_LOGIN_NOW', 'API 重登成功，浏览器 Cookie 已更新。');
    });

    getEl(ids.clearLogs).addEventListener('click', () => {
        runAction(ids.clearLogs, 'WQP_SESSION_CLEAR_LOGS', 'Session 日志已清空。');
    });

    chrome.storage.onChanged.addListener((changes, namespace) => {
        if (namespace === 'local' && changes.WQP_SessionKeeperState) {
            refreshSessionPanel().catch(() => {});
        }
    });
}
