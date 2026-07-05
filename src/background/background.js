// background.js: 后台脚本，用于监听浏览器事件，如标签页更新、插件安装等，以及与content scripts和popup交互
console.log('Background script is running.');
import '../shared/dataStore.js';
import { ensureDefaultSettings } from './services/settingsService.js';
import './services/sidebarMessageRouter.js';
import { initSessionKeeperService } from './services/sessionKeeperService.js';

const DATA_SET_LIST_PATH = 'dataSetList.json';
const PATHS = {
    vendorJs: 'src/vendor/js',
    vendorCss: 'src/vendor/css',
    sharedContent: 'src/content/shared',
    platformCommon: 'src/content/platform/common',
    platformData: 'src/content/platform/data',
    platformDistribution: 'src/content/platform/distribution',
    platformGenius: 'src/content/platform/genius',
    platformSimulate: 'src/content/platform/simulate',
    platformStyles: 'src/content/platform/styles',
};
let dataSetList = null; // 定义全局变量
const REPO_OWNER = "zhangkaihua88";
const REPO_NAME = "WebDataScope";
const CHECK_INTERVAL = 24 * 60 * 60 * 1000; // 24小时检查一次


// 内存中仅会话级别缓存，不做长期持久化
let recentApiRequests = [];
const MAX_RECENT = 200;
// 在此处直接维护需要排除的前缀列表
const EXCLUDED_PREFIXES = [
    'https://api.worldquantbrain.com/errors/api/2/envelope/'

];

async function configureSidePanel() {
    try {
        if (chrome.sidePanel?.setPanelBehavior) {
            await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
        }
    } catch (error) {
        console.warn('Side panel setup failed:', error);
    }
}

function getExtensionDataStore() {
    if (!globalThis.WQPDataStore) {
        throw new Error('WQPDataStore is not available');
    }
    return globalThis.WQPDataStore;
}

async function getJsonDataFile(path) {
    const data = await getExtensionDataStore().getJson(path);
    if (data === null) {
        throw new Error(`Data file not found in IndexedDB: ${path}`);
    }
    return data;
}

async function getRegionInfoData(key) {
    const data = await getExtensionDataStore().getInfoData(key);
    if (!data) {
        throw new Error(`Info data shard not found for ${key}. Please re-import the data zip.`);
    }
    return data;
}

function pickInfoRecords(source, ids) {
    const result = {};
    if (!source || !Array.isArray(ids)) return result;

    for (const id of ids) {
        if (Object.prototype.hasOwnProperty.call(source, id)) {
            result[id] = source[id];
        }
    }

    return result;
}

async function getInfoDataSubset(msg) {
    const { region, delay, datasetIds = [], datafieldIds = [] } = msg;
    if (!region || !delay) {
        throw new Error('region and delay are required');
    }

    const key = `${region}_${delay}`;
    const regionData = await getRegionInfoData(key);
    const isos = regionData.isos || {};
    const neutralization = regionData.neutralization || {};

    return {
        [key]: {
            sub_end_time: regionData.sub_end_time,
            isos: {
                mean: isos.mean,
                total_count: isos.total_count,
                dataset: pickInfoRecords(isos.dataset, datasetIds),
                datafield: pickInfoRecords(isos.datafield, datafieldIds),
            },
            neutralization: {
                dataset: pickInfoRecords(neutralization.dataset, datasetIds),
                datafield: pickInfoRecords(neutralization.datafield, datafieldIds),
            },
        },
    };
}

function arrayBufferToBase64(arrayBuffer) {
    const bytes = new Uint8Array(arrayBuffer);
    const chunkSize = 0x8000;
    let binary = '';

    for (let i = 0; i < bytes.length; i += chunkSize) {
        const chunk = bytes.subarray(i, i + chunkSize);
        binary += String.fromCharCode(...chunk);
    }

    return btoa(binary);
}

