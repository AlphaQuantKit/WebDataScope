import { constantTimeEqual, decryptText, hmacHex, sha256Hex } from './crypto.js';

export async function adminRequest(request, env, url) {
    if (!await requireAdmin(request, env)) return unauthorizedResponse();
    if (url.pathname === '/admin' && request.method === 'GET') return adminPageV2();
    if (url.pathname === '/api/admin/summary' && request.method === 'GET') return adminSummary(env);
    if (url.pathname === '/api/admin/uploads' && request.method === 'GET') return adminUploads(url, env);
    if (url.pathname === '/api/admin/contributors' && request.method === 'GET') return adminContributors(url, env);
    if (url.pathname === '/api/admin/alphas' && request.method === 'GET') return adminAlphas(url, env);
    const revokeMatch = url.pathname.match(/^\/api\/admin\/contributors\/([0-9a-f]{64})\/revoke$/);
    if (revokeMatch && request.method === 'POST') return revokeContributor(revokeMatch[1], env);
    if (url.pathname === '/api/admin/rebuild' && request.method === 'POST') {
        const { queueSnapshotBuild } = await import('./index.js');
        const state = await env.DB.prepare('SELECT source_revision FROM snapshot_publication_state WHERE id = 1').first();
        const snapshot = await queueSnapshotBuild(env, 'admin-rebuild', {
            sourceRevision: Number(state?.source_revision || 0),
        });
        return adminJson({ ok: true, snapshot });
    }
    return adminJson({ ok: false, error: 'not_found' }, 404);
}

async function requireAdmin(request, env) {
    const authorization = request.headers.get('Authorization') || '';
    if (!authorization.startsWith('Basic ') || !env.ADMIN_AUTH_DIGEST) return false;
    let credentials;
    try { credentials = atob(authorization.slice(6)); } catch { return false; }
    return constantTimeEqual(await sha256Hex(credentials), String(env.ADMIN_AUTH_DIGEST).toLowerCase());
}

function unauthorizedResponse() {
    return new Response('Authentication required.', {
        status: 401,
        headers: {
            'WWW-Authenticate': 'Basic realm="WebDataScope PNL share admin", charset="UTF-8"',
            'Cache-Control': 'no-store',
            'X-Robots-Tag': 'noindex, nofollow, noarchive',
        },
    });
}

function adminJson(value, status = 200) {
    return new Response(JSON.stringify(value), {
        status,
        headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'no-store',
            'X-Content-Type-Options': 'nosniff',
            'X-Frame-Options': 'DENY',
            'Referrer-Policy': 'no-referrer',
            'X-Robots-Tag': 'noindex, nofollow, noarchive',
        },
    });
}

async function adminSummary(env) {
    const [contributors, installations, alphas, points, uploads, snapshot, keys] = await Promise.all([
        env.DB.prepare('SELECT COUNT(*) AS count FROM contributors').first(),
        env.DB.prepare('SELECT COUNT(*) AS count FROM installations').first(),
        env.DB.prepare('SELECT COUNT(*) AS count FROM shared_alphas').first(),
        env.DB.prepare('SELECT COALESCE(SUM(pnl_point_count), 0) AS count FROM shared_alphas').first(),
        env.DB.prepare('SELECT status, COUNT(*) AS count FROM upload_audit GROUP BY status').all(),
        env.DB.prepare('SELECT * FROM snapshots WHERE id = 1').first(),
        env.DB.prepare('SELECT COUNT(*) AS count FROM access_keys WHERE revoked_at IS NULL AND expires_at > ?').bind(Date.now()).first(),
    ]);
    return adminJson({
        contributors: Number(contributors?.count || 0),
        installations: Number(installations?.count || 0),
        alphaRecords: Number(alphas?.count || 0),
        pnlPoints: Number(points?.count || 0),
        activeKeys: Number(keys?.count || 0),
        uploads: uploads.results || [],
        snapshot: snapshot || null,
    });
}

