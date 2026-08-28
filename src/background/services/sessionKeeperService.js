import { getLocalValue, setLocalValue } from './storageService.js';

const CONFIG_KEY = 'WQP_SessionKeeperConfig';
const STATE_KEY = 'WQP_SessionKeeperState';
const ALARM_NAME = 'WQP_SESSION_KEEP_ALIVE';
const SIGN_IN_URL = 'https://platform.worldquantbrain.com/sign-in';
const AUTHENTICATION_URL = 'https://api.worldquantbrain.com/authentication';

const DEFAULT_CONFIG = {
    enabled: true,
    autoLoginEnabled: false,
    keepAliveInterval: 5,
    preemptiveLoginEnabled: false,
    preemptiveBeforeExpiryHours: 0.5,
    authEmail: '',
    authPassword: '',
};

const DEFAULT_STATE = {
    status: 'unknown',
    lastChecked: null,
    sessionExpiry: null,
    lastLoginTime: null,
    lastLoginAttemptTime: null,
    lastLoginSuccess: null,
    lastToken: '',
    lastTokenTime: null,
    userId: '',
    sessionExpirySource: 'unknown',
    isLoginInProgress: false,
    lastError: '',
    debugLogs: [],
};

let initialized = false;
let isLoginInProgress = false;
let lastLoginAttempt = 0;
let loginRetryCount = 0;
let lastHeartbeatTime = Date.now();

const LOGIN_COOLDOWN_MS = 30 * 1000;
const MAX_LOGIN_RETRIES = 5;
const WAKE_THRESHOLD_MS = 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const TOKEN_WRITE_THROTTLE_MS = 30 * 1000;

function normalizeConfig(config = {}) {
    const keepAliveInterval = Number(config.keepAliveInterval);
    const preemptiveBeforeExpiryHours = Number(config.preemptiveBeforeExpiryHours);
    return {
        enabled: config.enabled !== false,
        autoLoginEnabled: config.autoLoginEnabled === true,
        keepAliveInterval: Number.isFinite(keepAliveInterval) && keepAliveInterval >= 1
            ? Math.min(60, keepAliveInterval)
            : DEFAULT_CONFIG.keepAliveInterval,
        preemptiveLoginEnabled: config.preemptiveLoginEnabled === true,
        preemptiveBeforeExpiryHours: Number.isFinite(preemptiveBeforeExpiryHours) && preemptiveBeforeExpiryHours >= 0.1
            ? Math.min(12, preemptiveBeforeExpiryHours)
            : DEFAULT_CONFIG.preemptiveBeforeExpiryHours,
        authEmail: typeof config.authEmail === 'string' ? config.authEmail.trim() : '',
        authPassword: typeof config.authPassword === 'string' ? config.authPassword : '',
    };
}

function sanitizeConfigForUi(config) {
    return {
        ...config,
        hasPassword: !!config.authPassword,
        authPassword: '',
    };
}

function sanitizeStateForUi(state) {
    const { lastToken, ...safeState } = state;
    return {
        ...safeState,
        hasToken: !!lastToken,
    };
}

function obfuscate(value) {
    const text = String(value || '');
    return btoa(text.split('').map((char, index) => {
        return String.fromCharCode(char.charCodeAt(0) + (index % 5) + 1);
    }).join(''));
}

function deobfuscate(value) {
    try {
        return atob(String(value || '')).split('').map((char, index) => {
            return String.fromCharCode(char.charCodeAt(0) - (index % 5) - 1);
        }).join('');
    } catch (_) {
        return String(value || '');
    }
}

async function getConfigRaw() {
    return normalizeConfig(await getLocalValue(CONFIG_KEY));
}

async function setConfigRaw(config) {
    const normalized = normalizeConfig(config);
    await setLocalValue(CONFIG_KEY, normalized);
    await syncAlarm(normalized);
    return normalized;
}

async function getStateRaw() {
    return { ...DEFAULT_STATE, ...(await getLocalValue(STATE_KEY) || {}) };
}

async function updateState(patch) {
    const state = {
        ...(await getStateRaw()),
        ...patch,
        isLoginInProgress,
    };
    await setLocalValue(STATE_KEY, state);
    return state;
}

async function logDebug(message) {
    const timestamp = new Date().toLocaleTimeString();
    const entry = `[${timestamp}] ${message}`;
    console.log('[WQP Session]', message);
    const state = await getStateRaw();
    const logs = [entry, ...(state.debugLogs || [])].slice(0, 60);
    await setLocalValue(STATE_KEY, { ...state, debugLogs: logs, isLoginInProgress });
}

