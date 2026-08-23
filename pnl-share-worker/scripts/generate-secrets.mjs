import { createHash, randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const token = () => randomBytes(32).toString('base64url');
const password = randomBytes(24).toString('base64url');
const secrets = {
    ACCOUNT_HASH_SECRET: token(),
    ACCESS_KEY_HASH_SECRET: token(),
    ALPHA_ALIAS_SECRET: token(),
    WQ_ID_ENCRYPTION_KEY_V1: token(),
    ALPHA_ID_ENCRYPTION_KEY_V1: token(),
    UPLOAD_ENCRYPTION_KEY_V1: token(),
    ADMIN_AUTH_DIGEST: createHash('sha256').update(`admin:${password}`).digest('hex'),
};

await Promise.all([
    writeFile(path.join(root, '.generated-secrets.json'), `${JSON.stringify(secrets, null, 2)}\n`, { mode: 0o600 }),
    writeFile(path.join(root, '.dev.vars'), `${Object.entries(secrets).map(([key, value]) => `${key}=${value}`).join('\n')}\n`, { mode: 0o600 }),
    writeFile(path.join(root, '.admin-credentials.txt'), `username=admin\npassword=${password}\n`, { mode: 0o600 }),
]);

process.stdout.write('Generated ignored local secret files. Secret values were not printed.\n');
