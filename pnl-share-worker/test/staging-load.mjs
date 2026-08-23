import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const targetUrl = String(process.env.PNL_SHARE_TEST_URL || '').replace(/\/$/, '');
if (!/^https:\/\/[^/]+\.workers\.dev$/i.test(targetUrl)) {
    throw new Error('PNL_SHARE_TEST_URL must explicitly name the staging workers.dev URL.');
}

function positiveInteger(name, fallback, maximum) {
    const value = Number(process.env[name] || fallback);
    if (!Number.isInteger(value) || value < 1 || value > maximum) {
        throw new Error(`${name} must be an integer from 1 to ${maximum}.`);
    }
    return value;
}

const clients = positiveInteger('PNL_SHARE_LOAD_CLIENTS', 16, 64);
const concurrency = Math.min(clients, positiveInteger('PNL_SHARE_LOAD_CONCURRENCY', 16, 64));
const recordCount = positiveInteger('PNL_SHARE_RECORD_COUNT', 64, 20_000);
const scriptPath = fileURLToPath(new URL('./local-e2e.mjs', import.meta.url));
const startedAt = Date.now();
const results = [];
let nextClient = 0;

function runClient(client) {
    return new Promise((resolve) => {
        const child = spawn(process.execPath, [scriptPath], {
            env: {
                ...process.env,
                PNL_SHARE_TEST_URL: targetUrl,
                PNL_SHARE_PROCESS_ONLY: '1',
                PNL_SHARE_RECORD_COUNT: String(recordCount),
                PNL_SHARE_STATUS_MAX_ATTEMPTS: process.env.PNL_SHARE_STATUS_MAX_ATTEMPTS || '1200',
                PNL_SHARE_STATUS_POLL_MS: process.env.PNL_SHARE_STATUS_POLL_MS || '500',
            },
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (chunk) => { stdout += chunk; });
        child.stderr.on('data', (chunk) => { stderr += chunk; });
        child.on('error', (error) => resolve({ client, ok: false, error: error.message }));
        child.on('close', (code) => {
            if (code !== 0) {
                resolve({ client, ok: false, error: stderr.trim() || stdout.trim() || `exit ${code}` });
                return;
            }
            try {
                const lines = stdout.trim().split(/\r?\n/).filter(Boolean);
                resolve({ client, ...JSON.parse(lines.at(-1)) });
            } catch (error) {
                resolve({ client, ok: false, error: `invalid child output: ${error.message}` });
            }
        });
    });
}

async function worker() {
    while (true) {
        const client = nextClient;
        nextClient += 1;
        if (client >= clients) return;
        results.push(await runClient(client + 1));
    }
}

await Promise.all(Array.from({ length: concurrency }, () => worker()));
const durationMs = Date.now() - startedAt;
const failures = results.filter((result) => !result.ok);
const processedMessages = results.reduce((sum, result) => sum + Number(result.processed || 0), 0);
const summary = {
    ok: failures.length === 0,
    targetUrl,
    clients,
    concurrency,
    recordCountPerClient: recordCount,
    successfulClients: clients - failures.length,
    failedClients: failures.length,
    processedMessages,
    durationMs,
    messagesPerSecond: Number((processedMessages / Math.max(0.001, durationMs / 1000)).toFixed(2)),
    failures: failures.map(({ client, error }) => ({ client, error: String(error || '').slice(0, 500) })),
};
process.stdout.write(`${JSON.stringify(summary)}\n`);
if (failures.length) process.exitCode = 1;