function decodeBase64Url(value) {
    const base64 = String(value || '').replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=');
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
        bytes[index] = binary.charCodeAt(index);
    }
    return new TextDecoder('utf-8').decode(bytes);
}

function parseJwtExpiry(token) {
    const parts = String(token || '').split('.');
    if (parts.length < 2) return null;
    try {
        const payload = JSON.parse(decodeBase64Url(parts[1]));
        const exp = Number(payload.exp);
        if (!Number.isFinite(exp) || exp <= 0) return null;
        return exp * 1000;
    } catch (_) {
        return null;
    }
}

async function syncTokenFromCookies() {
    try {
        if (!chrome?.cookies) return null;
        const cookie = await chrome.cookies.get({
            url: 'https://platform.worldquantbrain.com',
            name: 't',
        }) || await chrome.cookies.get({
            url: 'https://api.worldquantbrain.com',
            name: 't',
        });

        if (!cookie || !cookie.value) return null;
        const token = cookie.value.trim();
        const expiry = parseJwtExpiry(token);
        return { token, expiry };
    } catch (e) {
        console.warn('[WQP Session] Failed to read cookies:', e);
        return null;
    }
}

export async function handleCapturedSessionToken(token) {
    const normalizedToken = String(token || '').trim();
    if (!normalizedToken) return getSessionKeeperState();

    const expiry = parseJwtExpiry(normalizedToken);
    if (!expiry) {
        await logDebug('Ignored captured token because JWT expiry could not be parsed.');
        return getSessionKeeperState();
    }

    const now = Date.now();
    if (expiry <= now) {
        await updateState({
            status: 'expired',
            lastChecked: now,
            sessionExpiry: expiry,
            sessionExpirySource: 'token',
            lastToken: normalizedToken,
            lastTokenTime: now,
            lastError: 'Captured token is expired.',
        });
        await logDebug('Captured token is already expired.');
        return getSessionKeeperState();
    }

    const state = await getStateRaw();
    const isSameRecentToken = state.lastToken === normalizedToken
        && now - Number(state.lastTokenTime || 0) < TOKEN_WRITE_THROTTLE_MS;
    if (isSameRecentToken) return getSessionKeeperState();

    await updateState({
        status: 'valid',
        lastChecked: now,
        sessionExpiry: expiry,
        sessionExpirySource: 'token',
        lastToken: normalizedToken,
        lastTokenTime: now,
        lastLoginTime: state.lastLoginTime || now,
        lastError: '',
    });
    await logDebug(`Captured JWT token. Expiry: ${new Date(expiry).toLocaleString()}.`);
    return getSessionKeeperState();
}

async function syncAlarm(config = null) {
    const cfg = config || await getConfigRaw();
    await chrome.alarms.clear(ALARM_NAME);
    if (!cfg.enabled) return;
    chrome.alarms.create(ALARM_NAME, {
        periodInMinutes: cfg.keepAliveInterval,
    });
}

async function ensureDefaults() {
    const existingConfig = await getLocalValue(CONFIG_KEY);
    if (!existingConfig) await setLocalValue(CONFIG_KEY, DEFAULT_CONFIG);
    const existingState = await getLocalValue(STATE_KEY);
    if (!existingState) await setLocalValue(STATE_KEY, DEFAULT_STATE);
    await syncAlarm(normalizeConfig(existingConfig || DEFAULT_CONFIG));
}