async function adminUploads(url, env) {
    const page = Math.max(1, Math.min(1_000_000, Number(url.searchParams.get('page') || 1)));
    const pageSize = Math.max(1, Math.min(100, Number(url.searchParams.get('pageSize') || 25)));
    const result = await env.DB.prepare(`
        SELECT upload_id, account_hash, status, reason, record_count, pnl_point_count, created_at, finalized_at
        FROM upload_audit ORDER BY created_at DESC LIMIT ? OFFSET ?
    `).bind(pageSize, (page - 1) * pageSize).all();
    const total = await env.DB.prepare('SELECT COUNT(*) AS count FROM upload_audit').first();
    return adminJson({ page, pageSize, total: Number(total?.count || 0), uploads: result.results || [] });
}

async function adminContributors(url, env) {
    const page = Math.max(1, Math.min(1_000_000, Number(url.searchParams.get('page') || 1)));
    const pageSize = Math.max(1, Math.min(100, Number(url.searchParams.get('pageSize') || 25)));
    const result = await env.DB.prepare(`
        SELECT c.account_hash, c.encrypted_wq_id, c.encryption_iv, c.key_version,
               c.active_key_hash, c.key_expires_at, c.disabled,
               COUNT(a.alias) AS alpha_count
        FROM contributors c LEFT JOIN shared_alphas a ON a.account_hash = c.account_hash
        GROUP BY c.account_hash
        ORDER BY c.last_seen_at DESC LIMIT ? OFFSET ?
    `).bind(pageSize, (page - 1) * pageSize).all();
    const users = [];
    for (const row of result.results || []) {
        let wqId = '[解密失败]';
        try {
            const secret = env[`WQ_ID_ENCRYPTION_KEY_V${Number(row.key_version)}`];
            if (secret) wqId = await decryptText(row.encrypted_wq_id, row.encryption_iv, secret);
        } catch { /* Never log identifiers. */ }
        users.push({
            accountHash: row.account_hash,
            wqId,
            active: !Number(row.disabled),
            keyExpiresAt: Number(row.key_expires_at || 0),
            alphaCount: Number(row.alpha_count || 0),
        });
    }
    const total = await env.DB.prepare('SELECT COUNT(*) AS count FROM contributors').first();
    return adminJson({ page, pageSize, total: Number(total?.count || 0), contributors: users });
}

async function adminAlphas(url, env) {
    const page = Math.max(1, Math.min(1_000_000, Number(url.searchParams.get('page') || 1)));
    const pageSize = Math.max(1, Math.min(100, Number(url.searchParams.get('pageSize') || 25)));
    const search = String(url.searchParams.get('q') || '').trim().slice(0, 128);
    const select = `
        SELECT alias, encrypted_alpha_id, alpha_iv, key_version, account_hash,
               source_type, group_key, prod_corr, classifications_json,
               pnl_point_count, fingerprint, updated_at
    `;
    const searchAlias = search
        ? (search.startsWith('alpha_')
            ? search.toLowerCase()
            : `alpha_${await hmacHex(String(env.ALPHA_ALIAS_SECRET || ''), search)}`)
        : '';
    const result = search
        ? await env.DB.prepare(`${select} FROM shared_alphas WHERE alias = ? LIMIT 1`).bind(searchAlias).all()
        : await env.DB.prepare(`${select} FROM shared_alphas ORDER BY updated_at DESC LIMIT ? OFFSET ?`)
            .bind(pageSize, (page - 1) * pageSize).all();
    const decoded = [];
    for (const row of result.results || []) {
        let alphaId = '[解密失败]';
        try {
            const secret = env[`ALPHA_ID_ENCRYPTION_KEY_V${Number(row.key_version)}`];
            if (secret) alphaId = await decryptText(row.encrypted_alpha_id, row.alpha_iv, secret);
        } catch { /* Never log identifiers. */ }
        decoded.push({
            alias: row.alias,
            alphaId,
            accountHash: row.account_hash,
            sourceType: row.source_type,
            groupKey: row.group_key,
            prodCorr: Number(row.prod_corr),
            classifications: JSON.parse(row.classifications_json || '[]'),
            pnlPointCount: Number(row.pnl_point_count || 0),
            fingerprint: row.fingerprint,
            updatedAt: Number(row.updated_at || 0),
        });
    }
    const alphas = decoded;
    const total = search
        ? decoded.length
        : Number((await env.DB.prepare('SELECT COUNT(*) AS count FROM shared_alphas').first())?.count || 0);
    const stats = await adminAlphaStats(env);
    return adminJson({ page, pageSize, total, search, alphas, stats });
}

