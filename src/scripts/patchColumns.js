(function () {
    'use strict';
    // 通过 manifest content_scripts 的 world: "MAIN" + run_at: "document_start" 注入，
    // 在 MAIN world 中同步启动，保证在页面任何 <script> 执行之前就已就位。
    // 这与油猴的效果完全等价。

    const SEARCH = '},...e===i.kC.SUBMITTED?[l]:[c],...a?[d]:[],{';
    const VERSION_REGEX = /version:\s*"1\.0\.6"/;
    const VERSION_REPLACE = 'version:"1.0.6-wqp5"';

    const EXTRA_COLUMNS = [
        {
            id: 'id',
            name: 'Alpha ID',
            active: false,
            category: 'WQP',
            activeTabsWithoutParent: ['unsubmitted', 'submitted'],
            display: true,
            type: 'string',
            width: 100
        },
        {
            id: 'failedNumRA',
            parent: 'is',
            name: 'Failed RA',
            active: true,
            // filterOperator: "~",
            category: 'WQP',
            activeTabsWithoutParent: ['unsubmitted', 'submitted'],
            display: true,
            type: 'integer',
            width: 80
        },
        {
            id: 'failedNumPPA',
            parent: 'is',
            name: 'Failed PPA',
            active: true,
            // filterOperator: "~",
            category: 'WQP',
            activeTabsWithoutParent: ['unsubmitted', 'submitted'],
            display: true,
            type: 'integer',
            width: 80
        },
        {
            id: 'WQPPYS',
            parent: 'is',
            name: 'Pyramid',
            active: false,
            category: 'WQP',
            activeTabsWithoutParent: ['unsubmitted', 'submitted'],
            display: true,
            type: 'string',
        },
        {
            id: 'operatorCount',
            parent: 'regular',
            name: 'Operator Count',
            active: false,
            category: 'WQP',
            activeTabsWithoutParent: ['unsubmitted', 'submitted'],
            display: true,
            type: 'integer',
            width: 80
        },
    ];
    function buildReplacement() {
        const colsJson = EXTRA_COLUMNS.map(col => JSON.stringify(col)).join(',');
        return `},...e===i.kC.SUBMITTED?[l]:[c],...a?[d]:[],${colsJson},{`;
    }

    async function fetchPatchAndRun(src) {
        try {
            let code = await (await fetch(src)).text();
            let patched = false;
            if (code.includes(SEARCH)) {
                code = code.replace(SEARCH, buildReplacement());
                code = code.replace('readOnly:!0,display:!0,', 'readOnly:!1,display:!0,');
                console.log('[WQP] patchColumns: 成功注入列定义', src);
                patched = true;
            } else {
                console.warn('[WQP] patchColumns: 未找到列特征串，直接执行原始代码', src);
            }
            if (patched && VERSION_REGEX.test(code)) {
                code = code.replace(VERSION_REGEX, VERSION_REPLACE);
                console.log('[WQP] patchColumns: 成功升级 version，强制刷新 localStorage 缓存', src);
            }
            const s = document.createElement('script');
            s.textContent = code;
            document.head.appendChild(s);
            s.remove();
        } catch (e) {
            console.error('[WQP] patchColumns: 失败，回退原始加载', e, src);
            const s = document.createElement('script');
            s.src = src;
            document.head.appendChild(s);
        }
    }

    new MutationObserver((mutations) => {
        for (const mutation of mutations) {
            for (const node of mutation.addedNodes) {
                if (
                    node.nodeName === 'SCRIPT' &&
                    node.src &&
                    node.src.startsWith('https://platform.worldquantbrain.com/static/js/') &&
                    node.src.endsWith('.js') &&
                    !node.__wqp_done
                ) {
                    node.__wqp_done = true;
                    node.remove();
                    fetchPatchAndRun(node.src);
                }
            }
        }
    }).observe(document, { childList: true, subtree: true });

    console.log('[WQP] patchColumns: MutationObserver 已在 MAIN world 启动');
})();

