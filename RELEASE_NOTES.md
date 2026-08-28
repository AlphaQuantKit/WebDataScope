Release version 1.7.2

## Session 保活与自动重登

- 修复 `204/401/403` 会话失效识别；自动重登改为调用 WQ Authentication API 覆盖 Cookie，并仅在探活验证通过后报告成功，不再打开登录网页。
- “立即重登”返回真实结果，Session 状态同时显示剩余有效时间或已过期提示。

## PNL / Prod Corr 共享

- 共享功能默认关闭，仅允许完整增量同步且校验通过的数据上传；上传采用压缩分片、并发传输、服务端异步处理和可恢复签发流程。
- 每个共享 Key 自签发起 10 天有效，期间累计最多成功下载 30 次完整快照；同一 WQ 账号的新 Key 会使旧 Key 失效。
- 下载仅包含不可逆 Alpha alias、PnL、Prod Corr、分组、来源和各因子 classifications，不返回 WQ ID 或真实 Alpha ID，并支持插件与 Python。
- 上传使用安装级签名、短期 challenge、摘要和清单校验；共享数据使用私有 R2、D1 索引与管理员多层认证保护。

## 近期改进

- 调整“指南与日志”页面顺序，将“致谢与友情链接”移至“更新日志”上方。
- Alpha Distribution 矩阵右侧新增横向 TOTAL 列；横向与纵向 TOTAL 均显示数量及其占全部 Alpha 总数的百分比，右下角显示整体总数和比例。
- 修复 WorldQuant BRAIN 前端更新后自定义 Alpha 列无法注入的问题。
- 增强 Community 阅读样式、关注用户和代码高亮，并修复 Manifest V3 加载兼容问题。
- 优化 ProdMemo 增量同步、本地 Corr 计算、数据展示和缓存性能。

## 自行安装升级

- 保留原扩展目录并覆盖文件，然后在 `chrome://extensions` 点击“重新加载”，再刷新已打开的 WorldQuant 页面。
- 不要先删除扩展或换目录重新加载，否则扩展 ID 可能变化，导致本地设置、IndexedDB 和共享 Key 无法沿用。

> [!IMPORTANT]
> 版本号遵循 x.y.z：x 为重大架构变更，y 为功能新增，z 为 Bug 修复。