async function getCompressedBase64DataFile(path) {
    const normalizedPath = getExtensionDataStore().normalizeDataPath(path);
    const arrayBuffer = await getExtensionDataStore().getFileArrayBuffer(normalizedPath);
    if (!arrayBuffer) {
        throw new Error(`Data file not found in IndexedDB: ${normalizedPath}`);
    }
    return arrayBufferToBase64(arrayBuffer);
}

async function handleIndexedDbDataRequest(msg) {
    if (msg.responseType === 'json') {
        return getJsonDataFile(msg.path);
    }
    if (msg.responseType === 'compressed-base64') {
        return getCompressedBase64DataFile(msg.path);
    }
    if (msg.responseType === 'meta') {
        return getExtensionDataStore().getMeta();
    }
    throw new Error(`Unsupported data response type: ${msg.responseType}`);
}

function resetIndexedDbDataCache() {
    dataSetList = null;
}


// 初始化设置
chrome.runtime.onInstalled.addListener(async () => {
    configureSidePanel();
    const WQP_Settings = await ensureDefaultSettings();
    console.log('Current settings:', WQP_Settings);
    // 获取数据集列表
    try {
        dataSetList = await getDataSetList();
    } catch (error) {
        console.warn('Data zip has not been imported into IndexedDB yet.', error);
        dataSetList = null;
    }
    checkUpdate();
});

// 设置定时器，每天检查一次更新
chrome.runtime.onStartup.addListener(() => {
    configureSidePanel();
    checkUpdate();
});

configureSidePanel();
initSessionKeeperService();



// 监听标签页更新事件
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.status === 'complete' && tab.url) {
        const url = tab.url

        const distributionFlag = url == "https://platform.worldquantbrain.com/alphas/distribution"
        const geniusFlag = url.startsWith("https://platform.worldquantbrain.com/genius")
        const dataFlag = (
            url.includes("data/data-sets") ||
            url.includes("data/search/data-fields") ||
            url.includes("data/data-fields")
        )
        const simulateFlag = url.startsWith("https://platform.worldquantbrain.com/simulate")

        if (distributionFlag) {
            injectionDistributionScript(tabId);
        } else if (geniusFlag) {
            injectionGeniusScript(tabId);
        } else if (dataFlag) {
            injectionDataFlagScript(tabId, tab);
        } else if (simulateFlag) {
            injectionSimulateScript(tabId);
        }
    }
});

// 用 webNavigation.onCommitted 在导航提交时（DOM 为空、JS 尚未插入）立即注入到 MAIN world
// 比 tabs.onUpdated 的 'loading' 更早，确保 MutationObserver 在 WQ 第一个 <script> 插入前就已就位
chrome.webNavigation.onCommitted.addListener((details) => {
    // 只处理顶层主框架，忽略 iframe
    if (details.frameId !== 0) return;
    if (!details.url || !details.url.includes('platform.worldquantbrain.com')) return;
    injectFetchInterceptor(details.tabId);
}, { url: [{ hostContains: 'platform.worldquantbrain.com' }] });

