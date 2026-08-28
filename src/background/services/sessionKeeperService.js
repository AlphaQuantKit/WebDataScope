import { getLocalValue, setLocalValue } from './storageService.js';

const CONFIG_KEY = 'WQP_SessionKeeperConfig';
const STATE_KEY = 'WQP_SessionKeeperState';
const ALARM_NAME = 'WQP_SESSION_KEEP_ALIVE';
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

const LOGIN_COOLDOWN_MS = 60 * 1000;
const MAX_LOGIN_RETRIES = 5;
const WAKE_THRESHOLD_MS = 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const TOKEN_WRITE_THROTTLE_MS = 60 * 1000;

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
        authEmail: typeof config.authEmail === 'string' ? config.authEmail : '',
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

export function readAuthenticationSession(data, now = Date.now()) {
    const expirySeconds = Number(data?.token?.expiry);
    const userId = String(data?.user?.id || '').trim();
    if (!Number.isFinite(expirySeconds)) return null;
    return {
        userId,
        expirySeconds,
        sessionExpiry: now + Math.max(0, expirySeconds) * 1000,
        sessionExpirySource: 'authentication',
    };
}

export function isExpiredAuthenticationStatus(status) {
    return status === 204 || status === 401 || status === 403;
}

export function encodeBasicAuthorization(email, password) {
    const bytes = new TextEncoder().encode(`${String(email || '')}:${String(password || '')}`);
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return `Basic ${btoa(binary)}`;
}

function readAuthenticationError(data, status) {
    const candidate = data?.detail
        || data?.message
        || data?.error
        || data?.non_field_errors?.[0]
        || data?.email?.[0];
    const detail = typeof candidate === 'string' ? candidate.trim().slice(0, 300) : '';
    return detail ? `HTTP ${status}: ${detail}` : `HTTP ${status}`;
}