async function checkSessionViaProbe() {
    const now = Date.now();
    try {
        await logDebug('Checking session via /authentication probe...');

        // 1. 尝试从 Cookie 读取 JWT
        const cookieInfo = await syncTokenFromCookies();
        const jwtExpiry = cookieInfo?.expiry || null;
        const jwtToken = cookieInfo?.token || '';

        // 2. 发起 Probe GET 请求
        const response = await fetch(AUTHENTICATION_URL, {
            method: 'GET',
            mode: 'cors',
            credentials: 'include',
            headers: {
                Accept: 'application/json;version=2.0',
                'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8,en-GB;q=0.7,en-US;q=0.6',
            },
        });

        if (response.status === 401 || response.status === 403) {
            await updateState({
                status: 'expired',
                lastChecked: now,
                userId: '',
                sessionExpiry: null,
                sessionExpirySource: 'authentication',
                lastError: `Probe returned HTTP ${response.status} (Unauthorized).`,
            });
            await logDebug(`Session expired. Probe returned HTTP ${response.status}.`);
            return 'expired';
        }

        if (response.ok) {
            const data = await response.json().catch(() => null);
            const userId = String(data?.user?.id || '').trim();
            const rawExpirySeconds = Number(data?.token?.expiry);

            let sessionExpiry = null;
            let sessionExpirySource = 'unknown';

            if (Number.isFinite(rawExpirySeconds) && rawExpirySeconds > 0) {
                sessionExpiry = now + Math.max(0, rawExpirySeconds) * 1000;
                sessionExpirySource = 'authentication';
            } else if (jwtExpiry && jwtExpiry > now) {
                sessionExpiry = jwtExpiry;
                sessionExpirySource = 'token';
            } else if (userId) {
                // 如果已获取 userId 但无精确过期秒数，使用 2 小时作为估算窗口
                sessionExpiry = now + 2 * HOUR_MS;
                sessionExpirySource = 'synthetic';
            }

            if (!userId && !sessionExpiry) {
                await updateState({
                    status: 'expired',
                    lastChecked: now,
                    userId: '',
                    sessionExpiry: null,
                    sessionExpirySource: 'authentication',
                    lastError: 'Session expired (no active user).',
                });
                await logDebug('Session expired: authentication probe returned no active user.');
                return 'expired';
            }

            if (sessionExpiry && sessionExpiry <= now) {
                await updateState({
                    status: 'expired',
                    lastChecked: now,
                    userId,
                    sessionExpiry,
                    sessionExpirySource,
                    lastError: 'Authentication token is expired.',
                });
                await logDebug('Session expired: authentication token expiry has passed.');
                return 'expired';
            }

            const statePatch = {
                status: 'valid',
                lastChecked: now,
                userId,
                sessionExpiry,
                sessionExpirySource,
                lastError: '',
            };
            if (jwtToken) {
                statePatch.lastToken = jwtToken;
                statePatch.lastTokenTime = now;
            }
            await updateState(statePatch);
            const remainingSec = sessionExpiry ? Math.max(0, Math.round((sessionExpiry - now) / 1000)) : 0;
            await logDebug(`Session is valid for ${remainingSec}s${userId ? ` (${userId})` : ''} [${sessionExpirySource}].`);
            return 'valid';
        }

        await updateState({
            status: 'unknown',
            lastChecked: now,
            sessionExpiry: null,
            sessionExpirySource: 'authentication',
            lastError: `Probe returned HTTP ${response.status}.`,
        });
        await logDebug(`Authentication probe returned HTTP ${response.status}.`);
        return 'unknown';
    } catch (error) {
        await updateState({
            status: 'unknown',
            lastChecked: now,
            sessionExpiry: null,
            sessionExpirySource: 'authentication',
            lastError: error.message,
        });
        await logDebug(`Authentication probe failed: ${error.message}.`);
        return 'unknown';
    }
}

async function loginViaApi(email, password) {
    await logDebug(`Attempting direct API login for ${email}...`);
    try {
        const encoded = btoa(`${email}:${password}`);
        const response = await fetch(AUTHENTICATION_URL, {
            method: 'POST',
            mode: 'cors',
            credentials: 'include',
            headers: {
                Authorization: `Basic ${encoded}`,
                Accept: 'application/json;version=2.0',
                'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
            },
        });

        if (response.status === 201) {
            const data = await response.json().catch(() => null);
            const userId = String(data?.user?.id || '').trim();
            await logDebug(`API login successful (HTTP 201)${userId ? ` User: ${userId}` : ''}.`);
            return { ok: true, userId, data };
        }

        if (response.status === 401) {
            const wwwAuth = response.headers.get('WWW-Authenticate') || '';
            const location = response.headers.get('Location') || '';
            if (wwwAuth.toLowerCase().includes('persona') || location) {
                await logDebug('API login requires biometric/persona authentication, falling back to tab.');
                return { ok: false, needFallback: true, error: 'Biometric verification required.' };
            }
            return { ok: false, needFallback: false, error: 'Invalid email or password (401).' };
        }

        await logDebug(`API login returned HTTP ${response.status}, falling back to tab.`);
        return { ok: false, needFallback: true, error: `API login returned HTTP ${response.status}.` };
    } catch (error) {
        await logDebug(`API login request failed: ${error.message}, falling back to tab.`);
        return { ok: false, needFallback: true, error: error.message };
    }
}