// 注入 Fetch 拦截器到页面的 MAIN 环境中
function injectFetchInterceptor(tabId) {
    chrome.scripting.executeScript({
        target: { tabId: tabId },
        world: "MAIN", // 必须指定 MAIN，否则无法覆盖页面本身的 window.fetch
        func: () => {

            function postCapturedSessionToken(value) {
                const text = String(value || '');
                const match = text.match(/Bearer\s+([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)?)/i);
                if (!match?.[1]) return;
                window.postMessage({
                    type: 'WQP_SESSION_TOKEN_CAPTURED',
                    token: match[1],
                }, '*');
            }

            function scanHeadersForSessionToken(headers) {
                if (!headers) return;
                try {
                    if (headers instanceof Headers) {
                        postCapturedSessionToken(headers.get('Authorization') || headers.get('authorization'));
                        return;
                    }
                } catch (_) {
                    // Fall through to structural checks.
                }

                if (Array.isArray(headers)) {
                    headers.forEach(([key, value]) => {
                        if (String(key || '').toLowerCase() === 'authorization') {
                            postCapturedSessionToken(value);
                        }
                    });
                    return;
                }

                if (typeof headers === 'object') {
                    Object.keys(headers).forEach((key) => {
                        if (key.toLowerCase() === 'authorization') {
                            postCapturedSessionToken(headers[key]);
                        }
                    });
                }
            }

            function captureSessionTokenFromFetchArgs(resource, config) {
                try {
                    scanHeadersForSessionToken(config?.headers);
                    if (resource instanceof Request) {
                        scanHeadersForSessionToken(resource.headers);
                    }
                } catch (_) {
                    // Token sniffing must never affect page requests.
                }
            }

            // 将辅助函数定义在注入的内容脚本内
            function getAlphaCheckStates(originalData) {
                function readProdMemoCache() {
                    try {
                        return JSON.parse(localStorage.getItem('WQP_ProdMemoCache') || '{}') || {};
                    } catch (e) {
                        console.warn('[WQP] ProdMemo cache parse failed:', e);
                        return {};
                    }
                }

                function formatMemoValue(value) {
                    const numeric = Number(value);
                    return Number.isFinite(numeric) ? numeric.toFixed(4) : '';
                }

                function getMaxProdCorr(cache, alphaId) {
                    const memo = cache?.[alphaId];
                    return formatMemoValue(memo?.prod?.max);
                }

                function getMaxPoolProdCorr(cache, alphaId) {
                    const memo = cache?.[alphaId];
                    return formatMemoValue(memo?.pool?.max);
                }

                function getMaxSelfCorr(cache, alphaId) {
                    const memo = cache?.[alphaId];
                    return formatMemoValue(memo?.self?.max);
                }

                // 1. 定义需要校验的RA检查项名称（自动去重，避免重复统计）
                const RA_CHECK_NAMES = Array.from(new Set([
                    "HIGH_TURNOVER", "LOW_TURNOVER",
                    "LOW_FITNESS", "LOW_RETURNS", "LOW_SHARPE", 

                    'LOW_GLB_AMER_SHARPE', 'LOW_GLB_APAC_SHARPE', 'LOW_GLB_EMEA_SHARPE', 'LOW_ASI_JPN_SHARPE',

                    "IS_LADDER_SHARPE", // ATOM豁免 
                    "LOW_2Y_SHARPE",  "LOW_SUB_UNIVERSE_SHARPE",  "LOW_ROBUST_UNIVERSE_SHARPE", 
                    "LOW_AFTER_COST_ILLIQUID_UNIVERSE_SHARPE", 'LOW_INVESTABILITY_CONSTRAINED_SHARPE',

                    "LOW_ROBUST_UNIVERSE_RETURNS", 
                    "CONCENTRATED_WEIGHT",  
                    
                ]));
                const PPA_CHECK_NAMES = Array.from(new Set([
                    'LOW_TURNOVER',
                    'HIGH_TURNOVER',
                    'LOW_SUB_UNIVERSE_SHARPE', 
                    'LOW_ROBUST_UNIVERSE_SHARPE', 
                    'LOW_ROBUST_UNIVERSE_SHARPE.WITH_RATIO',
                    "LOW_ROBUST_UNIVERSE_RETURNS",
                    'LOW_INVESTABILITY_CONSTRAINED_SHARPE'
                ]));

                // 2. 核心逻辑：遍历数据，统计不合格数量并新增字段
                // 
                // 比如sub-univers ,robust 其实能不能把那些fail的具体值做出来，比如robust 那些的值
                // 能不能加个显示负的alpha的功能，比如当sharp为负的时候，如果测试值的绝对值都能通过平台标准就显示’-0‘
                // risk neut那个就是用传统neut跑的时候 会有个risk neut的线 大概sharpe 和 fit都更高的话 就需要遍历risk neut
                // 按照具体的pyramid筛选
                if (!Array.isArray(originalData?.results)) return originalData;
                const prodMemoCache = readProdMemoCache();
                originalData.results.forEach(item => {
                    item.maxProdCorr = getMaxProdCorr(prodMemoCache, item?.id);
                    item.maxPoolProdCorr = getMaxPoolProdCorr(prodMemoCache, item?.id);
                    item.maxSelfCorr = getMaxSelfCorr(prodMemoCache, item?.id);
                    // 容错处理：如果is/checks不存在，直接赋值0
                    if (!item?.is?.checks || !Array.isArray(item.is.checks)) {
                        item.is = item.is || {};
                        item.is.failedNumRA = 0;
                        item.is.failedNumPPA = 0;
                        return;
                    }
                    item.is.failedNum = item.is.checks.filter(check => 
                         check.result === 'FAIL'
                    ).length;
                    item.is.failedNumRA = item.is.checks.filter(check => 
                        RA_CHECK_NAMES.includes(check.name) && check.result !== 'PASS' && check.result !== 'PENDING'
                    ).length;
                    
                    item.is.failedNumPPA = item.is.checks.filter(check => 
                        PPA_CHECK_NAMES.includes(check.name) && check.result !== 'PASS' && check.result !== 'PENDING'
                    ).length;
                    
                    const pyramidCheck = item.is.checks.find(check => check.name === "MATCHES_PYRAMID");
                    item.is.WQPPYS = pyramidCheck?.pyramids
                        ?.map(pyramid => (pyramid.name?.split('/').pop() || '').toLowerCase())
                        ?.join('/') || '';
                    item.is.pyramidMultiplier = pyramidCheck?.multiplier ?? null;

                    
                });
                return originalData;
            }

            if (window.__wq_fetch_intercepted) return;
            window.__wq_fetch_intercepted = true;

            const originalFetch = window.fetch;
            window.fetch = async function (...args) {
                const url = typeof args[0] === 'string' ? args[0] : (args[0]?.url || '');
                captureSessionTokenFromFetchArgs(args[0], args[1]);

                // 执行原始请求
                const response = await originalFetch.apply(this, args);

                if (url && url.includes('/alphas/') && url.includes('/correlations/')) {
                    try {
                        const match = url.match(/\/alphas\/([^/]+)\/correlations\/([^/?#]+)/);
                        if (match) {
                            response.clone().json().then(data => {
                                window.postMessage({
                                    type: 'WQP_PRODMEMO_CORRELATION_DATA',
                                    alphaId: match[1],
                                    subType: match[2],
                                    data,
                                }, '*');
                            }).catch(() => {});
                        }
                    } catch (e) {
                        console.warn('[WQP] ProdMemo correlation capture failed:', e);
                    }
                }

                if (url && url.includes('/alphas/') && url.includes('/recordsets')) {
                    const match = url.match(/\/alphas\/([^/]+)\/recordsets/);
                    if (match) {
                        window.postMessage({
                            type: 'WQP_PRODMEMO_ALPHA_VIEW',
                            alphaId: match[1],
                        }, '*');
                    }
                }

                // 拦截并修改目标接口的响应
                if (url && url.includes("https://api.worldquantbrain.com/users/self/alphas?")) {
                    try {
                        const clone = response.clone();
                        let originalData = await clone.json();

                        // 👉 自定义你的修改逻辑
                        const modifiedData = getAlphaCheckStates(originalData);
                        console.log('拦截并修改了 alphas 响应：', modifiedData);

                        // 每次重置用新的Map
                        window.__wqp_alpha_checks = new Map();
                        if (modifiedData.results) {
                            modifiedData.results.forEach(item => {
                                if (item.id) {
                                    window.__wqp_alpha_checks.set(item.id, {
                                        maxProdCorr: item.maxProdCorr ?? '',
                                        maxPoolProdCorr: item.maxPoolProdCorr ?? '',
                                        maxSelfCorr: item.maxSelfCorr ?? '',
                                        failedNum: item.is?.failedNum ?? 0,
                                        failedNumRA: item.is?.failedNumRA ?? 0,
                                        failedNumPPA: item.is?.failedNumPPA ?? 0,
                                        pyramidMultiplier: item.is?.pyramidMultiplier ?? null,
                                        operatorCount: item.regular?.operatorCount ?? null,
                                        type: item.type || item.settings?.type || null,
                                        WQPPYS: item.is?.WQPPYS || '',
                                    });
                                }
                            });
                        }
                        window.dispatchEvent(new CustomEvent('__wqp_alpha_checks_updated'));

                        // 构造新 Response 返回给前端
                        return new Response(JSON.stringify(modifiedData), {
                            status: response.status,
                            statusText: response.statusText,
                            headers: response.headers
                        });
                    } catch (e) {
                        console.error("修改响应提取失败：", e);
                    }
                }
                return response;
            };

            const originalSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;
            XMLHttpRequest.prototype.setRequestHeader = function (header, value) {
                if (String(header || '').toLowerCase() === 'authorization') {
                    postCapturedSessionToken(value);
                }
                return originalSetRequestHeader.apply(this, arguments);
            };
        }
    }).catch(err => console.error("注入 Fetch 拦截器失败：", err));
}

// alphaPath: ["is", "sharpe"]， 从select performence开始搜索， activeTabsWithoutParent: ["unsubmitted", "submitted"],
// ############################## 以下为辅助函数 #################################


// 监听 api.worldquantbrain.com 的网络请求并广播到页面用于展示
try {
    chrome.webRequest.onBeforeRequest.addListener(
        (details) => {
            const url = details.url || '';
            if (!url.includes('api.worldquantbrain.com')) return;
            if (isExcluded(url)) return;
            let body = '';
            if ((details.method || '').toUpperCase() === 'POST' && details.requestBody) {
                body = extractRequestBody(details.requestBody);
            }
            const rec = {
                id: details.requestId,
                time: Date.now(),
                type: 'before',
                method: details.method,
                url,
                body,
                tabId: details.tabId,
            };
            recentApiRequests.push(rec);
            if (recentApiRequests.length > MAX_RECENT) recentApiRequests.shift();
            broadcastRequest(rec);
        },
        { urls: ["https://api.worldquantbrain.com/*"] },
        ["requestBody"]
    );

    chrome.webRequest.onCompleted.addListener(
        (details) => {
            const url = details.url || '';
            if (!url.includes('api.worldquantbrain.com')) return;
            if (isExcluded(url)) return;
            const rec = {
                id: details.requestId,
                time: Date.now(),
                type: 'completed',
                method: details.method,
                url,
                statusCode: details.statusCode,
                tabId: details.tabId,
                responseHeaders: details.responseHeaders || [],
            };
            recentApiRequests.push(rec);
            if (recentApiRequests.length > MAX_RECENT) recentApiRequests.shift();
            broadcastRequest(rec);
        },
        { urls: ["https://api.worldquantbrain.com/*"] },
        ["responseHeaders"]
    );
} catch (e) {
    console.warn('webRequest listeners failed to register', e);
}

// 内容脚本可主动请求最近 N 条记录
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg && msg.type === 'WQP_INDEXED_DATA_GET') {
        handleIndexedDbDataRequest(msg).then((data) => {
            sendResponse({ ok: true, data });
        }).catch((error) => {
            console.error('IndexedDB data request failed:', error);
            sendResponse({ ok: false, error: error.message });
        });
        return true;
    } else if (msg && msg.type === 'WQP_INFO_DATA_SUBSET') {
        getInfoDataSubset(msg).then((data) => {
            sendResponse({ ok: true, data });
        }).catch((error) => {
            console.error('Info data subset request failed:', error);
            sendResponse({ ok: false, error: error.message });
        });
        return true;
    } else if (msg && msg.type === 'WQP_INDEXED_DATA_UPDATED') {
        resetIndexedDbDataCache();
        sendResponse({ ok: true });
        return true;
    }

    if (msg && msg.type === 'REQ_MONITOR_GET_RECENT') {
        // 仅返回最近 100 条，且过滤 tabId 匹配或为 -1 的(无法关联标签的)记录
        const tabId = sender?.tab?.id;
        const list = recentApiRequests
            .filter(r => r.tabId === tabId || r.tabId === -1)
            .slice(-100);
        sendResponse({ ok: true, data: list });
        return true;
    } else if (msg && msg.type === 'REQ_MONITOR_GET_EXCLUDED') {
        sendResponse({ ok: true, data: EXCLUDED_PREFIXES });
        return true;
    } else if (msg && msg.type === 'WQ_MANAGER_LOGIN_AND_OPEN') {
        // 处理WQ Manager登录并打开页面
        console.log(msg.id)
        loginAndOpenWqManager(msg.wq_id, sender.tab.id).then(() => {
            sendResponse({ ok: true });
        }).catch(error => {
            sendResponse({ ok: false, error: error.message });
        });
        return true;
    }
});

