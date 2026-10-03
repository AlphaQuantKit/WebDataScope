(function () {
    'use strict';

    if (window.__WQP_ALPHA_DESCRIPTION_ASSISTANT__) return;
    window.__WQP_ALPHA_DESCRIPTION_ASSISTANT__ = true;

    const CONTROL_CLASS = 'wqp-alpha-description-ai';
    const ALPHA_URL_PATTERN = /^\/alpha\/([^/]+)(?:\/|$)/i;
    const RESERVED_ALPHA_PATHS = new Set(['unsubmitted', 'submitted', 'distribution']);
    const MAX_FIELDS = 12;
    const FIELD_FETCH_CONCURRENCY = 4;
    const IGNORED_TOKENS = new Set([
        'true', 'false', 'null', 'nan', 'inf', 'infinity',
        'and', 'or', 'not', 'if', 'else', 'return',
    ]);

    let renderTimer = null;
    let lastUrl = location.href;
    let observedAlphaId = '';

    function normalizeAlphaId(value) {
        const alphaId = String(value || '').trim();
        return alphaId && !RESERVED_ALPHA_PATHS.has(alphaId.toLowerCase()) ? alphaId : '';
    }

    function getAlphaIdFromUrl(value = location.href) {
        try {
            if (!value) return '';
            const url = new URL(value, location.origin);
            if (url.origin !== location.origin) return '';
            const match = url.pathname.match(ALPHA_URL_PATTERN);
            return normalizeAlphaId(match?.[1]);
        } catch (_) {
            return '';
        }
    }

    function getAlphaIdFromDialog() {
        const panel = document.querySelector('.alphas-details--active');
        if (panel) {
            const link = panel.querySelector('a.alphas-details-content__link-lg[href]');
            return getAlphaIdFromUrl(link?.href || '');
        }
        const links = document.querySelectorAll('[role="dialog"] a[href*="/alpha/"]');
        for (const link of links) {
            const alphaId = getAlphaIdFromUrl(link.href);
            if (alphaId) return alphaId;
        }
        return '';
    }

    function getAlphaId() {
        const dialogId = getAlphaIdFromDialog();
        if (document.querySelector('.alphas-details--active')) return dialogId;
        return dialogId || getAlphaIdFromUrl()
            || (/^\/alphas(?:\/|$)/.test(new URL(location.href).pathname) ? '' : observedAlphaId);
    }

    function isVisible(element) {
        return Boolean(element?.getClientRects?.().length);
    }

    function getNearbyText(element) {
        let node = element?.parentElement;
        const parts = [];
        for (let depth = 0; node && depth < 4; depth += 1, node = node.parentElement) {
            const text = String(node.innerText || '').trim();
            if (text && text.length < 1200) parts.push(text);
        }
        return parts.join('\n');
    }

    function classifySuperTextarea(textarea) {
        const attributes = [
            textarea.id,
            textarea.name,
            textarea.placeholder,
            textarea.getAttribute('aria-label'),
            textarea.getAttribute('data-testid'),
        ].filter(Boolean).join(' ');
        if (/selection.*description|description.*selection/i.test(attributes)) return 'selection';
        if (/combo.*description|description.*combo/i.test(attributes)) return 'combo';

        let node = textarea.parentElement;
        for (let depth = 0; node && depth < 5; depth += 1, node = node.parentElement) {
            const text = String(node.innerText || '').trim();
            if (!text || text.length > 1600) continue;
            const hasSelection = /description\s+of\s+selection\s+expression/i.test(text);
            const hasCombo = /description\s+of\s+combo\s+expression/i.test(text);
            if (hasSelection && !hasCombo) return 'selection';
            if (hasCombo && !hasSelection) return 'combo';
        }
        return '';
    }

    function scoreRegularDescriptionTextarea(textarea) {
        if (!textarea || !isVisible(textarea) || textarea.closest(`.${CONTROL_CLASS}`)) return -1;
        const attributes = [
            textarea.id,
            textarea.name,
            textarea.placeholder,
            textarea.getAttribute('aria-label'),
            textarea.getAttribute('data-testid'),
        ].filter(Boolean).join(' ');
        const nearby = getNearbyText(textarea);
        let score = 0;
        if (/description/i.test(textarea.placeholder || '')) score += 12;
        if (/description/i.test(attributes)) score += 8;
        if (/(^|\n)\s*description\s*(\n|$)/i.test(nearby)) score += 7;
        else if (/description/i.test(nearby)) score += 3;
        if (/comment|feedback|search/i.test(attributes)) score -= 8;
        return score;
    }

    function findDescriptionTargets() {
        const visibleTextareas = Array.from(document.querySelectorAll('textarea')).filter(isVisible);
        const selection = visibleTextareas.find(
            (textarea) => classifySuperTextarea(textarea) === 'selection',
        );
        const combo = visibleTextareas.find(
            (textarea) => classifySuperTextarea(textarea) === 'combo',
        );
        if (selection && combo && selection !== combo) {
            return { kind: 'SUPER', selection, combo, first: selection };
        }

        const sharedSuperCandidates = visibleTextareas.filter((textarea) => {
            const nearby = getNearbyText(textarea);
            return /description\s+of\s+selection\s+expression/i.test(nearby)
                && /description\s+of\s+combo\s+expression/i.test(nearby)
                && /notes/i.test(textarea.placeholder || '');
        });
        if (sharedSuperCandidates.length >= 2) {
            return {
                kind: 'SUPER',
                selection: sharedSuperCandidates[0],
                combo: sharedSuperCandidates[1],
                first: sharedSuperCandidates[0],
            };
        }

        const candidates = visibleTextareas
            .map((textarea) => ({ textarea, score: scoreRegularDescriptionTextarea(textarea) }))
            .filter((candidate) => candidate.score > 0)
            .sort((a, b) => b.score - a.score);
        const regular = candidates[0]?.textarea;
        return regular ? { kind: 'REGULAR', regular, first: regular } : null;
    }

    function sendMessage(type, payload = {}) {
        return new Promise((resolve, reject) => {
            chrome.runtime.sendMessage({ type, ...payload }, (response) => {
                if (chrome.runtime.lastError) {
                    reject(new Error(chrome.runtime.lastError.message));
                    return;
                }
                if (!response?.ok) {
                    reject(new Error(response?.error || `Request failed: ${type}`));
                    return;
                }
                resolve(response.data);
            });
        });
    }

    function setNativeTextareaValue(textarea, value) {
        const previousValue = textarea.value;
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
        if (setter) setter.call(textarea, value);
        else textarea.value = value;

        if (textarea._valueTracker) {
            textarea._valueTracker.setValue(previousValue);
        }
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
        textarea.dispatchEvent(new Event('change', { bubbles: true }));
        textarea.focus();
        textarea.setSelectionRange(value.length, value.length);
    }

    function cleanValue(value, maxLength = 4000) {
        return String(value ?? '').trim().slice(0, maxLength);
    }

    function pickLabel(value) {
        if (value === undefined || value === null || value === '') return '';
        if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
            return String(value);
        }
        return pickLabel(value.name) || pickLabel(value.id) || pickLabel(value.value);
    }

    function expressionValue(value) {
        if (typeof value === 'string' || typeof value === 'number') {
            return cleanValue(value, 12000);
        }
        if (!value || typeof value !== 'object') return '';
        return cleanValue(value.code || value.expression || value.value, 12000);
    }

    function pickRegularExpression(alpha) {
        return expressionValue(alpha?.regular)
            || expressionValue(alpha?.code)
            || expressionValue(alpha?.expression);
    }

    function pickSuperExpressions(alpha) {
        const combo = alpha?.combo && typeof alpha.combo === 'object' ? alpha.combo : {};
        const superAlpha = alpha?.super && typeof alpha.super === 'object' ? alpha.super : {};
        return {
            selectionExpression:
                expressionValue(alpha?.selectionExpression)
                || expressionValue(alpha?.selection)
                || expressionValue(combo.selectionExpression)
                || expressionValue(combo.selection)
                || expressionValue(superAlpha.selectionExpression)
                || expressionValue(superAlpha.selection),
            comboExpression:
                expressionValue(alpha?.comboExpression)
                || expressionValue(combo.comboExpression)
                || expressionValue(combo.combo)
                || expressionValue(combo.code)
                || expressionValue(superAlpha.comboExpression)
                || expressionValue(superAlpha.combo)
                || expressionValue(superAlpha.code),
        };
    }

    function findExpressionInPage(excludedTextareas = []) {
        const textareas = Array.from(document.querySelectorAll('textarea'))
            .filter((textarea) => !excludedTextareas.includes(textarea));
        const textareaExpression = textareas
            .map((textarea) => cleanValue(textarea.value, 12000))
            .find((value) => value.length > 3 && /[()=+\-*/]/.test(value));
        if (textareaExpression) return textareaExpression;

        const codeElements = Array.from(document.querySelectorAll('pre, code, [class*="expression"], [class*="code"]'));
        return codeElements
            .map((element) => cleanValue(element.textContent, 12000))
            .find((value) => value.length > 3 && /[()=+\-*/]/.test(value)) || '';
    }

    function extractFieldCandidates(expression) {
        const assignedNames = new Set();
        const assignmentPattern = /\b([A-Za-z_][A-Za-z0-9_]*)\s*=(?!=)/g;
        let match;
        while ((match = assignmentPattern.exec(expression)) !== null) {
            assignedNames.add(match[1]);
        }

        const candidates = [];
        const seen = new Set();
        const tokenPattern = /\b[A-Za-z_][A-Za-z0-9_]*\b/g;
        while ((match = tokenPattern.exec(expression)) !== null) {
            const token = match[0];
            const tail = expression.slice(tokenPattern.lastIndex);
            const isFunction = /^\s*\(/.test(tail);
            const normalized = token.toLowerCase();
            if (isFunction || assignedNames.has(token) || IGNORED_TOKENS.has(normalized) || seen.has(token)) {
                continue;
            }
            seen.add(token);
            candidates.push(token);
            if (candidates.length >= MAX_FIELDS) break;
        }
        return candidates;
    }

    async function fetchBrainJson(path) {
        const response = await fetch(`https://api.worldquantbrain.com${path}`, {
            method: 'GET',
            credentials: 'include',
            headers: { Accept: 'application/json' },
        });
        if (!response.ok) {
            const error = new Error(`BRAIN API request failed (${response.status}).`);
            error.status = response.status;
            throw error;
        }
        return response.json();
    }

    function normalizeFieldMetadata(fieldId, data) {
        const dataset = data?.dataset || data?.dataSet || {};
        return {
            id: cleanValue(data?.id || fieldId, 200),
            name: cleanValue(data?.name, 500),
            description: cleanValue(data?.description, 1200),
            type: cleanValue(data?.type, 100),
            dataset: {
                id: cleanValue(pickLabel(dataset?.id) || data?.datasetId || data?.dataSetId, 200),
                name: cleanValue(pickLabel(dataset?.name), 500),
                category: cleanValue(pickLabel(dataset?.category) || data?.category, 200),
            },
        };
    }

    async function fetchFieldMetadata(expression) {
        const candidates = extractFieldCandidates(expression);
        const results = [];
        let cursor = 0;

        async function worker() {
            while (cursor < candidates.length) {
                const index = cursor;
                cursor += 1;
                const fieldId = candidates[index];
                try {
                    const data = await fetchBrainJson(`/data-fields/${encodeURIComponent(fieldId)}`);
                    results[index] = normalizeFieldMetadata(fieldId, data);
                } catch (_) {
                    results[index] = null;
                }
            }
        }

        const workerCount = Math.min(FIELD_FETCH_CONCURRENCY, candidates.length);
        await Promise.all(Array.from({ length: workerCount }, () => worker()));
        return results.filter(Boolean);
    }

    function findLabeledExpressionInPage(role, excludedTextareas = []) {
        const rolePattern = role === 'selection' ? /selection\s+expression/i : /combo\s+expression/i;
        const candidates = Array.from(
            document.querySelectorAll('textarea, pre, code, [class*="expression"], [class*="code"]'),
        ).filter((element) => !excludedTextareas.includes(element));
        return candidates
            .map((element) => ({
                value: cleanValue(
                    element instanceof HTMLTextAreaElement ? element.value : element.textContent,
                    12000,
                ),
                nearby: getNearbyText(element),
            }))
            .find(({ value, nearby }) => (
                value.length > 3
                && /[()=+\-*/]/.test(value)
                && rolePattern.test(nearby)
            ))?.value || '';
    }

    function getSelectedAlphaCount(alpha) {
        const candidates = [
            alpha?.selectedAlphaCount,
            alpha?.selectedAlphasCount,
            alpha?.combo?.selectedAlphaCount,
            alpha?.combo?.selectedAlphasCount,
            alpha?.selection?.count,
        ];
        const apiValue = candidates.map(Number).find(Number.isFinite);
        if (Number.isFinite(apiValue)) return apiValue;
        const pageMatch = String(document.body?.innerText || '').match(/(\d[\d,]*)\s+Alphas?\s+have\s+been\s+selected/i);
        return pageMatch ? Number(pageMatch[1].replace(/,/g, '')) : null;
    }

    async function buildAlphaContext(alphaId, targets) {
        let alpha = null;
        try {
            alpha = await fetchBrainJson(`/alphas/${encodeURIComponent(alphaId)}`);
        } catch (error) {
            if (error.status === 401 || error.status === 403) {
                throw new Error('无法读取 Alpha 信息，请确认 BRAIN 登录状态后重试。');
            }
            console.warn('[WQP Alpha AI] Alpha API unavailable, using page content.', error);
        }

        const settings = alpha?.settings && typeof alpha.settings === 'object' ? alpha.settings : {};
        if (targets.kind === 'SUPER') {
            const excluded = [targets.selection, targets.combo];
            const expressions = pickSuperExpressions(alpha);
            const selectionExpression = expressions.selectionExpression
                || findLabeledExpressionInPage('selection', excluded);
            const comboExpression = expressions.comboExpression
                || findLabeledExpressionInPage('combo', excluded);
            if (!selectionExpression || !comboExpression) {
                throw new Error('未能读取 Super Alpha 的 Selection Expression 或 Combo Expression，请等待页面加载完成后重试。');
            }
            return {
                alphaId,
                alphaType: 'SUPER',
                selectionExpression,
                comboExpression,
                settings,
                selectedAlphaCount: getSelectedAlphaCount(alpha),
                existingSelectionDescription: cleanValue(targets.selection.value, 4000),
                existingComboDescription: cleanValue(targets.combo.value, 4000),
            };
        }

        const expression = pickRegularExpression(alpha) || findExpressionInPage([targets.regular]);
        if (!expression) {
            throw new Error('未能读取 Alpha 表达式，请等待页面加载完成后重试。');
        }

        const fields = await fetchFieldMetadata(expression);
        return {
            alphaId,
            alphaType: cleanValue(alpha?.type, 100) || 'REGULAR',
            expression,
            settings,
            fields,
            existingDescription: cleanValue(targets.regular.value, 4000),
        };
    }

    function setStatus(controls, text, mode = '') {
        const status = controls.querySelector('.wqp-alpha-description-ai__status');
        if (!status) return;
        status.textContent = text || '';
        status.className = `wqp-alpha-description-ai__status${mode ? ` is-${mode}` : ''}`;
    }

    function updateButtonLabel(controls, targets) {
        const button = controls.querySelector('.wqp-alpha-description-ai__button');
        if (!button || button.disabled) return;
        if (targets.kind === 'SUPER') {
            const hasDraft = targets.selection.value.trim() || targets.combo.value.trim();
            button.textContent = hasDraft ? 'AI 重新生成两项描述' : 'AI 生成两项描述';
            return;
        }
        button.textContent = targets.regular.value.trim() ? 'AI 重新生成描述' : 'AI 生成描述';
    }

    async function handleGenerate(controls, targets) {
        const button = controls.querySelector('.wqp-alpha-description-ai__button');
        const alphaId = getAlphaId();
        if (!button || !alphaId) return;

        button.disabled = true;
        button.textContent = '正在生成…';
        setStatus(controls, '正在读取 Alpha 表达式与上下文…', 'loading');

        try {
            const context = await buildAlphaContext(alphaId, targets);
            setStatus(
                controls,
                targets.kind === 'SUPER'
                    ? '正在调用 LLM 生成 Selection 与 Combo 描述…'
                    : '正在调用 LLM 生成合规描述…',
                'loading',
            );
            const result = await sendMessage('WQP_ALPHA_AI_GENERATE_DESCRIPTION', context);
            if (targets.kind === 'SUPER') {
                if (!result?.selectionDescription || !result?.comboDescription) {
                    throw new Error('LLM 未完整返回两项 Super Alpha 描述。');
                }
                setNativeTextareaValue(targets.selection, result.selectionDescription);
                setNativeTextareaValue(targets.combo, result.comboDescription);
                const selectionCount = result.characterCounts?.selection
                    || result.selectionDescription.length;
                const comboCount = result.characterCounts?.combo
                    || result.comboDescription.length;
                setStatus(
                    controls,
                    `已填入 Selection ${selectionCount} 字符、Combo ${comboCount} 字符${result.model ? ` · ${result.model}` : ''}`,
                    'success',
                );
            } else {
                if (!result?.description) throw new Error('LLM 未返回描述。');
                setNativeTextareaValue(targets.regular, result.description);
                setStatus(
                    controls,
                    `已填入 ${result.characterCount || result.description.length} 个字符${result.model ? ` · ${result.model}` : ''}`,
                    'success',
                );
            }
        } catch (error) {
            console.error('[WQP Alpha AI] Generation failed:', error);
            setStatus(controls, error.message || String(error), 'error');
        } finally {
            button.disabled = false;
            updateButtonLabel(controls, targets);
        }
    }

    function createControls(targets) {
        const controls = document.createElement('div');
        controls.className = CONTROL_CLASS;
        controls.dataset.kind = targets.kind;
        controls.innerHTML = `
            <div class="wqp-alpha-description-ai__actions">
                <span class="wqp-alpha-description-ai__status" aria-live="polite"></span>
                <button type="button" class="wqp-alpha-description-ai__button">AI 生成描述</button>
            </div>
            <div class="wqp-alpha-description-ai__notice">
                温馨提示：AI 生成的内容可能存在偏差，仅供参考；亲自梳理并填写描述，更有助于理解 Alpha 逻辑和提升研究能力。
            </div>
        `;
        controls.querySelector('button').addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            handleGenerate(controls, targets);
        });
        const textareas = targets.kind === 'SUPER'
            ? [targets.selection, targets.combo]
            : [targets.regular];
        textareas.forEach((textarea) => {
            textarea.addEventListener('input', () => updateButtonLabel(controls, targets));
        });
        updateButtonLabel(controls, targets);
        return controls;
    }

    function ensureControls() {
        const alphaId = getAlphaId();
        if (!alphaId) {
            document.querySelectorAll(`.${CONTROL_CLASS}`).forEach((element) => element.remove());
            return;
        }

        const targets = findDescriptionTargets();
        if (!targets?.first?.parentElement) return;

        const existing = Array.from(document.querySelectorAll(`.${CONTROL_CLASS}`));
        const attached = existing.find((element) => (
            element.nextElementSibling === targets.first
            && element.dataset.kind === targets.kind
        ));
        existing.forEach((element) => {
            if (element !== attached) element.remove();
        });
        if (attached) return;

        targets.first.insertAdjacentElement('beforebegin', createControls(targets));
    }

    function scheduleControls(delay = 100) {
        clearTimeout(renderTimer);
        renderTimer = setTimeout(ensureControls, delay);
    }

    function startObserver() {
        const observer = new MutationObserver(() => scheduleControls());
        observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'href'] });
        setInterval(() => {
            if (location.href !== lastUrl) {
                lastUrl = location.href;
                observedAlphaId = getAlphaIdFromUrl(lastUrl);
                scheduleControls(250);
            }
        }, 800);
        scheduleControls(0);
    }

    window.addEventListener('message', (event) => {
        if (event.source !== window || event.data?.type !== 'WQP_PRODMEMO_ALPHA_VIEW') return;
        const alphaId = normalizeAlphaId(event.data.alphaId);
        if (!alphaId) return;
        observedAlphaId = alphaId;
        scheduleControls(0);
    });

    if (document.documentElement) startObserver();
    else document.addEventListener('DOMContentLoaded', startObserver, { once: true });
})();
