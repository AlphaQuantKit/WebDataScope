# WebDataScope PNL / Prod Corr share Worker

独立的 Cloudflare Worker、D1 与私有 R2 后端。它接收插件完整的 Submitted/Prod 参考快照，保存加密后的 WQ ID、Alpha ID 和 PnL，并向持有 10 天 key 的插件或 Python 客户端提供只含稳定 alias 的全局 `jsonl.gz` 快照。

## 安全边界

- WQ cookie 和密码不会发往 Worker；插件只上传从当前 WQ summary 读取的 WQ ID。
- WQ ID、Alpha ID 和原始 PnL 分别使用版本化 AES-GCM 密钥加密；D1 只保存索引和元数据，PnL body 位于私有 R2。
- Alpha 下载标识由独立 HMAC 密钥生成，不是可逆密文。
- 上传使用安装级不可导出 P-256 私钥、短期 challenge、24 小时上传/恢复会话、gzip 分片、分片 SHA-256 和显式 Chrome 扩展 Origin 模式；每片最多 8 条，由 Queue 以 `batch_size=1` 自动处理，浏览器不再逐片调用 `/process`。
- 配置 R2 S3 凭据后，Worker 只签发限定对象、方法和有效期的 URL；分片在插件端用会话 AES-GCM 密钥加密后直传 R2，下载也直接从 R2 流出。凭据或 CORS 不可用时保留 Worker 上传/下载兼容通道。
- 多次上传只标记共享数据有新版本，由 Cron 每两小时最多合并重建一次；快照按四个互不重叠的 alias 区间使用游标分页并行构建，先生成 gzip 分片和 bundle，再生成单一 `dataset.jsonl.gz`。只有最终对象完整写入后才原子切换，构建期间旧快照继续可下载；发布后会清理旧快照分片、bundle、最终文件和超过 24 小时仍未被引用的 PnL 对象。
- 插件只有在完整增量同步成功、数量和失败清单一致，并且本次同步晚于上次成功上传时才会启用上传；本地 Submitted `dateSubmitted` 可以早于当前日期，同步完成时间也不限制在 30 分钟内。
- 上传记录保留 `classifications` 的 `id` / `name`；Submitted 记录由服务端强制 `prodCorr=1`。
- 插件在上传分片前提交 P-256 签名的 finalize 预授权；最后一个 Queue 分片、延迟 watchdog、状态查询和定时扫描均可幂等触发服务端 finalize。因此关闭侧边栏或浏览器后仍会自动完成并签发 key；key 与结果会加密保存，稍后用同一 session 领取时返回原 key，不会重复签发。
- 每个 key 在 10 天有效期内累计最多成功下载 30 次，不按自然日重置。
- 公开插件无法提供真正的远程代码证明；这些措施用于阻止普通脚本、网页跨域、重放和批量滥用，不能证明客户端绝未被修改。
- 管理页面仍有 Worker 内 Basic Auth 作为第二层保护；生产路由必须再置于 Cloudflare Access + MFA 后。

## 本地验证

1. `pnpm install`
2. `pnpm run secrets:generate`
3. `pnpm run db:migrate:local`
4. `pnpm test`
5. `pnpm run check`

生成的 `.generated-secrets.json`、`.dev.vars` 和 `.admin-credentials.txt` 均已忽略，脚本不会打印密钥。

## 部署顺序

1. 分别创建 staging/production D1 和私有 R2 bucket，并替换 `wrangler.jsonc` 中的数据库 ID、`R2_ACCOUNT_ID` 和 `R2_BUCKET_NAME`。
2. 设置 `EXTENSION_ORIGIN_MODE=any-chrome-extension`，允许任意合法的 `chrome-extension://<32 位 a-p 扩展 ID>`；缺失或未知模式会拒绝所有扩展 Origin。
3. 用 `wrangler secret bulk .generated-secrets.json` 分别上传基础 secrets。在 Cloudflare Dashboard 的 **R2 Object Storage → Manage R2 API Tokens** 为两个 bucket 分别创建仅限对应 bucket 的 Object Read & Write token，再分别设置 `R2_ACCESS_KEY_ID` 和 `R2_SECRET_ACCESS_KEY` Worker secret；不要把值写入仓库或命令行参数。
4. 对两个 bucket 应用 `r2-cors.json`。由于自行安装扩展没有固定 ID，Origin 使用 `*`；安全边界仍是短期签名 URL 只允许一个对象和一种方法，并且上传 body 另有会话加密与完整性校验。
5. 先应用 staging migration、部署并完成注册、自动 Queue 处理、两小时定时合并、四路 alias 游标快照、单 gzip、旧对象清理、直传/直下、兼容回退、finalize、stats、下载额度和管理页检查。
6. 再迁移和部署 production，触发一次新快照并确认旧快照在构建期间仍可下载，最后发布插件。

不要在创建真实 D1/R2、确认显式 Origin 模式和上传 secrets 前部署。

## Python 下载

```python
import requests

key = "wqs_..."
base = "https://pnl-share.hualabtech.com"

stats = requests.get(
    f"{base}/v1/share/stats",
    headers={"Authorization": f"Bearer {key}"},
    timeout=30,
).json()
snapshot = stats.get("snapshot") or {}
totals = stats.get("totals") or {}
if (
    snapshot.get("status") != "published"
    or snapshot.get("recordCount") != totals.get("recordCount")
    or snapshot.get("pnlPointCount") != totals.get("pnlPointCount")
):
    raise RuntimeError("共享快照正在构建，请稍后重试。")

route_response = requests.post(
    f"{base}/v1/share/download-url",
    headers={"Authorization": f"Bearer {key}"},
    timeout=30,
)
route_response.raise_for_status()
route = route_response.json()
url = route.get("downloadUrl") if route.get("direct") else f"{base}{route.get('datasetUrl', '/v1/share/dataset')}"
headers = {} if route.get("direct") else {"Authorization": f"Bearer {key}"}
response = requests.get(url, headers=headers, timeout=120)
response.raise_for_status()
open("wq-pnl-prod-corr.jsonl.gz", "wb").write(response.content)
```