async function loginAndOpenWqManager(wqId, currentTabId) {
    // 在当前标签页打开登录页面
    currentTabId = await new Promise((resolve, reject) => {
        chrome.tabs.create({ url: 'https://wqmanager.qzz.io/login', active: true }, (tab) => {
            if (chrome.runtime.lastError) return reject(chrome.runtime.lastError);
            resolve(tab.id);
        });
    });


    
    

    // 等待页面加载完成后，填充wq_id并自动提交
    return new Promise((resolve, reject) => {
        const listener = (tabId, changeInfo) => {
            if (tabId === currentTabId && changeInfo.status === 'complete') {
                chrome.tabs.onUpdated.removeListener(listener);

                // 在页面中自动填充wq_id并提交登录表单
                chrome.scripting.executeScript({
                    target: { tabId: currentTabId },
                    func: async (wq_id) => {
                        // 查找wq_id输入框
                        const wqIdInput = document.querySelector('input[type="text"]') ||
                                         document.querySelector('input[name="wq_id"]') ||
                                         document.querySelector('input[placeholder*="WQ"]');

                        if (wqIdInput) {
                            // 填充wq_id
                            wqIdInput.value = wq_id;
                            wqIdInput.dispatchEvent(new Event('input', { bubbles: true }));
                            wqIdInput.dispatchEvent(new Event('change', { bubbles: true }));

                            // 等待一下，然后查找并点击登录按钮
                            setTimeout(() => {
                                const loginButton = document.querySelector('button[type="submit"]') ||
                                                   document.querySelector('button');
                                if (loginButton) {
                                    loginButton.click();
                                }
                            }, 100);
                        }
                    },
                    args: [wqId]
                }).then(() => {
                    resolve();
                }).catch((error) => {
                    reject(error);
                });
            }
        };

        // 导航到 Profile 页面以触发 onUpdated 事件
        chrome.tabs.update(currentTabId, {
            url: 'https://wqmanager.qzz.io/Profile'
        });

        chrome.tabs.onUpdated.addListener(listener);

        setTimeout(() => {
            chrome.tabs.onUpdated.removeListener(listener);
            reject(new Error('页面加载超时'));
        }, 10000);
    });
}

