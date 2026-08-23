import assert from 'node:assert/strict';
import test from 'node:test';
import { directR2Config, presignR2Url } from '../src/s3.js';

const env = {
    R2_ACCOUNT_ID: '0123456789abcdef0123456789abcdef',
    R2_BUCKET_NAME: 'test-bucket',
    R2_ACCESS_KEY_ID: 'ACCESS123',
    R2_SECRET_ACCESS_KEY: 'secret-test',
};

test('direct R2 mode stays disabled unless every signing value is present', () => {
    assert.equal(directR2Config({ ...env, R2_SECRET_ACCESS_KEY: '' }), null);
    assert.equal(directR2Config({ ...env, R2_BUCKET_NAME: 'not dns compatible' }), null);
    assert.deepEqual(directR2Config(env), {
        accountId: env.R2_ACCOUNT_ID,
        bucket: env.R2_BUCKET_NAME,
        accessKeyId: env.R2_ACCESS_KEY_ID,
        secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    });
});

test('R2 SigV4 PUT URL is deterministic and signs Content-Type', async () => {
    const signed = await presignR2Url(env, {
        method: 'PUT',
        objectKey: 'folder/a b.json',
        contentType: 'application/json',
        expiresSeconds: 900,
        timestamp: Date.parse('2026-08-19T01:02:03Z'),
    });
    assert.equal(signed.url, 'https://test-bucket.0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com/folder/a%20b.json?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Content-Sha256=UNSIGNED-PAYLOAD&X-Amz-Credential=ACCESS123%2F20260819%2Fauto%2Fs3%2Faws4_request&X-Amz-Date=20260819T010203Z&X-Amz-Expires=900&X-Amz-SignedHeaders=content-type%3Bhost&X-Amz-Signature=9814403dceca9ab96b85d4f2f70347ed88fc91ef87e865b47c6ef4fd82333580');
    assert.deepEqual(signed.headers, { 'Content-Type': 'application/json' });
    assert.equal(signed.expiresAt, Date.parse('2026-08-19T01:17:03Z'));
});

test('R2 SigV4 rejects unsupported operations and clamps expiry', async () => {
    await assert.rejects(() => presignR2Url(env, { method: 'DELETE', objectKey: 'x' }), /Unsupported/);
    const signed = await presignR2Url(env, {
        method: 'GET',
        objectKey: 'x',
        expiresSeconds: 999_999,
        timestamp: Date.parse('2026-08-19T00:00:00Z'),
    });
    assert.match(signed.url, /X-Amz-Expires=604800/);
    assert.deepEqual(signed.headers, {});
});