function autoFillAndSubmit(email, password) {
    function notify(status, message = '') {
        try {
            chrome.runtime.sendMessage({ type: 'WQP_SESSION_LOGIN_SIGNAL', status, message });
        } catch (_) {
            // The background page also polls URL as a fallback.
        }
    }

    function waitFor(selector, timeout = 10000) {
        return new Promise((resolve) => {
            const found = document.querySelector(selector);
            if (found) {
                resolve(found);
                return;
            }
            const observer = new MutationObserver(() => {
                const node = document.querySelector(selector);
                if (node) {
                    observer.disconnect();
                    resolve(node);
                }
            });
            observer.observe(document.documentElement || document.body, {
                childList: true,
                subtree: true,
            });
            setTimeout(() => {
                observer.disconnect();
                resolve(null);
            }, timeout);
        });
    }

    (async () => {
        try {
            const challengeTitle = document.querySelector('h1,h2,[role="heading"]');
            const challengeText = challengeTitle?.textContent || '';
            if (/Security Check|Pardon the interruption|captcha/i.test(challengeText)) {
                notify('error', 'Captcha or security check detected.');
                return;
            }

            const emailInput = await waitFor('input#email, input[name="email"], input[type="email"]');
            const passwordInput = await waitFor('input#password, input[name="password"], input[name="currentPassword"], input[type="password"]');
            if (!emailInput || !passwordInput) {
                notify('error', 'Login inputs not found.');
                return;
            }

            const valueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
            if (valueSetter) {
                valueSetter.call(emailInput, email);
                valueSetter.call(passwordInput, password);
            } else {
                emailInput.value = email;
                passwordInput.value = password;
            }
            emailInput.dispatchEvent(new Event('input', { bubbles: true }));
            emailInput.dispatchEvent(new Event('change', { bubbles: true }));
            emailInput.dispatchEvent(new Event('blur', { bubbles: true }));
            passwordInput.dispatchEvent(new Event('input', { bubbles: true }));
            passwordInput.dispatchEvent(new Event('change', { bubbles: true }));
            passwordInput.dispatchEvent(new Event('blur', { bubbles: true }));

            await new Promise((resolve) => setTimeout(resolve, 300));

            const submit = await waitFor('button[type="submit"], button.MuiButton-containedPrimary, button:not([disabled])');
            if (submit) {
                submit.click();
            } else {
                const form = passwordInput.closest('form') || document.querySelector('form');
                if (form) form.requestSubmit ? form.requestSubmit() : form.submit();
            }

            let checks = 0;
            const timer = setInterval(() => {
                checks += 1;
                const alert = document.querySelector('[role="alert"], .MuiAlert-standardError, .error-message');
                if (alert?.textContent) {
                    clearInterval(timer);
                    notify('error', alert.textContent.trim());
                    return;
                }
                if (document.querySelector('input[name="otp"], input[autocomplete="one-time-code"]')) {
                    clearInterval(timer);
                    notify('error', '2FA detected.');
                    return;
                }
                if (!location.href.includes('sign-in')) {
                    clearInterval(timer);
                    notify('success');
                    return;
                }
                if (checks > 30) clearInterval(timer);
            }, 500);
        } catch (error) {
            notify('error', error.message);
        }
    })();
}

