import { getLocalValue, setLocalValue } from './storageService.js';
import { getSettings, saveSettings } from './settingsService.js';
import { runCommunityAction } from './supportCommunityService.js';
import {
    clearProdMemoCache,
    deleteProdMemoCache,
    getProdMemoCache,
    importProdMemoCache,
} from './prodMemoService.js';
import {
    clearSessionKeeperLogs,
    getSessionKeeperState,
    handleCapturedSessionToken,
    performKeepAlive,
    saveSessionKeeperConfig,
    triggerAutoLogin,
} from './sessionKeeperService.js';

function respond(sendResponse, promise) {
    promise
        .then((data) => sendResponse({ ok: true, data }))
        .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
    return true;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || typeof msg.type !== 'string') return false;

    if (msg.type === 'WQP_SETTINGS_GET') {
        return respond(sendResponse, getSettings());
    }
    if (msg.type === 'WQP_SETTINGS_SAVE') {
        return respond(sendResponse, saveSettings(msg.settings));
    }
    if (msg.type === 'WQP_SESSION_GET') {
        return respond(sendResponse, getSessionKeeperState());
    }
    if (msg.type === 'WQP_SESSION_SAVE') {
        return respond(sendResponse, saveSessionKeeperConfig(msg.config));
    }
    if (msg.type === 'WQP_SESSION_CHECK_NOW') {
        return respond(sendResponse, performKeepAlive({ manual: true }));
    }
    if (msg.type === 'WQP_SESSION_LOGIN_NOW') {
        return respond(sendResponse, triggerAutoLogin().then(() => getSessionKeeperState()));
    }
    if (msg.type === 'WQP_SESSION_CLEAR_LOGS') {
        return respond(sendResponse, clearSessionKeeperLogs());
    }
    if (msg.type === 'WQP_SESSION_TOKEN_CAPTURED') {
        return respond(sendResponse, handleCapturedSessionToken(msg.token));
    }
    if (msg.type === 'WQP_PRODMEMO_GET' || msg.type === 'WQP_PRODMEMO_EXPORT') {
        return respond(sendResponse, getProdMemoCache());
    }
    if (msg.type === 'WQP_PRODMEMO_IMPORT') {
        return respond(sendResponse, importProdMemoCache(msg.memoData));
    }
    if (msg.type === 'WQP_PRODMEMO_CLEAR') {
        return respond(sendResponse, clearProdMemoCache());
    }
    if (msg.type === 'WQP_PRODMEMO_DELETE') {
        return respond(sendResponse, deleteProdMemoCache(msg.alphaId));
    }
    if (msg.type === 'WQP_LLM_CONFIG_GET') {
        return respond(sendResponse, runCommunityAction('LLM_CONFIG_GET'));
    }
    if (msg.type === 'WQP_LLM_CONFIG_SAVE') {
        return respond(sendResponse, runCommunityAction('LLM_CONFIG_SAVE', { config: msg.config }));
    }
    if (msg.type === 'WQP_COMMUNITY_AI_SUMMARIZE_POST') {
        return respond(sendResponse, runCommunityAction('AI_SUMMARIZE_POST', {
            postUrl: msg.postUrl,
            postId: msg.postId,
            forceRefresh: msg.forceRefresh,
        }));
    }
    if (msg.type === 'WQP_COMMUNITY_AI_GET_CACHED_SUMMARY') {
        return respond(sendResponse, runCommunityAction('AI_GET_CACHED_SUMMARY', {
            postUrl: msg.postUrl,
            postId: msg.postId,
        }));
    }
    if (msg.type === 'WQP_COMMUNITY_AI_DRAFT_COMMENT') {
        return respond(sendResponse, runCommunityAction('AI_DRAFT_COMMENT', {
            postUrl: msg.postUrl,
            postId: msg.postId,
            customInstruction: msg.customInstruction,
        }));
    }
    if (msg.type === 'WQP_COMMUNITY_AI_POST_COMMENT') {
        return respond(sendResponse, runCommunityAction('AI_POST_COMMENT', {
            postUrl: msg.postUrl,
            postId: msg.postId,
            commentText: msg.commentText,
            commentHtml: msg.commentHtml,
        }));
    }

    return false;
});

chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== 'WQP_COMMUNITY_PORT') return;

    let running = false;

    port.onMessage.addListener((message) => {
        if (!message || message.type !== 'RUN') return;
        if (running) {
            port.postMessage({ type: 'done', ok: false, error: 'Another community task is already running.' });
            return;
        }

        running = true;
        const ctx = {
            progress(messageText, data) {
                try {
                    port.postMessage({ type: 'progress', message: messageText, data });
                } catch (_) {
                    // Port may be disconnected.
                }
            },
        };

        runCommunityAction(message.action, message.payload || {}, ctx)
            .then((data) => {
                port.postMessage({ type: 'done', ok: true, data });
            })
            .catch((error) => {
                port.postMessage({ type: 'done', ok: false, error: error.message || String(error) });
            })
            .finally(() => {
                running = false;
            });
    });
});