function broadcastRequest(rec) {
    // 仅向 platform.worldquantbrain.com 的标签分发
    chrome.tabs.query({ url: '*://platform.worldquantbrain.com/*' }, (tabs) => {
        for (const t of tabs) {
            chrome.tabs.sendMessage(t.id, { type: 'REQ_MONITOR_NEW', data: rec });
        }
    });
}

// 版本比较函数
function compareVersions(v1, v2) {
    const parts1 = v1.split('.').map(Number);
    const parts2 = v2.split('.').map(Number);
    for (let i = 0; i < Math.max(parts1.length, parts2.length); i++) {
        const num1 = parts1[i] || 0;
        const num2 = parts2[i] || 0;
        if (num1 !== num2) return num1 - num2;
    }
    return 0;
}

// 获取最新版本
async function checkUpdate() {
    try {
        const today = new Date().toISOString().split('T')[0]; // 获取当前日期 (YYYY-MM-DD)

        // 读取存储的上次提醒日期
        chrome.storage.local.get('WQP_LastNotifyDate', async ({ WQP_LastNotifyDate }) => {
            console.log('上次提醒日期:', WQP_LastNotifyDate);
            if (WQP_LastNotifyDate === today) {
                console.log('今天已经提醒过，无需重复提醒');
                return;
            }
            console.log('今天尚未提醒过，开始检查更新');

            // 获取 GitHub 上的最新版本
            const response = await fetch(
                `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/releases/latest`
            );
            const data = await response.json();
            const latestVersion = data.tag_name.replace(/^v/, ''); // 去除可能的v前缀
            const currentVersion = chrome.runtime.getManifest().version;
            console.log('最新版本:', latestVersion, '当前版本:', currentVersion);

            // 版本对比
            if (compareVersions(latestVersion, currentVersion) > 0) {
                showNotification(latestVersion, `https://github.com/${REPO_OWNER}/${REPO_NAME}/archive/refs/tags/${latestVersion}.zip`);

                // 记录今天已经提醒过
                chrome.storage.local.set({ WQP_LastNotifyDate: today });
            }
        });

    } catch (error) {
        console.error('检查更新失败:', error);
    }
}