async function performAutoLoginViaTab(email, password) {
    let loginTabId = null;
    try {
        await logDebug(`Starting background tab login for ${email}...`);
        const tab = await chrome.tabs.create({ url: SIGN_IN_URL, active: false });
        loginTabId = tab.id;

        await new Promise((resolve) => {
            const listener = (tabId, changeInfo) => {
                if (tabId === loginTabId && changeInfo.status === 'complete') {
                    chrome.tabs.onUpdated.removeListener(listener);
                    resolve();
                }
            };
            chrome.tabs.onUpdated.addListener(listener);
            setTimeout(() => {
                chrome.tabs.onUpdated.removeListener(listener);
                resolve();
            }, 12000);
        });

        await chrome.scripting.executeScript({
            target: { tabId: loginTabId },
            func: autoFillAndSubmit,
            args: [email, password],
        });

        const result = await new Promise((resolve) => {
            const messageListener = (request, sender) => {
                if (sender?.tab?.id !== loginTabId) return;
                if (request?.type !== 'WQP_SESSION_LOGIN_SIGNAL') return;
                if (request.status === 'success') {
                    cleanup();
                    resolve('success');
                } else if (request.status === 'error') {
                    cleanup();
                    resolve(request.message || 'error');
                }
            };
            const poller = setInterval(async () => {
                try {
                    const current = await chrome.tabs.get(loginTabId);
                    if (current?.url && !current.url.includes('sign-in') && !current.url.includes('about:blank')) {
                        cleanup();
                        resolve('success');
                    }
                } catch (_) {
                    cleanup();
                    resolve('closed');
                }
            }, 1000);
            const timeout = setTimeout(() => {
                cleanup();
                resolve('timeout');
            }, 25000);
            function cleanup() {
                clearInterval(poller);
                clearTimeout(timeout);
                chrome.runtime.onMessage.removeListener(messageListener);
            }
            chrome.runtime.onMessage.addListener(messageListener);
        });

        if (result === 'success') {
            // 等待 1.5 秒确保 Cookie 写入持久化
            await new Promise((resolve) => setTimeout(resolve, 1500));
            return { ok: true };
        }
        return { ok: false, error: result };
    } finally {
        if (loginTabId) {
            try {
                await chrome.tabs.remove(loginTabId);
            } catch (_) {
                // Ignore tab closure error
            }
        }
    }
}

async function performAutoLogin(email, password) {
    try {
        // 第一轨：优先使用 API 快速直登
        const apiResult = await loginViaApi(email, password);
        if (apiResult.ok) {
            loginRetryCount = 0;
            const now = Date.now();
            await updateState({
                lastLoginTime: now,
                lastLoginAttemptTime: now,
                lastLoginSuccess: true,
                lastChecked: now,
                lastError: '',
            });
            await logDebug('API login succeeded. Refreshing session probe...');
            await checkSessionViaProbe();
            return true;
        }

        // 如果是凭据错误，直接终止重试
        if (!apiResult.needFallback) {
            await updateState({
                status: 'login-failed',
                lastLoginAttemptTime: Date.now(),
                lastLoginSuccess: false,
                lastError: apiResult.error || 'Invalid credentials.',
            });
            await logDebug(`Auto-login halted: ${apiResult.error}`);
            return false;
        }

        // 第二轨：降级为后台 Tab 模拟登录
        await logDebug('API login failed, falling back to background Tab login...');
        const tabResult = await performAutoLoginViaTab(email, password);
        if (tabResult.ok) {
            loginRetryCount = 0;
            const now = Date.now();
            await updateState({
                lastLoginTime: now,
                lastLoginAttemptTime: now,
                lastLoginSuccess: true,
                lastChecked: now,
                lastError: '',
            });
            await logDebug('Tab login succeeded. Refreshing session probe...');
            await checkSessionViaProbe();
            return true;
        }

        // 均失败
        await updateState({
            status: 'login-failed',
            lastLoginAttemptTime: Date.now(),
            lastLoginSuccess: false,
            lastError: `Auto-login failed: ${tabResult.error}`,
        });
        await logDebug(`Auto-login failed: ${tabResult.error}`);
        if (tabResult.error !== 'Captcha or security check detected.' && loginRetryCount < MAX_LOGIN_RETRIES) {
            setTimeout(() => {
                triggerAutoLogin().catch((error) => logDebug(`Retry failed: ${error.message}`));
            }, LOGIN_COOLDOWN_MS + 1000);
        }
        return false;
    } finally {
        isLoginInProgress = false;
        await updateState({ isLoginInProgress: false });
    }
}

export async function triggerAutoLogin({ force = false } = {}) {
    const config = await getConfigRaw();
    if (!config.enabled || (!config.autoLoginEnabled && !force)) {
        await logDebug('Auto-login skipped because it is disabled.');
        return false;
    }
    if (!config.authEmail || !config.authPassword) {
        await updateState({ status: 'login-failed', lastError: 'Missing saved email or password.' });
        await logDebug('Auto-login skipped because credentials are missing.');
        return false;
    }
    if (isLoginInProgress) {
        await logDebug('Auto-login is already running.');
        return false;
    }
    const now = Date.now();
    if (!force && now - lastLoginAttempt < LOGIN_COOLDOWN_MS) {
        await logDebug('Auto-login cooldown is active.');
        return false;
    }
    if (!force && loginRetryCount >= MAX_LOGIN_RETRIES) {
        await logDebug('Auto-login retry limit reached.');
        return false;
    }

    isLoginInProgress = true;
    lastLoginAttempt = now;
    if (force) {
        loginRetryCount = 0;
    } else {
        loginRetryCount += 1;
    }

    await updateState({
        isLoginInProgress: true,
        lastLoginAttemptTime: now,
        lastError: '',
    });
    return performAutoLogin(config.authEmail, deobfuscate(config.authPassword));
}

