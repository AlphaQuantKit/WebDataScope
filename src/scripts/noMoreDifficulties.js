/*
  ！！！注意 ！！！
  noMoreDifficulties 的 fetch 重试逻辑已迁移至 background.js 的 injectFetchInterceptor 中，
  通过 chrome.scripting.executeScript({ world: "MAIN" }) 注入，不受 CSP 限制。
  
  原内容脚本内联注入的方式已被 WQ 的 CSP script-src 策略拦截（缺少 'unsafe-inline'），
  因此本文件仅保留为空壳。如需修改重试逻辑，请编辑 background.js 中的 fetchWithRetry。
*/
(function () {
    'use strict';
    console.log('[WQP] noMoreDifficulties: 功能已迁移至 background.js');
})();