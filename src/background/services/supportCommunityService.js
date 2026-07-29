import { getLocalValue, removeLocalValue, setLocalValue } from './storageService.js';

import { getLlmConfig, runLlmText, saveLlmConfig } from './llmService.js';

const API_BASE = 'https://api.worldquantbrain.com';
const SUPPORT_BASE = 'https://support.worldquantbrain.com';
const LIKED_IDS_KEY = 'WQP_LikedIds';
const DEFAULT_MAX_PAGES = 0; // 0 means no page cap, matching voteup.js recursion.
const TEXT_REQUEST_MAX_RETRIES = 3;
const MENTION_LOOKUP_MAX_RETRIES = 10;
const ZENDESK_API_PAGE_SIZE = 100;
const ZENDESK_RATE_LIMIT_MAX_RETRIES = 6;
const ZENDESK_RATE_LIMIT_BASE_DELAY_MS = 2000;
const ZENDESK_RATE_LIMIT_MAX_DELAY_MS = 90000;
const ZENDESK_REQUEST_MIN_INTERVAL_MS = 300;
const POST_DETAIL_CONCURRENCY = 4;
const RECENT_POST_CONCURRENCY = 3;
const SECTION_CONCURRENCY = 2;
const ARTICLE_CONCURRENCY = 3;
const AI_SUMMARY_PROMPT_VERSION = 'markdown-summary-v1';

let csrfToken = null;
let supportReadyPromise = null;
let communityStateSaveQueue = Promise.resolve();
let zendeskRequestQueue = Promise.resolve();
let lastZendeskRequestAt = 0;

function progress(ctx, message, data = {}) {
    if (ctx && typeof ctx.progress === 'function') {
        ctx.progress(message, data);
    }
}

function progressBar(ctx, message, current, total, label, id = 'overall') {
    progress(ctx, message, {
        progress: {
            id,
            current,
            total,
            label,
        },
    });
}

function progressScope(payload, key, fallback) {
    const value = String(payload?.[key] || '').trim();
    return value || fallback;
}

function hasPageBudget(page, maxPages) {
    const limit = Number(maxPages || 0);
    return !Number.isFinite(limit) || limit <= 0 || page < limit;
}

function createVoteStats() {
    return {
        total: 0,
        fromCache: 0,
        liked: 0,
        skipped: 0,
        failed: 0,
        targets: 0,
    };
}

function resetVoteStats(ctx = {}) {
    ctx.voteStats = createVoteStats();
    progress(ctx, '本次已点赞 0 个 (来自缓存 0 个)', { voteStats: ctx.voteStats });
}

function updateVoteStats(ctx = {}, delta = {}) {
    if (!ctx.voteStats) ctx.voteStats = createVoteStats();
    ctx.voteStats.liked += Number(delta.liked || 0);
    ctx.voteStats.skipped += Number(delta.skipped || 0);
    ctx.voteStats.failed += Number(delta.failed || 0);
    ctx.voteStats.targets += Number(delta.targets || 0);
    ctx.voteStats.fromCache = ctx.voteStats.skipped;
    ctx.voteStats.total = ctx.voteStats.liked + ctx.voteStats.skipped;
    return { ...ctx.voteStats };
}

function progressVote(ctx, message, delta) {
    progress(ctx, message, { voteStats: updateVoteStats(ctx, delta) });
}

function maskDisplayName(name) {
    const text = String(name || '').trim();
    if (!text) return '';
    return `${text[0]}${'*'.repeat(Math.max(text.length - 1, 0))}`;
}

function withCredentials(init = {}) {
    return {
        ...init,
        credentials: 'include',
        headers: {
            ...(init.headers || {}),
        },
    };
}

function getCookies(url) {
    return new Promise((resolve, reject) => {
        chrome.cookies.getAll({ url }, (cookies) => {
            if (chrome.runtime.lastError) {
                reject(chrome.runtime.lastError);
                return;
            }
            resolve(Array.isArray(cookies) ? cookies : []);
        });
    });
}

async function hasUsableCookie(url) {
    const cookies = await getCookies(url);
    return cookies.some((cookie) => !cookie.expirationDate || cookie.expirationDate * 1000 > Date.now());
}

function parseHelpCenterUser(html) {
    const match = String(html || '').match(/HelpCenter\.user\s*=\s*({[\s\S]*?});/);
    if (!match?.[1]) return null;
    try {
        return JSON.parse(match[1]);
    } catch (_) {
        return null;
    }
}

async function validateSupportSession(ctx = {}) {
    progress(ctx, '正在验证 Support Cookie...');
    const { response, text } = await fetchText(`${SUPPORT_BASE}/hc/en-us/community/topics`, {
        method: 'GET',
        headers: {
            Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        },
    });

    if (!response.url.startsWith(SUPPORT_BASE) || response.url.includes('/access/login')) {
        progress(ctx, `Support Cookie 不可用：跳转到 ${response.url}`);
        return false;
    }

    const user = parseHelpCenterUser(text);
    if (user?.role === 'anonymous') {
        progress(ctx, 'Support Cookie 不可用：当前是匿名用户。');
        return false;
    }

    if (!user) {
        progress(ctx, 'Support 页面未暴露 HelpCenter.user，继续用 CSRF 检查。');
    } else {
        progress(ctx, `Support Cookie 可用：${user.name || user.email || user.identifier || user.role || '已登录'}`);
    }

    await getCsrfToken(ctx);
    return true;
}

async function fetchText(url, init = {}) {
    let lastError = null;
    for (let attempt = 0; attempt <= TEXT_REQUEST_MAX_RETRIES; attempt += 1) {
        try {
            const response = await fetch(url, withCredentials(init));
            const text = await response.text();
            if (response.ok) {
                return { response, text };
            }
            lastError = new Error(`HTTP ${response.status} ${response.statusText} for ${url}${text ? ` ${text.slice(0, 300)}` : ''}`);
            lastError.retryable = response.status === 429 || response.status >= 500;
            if ((response.status === 429 || response.status >= 500) && attempt < TEXT_REQUEST_MAX_RETRIES) {
                await sleep(retryDelayMs(response, attempt));
                continue;
            }
            throw lastError;
        } catch (error) {
            lastError = error;
            if (error?.retryable === false) throw error;
            if (attempt >= TEXT_REQUEST_MAX_RETRIES) break;
            await sleep(ZENDESK_RATE_LIMIT_BASE_DELAY_MS * (2 ** attempt));
        }
    }
    throw lastError;
}

