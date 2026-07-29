import { getLocalValue, setLocalValue } from './storageService.js';

const CONFIG_KEY = 'WQP_LLM_Config';

const DEFAULT_CONFIG = {
    enabled: false,
    baseUrl: '',
    model: '',
    apiKey: '',
};

function normalizeBaseUrl(value) {
    return String(value || '').trim().replace(/\/+$/, '');
}

function normalizeConfig(config = {}) {
    return {
        enabled: config.enabled === true,
        baseUrl: normalizeBaseUrl(config.baseUrl),
        model: String(config.model || '').trim(),
        apiKey: String(config.apiKey || '').trim(),
    };
}

function sanitizeConfig(config) {
    const normalized = normalizeConfig(config);
    return {
        ...normalized,
        apiKey: '',
        hasApiKey: Boolean(normalized.apiKey),
    };
}

export async function getLlmConfig() {
    const saved = await getLocalValue(CONFIG_KEY);
    return sanitizeConfig({ ...DEFAULT_CONFIG, ...(saved || {}) });
}

export async function getLlmConfigRaw() {
    const saved = await getLocalValue(CONFIG_KEY);
    return normalizeConfig({ ...DEFAULT_CONFIG, ...(saved || {}) });
}

export async function saveLlmConfig(input = {}) {
    const existing = await getLlmConfigRaw();
    const next = normalizeConfig({
        ...existing,
        enabled: input.enabled === true,
        baseUrl: input.baseUrl,
        model: input.model,
        apiKey: typeof input.apiKey === 'string' && input.apiKey.length > 0
            ? input.apiKey
            : input.keepExistingApiKey === true
                ? existing.apiKey
                : '',
    });
    if (next.enabled) {
        await testLlmConfig(next);
    }
    await setLocalValue(CONFIG_KEY, next);
    return sanitizeConfig(next);
}

function extractJsonObject(text) {
    const raw = String(text || '').trim();
    if (!raw) throw new Error('LLM returned an empty response.');
    try {
        return JSON.parse(raw);
    } catch (_) {
        const match = raw.match(/\{[\s\S]*\}/);
        if (!match) throw new Error('LLM response is not valid JSON.');
        return JSON.parse(match[0]);
    }
}

export async function runLlmJson({ systemPrompt, userPrompt, schemaName = 'result' }) {
    const config = await getLlmConfigRaw();
    if (!config.enabled) throw new Error('AI is disabled. Please enable AI in the extension side panel.');
    if (!config.model) throw new Error('AI model is not configured.');
    return runLlmJsonWithConfig(config, { systemPrompt, userPrompt, schemaName });
}

export async function runLlmText({ systemPrompt, userPrompt, taskName = 'result' }) {
    const config = await getLlmConfigRaw();
    if (!config.enabled) throw new Error('AI is disabled. Please enable AI in the extension side panel.');
    if (!config.model) throw new Error('AI model is not configured.');
    return runLlmTextWithConfig(config, { systemPrompt, userPrompt, taskName });
}

async function requestChatCompletion(config, payload) {
    const headers = {
        Accept: 'application/json',
        'Content-Type': 'application/json',
    };
    if (config.apiKey) {
        headers.Authorization = `Bearer ${config.apiKey}`;
    }

    const response = await fetch(`${config.baseUrl}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
        const detail = data?.error?.message || data?.message || response.statusText;
        throw new Error(`LLM request failed (${response.status}): ${detail}`);
    }
    return data;
}

async function testLlmConfig(config) {
    if (!config.baseUrl) throw new Error('AI Base URL is required.');
    if (!config.model) throw new Error('AI model is required.');
    const data = await requestChatCompletion(config, {
        model: config.model,
        stream: false,
        messages: [
            { role: 'user', content: 'Reply with exactly: ok' },
        ],
    });
    const content = data?.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || !content.trim()) {
        throw new Error('LLM connectivity check returned an empty response.');
    }
    return true;
}

async function runLlmJsonWithConfig(config, { systemPrompt, userPrompt, schemaName = 'result' }) {
    const data = await requestChatCompletion(config, {
        model: config.model,
        stream: false,
        messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
        ],
    });

    const content = data?.choices?.[0]?.message?.content;
    const parsed = extractJsonObject(content);
    if (!parsed || typeof parsed !== 'object') {
        throw new Error(`LLM ${schemaName} response is not an object.`);
    }
    return {
        result: parsed,
        usage: data?.usage || null,
        model: data?.model || config.model,
    };
}

async function runLlmTextWithConfig(config, { systemPrompt, userPrompt, taskName = 'result' }) {
    const data = await requestChatCompletion(config, {
        model: config.model,
        stream: false,
        messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
        ],
    });

    const content = data?.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || !content.trim()) {
        throw new Error(`LLM ${taskName} response is empty.`);
    }
    return {
        text: content.trim(),
        usage: data?.usage || null,
        model: data?.model || config.model,
    };
}