// 显示通知
function showNotification(version, url) {
    chrome.notifications.create({
        type: 'basic',
        iconUrl: chrome.runtime.getURL('img/logo-128.png'), // 使用插件内的图片
        title: '发现新版本(WorldQuant Scope插件)',
        message: `点击下载 ${version}`,
    }, () => {
        chrome.notifications.onClicked.addListener(() => {
            chrome.tabs.create({ url });
        });
    });
}



// 获取数据集列表
async function getDataSetList() {
    const data = await getJsonDataFile(DATA_SET_LIST_PATH);
    if (!Array.isArray(data)) {
        throw new Error(`${DATA_SET_LIST_PATH} is not a valid data set list`);
    }
    return data;
}

// 注入分布图脚本
function injectionDistributionScript(tabId) {
    try {
        chrome.scripting.insertCSS({
            target: { tabId: tabId },
            files: [`${PATHS.platformDistribution}/distribution.css`],
        });
        chrome.scripting.executeScript({
            target: { tabId: tabId },
            files: [
                `${PATHS.vendorJs}/chart.js`,
                `${PATHS.sharedContent}/utils.js`,
                `${PATHS.platformDistribution}/distribution.js`,
            ],
        });
    } catch (error) {
        console.error('Script injection failed: ', error);
    }
}
// 注入数据标记脚本
async function injectionDataFlagScript(tabId, tab) {
    if (dataSetList === null) {
        try {
            dataSetList = await getDataSetList();
        } catch (error) {
            console.warn('Unable to load dataSetList from IndexedDB.', error);
            dataSetList = [];
        }
    }
    try {
        // 注入数据标记脚本
        chrome.scripting.executeScript({
            target: { tabId: tabId },
            files: [
                `${PATHS.sharedContent}/utils.js`,
                `${PATHS.platformData}/dataFlag.js`,
            ],
        }, () => {
            chrome.scripting.executeScript({
                target: { tabId },
                // 仅传递必要的元数据，不传递巨大的 dataInfo 对象
                args: [dataSetList, tab.url],
                func: (...args) => dataFlagFunc(...args),
            });
        });

    }
    catch (error) {
        console.error('Script injection failed: ', error);
    }
}

