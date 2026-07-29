(function () {
    'use strict';

    if (window.__WQP_COMMUNITY_AI_ASSISTANT__) return;
    window.__WQP_COMMUNITY_AI_ASSISTANT__ = true;

    const POST_URL_PATTERN = /^https:\/\/support\.worldquantbrain\.com\/hc\/[^/]+\/community\/posts\/\d+/;
    if (!POST_URL_PATTERN.test(location.href)) return;

    const MIN_CARD_WIDTH = 300;
    const MIN_CARD_HEIGHT = 132;

    let latestSummary = null;
    let latestDraft = null;
    let latestInstruction = '';
    let card = null;

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

    function escapeHtml(value) {
        return String(value ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function inlineMarkdownHtml(value) {
        return escapeHtml(value)
            .replace(/`([^`]+)`/g, '<code>$1</code>')
            .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
            .replace(/\*([^*]+)\*/g, '<em>$1</em>');
    }

    function markdownToHtml(value) {
        const lines = String(value || '').replace(/\r\n/g, '\n').split('\n');
        const blocks = [];
        let paragraph = [];
        let listItems = [];
        let listOrdered = false;

        const flushParagraph = () => {
            if (!paragraph.length) return;
            blocks.push(`<p>${paragraph.map(inlineMarkdownHtml).join('<br>')}</p>`);
            paragraph = [];
        };
        const flushList = () => {
            if (!listItems.length) return;
            const tag = listOrdered ? 'ol' : 'ul';
            blocks.push(`<${tag}>${listItems.map((item) => `<li>${inlineMarkdownHtml(item)}</li>`).join('')}</${tag}>`);
            listItems = [];
        };

        lines.forEach((rawLine) => {
            const line = rawLine.trim();
            if (!line) {
                flushParagraph();
                flushList();
                return;
            }
            const heading = line.match(/^(#{1,4})\s+(.+)$/);
            if (heading) {
                flushParagraph();
                flushList();
                const level = Math.min(4, heading[1].length + 1);
                blocks.push(`<h${level}>${inlineMarkdownHtml(heading[2])}</h${level}>`);
                return;
            }
            const numbered = line.match(/^\d+[.)]\s+(.+)$/);
            const bulleted = line.match(/^[-*+]\s+(.+)$/);
            if (numbered || bulleted) {
                flushParagraph();
                const isOrdered = Boolean(numbered);
                if (listItems.length && listOrdered !== isOrdered) flushList();
                listOrdered = isOrdered;
                listItems.push(numbered?.[1] || bulleted?.[1] || line);
                return;
            }
            flushList();
            paragraph.push(line);
        });

        flushParagraph();
        flushList();
        return blocks.join('') || '<p class="wqp-ai-muted">No content.</p>';
    }

    function formatDateTime(value) {
        if (!value) return '';
        const date = new Date(value);
        if (Number.isNaN(date.getTime())) return String(value);
        return date.toLocaleString();
    }

    function clamp(value, min, max) {
        return Math.min(Math.max(value, min), max);
    }

    function constrainCardToViewport() {
        if (!card) return;
        const rect = card.getBoundingClientRect();
        const maxLeft = Math.max(8, window.innerWidth - Math.min(rect.width, window.innerWidth - 16) - 8);
        const maxTop = Math.max(8, window.innerHeight - Math.min(rect.height, window.innerHeight - 16) - 8);
        card.style.left = `${clamp(rect.left, 8, maxLeft)}px`;
        card.style.top = `${clamp(rect.top, 8, maxTop)}px`;
        card.style.right = 'auto';
    }

    function setCollapsed(collapsed) {
        if (!card) return;
        card.classList.toggle('is-collapsed', collapsed);
        const toggle = card.querySelector('[data-action="toggle-collapse"]');
        if (toggle) {
            toggle.textContent = collapsed ? 'Expand' : 'Collapse';
            toggle.setAttribute('aria-label', collapsed ? 'Expand AI card' : 'Collapse AI card');
        }
        if (!collapsed && !card.style.height) {
            card.style.height = '';
        }
    }

    function bindCardWindowInteractions() {
        if (!card || card.dataset.boundWindow === 'true') return;
        card.dataset.boundWindow = 'true';
        let dragState = null;

        card.addEventListener('pointerdown', (event) => {
            const handle = event.target?.closest?.('.wqp-ai-card-head');
            if (!handle || event.target.closest('button, input, textarea, select, a, summary')) return;
            const rect = card.getBoundingClientRect();
            dragState = {
                pointerId: event.pointerId,
                startX: event.clientX,
                startY: event.clientY,
                left: rect.left,
                top: rect.top,
                width: rect.width,
                height: rect.height,
            };
            card.setPointerCapture?.(event.pointerId);
            card.classList.add('is-dragging');
            event.preventDefault();
        });

        card.addEventListener('pointermove', (event) => {
            if (!dragState || event.pointerId !== dragState.pointerId) return;
            const nextLeft = dragState.left + event.clientX - dragState.startX;
            const nextTop = dragState.top + event.clientY - dragState.startY;
            const maxLeft = Math.max(8, window.innerWidth - dragState.width - 8);
            const maxTop = Math.max(8, window.innerHeight - dragState.height - 8);
            card.style.left = `${clamp(nextLeft, 8, maxLeft)}px`;
            card.style.top = `${clamp(nextTop, 8, maxTop)}px`;
            card.style.right = 'auto';
        });

        card.addEventListener('pointerup', (event) => {
            if (!dragState || event.pointerId !== dragState.pointerId) return;
            dragState = null;
            card.releasePointerCapture?.(event.pointerId);
            card.classList.remove('is-dragging');
        });

        card.addEventListener('pointercancel', () => {
            dragState = null;
            card.classList.remove('is-dragging');
        });

        window.addEventListener('resize', () => {
            constrainCardToViewport();
        });
    }

    function ensureCard() {
        if (card) return card;
        if (!document.body) return null;

        card = document.createElement('div');
        card.id = 'wqp-community-ai-prompt';
        card.innerHTML = `
            <div class="wqp-ai-card-head">
                <div class="wqp-ai-card-title-row">
                    <div class="wqp-ai-prompt-title">AI forum assistant</div>
                    <div class="wqp-ai-window-actions">
                        <span class="wqp-ai-badge">Enabled</span>
                        <button type="button" class="wqp-ai-window-button" data-action="toggle-collapse" aria-label="Collapse AI card">Collapse</button>
                    </div>
                </div>
                <div class="wqp-ai-prompt-body">Summarize this post and its comments, then draft a reply when needed.</div>
            </div>
            <div class="wqp-ai-card-content">
                <div class="wqp-ai-intro">No AI call is made until you request a summary.</div>
                <div class="wqp-ai-prompt-actions">
                    <button type="button" class="wqp-ai-primary" data-action="summarize">AI summary</button>
                </div>
                <div class="wqp-ai-prompt-status"></div>
            </div>
        `;
        card.addEventListener('click', handleCardClick);
        card.addEventListener('input', handleCardInput);
        document.body.appendChild(card);
        bindCardWindowInteractions();
        return card;
    }

    function setCardContent(html) {
        ensureCard();
        const content = card?.querySelector('.wqp-ai-card-content');
        if (content) content.innerHTML = html;
    }

    function setCardStatus(text, mode = '') {
        ensureCard();
        const status = card?.querySelector('.wqp-ai-prompt-status');
        if (!status) return;
        status.textContent = text || '';
        status.className = `wqp-ai-prompt-status${mode ? ` ${mode}` : ''}`;
    }

    function setCardLoading(text) {
        setCardContent(`
            <div class="wqp-ai-loading">${escapeHtml(text)}</div>
            <div class="wqp-ai-prompt-status loading">${escapeHtml(location.href)}</div>
        `);
    }

    function setCardError(error) {
        setCardContent(`
            <div class="wqp-ai-error">
                <strong>Action failed</strong>
                <p>${escapeHtml(error.message || String(error))}</p>
            </div>
            <div class="wqp-ai-prompt-actions">
                <button type="button" class="wqp-ai-primary" data-action="summarize">Retry summary</button>
            </div>
        `);
    }

    async function showCardIfEnabled() {
        try {
            const config = await sendMessage('WQP_LLM_CONFIG_GET');
            if (config?.enabled === true) {
                ensureCard();
                await loadCachedSummary();
            }
        } catch (error) {
            console.warn('[WQP AI] Unable to read AI settings:', error);
        }
    }

    async function loadCachedSummary() {
        try {
            const data = await sendMessage('WQP_COMMUNITY_AI_GET_CACHED_SUMMARY', { postUrl: location.href });
            if (data?.summaryMarkdown) {
                renderSummary(data);
            }
        } catch (error) {
            console.warn('[WQP AI] Unable to load cached summary:', error);
        }
    }

    function renderSummary(data) {
        latestSummary = data;
        latestDraft = null;
        const source = data.source || {};
        const commentCount = `${source.commentCount || 0}/${source.totalCommentCount || 0}`;
        const cacheTime = formatDateTime(data.cache?.savedAt || source.fetchedAt);
        const statusText = data.cached ? 'Loaded cached summary.' : 'Summary generated and saved.';
        const markdown = data.summaryMarkdown || '';
        setCardContent(`
            <div class="wqp-ai-summary-head">
                <div class="wqp-ai-source" title="${escapeHtml(source.title || 'Support post')}">${escapeHtml(source.title || 'Support post')}</div>
                <span class="wqp-ai-badge ${data.cached ? 'is-cached' : 'is-fresh'}">${data.cached ? 'Cached' : 'Generated'}</span>
            </div>
            <div class="wqp-ai-meta">
                <span>Comments ${escapeHtml(commentCount)}</span>
                ${cacheTime ? `<span>${escapeHtml(cacheTime)}</span>` : ''}
            </div>
            <div class="wqp-ai-markdown">
                ${markdownToHtml(markdown)}
            </div>
            <label class="wqp-ai-field wqp-ai-comment-box">
                <span>Comment instruction</span>
                <textarea id="wqp-ai-comment-instruction" rows="3" placeholder="Optional: tone, angle, extra constraints">${escapeHtml(latestInstruction)}</textarea>
            </label>
            <div class="wqp-ai-prompt-actions">
                <button type="button" class="wqp-ai-primary" data-action="draft">Generate comment</button>
                <button type="button" data-action="refresh-summary">Refresh summary</button>
            </div>
            <div class="wqp-ai-prompt-status success">${escapeHtml(statusText)}</div>
        `);
    }

    function renderDraft(data) {
        latestDraft = data;
        const draft = data.draft || {};
        const markdown = draft.commentMarkdown || draft.commentText || '';
        setCardContent(`
            <div class="wqp-ai-summary-head">
                <div class="wqp-ai-source" title="${escapeHtml(latestSummary?.source?.title || 'Support post')}">${escapeHtml(latestSummary?.source?.title || 'Support post')}</div>
                <span class="wqp-ai-badge">Draft</span>
            </div>
            <div class="wqp-ai-draft-preview" id="wqp-ai-comment-preview">
                <div class="wqp-ai-preview-title">Markdown preview</div>
                ${markdownToHtml(markdown)}
            </div>
            <label class="wqp-ai-field">
                <span>Editable Markdown</span>
                <textarea id="wqp-ai-comment-draft" rows="8">${escapeHtml(markdown)}</textarea>
            </label>
            <div class="wqp-ai-prompt-actions">
                <button type="button" class="wqp-ai-primary" data-action="insert">Insert draft</button>
                <button type="button" data-action="post">Post comment</button>
                <button type="button" data-action="draft">Regenerate</button>
                <button type="button" data-action="show-summary">Summary</button>
            </div>
            <div class="wqp-ai-prompt-status success">Comment draft ready.</div>
        `);
    }

    async function runSummary(forceRefresh = false) {
        try {
            setCardLoading(forceRefresh ? 'Refreshing summary with AI...' : 'Checking saved summary...');
            const data = await sendMessage('WQP_COMMUNITY_AI_SUMMARIZE_POST', {
                postUrl: location.href,
                forceRefresh,
            });
            renderSummary(data);
        } catch (error) {
            setCardError(error);
        }
    }

    async function runDraft() {
        try {
            const instructionInput = document.getElementById('wqp-ai-comment-instruction');
            const instruction = instructionInput ? instructionInput.value : latestInstruction;
            latestInstruction = instruction;
            setCardStatus('Generating comment draft...', 'loading');
            const data = await sendMessage('WQP_COMMUNITY_AI_DRAFT_COMMENT', {
                postUrl: latestSummary?.source?.postUrl || location.href,
                customInstruction: instruction,
            });
            renderDraft(data);
        } catch (error) {
            setCardStatus(error.message || String(error), 'error');
        }
    }

    function setNativeInputValue(element, value) {
        const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), 'value')?.set;
        if (setter) setter.call(element, value);
        else element.value = value;
        element.dispatchEvent(new Event('input', { bubbles: true }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
    }

    function insertDraftIntoPage() {
        const text = document.getElementById('wqp-ai-comment-draft')?.value?.trim();
        if (!text) {
            setCardStatus('No comment draft to insert.', 'error');
            return false;
        }
        const editor = document.querySelector('textarea[name="body"], textarea#comment_body, .comment-form textarea, [contenteditable="true"], .ck-editor__editable, trix-editor');
        if (!editor) {
            setCardStatus('Comment editor was not found on this page.', 'error');
            return false;
        }
        editor.scrollIntoView({ behavior: 'smooth', block: 'center' });
        editor.focus();
        if (editor.tagName === 'TEXTAREA' || editor.tagName === 'INPUT') {
            setNativeInputValue(editor, text);
        } else if (editor.tagName === 'TRIX-EDITOR' && editor.editor) {
            editor.editor.loadHTML(markdownToHtml(text));
        } else {
            editor.innerHTML = markdownToHtml(text);
            editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
        }
        setCardStatus('Draft inserted into the page editor.', 'success');
        return true;
    }

    async function postDraft() {
        const text = document.getElementById('wqp-ai-comment-draft')?.value?.trim();
        if (!text) {
            setCardStatus('No comment draft to post.', 'error');
            return;
        }
        if (!confirm(`Post this AI comment to the current Support thread?\n\n${text}`)) return;
        try {
            setCardLoading('Posting comment...');
            const data = await sendMessage('WQP_COMMUNITY_AI_POST_COMMENT', {
                postUrl: latestDraft?.source?.postUrl || location.href,
                commentText: text,
            });
            setCardContent(`
                <div class="wqp-ai-success">
                    <strong>Comment posted.</strong>
                    <p>${escapeHtml(data.comment?.url || '')}</p>
                </div>
                <div class="wqp-ai-prompt-actions">
                    <button type="button" class="wqp-ai-primary" data-action="refresh-summary">Refresh summary</button>
                </div>
            `);
        } catch (error) {
            setCardError(error);
        }
    }

    function handleCardClick(event) {
        const action = event.target?.dataset?.action;
        if (!action) return;
        if (action === 'toggle-collapse') {
            setCollapsed(!card?.classList.contains('is-collapsed'));
            return;
        }
        if (action === 'summarize') runSummary(false);
        if (action === 'refresh-summary') runSummary(true);
        if (action === 'show-summary' && latestSummary) renderSummary(latestSummary);
        if (action === 'draft') runDraft();
        if (action === 'insert') insertDraftIntoPage();
        if (action === 'post') postDraft();
    }

    function handleCardInput(event) {
        if (event.target?.id !== 'wqp-ai-comment-draft') return;
        const preview = document.getElementById('wqp-ai-comment-preview');
        if (!preview) return;
        preview.innerHTML = `
            <div class="wqp-ai-preview-title">Markdown preview</div>
            ${markdownToHtml(event.target.value)}
        `;
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', showCardIfEnabled, { once: true });
    } else {
        showCardIfEnabled();
    }
})();
