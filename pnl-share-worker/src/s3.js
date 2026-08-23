import { sha256Hex } from './crypto.js';

const encoder = new TextEncoder();
const R2_REGION = 'auto';
const R2_SERVICE = 's3';

function encodeRfc3986(value) {
    return encodeURIComponent(String(value)).replace(/[!'()*]/g, (character) => (
        `%${character.charCodeAt(0).toString(16).toUpperCase()}`
    ));
}

function encodeObjectPath(value) {
    return String(value).split('/').map(encodeRfc3986).join('/');
}

function hex(bytes) {
    return Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');
}

async function hmac(key, value) {
    const rawKey = typeof key === 'string' ? encoder.encode(key) : key;
    const imported = await crypto.subtle.importKey(
        'raw', rawKey, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
    );
    return new Uint8Array(await crypto.subtle.sign('HMAC', imported, encoder.encode(String(value))));
}

async function signingKey(secretAccessKey, dateStamp) {
    const dateKey = await hmac(`AWS4${secretAccessKey}`, dateStamp);
    const regionKey = await hmac(dateKey, R2_REGION);
    const serviceKey = await hmac(regionKey, R2_SERVICE);
    return hmac(serviceKey, 'aws4_request');
}

export function directR2Config(env) {
    const accountId = String(env.R2_ACCOUNT_ID || '').trim();
    const bucket = String(env.R2_BUCKET_NAME || '').trim();
    const accessKeyId = String(env.R2_ACCESS_KEY_ID || '').trim();
    const secretAccessKey = String(env.R2_SECRET_ACCESS_KEY || '').trim();
    const dnsCompatibleBucket = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket);
    if (!accountId || !dnsCompatibleBucket || !accessKeyId || !secretAccessKey) return null;
    return { accountId, bucket, accessKeyId, secretAccessKey };
}

export async function presignR2Url(env, {
    method,
    objectKey,
    expiresSeconds = 300,
    contentType = '',
    timestamp = Date.now(),
} = {}) {
    const config = directR2Config(env);
    if (!config) return null;
    const operation = String(method || '').toUpperCase();
    if (!['GET', 'HEAD', 'PUT'].includes(operation)) throw new Error('Unsupported R2 presign operation.');
    const ttl = Math.max(1, Math.min(604_800, Math.floor(Number(expiresSeconds) || 300)));
    const date = new Date(timestamp);
    const amzDate = date.toISOString().replace(/[:-]|\.\d{3}/g, '');
    const dateStamp = amzDate.slice(0, 8);
    const credentialScope = `${dateStamp}/${R2_REGION}/${R2_SERVICE}/aws4_request`;
    // Match the virtual-hosted URL emitted by the official R2 SDK examples.
    // This avoids browser-specific handling of account-host/path-style S3 URLs.
    const host = `${config.bucket}.${config.accountId}.r2.cloudflarestorage.com`;
    const canonicalUri = `/${encodeObjectPath(objectKey)}`;
    const signedHeaders = contentType ? 'content-type;host' : 'host';
    const canonicalHeaders = contentType
        ? `content-type:${contentType}\nhost:${host}\n`
        : `host:${host}\n`;
    const query = new Map([
        ['X-Amz-Algorithm', 'AWS4-HMAC-SHA256'],
        ['X-Amz-Content-Sha256', 'UNSIGNED-PAYLOAD'],
        ['X-Amz-Credential', `${config.accessKeyId}/${credentialScope}`],
        ['X-Amz-Date', amzDate],
        ['X-Amz-Expires', String(ttl)],
        ['X-Amz-SignedHeaders', signedHeaders],
    ]);
    const canonicalQuery = [...query.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([name, value]) => `${encodeRfc3986(name)}=${encodeRfc3986(value)}`)
        .join('&');
    const canonicalRequest = [
        operation,
        canonicalUri,
        canonicalQuery,
        canonicalHeaders,
        signedHeaders,
        'UNSIGNED-PAYLOAD',
    ].join('\n');
    const stringToSign = [
        'AWS4-HMAC-SHA256',
        amzDate,
        credentialScope,
        await sha256Hex(canonicalRequest),
    ].join('\n');
    const signature = hex(await hmac(await signingKey(config.secretAccessKey, dateStamp), stringToSign));
    const url = `https://${host}${canonicalUri}?${canonicalQuery}&X-Amz-Signature=${signature}`;
    return {
        url,
        expiresAt: date.getTime() + (ttl * 1000),
        headers: contentType ? { 'Content-Type': contentType } : {},
    };
}
