import assert from 'node:assert/strict';
import test from 'node:test';
import { formatExpiryTime } from '../src/ui/sidebar/modules/sessionPanel.js';

test('session expiry status includes a stable remaining-time countdown', () => {
    const now = 1_800_000_000_000;
    assert.match(
        formatExpiryTime(now + 90 * 60 * 1000, 'authentication', now),
        /剩余 1小时30分，Authentication/,
    );
    assert.match(formatExpiryTime(now + 25 * 60 * 1000, 'token', now), /剩余 25分钟，JWT/);
    assert.match(formatExpiryTime(now - 1000, 'authentication', now), /已过期，Authentication/);
    assert.equal(formatExpiryTime(null, 'unknown', now), '-（未知）');
});