async function adminAlphaStats(env) {
    const [sources, groups, corrBuckets] = await Promise.all([
        env.DB.prepare(`
            SELECT source_type AS label, COUNT(*) AS count,
                   COALESCE(SUM(pnl_point_count), 0) AS pnl_points
            FROM shared_alphas GROUP BY source_type ORDER BY count DESC
        `).all(),
        env.DB.prepare(`
            SELECT group_key AS label, COUNT(*) AS count,
                   COALESCE(SUM(pnl_point_count), 0) AS pnl_points
            FROM shared_alphas GROUP BY group_key ORDER BY count DESC LIMIT 12
        `).all(),
        env.DB.prepare(`
            SELECT CASE
                WHEN prod_corr < -0.5 THEN '[-1, -0.5)'
                WHEN prod_corr < 0 THEN '[-0.5, 0)'
                WHEN prod_corr < 0.5 THEN '[0, 0.5)'
                WHEN prod_corr < 1 THEN '[0.5, 1)'
                ELSE '[1, 1]'
            END AS label,
            COUNT(*) AS count,
            COALESCE(SUM(pnl_point_count), 0) AS pnl_points
            FROM shared_alphas GROUP BY label ORDER BY MIN(prod_corr)
        `).all(),
    ]);
    const normalize = (result) => (result.results || []).map((row) => ({
        label: String(row.label || ''),
        count: Number(row.count || 0),
        pnlPoints: Number(row.pnl_points || 0),
    }));
    return {
        sources: normalize(sources),
        groups: normalize(groups),
        corrBuckets: normalize(corrBuckets),
    };
}

async function revokeContributor(accountHash, env) {
    const timestamp = Date.now();
    await env.DB.batch([
        env.DB.prepare('UPDATE contributors SET disabled = 1 WHERE account_hash = ?').bind(accountHash),
        env.DB.prepare('UPDATE installations SET disabled = 1 WHERE account_hash = ?').bind(accountHash),
        env.DB.prepare('UPDATE access_keys SET revoked_at = ? WHERE account_hash = ? AND revoked_at IS NULL').bind(timestamp, accountHash),
        env.DB.prepare('INSERT INTO admin_audit (action, target, created_at) VALUES (?, ?, ?)').bind('revoke_contributor', accountHash, timestamp),
    ]);
    return adminJson({ ok: true, revoked: accountHash });
}

function adminPageV2() {
    const nonce = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(18))));
    const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>PNL / Prod Corr 共享管理</title>