async function fetchJson(url, init = {}) {
    const response = await fetch(url, withCredentials(init));
    if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText} for ${url}`);
    }
    return response.json();
}

async function fetchJsonRetry(url, init = {}, ctx = {}, options = {}) {
    const maxRetries = Number(options.maxRetries ?? ZENDESK_RATE_LIMIT_MAX_RETRIES);
    let lastError = null;
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
        await waitForZendeskRequestSlot();
        const response = await fetch(url, withCredentials(init));
        if (response.ok) {
            return response.json();
        }

        const preview = await response.text().catch(() => '');
        lastError = new Error(`HTTP ${response.status} ${response.statusText} for ${url}${preview ? ` ${preview.slice(0, 300)}` : ''}`);
        lastError.status = response.status;
        const retryable = response.status === 429 || response.status >= 500;
        if (!retryable || attempt >= maxRetries) {
            throw lastError;
        }

        const delay = retryDelayMs(response, attempt);
        progress(ctx, `请求触发 ${response.status}，等待 ${Math.ceil(delay / 1000)} 秒后重试 (${attempt + 1}/${maxRetries})：${shortApiPath(url)}`);
        await sleep(delay);
    }
    throw lastError;
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

function parseRetryAfterMs(value) {
    const raw = String(value || '').trim();
    if (!raw) return 0;
    const seconds = Number(raw);
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
    const time = Date.parse(raw);
    return Number.isNaN(time) ? 0 : Math.max(0, time - Date.now());
}

function retryDelayMs(response, attempt) {
    const retryAfter = parseRetryAfterMs(response.headers.get('Retry-After'));
    if (retryAfter > 0) return Math.min(retryAfter, ZENDESK_RATE_LIMIT_MAX_DELAY_MS);
    const exponential = ZENDESK_RATE_LIMIT_BASE_DELAY_MS * (2 ** attempt);
    const jitter = Math.floor(Math.random() * 1000);
    return Math.min(exponential + jitter, ZENDESK_RATE_LIMIT_MAX_DELAY_MS);
}

async function waitForZendeskRequestSlot() {
    const run = zendeskRequestQueue
        .catch(() => {})
        .then(async () => {
            const elapsed = Date.now() - lastZendeskRequestAt;
            if (elapsed < ZENDESK_REQUEST_MIN_INTERVAL_MS) {
                await sleep(ZENDESK_REQUEST_MIN_INTERVAL_MS - elapsed);
            }
            lastZendeskRequestAt = Date.now();
        });
    zendeskRequestQueue = run;
    return run;
}

function shortApiPath(url) {
    try {
        const parsed = new URL(url, SUPPORT_BASE);
        const params = new URLSearchParams(parsed.search);
        if (params.has('page[after]')) params.set('page[after]', '...');
        if (params.has('page[before]')) params.set('page[before]', '...');
        const query = params.toString();
        return `${parsed.pathname}${query ? `?${query}` : ''}`;
    } catch (_) {
        return String(url || '');
    }
}

function buildZendeskApiUrl(pathOrUrl, params = {}) {
    const url = new URL(pathOrUrl, SUPPORT_BASE);
    Object.entries(params || {}).forEach(([key, value]) => {
        if (value === undefined || value === null || value === '') return;
        url.searchParams.set(key, String(value));
    });
    return url.href;
}

async function fetchZendeskJson(pathOrUrl, params = {}, ctx = {}) {
    const url = buildZendeskApiUrl(pathOrUrl, params);
    for (let attempt = 0; attempt <= ZENDESK_RATE_LIMIT_MAX_RETRIES; attempt += 1) {
        await waitForZendeskRequestSlot();
        const response = await fetch(url, withCredentials({
            method: 'GET',
            headers: { Accept: 'application/json' },
        }));
        if (response.ok) {
            return response.json();
        }

        if (response.status === 429 && attempt < ZENDESK_RATE_LIMIT_MAX_RETRIES) {
            const delay = retryDelayMs(response, attempt);
            progress(ctx, `Zendesk API 触发 429 限流，等待 ${Math.ceil(delay / 1000)} 秒后重试 (${attempt + 1}/${ZENDESK_RATE_LIMIT_MAX_RETRIES})：${shortApiPath(url)}`);
            await sleep(delay);
            continue;
        }

        const preview = await response.text().catch(() => '');
        const retryAfter = response.headers.get('Retry-After');
        const retryText = retryAfter ? ` Retry-After=${retryAfter}.` : '';
        throw new Error(`HTTP ${response.status} ${response.statusText} for ${url}.${retryText}${preview ? ` ${preview.slice(0, 300)}` : ''}`);
    }
    throw new Error(`HTTP 429 Too Many Requests for ${url}`);
}

function nextZendeskPageUrl(data) {
    if (data?.meta?.has_more === false) return '';
    const next = data?.links?.next || data?.next_page || '';
    return next ? absoluteUrl(next, SUPPORT_BASE) : '';
}

async function fetchZendeskItems(pathOrUrl, itemKey, params = {}, options = {}) {
    const items = [];
    const pageSize = Number(options.pageSize || ZENDESK_API_PAGE_SIZE);
    const maxPages = Number(options.maxPages || 0);
    const ctx = options.ctx || {};
    const firstParams = { ...params };
    if (!Object.prototype.hasOwnProperty.call(firstParams, 'page[size]')) {
        firstParams['page[size]'] = pageSize;
    }
    let pageUrl = buildZendeskApiUrl(pathOrUrl, firstParams);
    let page = 0;
    while (pageUrl) {
        page += 1;
        const data = await fetchZendeskJson(pageUrl, {}, ctx);
        const pageItems = Array.isArray(data?.[itemKey]) ? data[itemKey] : [];
        items.push(...pageItems);
        if (maxPages > 0 && page >= maxPages) break;
        pageUrl = nextZendeskPageUrl(data);
    }
    return items;
}

function absoluteUrl(href, baseUrl = SUPPORT_BASE) {
    try {
        return new URL(href, baseUrl).href;
    } catch (_) {
        return '';
    }
}

function normalizeSupportUrl(url) {
    const parsed = new URL(url, SUPPORT_BASE);
    return `${parsed.origin}${parsed.pathname}`;
}

function parseProfileId(value) {
    const raw = String(value || '').trim();
    if (!raw) throw new Error('profileId is required');
    const match = raw.match(/\/profiles\/([^/?#]+)/);
    return match ? decodeURIComponent(match[1]) : raw;
}

function isSupportProfileUrl(value) {
    return /\/profiles\/[^/?#]+/.test(String(value || ''));
}

function looksLikeSupportProfileId(value) {
    return /^\d{4,}$/.test(String(value || '').trim());
}

function profileUrl(profileId) {
    return `${SUPPORT_BASE}/hc/en-us/profiles/${encodeURIComponent(profileId)}`;
}

async function queryMentionProfileId(query, ctx = {}) {
    const cleanQuery = String(query || '').trim();
    if (!cleanQuery) return null;
    const url = `${SUPPORT_BASE}/hc/api/internal/communities/mentions.json?query=${encodeURIComponent(cleanQuery)}`;
    const data = await fetchJsonRetry(url, {
        method: 'GET',
        headers: { Accept: 'application/json' },
    }, ctx, { maxRetries: MENTION_LOOKUP_MAX_RETRIES });
    if (Array.isArray(data) && data[0]?.id) {
        return String(data[0].id);
    }
    progress(ctx, `${cleanQuery}: mentions 接口未返回 profile id。`);
    return null;
}

async function resolveProfileRef(input, ctx = {}, options = {}) {
    const raw = String(input || '').trim();
    const label = String(options.label || raw).trim();
    const fallback = String(options.fallback || '').trim();
    if (!raw && !fallback) {
        throw new Error('profile input is required');
    }

    let profileId = '';
    let source = '';
    if (isSupportProfileUrl(raw) || looksLikeSupportProfileId(raw)) {
        profileId = parseProfileId(raw);
        source = isSupportProfileUrl(raw) ? 'profile-url' : 'profile-id';
    } else if (raw) {
        await ensureSupportReady({}, ctx);
        profileId = await queryMentionProfileId(raw, ctx);
        source = 'mention-query';
    }

    if (!profileId && fallback) {
        if (isSupportProfileUrl(fallback) || looksLikeSupportProfileId(fallback)) {
            profileId = parseProfileId(fallback);
            source = isSupportProfileUrl(fallback) ? 'fallback-profile-url' : 'fallback-profile-id';
        } else {
            await ensureSupportReady({}, ctx);
            profileId = await queryMentionProfileId(fallback, ctx);
            source = 'fallback-mention-query';
        }
    }

    if (!profileId) {
        throw new Error(`Unable to resolve profile id for ${label || raw || fallback}`);
    }

    const resolved = {
        input: raw || fallback,
        label: label || raw || fallback,
        profileId,
        profileUrl: profileUrl(profileId),
        source,
    };
    return resolved;
}

function getQuarterStartTime() {
    const now = new Date();
    const easternDate = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
    const year = easternDate.getUTCFullYear();
    const month = easternDate.getUTCMonth();
    const quarterStartMonth = Math.floor(month / 3) * 3;
    return new Date(Date.UTC(year, quarterStartMonth, 1, 0, 0, 0));
}

function compareProfileEntryTime(datetime, quarterStart) {
    const entryTime = new Date(datetime);
    const valid = Number.isFinite(entryTime.getTime());
    return {
        raw: datetime || '',
        valid,
        parsedIso: valid ? entryTime.toISOString() : '',
        quarterStartIso: quarterStart.toISOString(),
        inCurrentQuarter: entryTime >= quarterStart,
    };
}

function formatBeijingTime(date = new Date()) {
    return date.toLocaleString('zh-CN', {
        timeZone: 'Asia/Shanghai',
        hour12: false,
    });
}

async function getCurrentWqUserId() {
    const data = await fetchJson(`${API_BASE}/users/self/consultant/summary`, {
        method: 'GET',
        headers: { Accept: 'application/json' },
    });
    return data?.leaderboard?.user || data?.user || data?.id || '';
}

async function getBatchRunLabel(ctx = {}) {
    const beijingTime = formatBeijingTime();
    try {
        const userId = await getCurrentWqUserId();
        return `${userId || 'UNKNOWN'}: ${beijingTime}`;
    } catch (error) {
        progress(ctx, `获取当前 WQ ID 失败：${error.message}`);
        return `UNKNOWN: ${beijingTime}`;
    }
}

function findNextPageUrl(html, baseUrl) {
    const anchorRegex = /<a\b[^>]*>/gi;
    let anchorMatch;
    while ((anchorMatch = anchorRegex.exec(String(html || ''))) !== null) {
        const tag = anchorMatch[0];
        if (!tagHasClass(tag, 'pagination-next-link')) continue;
        const href = getHtmlAttribute(tag, 'href');
        if (href) return absoluteUrl(href, baseUrl);
    }

    const patterns = [
        /<a\b[^>]*class=["'][^"']*pagination-next-link[^"']*["'][^>]*href=["']([^"']+)["'][^>]*>/i,
        /<a\b[^>]*href=["']([^"']+)["'][^>]*class=["'][^"']*pagination-next-link[^"']*["'][^>]*>/i,
        /<li\b[^>]*class=["'][^"']*pagination-next[^"']*["'][\s\S]*?<a\b[^>]*href=["']([^"']+)["'][^>]*>/i,
    ];
    for (const pattern of patterns) {
        const match = html.match(pattern);
        if (match?.[1]) return absoluteUrl(decodeHtmlAttributeValue(match[1]), baseUrl);
    }
    return '';
}

function extractHtmlTitle(html) {
    const match = String(html || '').match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
    return match?.[1]?.replace(/\s+/g, ' ').trim() || '';
}

function debugProfileTargets(message, data = {}) {
    try {
        console.log(`[WQP profile targets] ${message}`, data);
    } catch (_) {
        // Ignore logging failures in extension contexts.
    }
}

function extractCommentIds(html) {
    const ids = new Set();
    const regex = /community_comment_(\d+)/g;
    let match;
    while ((match = regex.exec(html)) !== null) {
        if (match[1]) ids.add(match[1]);
    }
    return Array.from(ids);
}

function extractHref(block, predicate) {
    const regex = /<a\b[^>]*>/gi;
    let match;
    while ((match = regex.exec(block)) !== null) {
        const href = getHtmlAttribute(match[0], 'href');
        if (!predicate || predicate(href, match[0])) return href;
    }
    return '';
}

function extractFirstTimeDateTime(block) {
    const match = String(block || '').match(/<time\b[^>]*>/i);
    return match ? getHtmlAttribute(match[0], 'datetime') : '';
}

function decodeHtmlAttributeValue(value) {
    return String(value || '')
        .replace(/&amp;/gi, '&')
        .replace(/&quot;/gi, '"')
        .replace(/&#39;/gi, "'")
        .replace(/&apos;/gi, "'")
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
        .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCharCode(parseInt(code, 16)));
}

function getHtmlAttribute(tag, name) {
    const pattern = new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i');
    const match = String(tag || '').match(pattern);
    return decodeHtmlAttributeValue(match?.[2] || match?.[3] || match?.[4] || '');
}

function tagHasClass(tag, className) {
    const classValue = getHtmlAttribute(tag, 'class');
    return classValue.split(/\s+/).includes(className);
}

function findOpenTagsByClass(html, className, start = 0, end = String(html || '').length) {
    const text = String(html || '');
    const tags = [];
    const tagRegex = /<([a-z][\w:-]*)\b[^>]*>/gi;
    tagRegex.lastIndex = Math.max(0, start);

    let match;
    while ((match = tagRegex.exec(text)) !== null && match.index < end) {
        if (tagHasClass(match[0], className)) {
            tags.push({
                index: match.index,
                end: tagRegex.lastIndex,
                tagName: match[1],
                tag: match[0],
            });
        }
    }
    return tags;
}

function escapeRegExp(value) {
    return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isClosingTag(tagText) {
    return /^<\s*\//.test(String(tagText || ''));
}

function findElementRange(html, start, tagName) {
    const text = String(html || '');
    const tag = String(tagName || '').toLowerCase();
    if (!tag) return null;

    const openEnd = text.indexOf('>', start);
    if (openEnd < 0) return null;

    const tagRegex = new RegExp(`<\\/?${escapeRegExp(tag)}\\b[^>]*>`, 'gi');
    tagRegex.lastIndex = start;
    const openMatch = tagRegex.exec(text);
    if (!openMatch || openMatch.index !== start || isClosingTag(openMatch[0])) return null;

    let depth = 1;
    let match;
    while ((match = tagRegex.exec(text)) !== null) {
        if (isClosingTag(match[0])) {
            depth -= 1;
            if (depth === 0) {
                return {
                    start,
                    openEnd,
                    innerStart: openEnd + 1,
                    innerEnd: match.index,
                    end: tagRegex.lastIndex,
                    openTag: openMatch[0],
                };
            }
        } else {
            depth += 1;
        }
    }

    return null;
}

function findElementRangesByClass(html, className, start = 0, end = String(html || '').length) {
    const text = String(html || '');
    const ranges = [];
    const tagRegex = /<([a-z][\w:-]*)\b[^>]*>/gi;
    tagRegex.lastIndex = Math.max(0, start);

    let match;
    while ((match = tagRegex.exec(text)) !== null && match.index < end) {
        const openTag = match[0];
        if (!tagHasClass(openTag, className)) continue;

        const range = findElementRange(text, match.index, match[1]);
        if (!range || range.start >= end) continue;
        ranges.push(range);
        if (range.end > tagRegex.lastIndex) {
            tagRegex.lastIndex = Math.min(range.end, end);
        }
    }
    return ranges;
}

function findFirstElementRangeByClass(html, className, start, end) {
    return findElementRangesByClass(html, className, start, end)[0] || null;
}

function extractHrefFromRange(html, range, predicate) {
    if (!range) return '';
    return extractHref(String(html || '').slice(range.innerStart, range.innerEnd), predicate);
}

function findFirstDatetimeInRange(html, range) {
    if (!range) return '';
    return extractFirstTimeDateTime(String(html || '').slice(range.start, range.end));
}

function findClosestAncestorRange(html, index, tagName) {
    const text = String(html || '');
    const tag = escapeRegExp(tagName);
    const tagRegex = new RegExp(`<${tag}\\b[^>]*>`, 'gi');
    let closest = null;
    let match;
    while ((match = tagRegex.exec(text)) !== null && match.index <= index) {
        const range = findElementRange(text, match.index, tagName);
        if (range && range.start <= index && index < range.end) {
            closest = range;
        }
    }
    return closest;
}

function findParentElementRange(html, childRange) {
    if (!childRange) return null;
    const text = String(html || '');
    const tagRegex = /<([a-z][\w:-]*)\b[^>]*>/gi;
    let parent = null;
    let match;

    while ((match = tagRegex.exec(text)) !== null && match.index < childRange.start) {
        const range = findElementRange(text, match.index, match[1]);
        if (!range) continue;
        if (range.start < childRange.start && childRange.end <= range.end) {
            if (!parent || range.start > parent.start) parent = range;
        }
    }
    return parent;
}

function directChildElementRanges(html, parentRange) {
    if (!parentRange) return [];
    const text = String(html || '');
    const ranges = [];
    const tagRegex = /<([a-z][\w:-]*)\b[^>]*>/gi;
    tagRegex.lastIndex = parentRange.innerStart;

    let match;
    while ((match = tagRegex.exec(text)) !== null && match.index < parentRange.innerEnd) {
        const range = findElementRange(text, match.index, match[1]);
        if (!range) continue;
        if (range.end <= parentRange.innerEnd) {
            ranges.push(range);
            tagRegex.lastIndex = Math.max(tagRegex.lastIndex, range.end);
        }
    }
    return ranges;
}

function findProfileCommentDatetime(html, anchorIndex) {
    const commentLi = findClosestAncestorRange(html, anchorIndex, 'li');
    const parent = findParentElementRange(html, commentLi);
    const siblings = directChildElementRanges(html, parent)
        .filter((range) => range.start !== commentLi?.start || range.end !== commentLi?.end);

    for (const sibling of siblings) {
        const datetime = findFirstDatetimeInRange(html, sibling);
        if (datetime) return datetime;
    }

    return '';
}

function parseProfilePostEntries(html, baseUrl) {
    const entries = [];
    const contributionRanges = findElementRangesByClass(html, 'profile-contribution');
    for (const contribution of contributionRanges) {
        const titleRange = findFirstElementRangeByClass(
            html,
            'profile-contribution-title',
            contribution.innerStart,
            contribution.innerEnd,
        );
        const href = extractHrefFromRange(html, titleRange, (value) => value.includes('/community/posts/'));
        const url = href ? normalizeSupportUrl(absoluteUrl(href, baseUrl)) : '';
        if (!url) continue;
        entries.push({
            url,
            datetime: findFirstDatetimeInRange(html, contribution),
            datetimeSource: '.profile-contribution querySelector("time").dateTime',
        });
    }
    return entries;
}

function parseProfileCommentEntries(html, baseUrl) {
    const entries = [];
    const anchorRegex = /<a\b[^>]*>/gi;
    let match;
    while ((match = anchorRegex.exec(html)) !== null) {
        const tag = match[0];
        if (!tagHasClass(tag, 'comment-link')) continue;
        const href = getHtmlAttribute(tag, 'href');
        if (!href) continue;
        const fullUrl = absoluteUrl(href, baseUrl);
        if (!fullUrl) continue;
        const url = normalizeSupportUrl(fullUrl);
        if (!url) continue;
        entries.push({
            url,
            datetime: findProfileCommentDatetime(html, match.index),
            datetimeSource: '.comment-link closest("li") sibling querySelector("time").dateTime',
        });
    }
    return entries;
}

function createVoteSummary() {
    return {
        targets: 0,
        liked: 0,
        skipped: 0,
        failed: 0,
        profiles: [],
    };
}

function mergeSummary(target, source) {
    target.targets += source.targets || 0;
    target.liked += source.liked || 0;
    target.skipped += source.skipped || 0;
    target.failed += source.failed || 0;
    if (Array.isArray(source.profiles) && source.profiles.length) {
        target.profiles.push(...source.profiles);
    }
    return target;
}

function createCrawlSummary() {
    return {
        communities: 0,
        topics: 0,
        comments: 0,
        articles: 0,
        updated: 0,
    };
}

function mergeCrawlSummary(target, source) {
    ['communities', 'topics', 'comments', 'articles', 'updated'].forEach((key) => {
        target[key] += Number(source?.[key] || 0);
    });
    return target;
}

function extractIdFromPath(url, type) {
    try {
        const pattern = new RegExp(`/${type}/(\\d+)`);
        const match = new URL(url, SUPPORT_BASE).pathname.match(pattern);
        return match?.[1] || '';
    } catch (_) {
        return '';
    }
}

function communityTopicUrl(topicId) {
    return `${SUPPORT_BASE}/hc/en-us/community/topics/${encodeURIComponent(topicId)}`;
}

function communityPostUrl(postId) {
    return `${SUPPORT_BASE}/hc/en-us/community/posts/${encodeURIComponent(postId)}`;
}

function categoryUrl(categoryId) {
    return `${SUPPORT_BASE}/hc/en-us/categories/${encodeURIComponent(categoryId)}`;
}

function sectionUrl(sectionId) {
    return `${SUPPORT_BASE}/hc/en-us/sections/${encodeURIComponent(sectionId)}`;
}

function articleUrl(articleId) {
    return `${SUPPORT_BASE}/hc/en-us/articles/${encodeURIComponent(articleId)}`;
}

function parseApiId(value, pathType, label) {
    if (value && typeof value === 'object' && value.id != null) return String(value.id);
    const raw = String(value || '').trim();
    if (!raw) throw new Error(`${label} is required`);
    const fromPath = extractIdFromPath(raw, pathType);
    if (fromPath) return fromPath;
    if (/^\d+$/.test(raw)) return raw;
    throw new Error(`Unable to parse ${label}: ${raw}`);
}

function numberField(value, fallback = 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function authorName(item) {
    return item?.author?.name || item?.user?.name || item?.created_by?.name || '';
}

function normalizeCommunityTopic(topic = {}) {
    const id = String(topic.id || '');
    return {
        id,
        url: topic.html_url || communityTopicUrl(id),
        title: topic.name || topic.title || '',
        description: topic.description || '',
        posts: numberField(topic.post_count ?? topic.posts_count ?? topic.posts),
        followers: numberField(topic.follower_count ?? topic.followers_count ?? topic.followers),
        apiUrl: topic.url || '',
    };
}

function normalizeCommunityPost(post = {}, fallbackTopicId = '') {
    const id = String(post.id || '');
    const topicId = String(post.topic_id || fallbackTopicId || '');
    const updatedAt = post.updated_at || '';
    const createdAt = post.created_at || '';
    return {
        id,
        url: post.html_url || communityPostUrl(id),
        title: post.title || '',
        author: authorName(post) || String(post.author_id || ''),
        authorId: post.author_id || '',
        datetime: updatedAt || createdAt,
        createdAt,
        updatedAt,
        voteNum: numberField(post.vote_sum ?? post.vote_count),
        commentNum: numberField(post.comment_count ?? post.comments_count ?? (Array.isArray(post.comments) ? post.comments.length : 0)),
        topicId,
        postContent: post.details || post.body || post.content || '',
        status: post.status || '',
        apiUrl: post.url || '',
    };
}

function normalizePostComment(comment = {}, postId = '') {
    const id = String(comment.id || '');
    const resolvedPostId = String(comment.post_id || comment.post?.id || postId || '');
    const updatedAt = comment.updated_at || '';
    const createdAt = comment.created_at || '';
    return {
        id,
        postId: resolvedPostId,
        url: comment.html_url || (resolvedPostId ? `${communityPostUrl(resolvedPostId)}/comments/${encodeURIComponent(id)}` : ''),
        author: authorName(comment) || String(comment.author_id || ''),
        authorId: comment.author_id || '',
        commentTimeDatetime: updatedAt || createdAt,
        createdAt,
        updatedAt,
        commentContent: comment.body || comment.details || comment.content || '',
        voteNum: numberField(comment.vote_sum ?? comment.vote_count),
        apiUrl: comment.url || '',
    };
}

function normalizeCategory(category = {}) {
    const id = String(category.id || '');
    return {
        id,
        url: category.html_url || categoryUrl(id),
        title: category.name || category.title || '',
        description: category.description || '',
        apiUrl: category.url || '',
    };
}

function normalizeSection(section = {}, fallbackCategoryId = '') {
    const id = String(section.id || '');
    return {
        id,
        url: section.html_url || sectionUrl(id),
        title: section.name || section.title || '',
        categoryId: String(section.category_id || fallbackCategoryId || ''),
        parentSectionId: section.parent_section_id ? String(section.parent_section_id) : '',
        description: section.description || '',
        apiUrl: section.url || '',
    };
}

function normalizeArticle(article = {}) {
    const id = String(article.id || '');
    const updatedAt = article.updated_at || '';
    const createdAt = article.created_at || '';
    return {
        id,
        url: article.html_url || articleUrl(id),
        title: article.title || article.name || '',
        author: authorName(article) || String(article.author_id || ''),
        authorId: article.author_id || '',
        datetime: updatedAt || createdAt,
        createdAt,
        updatedAt,
        sectionId: article.section_id ? String(article.section_id) : '',
        categoryId: article.category_id ? String(article.category_id) : '',
        voteNum: numberField(article.vote_sum ?? article.vote_count),
        commentNum: numberField(article.comment_count ?? article.comments_count),
        articleContent: article.body || article.details || article.content || '',
        apiUrl: article.url || '',
        lastCrawledAt: new Date().toISOString(),
    };
}

function commentsCount(map) {
    return map && typeof map === 'object' ? Object.keys(map).length : 0;
}

function postCommentsAreCurrent(existing, topic) {
    if (!existing || !topic) return false;
    const existingComments = existing.comments && typeof existing.comments === 'object' ? existing.comments : {};
    const expectedCommentCount = Number(topic.commentNum || 0);
    const storedCommentCount = commentsCount(existingComments);
    return storedCommentCount === expectedCommentCount;
}

async function runWithConcurrency(tasks, limit) {
    const results = new Array(tasks.length);
    let index = 0;
    const workers = new Array(Math.min(Math.max(limit || 1, 1), tasks.length || 1)).fill(0).map(async () => {
        while (index < tasks.length) {
            const current = index;
            index += 1;
            try {
                results[current] = await tasks[current]();
            } catch (error) {
                results[current] = { error };
            }
        }
    });
    await Promise.all(workers);
    return results;
}

async function getCommunityState() {
    const state = await getLocalValue('WQP_CommunityState');
    return state && typeof state === 'object' ? state : {};
}

async function saveCommunityStatePatch(patch) {
    const run = communityStateSaveQueue
        .catch(() => {})
        .then(async () => {
            const current = await getCommunityState();
            await setLocalValue('WQP_CommunityState', { ...current, ...patch });
        });
    communityStateSaveQueue = run;
    return run;
}

async function fetchPostComments(postRef, ctx = {}) {
    const postId = parseApiId(postRef, 'posts', 'postId');
    const postHint = postRef && typeof postRef === 'object'
        ? normalizeCommunityPost(postRef, postRef.topicId)
        : null;
    const commentItems = await fetchZendeskItems(`/api/v2/community/posts/${encodeURIComponent(postId)}/comments.json`, 'comments', {}, { ctx });
    const post = postHint || normalizeCommunityPost({ id: postId });
    const comments = {};
    commentItems.forEach((comment) => {
        const item = normalizePostComment(comment, postId);
        if (item.id) comments[item.id] = item;
    });
    return {
        postContent: post.postContent || postHint?.postContent || '',
        post,
        comments,
    };
}

function decodeBasicHtmlEntities(text) {
    return String(text || '')
        .replace(/&nbsp;/gi, ' ')
        .replace(/&amp;/gi, '&')
        .replace(/&quot;/gi, '"')
        .replace(/&#39;/gi, "'")
        .replace(/&apos;/gi, "'")
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
        .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCharCode(parseInt(code, 16)));
}

function htmlToText(html) {
    return decodeBasicHtmlEntities(String(html || '')
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/p>/gi, '\n')
        .replace(/<\/li>/gi, '\n')
        .replace(/<[^>]+>/g, ' ')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .replace(/[ \t]{2,}/g, ' ')
        .trim());
}

function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function plainTextToHtml(value) {
    const paragraphs = String(value || '')
        .split(/\n{2,}/)
        .map((part) => part.trim())
        .filter(Boolean);
    if (!paragraphs.length) return '';
    return paragraphs.map((paragraph) => `<p>${escapeHtml(paragraph).replace(/\n/g, '<br>')}</p>`).join('');
}

function inlineMarkdownToHtml(value) {
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
        blocks.push(`<p>${paragraph.map(inlineMarkdownToHtml).join('<br>')}</p>`);
        paragraph = [];
    };
    const flushList = () => {
        if (!listItems.length) return;
        const tag = listOrdered ? 'ol' : 'ul';
        blocks.push(`<${tag}>${listItems.map((item) => `<li>${inlineMarkdownToHtml(item)}</li>`).join('')}</${tag}>`);
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
            blocks.push(`<h${level}>${inlineMarkdownToHtml(heading[2])}</h${level}>`);
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
    return blocks.join('') || plainTextToHtml(value);
}

function hashText(value) {
    const text = String(value || '');
    let hash = 2166136261;
    for (let index = 0; index < text.length; index += 1) {
        hash ^= text.charCodeAt(index);
        hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
}

function buildCommunityAiContextHash(context) {
    return hashText([
        context.post.id,
        context.post.title || '',
        context.post.text || '',
        context.source.totalCommentCount,
        ...context.comments.map((comment) => [
            comment.id,
            comment.text || '',
        ].join(':')),
    ].join('\n'));
}

async function fetchCommunityPostDetail(postRef, ctx = {}) {
    const postId = parseApiId(postRef, 'posts', 'postId');
    const data = await fetchZendeskJson(`/api/v2/community/posts/${encodeURIComponent(postId)}.json`, {}, ctx);
    return normalizeCommunityPost(data?.post || { id: postId });
}

async function buildCommunityAiContext(payload = {}, ctx = {}) {
    const postRef = payload.postUrl || payload.postId;
    if (!postRef) throw new Error('postUrl or postId is required');
    await ensureSupportReady(payload, ctx);

    const post = await fetchCommunityPostDetail(postRef, ctx);
    const detail = await fetchPostComments(post, ctx);
    const mergedPost = {
        ...post,
        postContent: post.postContent || detail.postContent || '',
    };
    const comments = Object.values(detail.comments || {})
        .sort((a, b) => {
            const voteDiff = Number(b.voteNum || 0) - Number(a.voteNum || 0);
            if (voteDiff !== 0) return voteDiff;
            return String(a.commentTimeDatetime || '').localeCompare(String(b.commentTimeDatetime || ''));
        })
        .map((comment) => ({
            id: comment.id,
            author: comment.author,
            createdAt: comment.createdAt || comment.commentTimeDatetime,
            voteNum: comment.voteNum,
            text: htmlToText(comment.commentContent),
        }));

    const source = {
        postId: mergedPost.id,
        postUrl: mergedPost.url || communityPostUrl(mergedPost.id),
        title: mergedPost.title,
        commentCount: comments.length,
        totalCommentCount: commentsCount(detail.comments),
        fetchedAt: new Date().toISOString(),
    };
    return {
        source,
        post: {
            id: mergedPost.id,
            title: mergedPost.title,
            author: mergedPost.author,
            createdAt: mergedPost.createdAt || mergedPost.datetime,
            updatedAt: mergedPost.updatedAt,
            voteNum: mergedPost.voteNum,
            text: htmlToText(mergedPost.postContent),
        },
        comments,
    };
}

function buildAiContextText(context) {
    const commentsText = context.comments.map((comment, index) => [
        `Comment ${index + 1} id=${comment.id} author=${comment.author || '-'} votes=${comment.voteNum || 0} created=${comment.createdAt || '-'}`,
        comment.text || '',
    ].join('\n')).join('\n\n');
    return [
        `Post id: ${context.post.id}`,
        `Title: ${context.post.title}`,
        `Author: ${context.post.author || '-'}`,
        `Created: ${context.post.createdAt || '-'}`,
        '',
        'Post body:',
        context.post.text || '(empty)',
        '',
        `Comments included: ${context.comments.length}/${context.source.totalCommentCount}`,
        commentsText || '(no comments)',
    ].join('\n');
}

async function saveCommunityAiPatch(postId, patch) {
    const state = await getCommunityState();
    const aiByPost = state.aiByPost && typeof state.aiByPost === 'object' ? state.aiByPost : {};
    aiByPost[postId] = {
        ...(aiByPost[postId] || {}),
        ...patch,
        updatedAt: new Date().toISOString(),
    };
    await saveCommunityStatePatch({ aiByPost });
}

export async function getCachedCommunityAiSummary(payload = {}) {
    const postRef = payload.postUrl || payload.postId;
    if (!postRef) throw new Error('postUrl or postId is required');
    const postId = parseApiId(postRef, 'posts', 'postId');
    const state = await getCommunityState();
    const cachedSummary = state.aiByPost?.[postId]?.summary;
    if (!cachedSummary) return null;
    if (!cachedSummary.summaryMarkdown || cachedSummary.cache?.promptVersion !== AI_SUMMARY_PROMPT_VERSION) return null;
    return {
        ...cachedSummary,
        cached: true,
        cacheUnchecked: true,
    };
}

export async function summarizeCommunityPostWithAi(payload = {}, ctx = {}) {
    progress(ctx, 'Fetching post and comments for AI summary...');
    const context = await buildCommunityAiContext(payload, ctx);
    const contextHash = buildCommunityAiContextHash(context);
    const llmConfig = await getLlmConfig();
    const state = await getCommunityState();
    const cachedSummary = state.aiByPost?.[context.source.postId]?.summary;
    if (payload.forceRefresh !== true
        && cachedSummary?.cache?.contextHash === contextHash
        && cachedSummary?.cache?.model === llmConfig.model
        && cachedSummary?.cache?.baseUrl === llmConfig.baseUrl
        && cachedSummary?.cache?.promptVersion === AI_SUMMARY_PROMPT_VERSION
        && cachedSummary?.summaryMarkdown) {
        progress(ctx, `Using cached AI summary for ${context.source.postId}.`);
        return {
            ...cachedSummary,
            cached: true,
        };
    }

    progress(ctx, `Summarizing ${context.comments.length}/${context.source.totalCommentCount} comments with AI...`);

    const { text, usage, model } = await runLlmText({
        taskName: 'community summary',
        systemPrompt: [
            '你是一名专业的技术社区讨论总结师，擅长从帖子正文和长评论串中提炼结构化结论。',
            '',
            '你的任务是帮助读者快速理解：',
            '1. 楼主在问什么；',
            '2. 评论区提供了哪些有效信息；',
            '3. 哪些内容已经形成共识或存在分歧；',
            '4. 哪些问题仍缺少信息或尚未解决；',
            '5. 后续回复可以从哪些已有信息切入。',
            '',
            '严格规则：',
            '- 只能使用用户提供的帖子正文和评论内容。',
            '- 不得引入外部事实、平台规则、个人经验、模型常识或上下文中未出现的指标。',
            '- 不得编造事实、排名、alpha 表现、提交记录、官方政策、用户身份或操作结果。',
            '- 必须区分事实、观点、建议和未验证内容。',
            '- 没有上下文支撑的内容，不得写成结论，只能放入“仍未解决的问题”或“风险提醒”。',
            '- 如果原文或评论中本身存在猜测，可以说明“评论中有人猜测/提到”，但不得将其当作事实。',
            '',
            '输出要求：',
            '- 直接返回 Markdown 正文。',
            '- 不添加“以下是总结”等前言。',
            '- 使用简体中文。',
            '- 表达要具体、克制、可扫描，避免空泛套话和重复内容。',
        ].join('\n'),

        userPrompt: [
            '请基于下面提供的帖子正文和评论串，输出一份专业讨论总结。',
            '',
            '请使用以下 Markdown 结构：',
            '',
            '## 核心问题',
            '- 概括楼主提出的问题。',
            '- 补充楼主给出的背景、条件、约束或已尝试内容。',
            '- 不要扩展原文没有提到的背景。',
            '',
            '## 评论区要点',
            '- 总结评论区已经提供的有效信息。',
            '- 区分共识、分歧、补充条件、操作建议和经验反馈。',
            '- 如果某条评论只是猜测或未被确认，需要明确其不确定性。',
            '',
            '## 仍未解决的问题',
            '- 列出当前上下文仍缺少的信息。',
            '- 列出评论中没有确认、没有结论或需要楼主进一步补充的点。',
            '- 不要把推测写成已解决。',
            '',
            '## 可回复角度',
            '- 只基于已有帖子和评论，给出后续回复可以切入的方向。',
            '- 可以包括：补充信息、澄清条件、回应评论分歧、追问关键变量、整理已有结论。',
            '- 不要生成脱离上下文的新建议。',
            '',
            '## 风险提醒',
            '- 标出上下文不足导致的潜在误读。',
            '- 标出未验证猜测、指标解释风险、政策/官方口径风险。',
            '- 如果没有明显风险，写“暂无明显风险，但仍应避免超出原文推断。”',
            '',
            '整体要求：',
            '- 分段分条，重点明确。',
            '- 每条尽量具体，不写泛泛而谈的空话。',
            '- 不要重复同一信息。',
            '- 不要输出原文复述式长摘要。',
            '- 不要把没有证据的猜测写成事实。',
            '',
            buildAiContextText(context),
        ].join('\n'),
    });

    const data = {
        source: context.source,
        summaryMarkdown: text,
        usage,
        model,
        cached: false,
        cache: {
            contextHash,
            baseUrl: llmConfig.baseUrl,
            model: llmConfig.model,
            promptVersion: AI_SUMMARY_PROMPT_VERSION,
            savedAt: new Date().toISOString(),
        },
    };
    await saveCommunityAiPatch(context.source.postId, { summary: data });
    return data;
}

export async function draftCommunityPostCommentWithAi(payload = {}, ctx = {}) {
    progress(ctx, 'Fetching post and comments for AI comment draft...');
    const context = await buildCommunityAiContext(payload, ctx);
    const customInstruction = String(payload.customInstruction || '').trim();

    progress(ctx, 'Drafting AI comment...');
    const { text, usage, model } = await runLlmText({
        taskName: 'community comment draft',
        systemPrompt: [
            '你是一名专业的技术社区回复顾问，擅长根据帖子正文和评论上下文，起草克制、清晰、有帮助的中文社区评论。',
            '',
            '你的目标是参与讨论、补充信息、提出澄清问题或整理已有观点，而不是替官方下结论。',
            '',
            '信息边界：',
            '- 只能使用用户提供的帖子正文、评论内容和用户额外指令。',
            '- 用户额外指令只代表写作偏好、语气要求或回复方向，不自动构成事实依据。',
            '- 不得引入外部事实、平台规则、官方政策、个人经历、模型常识或上下文中不存在的数据。',
            '- 不得声称自己代表官方、管理员、平台、规则解释者或有内部信息。',
            '- 不得编造个人 alpha 数据、排名、提交数量、Sharpe、Fitness、VF、回测结果、审核状态或任何未出现的指标。',
            '',
            '证据规则：',
            '- 帖子或评论中明确出现的信息，可以作为回复依据。',
            '- 评论区中的观点、经验或猜测，只能按“评论中提到/有人建议/可以先确认”的方式表达，不得写成事实。',
            '- 上下文证据不足时，优先提出澄清问题、检查方向或谨慎补充，不要强行给结论。',
            '- 不要使用“研究表明”“通常来说”“官方应该”“一定是”等缺乏上下文支撑的表达。',
            '- 避免使用“可能”“应该会”“大概”“我觉得”等无依据表达；需要表达不确定性时，用“从目前信息看”“建议先确认”“还需要补充”这类克制表述。',
            '',
            '回复风格：',
            '- 回复要像真实社区评论，简洁、自然、有针对性。',
            '- 第一段必须承接楼主的具体问题，不要泛泛开场。',
            '- 后续内容如有依据，给出 1-3 条具体细节、检查方向、补充问题或可执行建议。',
            '- 多个要点使用编号列表或短横线列表；每条只表达一个重点。',
            '- 避免空泛附和、过度寒暄、泛泛夸赞、免责声明、套话和填充内容。',
            '- 不要写成长篇总结，不要复述整段帖子。',
            '',
            '输出要求：',
            '- 直接返回可发布的 Markdown 评论正文。',
            '- 不附加 reason、riskFlags、解释文字、标题或前言。',
            '- 使用简体中文。',
        ].join('\n'),

        userPrompt: [
            '请基于下面的帖子正文和评论串，起草一条适合直接发布的社区评论。',
            '',
            '写作要求：',
            '- 先承接楼主的具体问题。',
            '- 再基于已有上下文给出具体回复。',
            '- 如果依据不足，只提出澄清问题、检查方向或谨慎补充。',
            '- 如果包含多个细节，请使用 1. 2. 3. 或 - 列表。',
            '- 控制篇幅，避免写成总结报告。',
            '',
            customInstruction
                ? `用户额外指令：${customInstruction}\n注意：该指令只影响回复角度、语气或篇幅，不得作为事实依据。`
                : '',
            '',
            buildAiContextText(context),
        ].join('\n'),
    });

    const commentMarkdown = String(text || '').trim();
    const data = {
        source: context.source,
        draft: {
            commentMarkdown,
            commentText: commentMarkdown,
            commentHtml: markdownToHtml(commentMarkdown),
        },
        usage,
        model,
    };
    await saveCommunityAiPatch(context.source.postId, { draft: data });
    return data;
}

export async function createCommunityPostComment(payload = {}, ctx = {}) {
    const postRef = payload.postUrl || payload.postId;
    if (!postRef) throw new Error('postUrl or postId is required');
    const postId = parseApiId(postRef, 'posts', 'postId');
    const body = String(payload.commentHtml || markdownToHtml(payload.commentText || '')).trim();
    if (!body) throw new Error('comment body is required');

    await ensureSupportReady(payload, ctx);
    const token = await getCsrfToken(ctx);
    progress(ctx, `Posting comment to ${postId}...`);
    const response = await fetch(`${SUPPORT_BASE}/api/v2/community/posts/${encodeURIComponent(postId)}/comments.json`, withCredentials({
        method: 'POST',
        headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
            'X-CSRF-Token': token,
            'X-Requested-With': 'XMLHttpRequest',
        },
        body: JSON.stringify({
            comment: {
                body,
            },
        }),
    }));
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
        const detail = data?.error || data?.description || data?.message || response.statusText;
        throw new Error(`Comment post failed (${response.status}): ${detail}`);
    }

    const comment = normalizePostComment(data?.comment || data, postId);
    await saveCommunityAiPatch(postId, {
        lastPostedComment: {
            comment,
            body,
            postedAt: new Date().toISOString(),
        },
    });
    return {
        postId,
        comment,
        response: data,
    };
}

async function getLikedIds() {
    const ids = await getLocalValue(LIKED_IDS_KEY);
    return Array.isArray(ids) ? ids : [];
}

async function saveLikedId(url) {
    const ids = await getLikedIds();
    if (!ids.includes(url)) {
        ids.push(url);
        await setLocalValue(LIKED_IDS_KEY, ids);
    }
}

export async function clearLikedIds() {
    await removeLocalValue(LIKED_IDS_KEY);
    return createVoteSummary();
}

export async function authenticateSupport(payload = {}, ctx = {}) {
    const hasSupportCookie = await hasUsableCookie(SUPPORT_BASE);
    if (hasSupportCookie) {
        csrfToken = null;
        try {
            const supportSessionValid = await validateSupportSession(ctx);
            if (supportSessionValid) {
                return {
                    targets: 1,
                    liked: 0,
                    skipped: 0,
                    failed: 0,
                    status: 200,
                    finalUrl: SUPPORT_BASE,
                    authMode: 'support-cookie',
                };
            }
        } catch (error) {
            progress(ctx, `Support Cookie 验证失败，继续尝试 WQ 链式登录：${error.message}`);
            csrfToken = null;
        }
    }

    const hasWqCookie = await hasUsableCookie(API_BASE);
    if (hasWqCookie) {
        progress(ctx, '检测到 WQ API Cookie，尝试链式换取 Support 登录态。');
    } else {
        throw new Error('未检测到 Support Cookie 或 WQ API Cookie。请先在浏览器登录 WorldQuant BRAIN 或 Support。');
    }

    progress(ctx, '正在连接 Support 会话...');
    const returnTo = encodeURIComponent(`${SUPPORT_BASE}/hc/en-us/community/topics`);
    const response = await fetch(`${API_BASE}/authentication/support?return_to=${returnTo}`, withCredentials({
        method: 'GET',
        redirect: 'follow',
        headers: {
            Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        },
    }));
    const text = await response.text();
    csrfToken = null;
    const connected = response.url.startsWith(SUPPORT_BASE) || text.includes('HelpCenter') || text.includes('/hc/en-us/community');
    const user = parseHelpCenterUser(text);

    progress(ctx, `Support 连接返回：${response.status}`);
    if (!response.ok || !connected || user?.role === 'anonymous') {
        throw new Error(`Support 登录态不可用：HTTP ${response.status}, finalUrl=${response.url}`);
    }
    await getCsrfToken(ctx);

    return {
        targets: 1,
        liked: 0,
        skipped: 0,
        failed: 0,
        status: response.status,
        finalUrl: response.url,
        authMode: 'wq-cookie-chain',
        htmlPreview: text.slice(0, 300),
    };
}

async function getCsrfToken(ctx = {}) {
    if (csrfToken) return csrfToken;
    progress(ctx, '正在获取 Support CSRF token...');
    const data = await fetchZendeskJson('/api/v2/help_center/sessions.json', {}, ctx);
    csrfToken = data?.current_session?.csrf_token;
    if (!csrfToken) {
        throw new Error('Unable to get Support CSRF token');
    }
    return csrfToken;
}

async function ensureSupportReady(payload = {}, ctx = {}) {
    if (!supportReadyPromise) {
        supportReadyPromise = (async () => {
            try {
                await getCsrfToken(ctx);
            } catch (_) {
                await authenticateSupport(payload, ctx);
                await getCsrfToken(ctx);
            }
        })();
    }
    try {
        await supportReadyPromise;
    } finally {
        supportReadyPromise = null;
    }
}

async function upVoteUrl(rawUrl, payload = {}, ctx = {}) {
    const summary = createVoteSummary();
    const url = normalizeSupportUrl(rawUrl);
    summary.targets = 1;

    const likedIds = await getLikedIds();
    if (likedIds.includes(url)) {
        summary.skipped = 1;
        progressVote(ctx, `跳过已点赞：${url}`, summary);
        return summary;
    }

    await ensureSupportReady(payload, ctx);
    try {
        const response = await fetch(`${url}/vote`, withCredentials({
            method: 'POST',
            headers: {
                Accept: 'application/json, text/javascript, */*; q=0.01',
                'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
                'X-CSRF-Token': csrfToken,
                'X-Requested-With': 'XMLHttpRequest',
            },
            body: 'value=up',
        }));
        const data = await response.json().catch(() => ({}));
        if (response.ok && data?.value === 'up') {
            await saveLikedId(url);
            summary.liked = 1;
            progressVote(ctx, `点赞成功：${url}`, summary);
        } else {
            summary.failed = 1;
            progressVote(ctx, `点赞失败：${url} (${response.status})`, summary);
        }
    } catch (error) {
        summary.failed = 1;
        progressVote(ctx, `点赞失败：${url} (${error.message})`, summary);
    }
    return summary;
}

async function collectPostVoteTargets(postUrl, ctx = {}, maxPages = DEFAULT_MAX_PAGES) {
    const basePostUrl = normalizeSupportUrl(postUrl);
    const targets = new Set([basePostUrl]);
    const visited = new Set();
    let pageUrl = basePostUrl;
    let page = 0;

    while (pageUrl && hasPageBudget(page, maxPages) && !visited.has(pageUrl)) {
        page += 1;
        visited.add(pageUrl);
        progress(ctx, `抓取帖子评论页 ${page}: ${pageUrl}`);
        const { text } = await fetchText(pageUrl, {
            method: 'GET',
            headers: {
                Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            },
        });
        for (const commentId of extractCommentIds(text)) {
            targets.add(`${basePostUrl}/comments/${commentId}`);
        }
        pageUrl = findNextPageUrl(text, pageUrl);
    }

    return Array.from(targets);
}

export async function upVotePost(payload = {}, ctx = {}) {
    if (!payload.postUrl) throw new Error('postUrl is required');
    await ensureSupportReady(payload, ctx);
    const targets = await collectPostVoteTargets(payload.postUrl, ctx, payload.maxPages || DEFAULT_MAX_PAGES);
    progress(ctx, `共发现 ${targets.length} 个点赞目标。`);
    const summary = createVoteSummary();
    for (const target of targets) {
        mergeSummary(summary, await upVoteUrl(target, payload, ctx));
    }
    return summary;
}

async function collectProfileTargets(profileIdValue, kind, ctx = {}, maxPages = DEFAULT_MAX_PAGES) {
    const profileId = parseProfileId(profileIdValue);
    const quarterStart = getQuarterStartTime();
    const filter = kind === 'comments' ? 'comments' : 'posts';
    const startUrl = `${SUPPORT_BASE}/hc/en-us/profiles/${encodeURIComponent(profileId)}?sort_by=recent_user_activity&filter_by=${filter}`;
    const targets = [];
    const visited = new Set();
    let pageUrl = startUrl;
    let page = 0;
    let reachedOldEntries = false;

    while (pageUrl && hasPageBudget(page, maxPages) && !visited.has(pageUrl) && !reachedOldEntries) {
        page += 1;
        visited.add(pageUrl);
        progress(ctx, `抓取用户 ${profileId} ${filter} 第 ${page} 页`);
        const { response, text } = await fetchText(pageUrl, {
            method: 'GET',
            headers: {
                Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            },
        });
        debugProfileTargets('fetched profile page', {
            profileId,
            filter,
            page,
            requestUrl: pageUrl,
            finalUrl: response?.url || '',
            status: response?.status,
            htmlLength: String(text || '').length,
            title: extractHtmlTitle(text),
            profileContributionCount: findOpenTagsByClass(text, 'profile-contribution').length,
            profileContributionTitleCount: findOpenTagsByClass(text, 'profile-contribution-title').length,
            commentLinkCount: findOpenTagsByClass(text, 'comment-link').length,
            hasNextPage: Boolean(findNextPageUrl(text, pageUrl)),
            quarterStart: quarterStart.toISOString(),
        });
        const entries = kind === 'comments'
            ? parseProfileCommentEntries(text, pageUrl)
            : parseProfilePostEntries(text, pageUrl);
        debugProfileTargets('parsed profile targets', {
            profileId,
            filter,
            page,
            entries: entries.length,
            samples: entries.slice(0, 5).map((entry) => ({
                url: entry.url,
                datetime: entry.datetime,
                datetimeSource: entry.datetimeSource,
                timeCompare: compareProfileEntryTime(entry.datetime, quarterStart),
            })),
        });
        progress(ctx, `用户 ${profileId} ${filter} 第 ${page} 页解析到 ${entries.length} 个目标`);

        for (let index = 0; index < entries.length; index += 1) {
            const entry = entries[index];
            const timeCompare = compareProfileEntryTime(entry.datetime, quarterStart);
            if (!timeCompare.inCurrentQuarter) {
                reachedOldEntries = true;
                debugProfileTargets('stop collecting profile targets', {
                    profileId,
                    filter,
                    page,
                    entryIndex: index,
                    reason: timeCompare.valid ? 'before-quarter-start' : 'invalid-datetime',
                    entry,
                    timeCompare,
                    collectedTargets: targets.length,
                });
                break;
            }
            if (entry.url) targets.push(entry.url);
        }
        pageUrl = findNextPageUrl(text, pageUrl);
        debugProfileTargets('profile page done', {
            profileId,
            filter,
            page,
            collectedTargets: targets.length,
            nextPageUrl: pageUrl,
            reachedOldEntries,
        });
    }

    debugProfileTargets('profile target collection done', {
        profileId,
        filter,
        pages: page,
        targets: targets.length,
        maxPages,
    });
    return targets;
}

export async function upVoteUser(payload = {}, ctx = {}) {
    const profileInput = payload.profileId || payload.profileInput;
    if (!profileInput) throw new Error('profileId is required');
    await ensureSupportReady(payload, ctx);
    const resolvedProfile = await resolveProfileRef(profileInput, ctx);
    const profileId = resolvedProfile.profileId;
    const postTargets = await collectProfileTargets(profileId, 'posts', ctx, payload.maxPages || DEFAULT_MAX_PAGES);
    const commentTargets = await collectProfileTargets(profileId, 'comments', ctx, payload.maxPages || DEFAULT_MAX_PAGES);
    const targets = Array.from(new Set([...postTargets, ...commentTargets]));
    progress(ctx, `用户 ${profileId} 本季度共发现 ${targets.length} 个点赞目标。`);

    const summary = createVoteSummary();
    summary.profiles.push(resolvedProfile);
    for (const target of targets) {
        mergeSummary(summary, await upVoteUrl(target, payload, ctx));
    }
    return summary;
}

export async function resolveProfileOnly(payload = {}, ctx = {}) {
    const input = payload.profileId || payload.profileInput || payload.input;
    const resolvedProfile = await resolveProfileRef(input, ctx, {
        label: payload.label,
        fallback: payload.fallback,
    });
    return {
        targets: 0,
        liked: 0,
        skipped: 0,
        failed: 0,
        profiles: [resolvedProfile],
    };
}

export async function upVoteUsers(payload = {}, ctx = {}) {
    const users = payload.users;
    if (!users || typeof users !== 'object') {
        throw new Error('users must be a JSON object or array');
    }

    const entries = Array.isArray(users)
        ? users.map((item) => [String(item), ''])
        : Object.entries(users);
    if (!entries.length) {
        throw new Error('users is empty');
    }
    const summary = createVoteSummary();
    summary.batchUserResults = [];
    summary.batchRunLabel = await getBatchRunLabel(ctx);
    progress(ctx, summary.batchRunLabel, { batchRunLabel: summary.batchRunLabel });

    const totalUsers = entries.length;
    const batchProgressId = 'batch-users';
    const updateBatchUserProgress = (completed, message = '') => {
        const done = Math.min(Math.max(Number(completed) || 0, 0), totalUsers);
        const remaining = Math.max(totalUsers - done, 0);
        const label = `批量点赞用户：已完成 ${done}/${totalUsers}，剩余 ${remaining}`;
        progressBar(ctx, message || label, done, totalUsers, label, batchProgressId);
    };
    updateBatchUserProgress(0);

    for (let index = 0; index < entries.length; index += 1) {
        const [name, profileValue] = entries[index];
        updateBatchUserProgress(index, `正在点赞用户 ${index + 1}/${totalUsers}：${name}（已完成 ${index}/${totalUsers}，剩余 ${totalUsers - index}）`);
        try {
            const resolvedProfile = await resolveProfileRef(name, ctx, {
                label: name,
                fallback: profileValue,
            });
            const userSummary = await upVoteUser({ ...payload, profileId: resolvedProfile.profileId }, ctx);
            userSummary.profiles = [
                resolvedProfile,
                ...userSummary.profiles.filter((item) => item.profileId !== resolvedProfile.profileId),
            ];
            mergeSummary(summary, userSummary);
            const batchUserResult = {
                name,
                maskedName: maskDisplayName(name),
                profileId: resolvedProfile.profileId,
                profileUrl: resolvedProfile.profileUrl,
                total: Number(userSummary.liked || 0) + Number(userSummary.skipped || 0),
                liked: Number(userSummary.liked || 0),
                skipped: Number(userSummary.skipped || 0),
                failed: Number(userSummary.failed || 0),
                index: index + 1,
                count: totalUsers,
            };
            summary.batchUserResults.push(batchUserResult);
            progress(ctx, `${batchUserResult.maskedName || name}: ${batchUserResult.total}`, { batchUserResult });
        } catch (error) {
            const batchUserResult = {
                name,
                maskedName: maskDisplayName(name),
                profileId: '',
                profileUrl: '',
                total: 0,
                liked: 0,
                skipped: 0,
                failed: 1,
                error: error.message || String(error),
                index: index + 1,
                count: totalUsers,
            };
            summary.failed += 1;
            summary.batchUserResults.push(batchUserResult);
            progress(ctx, `${batchUserResult.maskedName || name}: 失败 - ${batchUserResult.error}`, { batchUserResult });
        }
        updateBatchUserProgress(index + 1, `已完成用户 ${index + 1}/${totalUsers}：${name}，剩余 ${totalUsers - index - 1}`);
    }
    return summary;
}

export async function crawlCommunityFullAll(payload = {}, ctx = {}) {
    await ensureSupportReady(payload, ctx);
    const summary = createCrawlSummary();
    const state = await getCommunityState();
    state.byCommunity = state.byCommunity && typeof state.byCommunity === 'object' ? state.byCommunity : {};
    const mainProgressId = progressScope(payload, 'progressScope', 'overall');
    const detailProgressId = progressScope(payload, 'detailProgressScope', 'detail');

    progress(ctx, '开始通过 API 抓取社区列表...');
    const communities = (await fetchZendeskItems('/api/v2/community/topics.json', 'topics', {}, { ctx }))
        .map(normalizeCommunityTopic)
        .filter((community) => community.id);
    summary.communities = communities.length;
    progressBar(ctx, `共发现 ${communities.length} 个社区。`, 0, communities.length, '社区进度', mainProgressId);

    for (let index = 0; index < communities.length; index += 1) {
        const community = communities[index];
        const commId = String(community.id);
        const commState = {
            ...(state.byCommunity[commId] || {}),
            ...community,
            id: commId,
            topics: state.byCommunity[commId]?.topics || {},
        };
        state.byCommunity[commId] = commState;

        let pageUrl = buildZendeskApiUrl(`/api/v2/community/topics/${encodeURIComponent(commId)}/posts.json`, {
            'page[size]': ZENDESK_API_PAGE_SIZE,
        });
        let page = 0;
        let finishedCommunityTopics = 0;
        let knownCommunityTopics = 0;
        progressBar(ctx, `(${index + 1}/${communities.length}) 社区：${community.title}`, index, communities.length, '社区进度', mainProgressId);
        while (pageUrl) {
            page += 1;
            const pageData = await fetchZendeskJson(pageUrl, {}, ctx);
            const topics = (Array.isArray(pageData?.posts) ? pageData.posts : [])
                .map((post) => normalizeCommunityPost(post, commId))
                .filter((post) => post.id);
            knownCommunityTopics += topics.length;
            progressBar(ctx, `${community.title} API 第 ${page} 页：新增 ${topics.length} 个帖子。`, finishedCommunityTopics, knownCommunityTopics, `当前社区：${community.title}`, detailProgressId);

            const topicTasks = topics.map((topic, topicIndex) => async () => {
                const topicId = String(topic.id);
                const existing = commState.topics[topicId];
                if (postCommentsAreCurrent(existing, topic)) {
                    finishedCommunityTopics += 1;
                    progressBar(ctx, `跳过未变化帖子 (${finishedCommunityTopics}/${knownCommunityTopics})：${topic.title || topicId}`, finishedCommunityTopics, knownCommunityTopics, `当前社区：${community.title}`, detailProgressId);
                    return {
                        topicId,
                        topic,
                        existing,
                        skipped: true,
                    };
                }
                progressBar(ctx, `抓取帖子 (${topicIndex + 1}/${topics.length})：${topic.title || topicId}`, finishedCommunityTopics, knownCommunityTopics, `当前社区：${community.title}`, detailProgressId);
                const detail = await fetchPostComments(topic, ctx);
                finishedCommunityTopics += 1;
                progressBar(ctx, `已抓取帖子 (${finishedCommunityTopics}/${knownCommunityTopics})：${topic.title || topicId}`, finishedCommunityTopics, knownCommunityTopics, `当前社区：${community.title}`, detailProgressId);
                return {
                    topicId,
                    topic,
                    existing,
                    detail,
                    comments: commentsCount(detail.comments),
                };
            });
            const topicResults = await runWithConcurrency(topicTasks, Math.min(POST_DETAIL_CONCURRENCY, topics.length || 1));
            topicResults.forEach((result) => {
                if (!result) return;
                if (result.error) {
                    progress(ctx, `帖子抓取失败：${result.error.message || String(result.error)}`);
                    return;
                }
                if (result.skipped) {
                    commState.topics[result.topicId] = {
                        ...(result.existing || {}),
                        ...result.topic,
                        comments: result.existing?.comments || {},
                        lastCrawledAt: new Date().toISOString(),
                    };
                    return;
                }
                commState.topics[result.topicId] = {
                    ...(result.existing || {}),
                    ...result.topic,
                    ...(result.detail.post || {}),
                    postContent: result.detail.postContent || result.topic.postContent || '',
                    comments: result.detail.comments,
                    lastCrawledAt: new Date().toISOString(),
                };
                summary.topics += 1;
                summary.comments += result.comments;
                summary.updated += 1;
            });

            state.byCommunity[commId] = commState;
            state.byCommunityTime = new Date().toISOString();
            await saveCommunityStatePatch({
                byCommunity: state.byCommunity,
                byCommunityTime: state.byCommunityTime,
            });
            pageUrl = nextZendeskPageUrl(pageData);
        }
        progressBar(ctx, `${community.title} 完成。`, index + 1, communities.length, '社区进度', mainProgressId);
    }

    state.byCommunityTime = new Date().toISOString();
    await saveCommunityStatePatch({
        byCommunity: state.byCommunity,
        byCommunityTime: state.byCommunityTime,
    });
    progress(ctx, `社区帖子/评论抓取完成：更新 ${summary.updated} 帖。`);
    return summary;
}

export async function crawlRecentActivitiesIncremental(payload = {}, ctx = {}) {
    await ensureSupportReady(payload, ctx);
    const summary = createCrawlSummary();
    const state = await getCommunityState();
    state.byCommunity = state.byCommunity && typeof state.byCommunity === 'object' ? state.byCommunity : {};

    const perPage = Number(payload.perPage || ZENDESK_API_PAGE_SIZE);
    const prevTime = state.byCommunityTime ? new Date(state.byCommunityTime) : null;
    const cutoff = prevTime ? new Date(prevTime.getTime() - 2 * 3600 * 1000) : new Date(Date.now() - 2 * 3600 * 1000);
    const topicsMap = new Map();
    let pageUrl = buildZendeskApiUrl('/api/v2/community/posts.json', {
        'page[size]': perPage,
        sort_by: 'updated_at',
        sort_order: 'desc',
    });
    let page = 0;
    let stop = false;

    progress(ctx, '开始通过 API 增量更新最近帖子...');
    while (pageUrl && !stop) {
        page += 1;
        const data = await fetchZendeskJson(pageUrl, {}, ctx);
        const posts = Array.isArray(data?.posts) ? data.posts : [];
        if (!posts.length) break;

        for (const rawPost of posts) {
            const post = normalizeCommunityPost(rawPost);
            if (!post.id) continue;
            const timestamp = post.updatedAt || post.createdAt || post.datetime
                ? new Date(post.updatedAt || post.createdAt || post.datetime)
                : null;
            if (timestamp && timestamp < cutoff) {
                stop = true;
                break;
            }
            topicsMap.set(post.id, {
                topicId: post.id,
                commId: post.topicId || 'unknown',
                post,
            });
        }

        if (stop) break;
        pageUrl = nextZendeskPageUrl(data);
    }

    const topics = Array.from(topicsMap.values());
    summary.communities = new Set(topics.map((item) => String(item.commId || 'unknown'))).size;
    progressBar(ctx, `最近活动需要更新 ${topics.length} 个帖子。`, 0, topics.length, '最近活动增量', 'overall');
    let finishedTopics = 0;
    const updateTasks = topics.map((item, index) => async () => {
        const commId = String(item.commId || 'unknown');
        const commState = state.byCommunity[commId] || { id: commId, topics: {} };
        commState.topics = commState.topics || {};
        const existing = commState.topics[item.topicId];
        if (postCommentsAreCurrent(existing, item.post)) {
            finishedTopics += 1;
            progressBar(ctx, `最近活动跳过未变化 (${finishedTopics}/${topics.length})：${item.topicId}`, finishedTopics, topics.length, '最近活动增量', 'overall');
            return {
                item,
                commId,
                existing,
                skipped: true,
            };
        }
        progressBar(ctx, `最近活动抓取 (${index + 1}/${topics.length})：${item.topicId}`, finishedTopics, topics.length, '最近活动增量', 'overall');
        const detail = await fetchPostComments(item.post, ctx);
        finishedTopics += 1;
        progressBar(ctx, `最近活动已抓取 (${finishedTopics}/${topics.length})：${item.topicId}`, finishedTopics, topics.length, '最近活动增量', 'overall');
        return {
            item,
            commId,
            existing,
            detail,
        };
    });
    const updateResults = await runWithConcurrency(updateTasks, Math.min(RECENT_POST_CONCURRENCY, topics.length || 1));
    updateResults.forEach((result) => {
        if (!result) return;
        if (result.error) {
            progress(ctx, `最近活动帖子抓取失败：${result.error.message || String(result.error)}`);
            return;
        }
        const { item, commId, existing, detail } = result;
        const commState = state.byCommunity[commId] || { id: commId, topics: {} };
        commState.topics = commState.topics || {};
        if (result.skipped) {
            commState.topics[item.topicId] = {
                ...(existing || {}),
                ...(item.post || {}),
                comments: existing?.comments || {},
                lastCrawledAt: new Date().toISOString(),
            };
            state.byCommunity[commId] = commState;
            return;
        }
        commState.topics[item.topicId] = {
            ...(existing || {}),
            ...(item.post || {}),
            ...(detail.post || {}),
            id: item.topicId,
            commentNum: Math.max(Number(item.post?.commentNum || 0), commentsCount(detail.comments)),
            postContent: detail.postContent || item.post?.postContent || existing?.postContent || '',
            comments: detail.comments,
            lastCrawledAt: new Date().toISOString(),
        };
        state.byCommunity[commId] = commState;
        summary.topics += 1;
        summary.comments += commentsCount(detail.comments);
        summary.updated += 1;
    });

    state.byCommunityTime = new Date().toISOString();
    await saveCommunityStatePatch({
        byCommunity: state.byCommunity,
        byCommunityTime: state.byCommunityTime,
    });
    progress(ctx, `最近活动增量完成：更新 ${summary.updated} 帖。`);
    return summary;
}

async function fetchArticleDetailFromApi(article, ctx = {}) {
    const normalized = normalizeArticle(article);
    if (normalized.articleContent) return normalized;
    const articleId = parseApiId(article, 'articles', 'articleId');
    const data = await fetchZendeskJson(`/api/v2/help_center/en-us/articles/${encodeURIComponent(articleId)}.json`, {}, ctx);
    return normalizeArticle({ ...article, ...(data?.article || {}) });
}

export async function crawlCategoryFullAll(payload = {}, ctx = {}) {
    await ensureSupportReady(payload, ctx);
    const summary = createCrawlSummary();
    const state = await getCommunityState();
    state.byCategory = {};
    const mainProgressId = progressScope(payload, 'progressScope', 'overall');
    const detailProgressId = progressScope(payload, 'detailProgressScope', 'detail');

    progress(ctx, '开始通过 API 抓取分类/文章...');
    const [rawCategories, rawSections] = await Promise.all([
        fetchZendeskItems('/api/v2/help_center/en-us/categories.json', 'categories', {}, { ctx }),
        fetchZendeskItems('/api/v2/help_center/en-us/sections.json', 'sections', {}, { ctx }),
    ]);
    const categories = rawCategories
        .map(normalizeCategory)
        .filter((category) => category.id);
    const sectionsByCategory = new Map();
    rawSections
        .map((section) => normalizeSection(section))
        .filter((section) => section.id && section.categoryId)
        .forEach((section) => {
            const categoryId = String(section.categoryId);
            if (!sectionsByCategory.has(categoryId)) sectionsByCategory.set(categoryId, []);
            sectionsByCategory.get(categoryId).push(section);
        });
    progressBar(ctx, `共发现 ${categories.length} 个分类。`, 0, categories.length, '分类进度', mainProgressId);

    for (let categoryIndex = 0; categoryIndex < categories.length; categoryIndex += 1) {
        const category = categories[categoryIndex];
        const catId = String(category.id);
        const catState = {
            id: catId,
            url: category.url,
            title: category.title,
            description: category.description || '',
            sections: {},
        };
        progressBar(ctx, `(${categoryIndex + 1}/${categories.length}) 分类：${category.title}`, categoryIndex, categories.length, '分类进度', mainProgressId);

        let sections = sectionsByCategory.get(catId) || [];
        if (!sections.length) {
            sections = [{ id: 'root', url: category.url, title: `${category.title} (root)`, categoryId: catId }];
        }

        progressBar(ctx, `${category.title} 共 ${sections.length} 个子分类。`, 0, sections.length, `当前分类：${category.title}`, detailProgressId);
        let finishedSections = 0;
        const sectionTasks = sections.map((section, sectionIndex) => async () => {
            const secId = String(section.id || section.url);
            const secState = {
                id: secId,
                url: section.url,
                title: section.title,
                categoryId: section.categoryId || catId,
                parentSectionId: section.parentSectionId || '',
                description: section.description || '',
                articles: {},
            };
            progressBar(ctx, `抓取子分类 (${sectionIndex + 1}/${sections.length})：${section.title}`, finishedSections, sections.length, `当前分类：${category.title}`, detailProgressId);
            const articlesPath = secId === 'root'
                ? `/api/v2/help_center/en-us/categories/${encodeURIComponent(catId)}/articles.json`
                : `/api/v2/help_center/en-us/sections/${encodeURIComponent(secId)}/articles.json`;
            const articles = await fetchZendeskItems(articlesPath, 'articles', {}, { ctx });
            const tasks = articles.map((article) => async () => fetchArticleDetailFromApi(article, ctx));
            const details = await runWithConcurrency(tasks, Math.min(ARTICLE_CONCURRENCY, tasks.length || 1));
            details.forEach((detail) => {
                if (!detail || detail.error) return;
                secState.articles[String(detail.id)] = detail;
            });
            finishedSections += 1;
            progressBar(ctx, `${section.title} 完成：${Object.keys(secState.articles).length} 篇文章。`, finishedSections, sections.length, `当前分类：${category.title}`, detailProgressId);
            return {
                secId,
                secState,
                articles: Object.keys(secState.articles).length,
            };
        });
        const sectionResults = await runWithConcurrency(sectionTasks, Math.min(SECTION_CONCURRENCY, sections.length || 1));
        sectionResults.forEach((result) => {
            if (!result) return;
            if (result.error) {
                progress(ctx, `子分类抓取失败：${result.error.message || String(result.error)}`);
                return;
            }
            catState.sections[result.secId] = result.secState;
            summary.articles += result.articles;
            summary.updated += result.articles;
        });

        state.byCategory[catId] = catState;
        state.byCategoryTime = new Date().toISOString();
        await saveCommunityStatePatch({
            byCategory: state.byCategory,
            byCategoryTime: state.byCategoryTime,
        });
        summary.communities += 1;
        progressBar(ctx, `${category.title} 完成。`, categoryIndex + 1, categories.length, '分类进度', mainProgressId);
    }

    state.byCategoryTime = new Date().toISOString();
    await saveCommunityStatePatch({
        byCategory: state.byCategory,
        byCategoryTime: state.byCategoryTime,
    });
    progress(ctx, `分类/文章抓取完成：${summary.articles} 篇文章。`);
    return summary;
}

export async function crawlFullAll(payload = {}, ctx = {}) {
    const summary = createCrawlSummary();
    progress(ctx, '开始全量抓取帖子评论和文章...', {
        progress: [
            { id: 'overall', current: 0, total: 2, label: '全量抓取' },
            { id: 'community-main', current: 0, total: 0, label: '帖子评论' },
            { id: 'community-detail', current: 0, total: 0, label: '当前社区' },
            { id: 'category-main', current: 0, total: 0, label: '分类文章' },
            { id: 'category-detail', current: 0, total: 0, label: '当前分类' },
        ],
    });
    let finishedStages = 0;
    const stageTasks = [
        async () => {
            const stageSummary = await crawlCommunityFullAll({
                ...payload,
                progressScope: 'community-main',
                detailProgressScope: 'community-detail',
            }, ctx);
            finishedStages += 1;
            progressBar(ctx, '帖子和评论抓取完成。', finishedStages, 2, '全量抓取', 'overall');
            return stageSummary;
        },
        async () => {
            const stageSummary = await crawlCategoryFullAll({
                ...payload,
                progressScope: 'category-main',
                detailProgressScope: 'category-detail',
            }, ctx);
            finishedStages += 1;
            progressBar(ctx, '分类和文章抓取完成。', finishedStages, 2, '全量抓取', 'overall');
            return stageSummary;
        },
    ];
    const stageResults = [];
    for (const runStage of stageTasks) {
        try {
            stageResults.push(await runStage());
        } catch (error) {
            stageResults.push({ error });
        }
    }
    const errors = [];
    stageResults.forEach((stageSummary) => {
        if (stageSummary?.error) {
            errors.push(stageSummary.error.message || String(stageSummary.error));
            return;
        }
        mergeCrawlSummary(summary, stageSummary);
    });
    if (errors.length) {
        throw new Error(`全量抓取部分失败：${errors.join('；')}`);
    }
    progressBar(ctx, `全量抓取完成：更新 ${summary.updated} 项。`, 2, 2, '全量抓取', 'overall');
    return summary;
}

export async function runCommunityAction(action, payload = {}, ctx = {}) {
    if (['UPVOTE_POST', 'UPVOTE_USER', 'UPVOTE_USERS'].includes(action)) {
        resetVoteStats(ctx);
    }
    switch (action) {
        case 'AUTH_SUPPORT':
            return authenticateSupport(payload, ctx);
        case 'UPVOTE_POST':
            return upVotePost(payload, ctx);
        case 'UPVOTE_USER':
            return upVoteUser(payload, ctx);
        case 'UPVOTE_USERS':
            return upVoteUsers(payload, ctx);
        case 'RESOLVE_PROFILE':
            return resolveProfileOnly(payload, ctx);
        case 'CRAWL_FULL_ALL':
            return crawlFullAll(payload, ctx);
        case 'CRAWL_COMMUNITY_FULL':
            return crawlCommunityFullAll(payload, ctx);
        case 'CRAWL_RECENT_INCREMENTAL':
            return crawlRecentActivitiesIncremental(payload, ctx);
        case 'CRAWL_CATEGORY_FULL':
            return crawlCategoryFullAll(payload, ctx);
        case 'CLEAR_LIKED_IDS':
            return clearLikedIds();
        case 'LLM_CONFIG_GET':
            return getLlmConfig();
        case 'LLM_CONFIG_SAVE':
            return saveLlmConfig(payload.config);
        case 'AI_SUMMARIZE_POST':
            return summarizeCommunityPostWithAi(payload, ctx);
        case 'AI_GET_CACHED_SUMMARY':
            return getCachedCommunityAiSummary(payload);
        case 'AI_DRAFT_COMMENT':
            return draftCommunityPostCommentWithAi(payload, ctx);
        case 'AI_POST_COMMENT':
            return createCommunityPostComment(payload, ctx);
        default:
            throw new Error(`Unsupported community action: ${action}`);
    }
}