// 注入 Genius 脚本
function injectionGeniusScript(tabId) {
    try {
        // 注入 CSS 文件
        chrome.scripting.insertCSS({
            target: { tabId: tabId },
            files: [
                `${PATHS.platformGenius}/genius.css`,
                `${PATHS.platformStyles}/idcard.css`,
                `${PATHS.vendorCss}/dataTables.dataTables.css`,
                `${PATHS.vendorCss}/columnControl.dataTables.min.css`,
                `${PATHS.vendorCss}/responsive.dataTables.min.css`,
                `${PATHS.vendorCss}/buttons.dataTables.min.css`,
            ],
        }, () => {
            if (chrome.runtime.lastError) {
                console.error("CSS注入失败", chrome.runtime.lastError.message);
            } else {
                console.log("CSS注入成功");
            }
        });

        // 检查是否已经注入了js脚本
        chrome.scripting.executeScript({
            target: { tabId: tabId },
            func: () => {
                return typeof OptUrl !== 'undefined';
            },
        }, (results) => {
            if (!results || !results[0].result) {
                // 如果 OptUrl 未定义，则注入脚本
                chrome.scripting.executeScript({
                    target: { tabId: tabId },
                    files: [
                        `${PATHS.sharedContent}/requestMonitorUI.js`,
                        `${PATHS.vendorJs}/jquery-3.7.0.min.js`,
                        `${PATHS.vendorJs}/jquery.dataTables.min.js`,
                        `${PATHS.vendorJs}/dataTables.columnControl.min.js`,
                        `${PATHS.vendorJs}/columnControl.dataTables.min.js`,
                        `${PATHS.vendorJs}/dataTables.responsive.min.js`,
                        `${PATHS.vendorJs}/responsive.dataTables.min.js`,
                        `${PATHS.vendorJs}/dataTables.buttons.min.js`,
                        `${PATHS.vendorJs}/buttons.colVis.min.js`,
                        `${PATHS.vendorJs}/buttons.html5.min.js`,
                        `${PATHS.sharedContent}/utils.js`,
                        `${PATHS.sharedContent}/uiCard.js`,
                        `${PATHS.platformGenius}/genius.js`,
                    ],
                });
            }
            else {
                // 如果 OptUrl 已定义，则直接注入数据
                chrome.scripting.executeScript({
                    target: { tabId: tabId },
                    args: [],
                    func: (...args) => watchForElementAndInsertButton(...args),
                });
                // 同时确保请求监视器 UI 注入
                chrome.scripting.executeScript({
                    target: { tabId: tabId },
                    files: [`${PATHS.sharedContent}/requestMonitorUI.js`],
                });
            }
        });
        console.log(tabId.url);
    } catch (error) {
        console.error('Script injection failed: ', error);
    }
}

