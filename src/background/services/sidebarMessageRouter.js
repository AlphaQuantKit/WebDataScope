import { getSettings, saveSettings } from './settingsService.js';
import { generateAlphaDescriptionWithAi } from './alphaDescriptionService.js';
import {
    getCommunityPostMarkers,
    listCommunityFavoritePosts,
    markCommunityPostRead,
    setCommunityPostFavorite,
} from './communityPostMarkerService.js';
import { getLlmConfig, saveLlmConfig } from './llmService.js';
import {
    clearProdMemoCache,
    clearProdMemoSyncData,
    deleteProdMemoCache,
    exportProdMemoCache,
    getProdMemoCache,
    importProdMemoCache,
    runProdMemoAction,
} from './prodMemoService.js';
import {
    clearSessionKeeperLogs,
    getSessionKeeperState,
    handleCapturedSessionToken,
    performKeepAlive,
    saveSessionKeeperConfig,
    triggerAutoLogin,
} from './sessionKeeperService.js';
import { runCommunityAction } from './supportCommunityService.js';
import { downloadSharedData, getShareStatus, uploadSharedData } from './pnlShareService.js';

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
    if (msg.type === 'WQP_PNL_SHARE_STATUS') {
        return respond(sendResponse, getShareStatus());
    }
    if (msg.type === 'WQP_PNL_SHARE_UPLOAD') {
        return respond(sendResponse, uploadSharedData());
    }
    if (msg.type === 'WQP_PNL_SHARE_DOWNLOAD') {
        return respond(sendResponse, downloadSharedData());
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
    if (msg.type === 'WQP_PRODMEMO_GET') {
        return respond(sendResponse, getProdMemoCache());
    }
    if (msg.type === 'WQP_PRODMEMO_EXPORT') {
        return respond(sendResponse, exportProdMemoCache());
    }
    if (msg.type === 'WQP_PRODMEMO_IMPORT') {
        return respond(sendResponse, importProdMemoCache(msg.memoData));
    }
    if (msg.type === 'WQP_PRODMEMO_CLEAR') {
        return respond(sendResponse, clearProdMemoCache());
    }
    if (msg.type === 'WQP_PRODMEMO_CLEAR_SYNC') {
        return respond(sendResponse, clearProdMemoSyncData());
    }
    if (msg.type === 'WQP_PRODMEMO_DELETE') {
        return respond(sendResponse, deleteProdMemoCache(msg.alphaId));
    }
    if (msg.type === 'WQP_PRODMEMO_DB') {
        return respond(sendResponse, runProdMemoAction(msg.action, msg.payload || {}));
    }
    if (msg.type === 'WQP_LLM_CONFIG_GET') {
        return respond(sendResponse, getLlmConfig());
    }
    if (msg.type === 'WQP_LLM_CONFIG_SAVE') {
        return respond(sendResponse, saveLlmConfig(msg.config));
    }
    if (msg.type === 'WQP_ALPHA_AI_GENERATE_DESCRIPTION') {
        return respond(sendResponse, generateAlphaDescriptionWithAi({
            alphaId: msg.alphaId,
            alphaType: msg.alphaType,
            expression: msg.expression,
            settings: msg.settings,
            fields: msg.fields,
            existingDescription: msg.existingDescription,
            selectionExpression: msg.selectionExpression,
            comboExpression: msg.comboExpression,
            existingSelectionDescription: msg.existingSelectionDescription,
            existingComboDescription: msg.existingComboDescription,
            selectedAlphaCount: msg.selectedAlphaCount,
        }));
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
    if (msg.type === 'WQP_COMMUNITY_AI_GET_POST_STATUSES') {
        return respond(sendResponse, runCommunityAction('AI_GET_POST_STATUSES', {
            postIds: msg.postIds,
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
    if (msg.type === 'WQP_COMMUNITY_POST_MARKERS_GET') {
        return respond(sendResponse, getCommunityPostMarkers({
            postIds: msg.postIds,
        }));
    }
    if (msg.type === 'WQP_COMMUNITY_POST_FAVORITES_GET') {
        return respond(sendResponse, listCommunityFavoritePosts());
    }
    if (msg.type === 'WQP_COMMUNITY_POST_MARK_READ') {
        return respond(sendResponse, markCommunityPostRead({
            postId: msg.postId,
            postUrl: msg.postUrl,
            title: msg.title,
            postDate: msg.postDate,
        }));
    }
    if (msg.type === 'WQP_COMMUNITY_POST_FAVORITE_SET') {
        return respond(sendResponse, setCommunityPostFavorite({
            postId: msg.postId,
            postUrl: msg.postUrl,
            title: msg.title,
            postDate: msg.postDate,
            favorite: msg.favorite,
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
