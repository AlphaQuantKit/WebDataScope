import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

test('WQ Manager login and profile navigation both use the current domain', async () => {
    const source = await readFile(new URL('../src/background/background.js', import.meta.url), 'utf8');
    const start = source.indexOf('async function loginAndOpenWqManager(');
    const end = source.indexOf('\nfunction broadcastRequest(', start);
    assert.ok(start >= 0 && end > start);
    const navigations = [];
    let listener;
    let injection;
    const chrome = {
        runtime: {},
        tabs: {
            create(options, callback) {
                navigations.push(options.url);
                callback({ id: 42 });
            },
            update(tabId, options) {
                assert.equal(tabId, 42);
                navigations.push(options.url);
            },
            onUpdated: {
                addListener(callback) { listener = callback; },
                removeListener(callback) { assert.equal(callback, listener); },
            },
        },
        scripting: {
            async executeScript(options) { injection = options; },
        },
    };
    const login = vm.runInNewContext(`(${source.slice(start, end)})`, {
        chrome,
        setTimeout() { return 1; },
    });
    const pending = login('WQ-TEST', 7);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(navigations, [
        'https://wqmanager.icu/login',
        'https://wqmanager.icu/Profile',
    ]);
    listener(42, { status: 'complete' });
    await pending;
    assert.equal(injection.target.tabId, 42);
    assert.equal(injection.args[0], 'WQ-TEST');
    assert.doesNotMatch(source, /wqmanager\.qzz\.io/);
});