<style>
body{font:14px system-ui;max-width:1200px;margin:24px auto;padding:0 16px;color:#172033;background:#f5f7fb}
.card{background:#fff;border:1px solid #dfe4ef;border-radius:12px;padding:16px;margin:12px 0}
.cards{display:grid;grid-template-columns:repeat(5,1fr);gap:10px}
.metric{font-size:22px;font-weight:700}
.muted{color:#68738a}
button{padding:8px 12px;border-radius:8px;border:1px solid #ccd4e2;background:#fff;cursor:pointer}
button:disabled{cursor:not-allowed;opacity:.55}
.toolbar,.alpha-toolbar{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.alpha-toolbar{margin:12px 0}
.alpha-toolbar input{min-width:280px;padding:8px 10px;border:1px solid #ccd4e2;border-radius:8px}
.chart-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;margin:12px 0 16px}
.chart-panel{min-width:0;border:1px solid #e5e9f1;border-radius:8px;padding:10px}
.chart-panel h3{font-size:14px;margin:0 0 6px}
.chart-panel svg{display:block;width:100%;height:220px}
.chart-panel text{font:12px system-ui;fill:#172033}
.chart-panel .bar{fill:#246bfd}
.chart-panel .grid-line{stroke:#e5e9f1;stroke-width:1}
.table{overflow:auto}
table{border-collapse:collapse;width:100%}
th,td{text-align:left;padding:8px;border-bottom:1px solid #e5e9f1;white-space:nowrap}
.secret{cursor:pointer;color:#246bfd}
@media(max-width:900px){.chart-grid{grid-template-columns:1fr 1fr}}
@media(max-width:760px){.cards{grid-template-columns:repeat(2,1fr)}.chart-grid{grid-template-columns:1fr}.alpha-toolbar input{min-width:220px;width:100%}}
</style>
</head>
<body>
<h1>PNL / Prod Corr 共享管理</h1>
<p class="muted">WQ ID 与 Alpha ID 默认遮蔽，点击才显示；生产环境建议在 Worker 前再启用 Cloudflare Access + MFA。</p>
<div class="toolbar"><button id="refresh" type="button">刷新</button><button id="rebuild" type="button">重建快照</button></div>
<div id="metrics" class="cards"></div>
<div class="card"><h2>贡献者</h2><div class="table"><table><thead><tr><th>WQ ID</th><th>Alpha 数</th><th>Key 到期</th><th>状态</th></tr></thead><tbody id="contributors"></tbody></table></div></div>
<div class="card">
  <h2>Alpha / PnL 明细</h2>
  <div class="alpha-toolbar">
    <label for="alphaSearch">搜索 Alpha ID</label>
    <input id="alphaSearch" type="search" placeholder="输入完整 Alpha ID" autocomplete="off">
    <button id="alphaSearchBtn" type="button">搜索</button>
    <button id="alphaClearBtn" type="button">清除</button>
    <span id="alphaCount" class="muted"></span>
  </div>
  <div class="chart-grid" aria-label="Alpha 与 PnL 统计图">
    <div class="chart-panel"><h3>来源 Alpha 数</h3><svg id="sourceChart" role="img" aria-label="按来源统计 Alpha 数"></svg></div>
    <div class="chart-panel"><h3>来源 PnL 点数</h3><svg id="pnlChart" role="img" aria-label="按来源统计 PnL 点数"></svg></div>
    <div class="chart-panel"><h3>分组 Alpha 数（前 12）</h3><svg id="groupChart" role="img" aria-label="按分组统计 Alpha 数"></svg></div>
    <div class="chart-panel"><h3>Prod Corr 分布</h3><svg id="corrChart" role="img" aria-label="Prod Corr 区间分布"></svg></div>
  </div>
  <div class="table"><table><thead><tr><th>Alpha ID</th><th>Alias</th><th>来源</th><th>分组</th><th>Prod Corr</th><th>Classifications</th><th>PnL 点</th></tr></thead><tbody id="alphas"></tbody></table></div>
</div>
<div class="card"><h2>上传记录</h2><div class="table"><table><thead><tr><th>上传 ID</th><th>账号索引</th><th>状态</th><th>记录数</th><th>PnL 点数</th><th>时间</th></tr></thead><tbody id="uploads"></tbody></table></div></div>
<p id="status" class="muted"></p>
<script nonce="${nonce}">
const $ = (id) => document.getElementById(id);
const svgNs = 'http://www.w3.org/2000/svg';
const api = async (url, options) => {
  const response = await fetch(url, Object.assign({ cache: 'no-store' }, options || {}));
  const data = await response.json();
  if (!response.ok) throw Error(data.error || response.status);
  return data;
};
const cell = (tr, value) => { const td = document.createElement('td'); td.textContent = String(value == null ? '' : value); tr.append(td); };
const secretCell = (tr, value) => {
  const td = document.createElement('td');
  const raw = String(value == null ? '' : value);
  td.className = 'secret';
  td.textContent = raw.length > 8 ? raw.slice(0, 4) + '…' + raw.slice(-3) : '••••';
  td.setAttribute('title', '点击显示/隐藏');
  td.onclick = () => {
    td.dataset.open = td.dataset.open === '1' ? '0' : '1';
    td.textContent = td.dataset.open === '1' ? raw : (raw.length > 8 ? raw.slice(0, 4) + '…' + raw.slice(-3) : '••••');
  };
  tr.append(td);
};
const chartText = (text, x, y, anchor) => {
  const node = document.createElementNS(svgNs, 'text');
  node.setAttribute('x', String(x)); node.setAttribute('y', String(y));
  if (anchor) node.setAttribute('text-anchor', anchor);
  node.textContent = text; return node;
};
function drawBars(id, items) {
  const svg = $(id); svg.replaceChildren();
  const values = (items || []).slice(0, 12).map((item) => ({ label: String(item.label || ''), value: Number(item.count || 0) }));
  const width = 640; const rowHeight = 30; const height = Math.max(150, values.length * rowHeight + 32);
  svg.setAttribute('viewBox', '0 0 ' + width + ' ' + height);
  if (!values.length) { svg.append(chartText('暂无数据', width / 2, height / 2, 'middle')); return; }
  const left = 180; const right = 28; const plotWidth = width - left - right;
  const max = Math.max(1, ...values.map((item) => item.value));
  values.forEach((item, index) => {
    const y = 10 + index * rowHeight;
    const label = item.label.length > 22 ? item.label.slice(0, 21) + '…' : item.label;
    svg.append(chartText(label, left - 8, y + 18, 'end'));
    const grid = document.createElementNS(svgNs, 'line');
    grid.setAttribute('x1', String(left)); grid.setAttribute('x2', String(left + plotWidth));
    grid.setAttribute('y1', String(y + 22)); grid.setAttribute('y2', String(y + 22)); grid.setAttribute('class', 'grid-line');
    svg.append(grid);
    const bar = document.createElementNS(svgNs, 'rect');
    bar.setAttribute('x', String(left)); bar.setAttribute('y', String(y + 5));
    bar.setAttribute('width', String(Math.max(item.value ? 2 : 0, (item.value / max) * plotWidth)));
    bar.setAttribute('height', '16'); bar.setAttribute('rx', '3'); bar.setAttribute('class', 'bar');
    bar.setAttribute('data-tooltip', label + '：' + item.value); svg.append(bar);
    svg.append(chartText(String(item.value), left + (item.value / max) * plotWidth + 6, y + 18));
  });
}
function renderAlphas(data) {
  $('alphas').replaceChildren(...(data.alphas || []).map((item) => {
    const tr = document.createElement('tr');
    secretCell(tr, item.alphaId); cell(tr, item.alias); cell(tr, item.sourceType); cell(tr, item.groupKey);
    cell(tr, item.prodCorr); cell(tr, (item.classifications || []).map((value) => value.name || value.id).join(', ')); cell(tr, item.pnlPointCount);
    return tr;
  }));
  const query = data.search ? '，搜索“' + data.search + '”' : '';
  $('alphaCount').textContent = '匹配 ' + Number(data.total || 0) + ' 条' + query;
  const stats = data.stats || {};
  drawBars('sourceChart', (stats.sources || []).map((item) => ({ label: item.label === 'submitted' ? 'Submitted' : 'Prod 参考', count: item.count })));
  drawBars('pnlChart', (stats.sources || []).map((item) => ({ label: item.label === 'submitted' ? 'Submitted' : 'Prod 参考', count: item.pnlPoints })));
  drawBars('groupChart', stats.groups || []);
  drawBars('corrChart', stats.corrBuckets || []);
}
async function loadAlphas(query) {
  const suffix = query ? '?q=' + encodeURIComponent(query) : '';
  renderAlphas(await api('/api/admin/alphas' + suffix));
}
async function load() {
  try {
    const results = await Promise.all([api('/api/admin/summary'), api('/api/admin/contributors'), api('/api/admin/alphas'), api('/api/admin/uploads')]);
    const summary = results[0]; const contributors = results[1]; const alphas = results[2]; const uploads = results[3];
    $('metrics').replaceChildren(...[['贡献者', summary.contributors], ['安装', summary.installations], ['Alpha', summary.alphaRecords], ['PnL 点', summary.pnlPoints], ['活跃 Key', summary.activeKeys]].map(([name, value]) => {
      const box = document.createElement('div'); box.className = 'card'; box.textContent = name;
      const metric = document.createElement('div'); metric.className = 'metric'; metric.textContent = value; box.append(metric); return box;
    }));
    $('contributors').replaceChildren(...(contributors.contributors || []).map((item) => { const tr = document.createElement('tr'); secretCell(tr, item.wqId); cell(tr, item.alphaCount); cell(tr, item.keyExpiresAt ? new Date(item.keyExpiresAt).toLocaleString() : '-'); cell(tr, item.active ? '启用' : '禁用'); return tr; }));
    renderAlphas(alphas);
    $('uploads').replaceChildren(...(uploads.uploads || []).map((item) => { const tr = document.createElement('tr'); cell(tr, item.upload_id); cell(tr, item.account_hash); cell(tr, item.status); cell(tr, item.record_count); cell(tr, item.pnl_point_count); cell(tr, item.created_at ? new Date(item.created_at).toLocaleString() : '-'); return tr; }));
    $('status').textContent = '刷新：' + new Date().toLocaleString();
  } catch (error) { $('status').textContent = '失败：' + error.message; }
}
$('refresh').onclick = load;
$('rebuild').onclick = async () => { try { await api('/api/admin/rebuild', { method: 'POST' }); await load(); } catch (error) { $('status').textContent = '重建失败：' + error.message; } };
$('alphaSearchBtn').onclick = () => loadAlphas($('alphaSearch').value.trim()).catch((error) => { $('status').textContent = '搜索失败：' + error.message; });
$('alphaClearBtn').onclick = () => { $('alphaSearch').value = ''; loadAlphas('').catch((error) => { $('status').textContent = '清除搜索失败：' + error.message; }); };
$('alphaSearch').onkeydown = (event) => { if (event.key === 'Enter') $('alphaSearchBtn').click(); };
load();
</script>
</body>
</html>`;
    return new Response(html, {
        headers: {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-store',
            'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'`,
            'X-Content-Type-Options': 'nosniff',
            'X-Frame-Options': 'DENY',
            'Referrer-Policy': 'no-referrer',
            'X-Robots-Tag': 'noindex, nofollow, noarchive',
        },
    });
}

function adminPage() {
    const nonce = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(18))));
    return new Response(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>PNL / Prod Corr 共享管理</title><style>body{font:14px system-ui;max-width:1200px;margin:24px auto;padding:0 16px;color:#172033;background:#f5f7fb}.card{background:#fff;border:1px solid #dfe4ef;border-radius:12px;padding:16px;margin:12px 0}.cards{display:grid;grid-template-columns:repeat(5,1fr);gap:10px}.metric{font-size:22px;font-weight:700}.muted{color:#68738a}button{padding:8px 12px;border-radius:8px;border:1px solid #ccd4e2;background:#fff;cursor:pointer}.table{overflow:auto}table{border-collapse:collapse;width:100%}th,td{text-align:left;padding:8px;border-bottom:1px solid #e5e9f1;white-space:nowrap}.secret{cursor:pointer;color:#246bfd}@media(max-width:760px){.cards{grid-template-columns:repeat(2,1fr)}}</style></head><body><h1>PNL / Prod Corr 共享管理</h1><p class="muted">WQ ID 与 Alpha ID 默认遮蔽，点击才显示；生产环境建议在 Worker 前再启用 Cloudflare Access + MFA。</p><button id="refresh">刷新</button><button id="rebuild">重建快照</button><div id="metrics" class="cards"></div><div class="card"><h2>贡献者</h2><div class="table"><table><thead><tr><th>WQ ID</th><th>Alpha 数</th><th>Key 到期</th><th>状态</th></tr></thead><tbody id="contributors"></tbody></table></div></div><div class="card"><h2>Alpha / PnL 明细</h2><div class="table"><table><thead><tr><th>Alpha ID</th><th>Alias</th><th>来源</th><th>分组</th><th>Prod Corr</th><th>Classifications</th><th>PnL 点</th></tr></thead><tbody id="alphas"></tbody></table></div></div><div class="card"><h2>上传记录</h2><div class="table"><table><thead><tr><th>上传 ID</th><th>账号索引</th><th>状态</th><th>记录数</th><th>PnL 点数</th><th>时间</th></tr></thead><tbody id="uploads"></tbody></table></div></div><p id="status" class="muted"></p><script nonce="${nonce}">const $=id=>document.getElementById(id);const api=async u=>{const r=await fetch(u,{cache:'no-store'});const d=await r.json();if(!r.ok)throw Error(d.error||r.status);return d};const cell=(tr,v)=>{const td=document.createElement('td');td.textContent=String(v??'');tr.append(td)};const secretCell=(tr,v)=>{const td=document.createElement('td');const raw=String(v??'');td.className='secret';td.textContent=raw.length>8?raw.slice(0,4)+'…'+raw.slice(-3):'••••';td.title='点击显示/隐藏';td.onclick=()=>{td.dataset.open=td.dataset.open==='1'?'0':'1';td.textContent=td.dataset.open==='1'?raw:(raw.length>8?raw.slice(0,4)+'…'+raw.slice(-3):'••••')};tr.append(td)};async function load(){try{const [s,c,a,u]=await Promise.all([api('/api/admin/summary'),api('/api/admin/contributors'),api('/api/admin/alphas'),api('/api/admin/uploads')]);$('metrics').replaceChildren(...[['贡献者',s.contributors],['安装',s.installations],['Alpha',s.alphaRecords],['PnL 点',s.pnlPoints],['活跃 Key',s.activeKeys]].map(([n,v])=>{const d=document.createElement('div');d.className='card';d.textContent=n;const x=document.createElement('div');x.className='metric';x.textContent=v;d.append(x);return d}));$('contributors').replaceChildren(...c.contributors.map(x=>{const tr=document.createElement('tr');secretCell(tr,x.wqId);cell(tr,x.alphaCount);cell(tr,x.keyExpiresAt?new Date(x.keyExpiresAt).toLocaleString():'-');cell(tr,x.active?'启用':'禁用');return tr}));$('alphas').replaceChildren(...a.alphas.map(x=>{const tr=document.createElement('tr');secretCell(tr,x.alphaId);cell(tr,x.alias);cell(tr,x.sourceType);cell(tr,x.groupKey);cell(tr,x.prodCorr);cell(tr,x.classifications.map(v=>v.name||v.id).join(', '));cell(tr,x.pnlPointCount);return tr}));$('uploads').replaceChildren(...u.uploads.map(x=>{const tr=document.createElement('tr');cell(tr,x.upload_id);cell(tr,x.account_hash);cell(tr,x.status);cell(tr,x.record_count);cell(tr,x.pnl_point_count);cell(tr,x.created_at?new Date(x.created_at).toLocaleString():'-');return tr}));$('status').textContent='刷新：'+new Date().toLocaleString()}catch(e){$('status').textContent='失败：'+e.message}}$('refresh').onclick=load;$('rebuild').onclick=async()=>{try{await fetch('/api/admin/rebuild',{method:'POST'});load()}catch(e){$('status').textContent='重建失败：'+e.message}};load();</script></body></html>`, {
        headers: {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-store',
            'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'`,
            'X-Content-Type-Options': 'nosniff',
            'X-Frame-Options': 'DENY',
            'Referrer-Policy': 'no-referrer',
            'X-Robots-Tag': 'noindex, nofollow, noarchive',
        },
    });
}
