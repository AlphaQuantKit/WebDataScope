// background.js: 后台脚本，用于监听浏览器事件，如标签页更新、插件安装等，以及与content scripts和popup交互
console.log('Background script is running.');
// 以副作用方式加载 pako（UMD 构建会挂到 globalThis.pako），适配 MV3 Service Worker
import './lib/pako.min.js';
import './lib/msgpack.min.js';

const dataSetListUrl = chrome.runtime.getURL(`data/dataSetList.json`);
const dataInfoUrl = chrome.runtime.getURL(`data/oth/info_data.bin`);
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


// 初始化设置
chrome.runtime.onInstalled.addListener(async () => {
    chrome.storage.local.get('WQPSettings', ({ WQPSettings }) => {
        // 如果没有找到 WQPSettings，则设置默认值
        if (!WQPSettings) {
            const defaultSettings = {
                apiAddress: "https://wq-backend.vercel.app",
                hiddenFeatureEnabled: false,
                dataAnalysisEnabled: true,
                geniusAlphaCount: 40,
                geniusCombineTag: true,
                apiMonitorEnabled: true,
            };

            // 将默认设置保存到 Chrome 存储中
            chrome.storage.local.set({ WQPSettings: defaultSettings }, () => {
                console.log('Default settings have been applied.');
            });
        } else {
            console.log('Current settings:', WQPSettings);
        }
    });
    // 获取数据集列表
    dataSetList = await getDataSetList();
    checkUpdate();
});

// 设置定时器，每天检查一次更新
chrome.runtime.onStartup.addListener(() => {
    checkUpdate();
});



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
    // 排除 genius 页面，避免干扰 genius 功能
    if (details.url.includes('/genius')) return;
    injectFetchInterceptor(details.tabId);
}, { url: [{ hostContains: 'platform.worldquantbrain.com' }] });

