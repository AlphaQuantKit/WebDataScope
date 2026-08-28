import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import {
    encodeBasicAuthorization,
    isExpiredAuthenticationStatus,
    performKeepAlive,
    readAuthenticationSession,
    requestApiLogin,
    saveSessionKeeperConfig,
} from '../src/background/services/sessionKeeperService.js';

test('authentication probe treats the WQ logged-out statuses as expired', () => {
    assert.equal(isExpiredAuthenticationStatus(204), true);
    assert.equal(isExpiredAuthenticationStatus(401), true);
    assert.equal(isExpiredAuthenticationStatus(403), true);
    assert.equal(isExpiredAuthenticationStatus(200), false);
    assert.equal(isExpiredAuthenticationStatus(500), false);
});

test('basic authorization safely encodes UTF-8 credentials', () => {
    const header = encodeBasicAuthorization('user@example.com', 'päss:密码');
    assert.match(header, /^Basic /);
    assert.equal(Buffer.from(header.slice(6), 'base64').toString('utf8'), 'user@example.com:päss:密码');
});

test('authentication response expiry is interpreted as remaining seconds', () => {
    assert.deepEqual(readAuthenticationSession({
        user: { id: 'WQ-123' },
        token: { expiry: 3600 },
    }, 1_800_000_000_000), {
        userId: 'WQ-123',
        expirySeconds: 3600,
        sessionExpiry: 1_800_003_600_000,
        sessionExpirySource: 'authentication',
    });
    assert.equal(readAuthenticationSession({ token: {} }), null);
});

test('API login posts Basic credentials with browser cookie persistence enabled', async () => {
    const calls = [];
    const authSession = await requestApiLogin('user@example.com', 'secret', async (url, options) => {
        calls.push({ url, options });
        return new Response(JSON.stringify({
            user: { id: 'WQ-123' },
            token: { expiry: 7200 },
        }), {
            status: 201,
            headers: { 'Content-Type': 'application/json' },
        });
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://api.worldquantbrain.com/authentication');
    assert.equal(calls[0].options.method, 'POST');
    assert.equal(calls[0].options.credentials, 'include');
    assert.equal(calls[0].options.cache, 'no-store');
    assert.equal(Buffer.from(calls[0].options.headers.Authorization.slice(6), 'base64').toString('utf8'), 'user@example.com:secret');
    assert.equal(calls[0].options.body, undefined);
    assert.equal(authSession.userId, 'WQ-123');
    assert.equal(authSession.expirySeconds, 7200);
});

test('API login reports authentication errors and rejects empty success bodies', async () => {
    await assert.rejects(
        requestApiLogin('user@example.com', 'wrong', async () => new Response(
            JSON.stringify({ detail: 'Invalid credentials' }),
            { status: 401, headers: { 'Content-Type': 'application/json' } },
        )),
        /HTTP 401: Invalid credentials/,
    );
    await assert.rejects(
        requestApiLogin('user@example.com', 'secret', async () => new Response(null, { status: 204 })),
        /did not contain a valid token expiry/,
    );
});

test('the 204 recovery flow posts API login and re-probes before success', async () => {
    const originalChrome = globalThis.chrome;
    const originalFetch = globalThis.fetch;
    const memory = {};
    const calls = [];
    globalThis.chrome = {
        runtime: { lastError: null },
        storage: {
            local: {
                get(key, callback) { callback({ [key]: memory[key] }); },
                set(values, callback) { Object.assign(memory, structuredClone(values)); callback(); },
            },
        },
        alarms: {
            async clear() { return true; },
            create() {},
        },
    };
    globalThis.fetch = async (_url, options) => {
        calls.push(options);
        if (calls.length === 1) return new Response(null, { status: 204 });
        return new Response(JSON.stringify({
            user: { id: 'WQ-AUTO' },
            token: { expiry: 3600 },
        }), {
            status: calls.length === 2 ? 201 : 200,
            headers: { 'Content-Type': 'application/json' },
        });
    };

    try {
        await saveSessionKeeperConfig({
            enabled: true,
            autoLoginEnabled: true,
            keepAliveInterval: 5,
            preemptiveLoginEnabled: false,
            preemptiveBeforeExpiryHours: 0.5,
            authEmail: 'user@example.com',
            authPassword: 'secret',
        });
        const result = await performKeepAlive();
        assert.deepEqual(calls.map((options) => options.method), ['GET', 'POST', 'GET']);
        assert.equal(result.state.status, 'valid');
        assert.equal(result.state.userId, 'WQ-AUTO');
        assert.equal(result.state.lastLoginSuccess, true);
        assert.equal(result.state.isLoginInProgress, false);
    } finally {
        globalThis.chrome = originalChrome;
        globalThis.fetch = originalFetch;
    }
});

test('session login no longer opens or scripts the sign-in page', async () => {
    const source = await readFile(new URL('../src/background/services/sessionKeeperService.js', import.meta.url), 'utf8');
    assert.doesNotMatch(source, /platform\.worldquantbrain\.com\/sign-in/);
    assert.doesNotMatch(source, /chrome\.tabs\.create/);
    assert.doesNotMatch(source, /chrome\.scripting\.executeScript/);
    assert.match(source, /performApiLogin\(config\.authEmail/);
});