export async function performKeepAlive({ manual = false } = {}) {
    const config = await getConfigRaw();
    if (!config.enabled) {
        await updateState({ status: 'disabled', lastChecked: Date.now() });
        return getSessionKeeperState();
    }

    const now = Date.now();
    const elapsed = now - lastHeartbeatTime;
    lastHeartbeatTime = now;
    if (manual) {
        await logDebug('Manual session check requested.');
    } else if (elapsed > WAKE_THRESHOLD_MS) {
        await logDebug(`Browser wake detected after ${Math.round(elapsed / 1000)}s.`);
    }

    const status = await checkSessionViaProbe();
    loginRetryCount = 0;
    if (status === 'expired') {
        if (config.autoLoginEnabled) {
            await triggerAutoLogin();
        }
        return getSessionKeeperState();
    }

    const state = await getStateRaw();
    const sessionExpiry = Number(state.sessionExpiry || 0);
    const remainingMs = sessionExpiry - Date.now();
    const shouldPreempt = status === 'valid'
        && config.preemptiveLoginEnabled
        && sessionExpiry > 0
        && remainingMs <= config.preemptiveBeforeExpiryHours * HOUR_MS;

    if (shouldPreempt) {
        await logDebug(`Session expires in ${Math.max(0, Math.round(remainingMs / 60000))} min; triggering preemptive login.`);
        await triggerAutoLogin();
    }
    return getSessionKeeperState();
}

export async function getSessionKeeperState() {
    const config = await getConfigRaw();
    const state = await getStateRaw();
    return {
        config: sanitizeConfigForUi(config),
        state: sanitizeStateForUi({
            ...state,
            isLoginInProgress,
        }),
    };
}

export async function saveSessionKeeperConfig(input = {}) {
    const existing = await getConfigRaw();
    const next = {
        ...existing,
        enabled: input.enabled === true,
        autoLoginEnabled: input.autoLoginEnabled === true,
        keepAliveInterval: input.keepAliveInterval,
        preemptiveLoginEnabled: input.preemptiveLoginEnabled === true,
        preemptiveBeforeExpiryHours: input.preemptiveBeforeExpiryHours,
        authEmail: typeof input.authEmail === 'string' ? input.authEmail.trim() : '',
    };
    if (typeof input.authPassword === 'string' && input.authPassword.length > 0) {
        next.authPassword = obfuscate(input.authPassword);
    } else if (input.keepExistingPassword === true) {
        next.authPassword = existing.authPassword;
    } else {
        next.authPassword = '';
    }

    const saved = await setConfigRaw(next);
    await logDebug('Session keeper settings saved.');
    // 保存设置后若启用了保活，立即执行一次检查
    if (saved.enabled) {
        performKeepAlive().catch((err) => console.warn('Keep-alive after save failed:', err));
    }
    return {
        config: sanitizeConfigForUi(saved),
        state: sanitizeStateForUi(await getStateRaw()),
    };
}

export async function clearSessionKeeperLogs() {
    await updateState({ debugLogs: [] });
    return getSessionKeeperState();
}

export function initSessionKeeperService() {
    if (initialized) return;
    initialized = true;

    chrome.runtime.onInstalled.addListener(() => {
        ensureDefaults().catch((error) => console.warn('Session keeper init failed:', error));
    });
    chrome.runtime.onStartup.addListener(() => {
        ensureDefaults().catch((error) => console.warn('Session keeper startup failed:', error));
    });
    chrome.alarms.onAlarm.addListener((alarm) => {
        if (alarm.name === ALARM_NAME) {
            performKeepAlive().catch((error) => logDebug(`Keep-alive failed: ${error.message}`));
        }
    });
    chrome.storage.onChanged.addListener((changes, namespace) => {
        if (namespace === 'local' && changes[CONFIG_KEY]) {
            syncAlarm(normalizeConfig(changes[CONFIG_KEY].newValue)).catch((error) => {
                console.warn('Session alarm sync failed:', error);
            });
        }
    });

    ensureDefaults().catch((error) => console.warn('Session keeper defaults failed:', error));
}