// 注入 Fetch 拦截器到页面的 MAIN 环境中
function injectFetchInterceptor(tabId) {
    chrome.scripting.executeScript({
        target: { tabId: tabId },
        world: "MAIN", // 必须指定 MAIN，否则无法覆盖页面本身的 window.fetch
        func: () => {

            // 将辅助函数定义在注入的内容脚本内
            function getAlphaCheckStates(originalData) {
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
                    "OLD_SIMULATION"                        
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
                originalData.results.forEach(item => {
                    // 容错处理：如果is/checks不存在，直接赋值0
                    if (!item?.is?.checks || !Array.isArray(item.is.checks)) {
                        item.is.failedNumRA = 0;
                        item.is.failedNumPPA = 0;
                        return;
                    }
                    item.is.failedNumRA = item.is.checks.filter(check => 
                        RA_CHECK_NAMES.includes(check.name) && check.result !== 'PASS' && check.result !== 'PENDING'
                    ).length;
                    
                    item.is.failedNumPPA = item.is.checks.filter(check => 
                        (PPA_CHECK_NAMES.includes(check.name) && check.result !== 'PASS' && check.result !== 'PENDING') || (check.name === "LOW_SHARPE" && check.value < 1)
                    ).length;
                    
                    item.is.WQPPYS = item.is.checks
                        .find(check => check.name === "MATCHES_PYRAMID")?.pyramids
                        ?.map(pyramid => (pyramid.name?.split('/').pop() || '').toLowerCase())
                        ?.join('/') || '';

                    
                });
                return originalData;
            }

            if (window.__wq_fetch_intercepted) return;
            window.__wq_fetch_intercepted = true;

            const originalFetch = window.fetch;
            window.fetch = async function (...args) {
                
                const url = typeof args[0] === 'string' ? args[0] : (args[0]?.url || '');
                const method = typeof args[0] === 'string' ? (args[1]?.method || 'GET') : (args[0]?.method || 'GET');

                // 重试逻辑：仅对 WQ API 的 GET 请求启用网络错误和服务端错误重试
                const maxRetries = 10;
                const retryStatuses = [429, 500, 502, 503, 504];
                const isTarget = method.toUpperCase() === 'GET' && url.startsWith('https://api.worldquantbrain.com/');

                const fetchWithRetry = async (retryCount = 0) => {
                    try {
                        const res = await originalFetch.apply(this, args);
                        if (isTarget && retryStatuses.includes(res.status) && retryCount < maxRetries) {
                            console.log(`[WQP] 请求失败(${res.status})，第${retryCount + 1}次重试: ${url}`);
                            await new Promise(r => setTimeout(r, (retryCount + 1) * 500));
                            return fetchWithRetry(retryCount + 1);
                        }
                        return res;
                    } catch (err) {
                        if (isTarget && retryCount < maxRetries && err.message?.includes('Failed to fetch')) {
                            console.log(`[WQP] 网络错误，第${retryCount + 1}次重试: ${url}`);
                            await new Promise(r => setTimeout(r, (retryCount + 1) * 500));
                            return fetchWithRetry(retryCount + 1);
                        }
                        throw err;
                    }
                };

                // 执行原始请求（带重试）
                const response = await fetchWithRetry();
                // ========== ProdMemo 拦截逻辑 ==========
                try {
                    const responseUrl = response.url;

                    // 1. 拦截 Prod Correlation 数据
                    if (responseUrl.includes('/correlations/prod')) {
                        const prodMatch = responseUrl.match(/\/alphas\/([^/]+)\/correlations\/prod/);
                        if (prodMatch && response.ok && response.status !== 204) {
                            const alphaId = prodMatch[1];
                            const clone = response.clone();
                            clone.text().then(text => {
                                if (!text) return;
                                try {
                                    const data = JSON.parse(text);
                                    window.postMessage({
                                        type: 'WQSCOPE_PRODMEMO_DATA',
                                        alphaId: alphaId,
                                        data: data
                                    }, '*');
                                } catch (parseErr) {}
                            }).catch(() => {});
                        }
                    }

                    // 2. 拦截 Alpha Page Load (Recordsets) 触发 UI 检查
                    const recordsetsMatch = responseUrl.match(/\/alphas\/([^/]+)\/recordsets(?:[?#]|$)/);
                    if (recordsetsMatch) {
                        const alphaId = recordsetsMatch[1];
                        window.postMessage({
                            type: 'WQSCOPE_PRODMEMO_VIEW',
                            alphaId: alphaId
                        }, '*');
                    }

                } catch (e) {}
                // ========== ProdMemo 拦截逻辑结束 ==========

                // 拦截并修改 /users/self/alphas 接口响应，同时发送 ProdMemo 列表数据
                if (url && url.includes("https://api.worldquantbrain.com/users/self/alphas") && !url.includes('/alphas/')) {
                    try {
                        const clone = response.clone();
                        let originalData = await clone.json();

                        // 👉 自定义你的修改逻辑（先执行，确保 failedNumRA/PPA 被计算）
                        const modifiedData = getAlphaCheckStates(originalData);
                        console.log('拦截并修改了 alphas 响应：', modifiedData);

                        // 发送 ProdMemo 列表数据（在 getAlphaCheckStates 之后，从 modifiedData 获取数据）
                        if (response.ok && response.status !== 204 && modifiedData.results && Array.isArray(modifiedData.results)) {
                            const alphaIds = modifiedData.results.map(r => r.id);
                            const isDataMap = {};
                            modifiedData.results.forEach(alpha => {
                                const alphaId = alpha.id;
                                let isPassed = null;
                                let multiplier = null;
                                let pyramids = [];
                                let failedNumRA = 0;
                                let failedNumPPA = 0;
                                let operatorCount = null;

                                if (alpha.is && alpha.is.checks) {
                                    const checks = alpha.is.checks;
                                    const hasFail = checks.some(c => c?.result === 'FAIL');
                                    isPassed = !hasFail;

                                    const pyramidCheck = checks.find(c => c && c.name === 'MATCHES_PYRAMID');
                                    if (pyramidCheck) {
                                        multiplier = pyramidCheck.multiplier;
                                        if (pyramidCheck.pyramids && Array.isArray(pyramidCheck.pyramids)) {
                                            pyramids = pyramidCheck.pyramids.map(p => {
                                                const nameParts = p.name.split('/');
                                                return nameParts[nameParts.length - 1].toLowerCase();
                                            });
                                        }
                                    }

                                    // 获取 failedNumRA 和 failedNumPPA（现在已经被 getAlphaCheckStates 计算好了）
                                    failedNumRA = alpha.is.failedNumRA || 0;
                                    failedNumPPA = alpha.is.failedNumPPA || 0;
                                }

                                // 获取 operatorCount（注意：0 是有效值，不能用 ||）
                                operatorCount = alpha.regular?.operatorCount ?? null;

                                // SUPER 类型 multiplier 强制为 1
                                if (alpha.type === 'SUPER') {
                                    multiplier = 1;
                                }

                                isDataMap[alphaId] = { isPassed, multiplier, pyramids: pyramids.join('/'), failedNumRA, failedNumPPA, operatorCount };
                            });

                            window.postMessage({
                                type: 'WQSCOPE_PRODMEMO_LIST',
                                alphaIds: alphaIds,
                                isDataMap: isDataMap
                            }, '*');
                        }
                        
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
            chrome.tabs.sendMessage(t.id, { type: 'REQ_MONITOR_NEW', data: rec }).catch(() => {});
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
        chrome.storage.local.get('lastNotifyDate', async ({ lastNotifyDate }) => {
            console.log('上次提醒日期:', lastNotifyDate);
            if (lastNotifyDate === today) {
                console.log('今天已经提醒过，无需重复提醒');
                return;
            }
            console.log('今天尚未提醒过，开始检查更新');

            // 获取 GitHub 上的最新版本
            const response = await fetch(
                `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/releases/latest`
            );
            const data = await response.json();
            if (!data?.tag_name) {
                console.log('[WQP] 检查更新失败：无法获取最新版本信息', data);
                return;
            }
            const latestVersion = data.tag_name.replace(/^v/, ''); // 去除可能的v前缀
            const currentVersion = chrome.runtime.getManifest().version;
            console.log('最新版本:', latestVersion, '当前版本:', currentVersion);

            // 版本对比
            if (compareVersions(latestVersion, currentVersion) > 0) {
                showNotification(latestVersion, `https://github.com/${REPO_OWNER}/${REPO_NAME}/archive/refs/tags/${latestVersion}.zip`);

                // 记录今天已经提醒过
                chrome.storage.local.set({ lastNotifyDate: today });
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
    const response = await fetch(dataSetListUrl);
    if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status} for ${dataSetListUrl}`);
    }
    const data = await response.json(); // Parse JSON data
    return data
}

// 注入分布图脚本
function injectionDistributionScript(tabId) {
    try {
        chrome.scripting.insertCSS({
            target: { tabId: tabId },
            files: ['src/css/distribution.css'],
        });
        chrome.scripting.executeScript({
            target: { tabId: tabId },
            files: ['src/scripts/lib/chart.js', "src/scripts/utils.js", 'src/scripts/distribution.js'],
        });
    } catch (error) {
        console.error('Script injection failed: ', error);
    }
}
// 注入数据标记脚本
async function injectionDataFlagScript(tabId, tab) {
    if (dataSetList === null) {
        dataSetList = await getDataSetList();
    }
    // 获取当前扩展版本号，用于缓存版本控制
    const version = chrome.runtime.getManifest().version;

    try {
        // 必须注入 pako 和 msgpack 供 content script 使用
        chrome.scripting.executeScript({
            target: { tabId: tabId },
            files: [
                "src/scripts/lib/pako.min.js",
                "src/scripts/lib/msgpack.min.js",
                "src/scripts/utils.js", 
                "src/scripts/dataFlag.js"
            ],
        }, () => {
            chrome.scripting.executeScript({
                target: { tabId },
                // 仅传递必要的元数据，不传递巨大的 dataInfo 对象
                args: [dataSetList, dataInfoUrl, version, tab.url],
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
                "src/css/genius.css",
                "src/css/idcard.css",
                "src/css/dataTables.dataTables.css",
                "src/css/columnControl.dataTables.min.css",
                "src/css/responsive.dataTables.min.css",
                "src/css/buttons.dataTables.min.css",
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
                        "src/scripts/requestMonitorUI.js",
                        "src/scripts/lib/jquery-3.7.0.min.js",
                        "src/scripts/lib/jquery.dataTables.min.js",
                        "src/scripts/lib/dataTables.columnControl.min.js",
                        "src/scripts/lib/columnControl.dataTables.min.js",
                        "src/scripts/lib/dataTables.responsive.min.js",
                        "src/scripts/lib/responsive.dataTables.min.js",
                        "src/scripts/lib/dataTables.buttons.min.js",
                        "src/scripts/lib/buttons.colVis.min.js",
                        "src/scripts/lib/buttons.html5.min.js",
                        "src/scripts/utils.js",
                        "src/scripts/uiCard.js",
                        "src/scripts/genius.js"],
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
                    files: ["src/scripts/requestMonitorUI.js"],
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
                "src/css/simulate.css",
            ],
        });
        chrome.scripting.executeScript({
            target: { tabId: tabId },
            files: [
                "src/scripts/simulate.js",
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