function injectionSimulateScript(tabId) {
    try {
        chrome.scripting.insertCSS({
            target: { tabId: tabId },
            files: [
                `${PATHS.platformSimulate}/simulate.css`,
            ],
        });
        chrome.scripting.executeScript({
            target: { tabId: tabId },
            files: [
                `${PATHS.platformSimulate}/simulate.js`,
            ],
        });
    } catch (error) {
        console.error('Script injection failed: ', error);
    }
}

function isExcluded(url) {
    if (!url) return false;
    if (!Array.isArray(EXCLUDED_PREFIXES) || EXCLUDED_PREFIXES.length === 0) return false;
    return EXCLUDED_PREFIXES.some(p => typeof p === 'string' && url.startsWith(p));
}

const MAX_BODY_LEN = 2000;
function extractRequestBody(requestBody) {
    try {
        if (!requestBody) return '';
        if (requestBody.formData) {
            const parts = [];
            for (const k of Object.keys(requestBody.formData)) {
                const vals = requestBody.formData[k];
                if (Array.isArray(vals)) {
                    for (const v of vals) parts.push(`${k}=${String(v)}`);
                } else {
                    parts.push(`${k}=${String(vals)}`);
                }
            }
            return parts.join('&').slice(0, MAX_BODY_LEN);
        }
        if (requestBody.raw && Array.isArray(requestBody.raw) && requestBody.raw.length > 0) {
            const chunk = requestBody.raw[0];
            const bytes = chunk.bytes;
            if (bytes) {
                const u8 = new Uint8Array(bytes);
                const txt = new TextDecoder('utf-8').decode(u8);
                return txt.slice(0, MAX_BODY_LEN);
            }
        }
    } catch (e) {
        console.warn('extractRequestBody failed', e);
    }
    return '';
}