export async function requestApiLogin(email, password, fetchImpl = fetch) {
    const response = await fetchImpl(AUTHENTICATION_URL, {
        method: 'POST',
        mode: 'cors',
        credentials: 'include',
        cache: 'no-store',
        headers: {
            Accept: 'application/json;version=2.0',
            Authorization: encodeBasicAuthorization(email, password),
        },
    });
    const data = await response.json().catch(() => null);
    if (!response.ok) throw new Error(`API login failed: ${readAuthenticationError(data, response.status)}.`);

    const authSession = readAuthenticationSession(data);
    if (!authSession || authSession.expirySeconds <= 0) {
        throw new Error('API login failed: authentication response did not contain a valid token expiry.');
    }
    return authSession;
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
        const response = await fetch(AUTHENTICATION_URL, {
            method: 'GET',
            mode: 'cors',
            credentials: 'include',
            headers: {
                Accept: 'application/json;version=2.0',
                'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8,en-GB;q=0.7,en-US;q=0.6',
            },
        });

        if (isExpiredAuthenticationStatus(response.status)) {
            await updateState({
                status: 'expired',
                lastChecked: now,
                userId: '',
                sessionExpiry: null,
                sessionExpirySource: 'authentication',
                lastError: `Probe returned ${response.status}; authentication is required.`,
            });
            await logDebug(`Session expired. Probe returned ${response.status}.`);
            return 'expired';
        }

        if (response.ok) {
            const data = await response.json().catch(() => null);
            const authSession = readAuthenticationSession(data, now);
            if (!authSession) {
                await updateState({
                    status: 'unknown',
                    lastChecked: now,
                    sessionExpiry: null,
                    sessionExpirySource: 'authentication',
                    lastError: 'Authentication response missing token.expiry.',
                });
                await logDebug('Authentication probe did not include token.expiry.');
                return 'unknown';
            }
            if (authSession.expirySeconds <= 0) {
                await updateState({
                    status: 'expired',
                    lastChecked: now,
                    userId: authSession.userId,
                    sessionExpiry: authSession.sessionExpiry,
                    sessionExpirySource: 'authentication',
                    lastError: 'Authentication token is expired.',
                });
                await logDebug('Session expired. Authentication token expiry is non-positive.');
                return 'expired';
            }
            await updateState({
                status: 'valid',
                lastChecked: now,
                userId: authSession.userId,
                sessionExpiry: authSession.sessionExpiry,
                sessionExpirySource: authSession.sessionExpirySource,
                lastError: '',
            });
            await logDebug(`Session is valid for ${Math.round(authSession.expirySeconds)}s${authSession.userId ? ` (${authSession.userId})` : ''}.`);
            return 'valid';
        }

        await updateState({
            status: 'unknown',
            lastChecked: now,
            sessionExpiry: null,
            sessionExpirySource: 'authentication',
            lastError: `Probe returned ${response.status}.`,
        });
        await logDebug(`Authentication probe returned ${response.status}.`);
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

async function performApiLogin(email, password) {
    try {
        await logDebug('Starting API auto-login with the saved account...');
        await requestApiLogin(email, password);
        await logDebug('API login returned successfully; verifying the updated browser cookie...');

        const status = await checkSessionViaProbe();
        if (status !== 'valid') {
            throw new Error('API login returned successfully, but the updated cookie did not produce a valid session.');
        }

        loginRetryCount = 0;
        const now = Date.now();
        await updateState({
            lastLoginTime: now,
            lastLoginAttemptTime: now,
            lastLoginSuccess: true,
            lastChecked: now,
            lastError: '',
        });
        await logDebug('API auto-login succeeded and the browser cookie is valid.');
        return true;
    } catch (error) {
        const message = error?.message || String(error);
        await updateState({
            status: 'login-failed',
            lastLoginAttemptTime: Date.now(),
            lastLoginSuccess: false,
            lastError: message,
        });
        await logDebug(`API auto-login failed: ${message}`);
        return false;
    } finally {
        isLoginInProgress = false;
        await updateState({ isLoginInProgress: false });
    }
}

export async function triggerAutoLogin({ manual = false } = {}) {
    const config = await getConfigRaw();
    if (!manual && (!config.enabled || !config.autoLoginEnabled)) {
        await logDebug('Auto-login skipped because it is disabled.');
        return false;
    }
    if (!config.authEmail || !config.authPassword) {
        const message = 'Missing saved email or password.';
        await updateState({ status: 'login-failed', lastError: message });
        await logDebug('Auto-login skipped because credentials are missing.');
        if (manual) throw new Error(message);
        return false;
    }
    if (isLoginInProgress) {
        const message = 'API auto-login is already running.';
        await logDebug(message);
        if (manual) throw new Error(message);
        return false;
    }
    const now = Date.now();
    const state = await getStateRaw();
    const mostRecentAttempt = Math.max(lastLoginAttempt, Number(state.lastLoginAttemptTime || 0));
    if (!manual && now - mostRecentAttempt < LOGIN_COOLDOWN_MS) {
        await logDebug('Auto-login cooldown is active.');
        return false;
    }
    if (!manual && loginRetryCount >= MAX_LOGIN_RETRIES) {
        await logDebug('Auto-login retry limit reached.');
        return false;
    }

    if (manual) loginRetryCount = 0;
    isLoginInProgress = true;
    lastLoginAttempt = now;
    loginRetryCount += 1;
    await updateState({
        isLoginInProgress: true,
        lastLoginAttemptTime: now,
        lastError: '',
    });
    const success = await performApiLogin(config.authEmail, deobfuscate(config.authPassword));
    if (!success && manual) {
        const failedState = await getStateRaw();
        throw new Error(failedState.lastError || 'API auto-login failed.');
    }
    return success;
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
    if (status === 'expired') {
        await triggerAutoLogin();
        return getSessionKeeperState();
    }

    if (status === 'valid') loginRetryCount = 0;

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
