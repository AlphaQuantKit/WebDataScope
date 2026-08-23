const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function randomBytes(length = 32) {
    const bytes = new Uint8Array(length);
    crypto.getRandomValues(bytes);
    return bytes;
}

export function bytesToBase64Url(bytes) {
    let binary = '';
    for (let index = 0; index < bytes.length; index += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
    }
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export function base64UrlToBytes(value) {
    const normalized = String(value || '').replace(/-/g, '+').replace(/_/g, '/');
    const binary = atob(normalized + '='.repeat((4 - (normalized.length % 4)) % 4));
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export function hex(bytes) {
    return Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');
}

export async function sha256Hex(value) {
    const input = value instanceof Uint8Array ? value : encoder.encode(String(value));
    return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', input)));
}

export async function importHmacKey(secret) {
    return crypto.subtle.importKey(
        'raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
    );
}

export async function hmacHexWithKey(key, value) {
    return hex(new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(String(value)))));
}

export async function hmacHex(secret, value) {
    return hmacHexWithKey(await importHmacKey(secret), value);
}

export async function hmacBytes(secret, value) {
    const key = await crypto.subtle.importKey(
        'raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
    );
    return new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(String(value))));
}

export async function importEncryptionKey(secret) {
    return crypto.subtle.importKey('raw', base64UrlToBytes(secret), 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export async function encryptBytesWithKey(value, key) {
    const iv = randomBytes(12);
    const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv }, key, value instanceof Uint8Array ? value : new Uint8Array(value),
    ));
    return { ciphertext: bytesToBase64Url(ciphertext), iv: bytesToBase64Url(iv) };
}

export async function encryptTextWithKey(value, key) {
    return encryptBytesWithKey(encoder.encode(String(value)), key);
}

export async function encryptText(value, secret) {
    return encryptTextWithKey(value, await importEncryptionKey(secret));
}

export async function encryptBytes(value, secret) {
    return encryptBytesWithKey(value, await importEncryptionKey(secret));
}

export async function decryptText(ciphertext, iv, secret) {
    const plaintext = await decryptBytes(ciphertext, iv, secret);
    return decoder.decode(plaintext);
}

export async function decryptBytesWithKey(ciphertext, iv, key) {
    return new Uint8Array(await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: base64UrlToBytes(iv) }, key, base64UrlToBytes(ciphertext),
    ));
}

export async function decryptBytes(ciphertext, iv, secret) {
    return decryptBytesWithKey(ciphertext, iv, await importEncryptionKey(secret));
}

export async function importVerifyKey(jwk) {
    return crypto.subtle.importKey(
        'jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify'],
    );
}

export async function verifySignature(publicJwk, value, signature) {
    try {
        const key = await importVerifyKey(publicJwk);
        return crypto.subtle.verify(
            { name: 'ECDSA', hash: 'SHA-256' }, key,
            base64UrlToBytes(signature), encoder.encode(value),
        );
    } catch {
        return false;
    }
}

export function constantTimeEqual(left, right) {
    if (typeof left !== 'string' || typeof right !== 'string') return false;
    const max = Math.max(left.length, right.length);
    let difference = left.length ^ right.length;
    for (let index = 0; index < max; index += 1) {
        difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
    }
    return difference === 0;
}

export function currentKeyVersion(env) {
    const version = Number(env.KEY_VERSION || 1);
    if (!Number.isInteger(version) || version < 1 || version > 999) throw new Error('Invalid KEY_VERSION.');
    return version;
}
