Release version 1.7.1

## PNL / Prod Corr 共享

- 新增 PNL / Prod Corr 共享功能，默认关闭，用户可在设置页主动开启。
- 上传显示压缩、传输、服务端处理和最终校验进度；每个 gzip 分片最多 8 个 Alpha，使用 4 路上传。创建任务后插件会先提交签名的 finalize 授权，服务端在 Queue 处理完最后一个分片后自动签发 Key，并保留 24 小时恢复窗口；关闭侧边栏或浏览器不会中断服务端处理，稍后重新打开即可领取同一个 Key。遇到限流会按 `Retry-After` 自动等待重试。
- 多次上传合并为定时快照，每两小时最多重建一次；共享快照按四个 alias 区间使用游标分页并行构建，Queue 始终保持 `batch_size=1`。最终预生成一个完整 `dataset.jsonl.gz`，生成完毕后再原子替换旧快照，并清理旧分片、bundle、最终文件和失效 PnL 对象。
- 配置 R2 短期签名后，上传和下载文件流可绕过 Worker 直达私有 R2；签名、CORS 或凭据不可用时自动保留 Worker 兼容通道。
- 上传按钮只有在完成完整的增量同步、Alpha/PnL 数量完整、失败清单为空，并且本次同步晚于上次成功上传时才会启用；本地 Submitted `dateSubmitted` 可以早于当前日期，同步完成时间也不要求必须在 30 分钟内。
- 上传自动包含当前账号下符合条件的 Submitted Alpha 和 Prod 参考数据，不提供手工勾选或修改入口；Submitted Alpha 的 `prodCorr` 由服务端强制为 `1`。
- 每个 Alpha 按自身数据保存 `classifications` 的 `id` 和 `name`，不会把所有因子统一成同一个 classification。
- 服务端自动完成上传后签发 10 天有效的共享 Key，有效期从实际签发时开始；同一 WQ 账号的新 Key 会使旧 Key 失效。
- 共享下载只返回不可逆 Alpha alias、PnL、Prod Corr、`groupKey`、来源和各因子自己的 classifications，不返回 WQ ID 或真实 Alpha ID；Python 可使用 `Authorization: Bearer` 下载，侧边栏可直接下载已配置当前 Key 的 Python 示例。
- 每个 Key 在 10 天有效期内最多成功下载 30 次全局快照；侧边栏可查看共享数据量和剩余额度。
- 下载数据写入独立的共享只读库，不会回传到个人上传数据，也不会自动合并回个人 PnL 数据库。
- 下载的共享 PnL 仅作为本地 `PROD_LOWER_BOUND` 的已知 Prod Corr 参考曲线，不进入 SELF 或 POOL；三种本地 Corr 的候选分组均只要求 Region 相同，不再限制 Universe 或 Delay。

## 安全与管理员

- 上传使用安装级 P-256 签名、短期 challenge、分片摘要和完整清单校验；服务端使用私有 R2、D1 索引和加密标识保存数据。
- 管理页面使用 Cloudflare Access + MFA，并保留 Worker 管理员认证作为额外保护层。
- 管理页面的 Alpha / PnL 明细提供来源、PnL 点数、分组和 Prod Corr 统计图，并支持按完整 Alpha ID 精确搜索。
- 公开自行安装扩展无法从密码学上证明代码未被修改；本版本的 Origin、签名、限流和完整同步校验用于降低普通脚本、重放和批量投毒风险。

## 自行安装升级

- 自行安装用户请保留原扩展目录，覆盖新版本文件后，在 `chrome://extensions` 点击“重新加载”，再刷新已经打开的 WorldQuant 页面。
- 不要为了升级先删除旧扩展再从另一个目录加载，否则浏览器可能生成新的扩展 ID，并导致本地设置、IndexedDB 和共享 Key 无法继续使用。

## Community 阅读增强

- Community 正文改用系统字体，代码块使用等宽字体，并优化 Pinned、Featured、Official 和顾问等级等标签的配色与样式。
- 新增关注用户功能：可点击作者 ID 旁的星标关注或取消关注；关注列表仅保存在浏览器本地。
- 新增代码块语法高亮，并对 FASTEXPR 算子、数据字段和 fastplus API 提供专用高亮。
- 支持 Community 动态加载内容，帖子列表、帖子详情和评论区域均可自动应用阅读增强。

## 修复内容

- 修复浏览器访问 R2 直连下载时可能出现 `Failed to fetch` 的问题：预签名 URL 改为官方 bucket-host 格式；服务端返回 gzip member 边界，插件使用内置 pako 分段解压多 member 快照，并在直连读取失败时自动回退 Worker；Python 示例同步增加异常回退。
- 修复 WorldQuant BRAIN 平台脚本更新后，自定义 Alpha 列无法正常注入的问题，并刷新本地列配置。
- 修复 Community 增强模块在 Manifest V3 内容脚本中无法启动的问题。
- 修复语法高亮可能遗漏未闭合引号的问题，确保页面展示及复制的代码内容保持不变。

更新扩展并刷新已打开的 WorldQuant BRAIN 或 Community 页面后即可生效。

> [!IMPORTANT]
> 关于版本的说明：版本号遵循 x.y.z：x 为重大架构变更，y 为功能新增，z 为 Bug 修复。
