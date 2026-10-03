Release version 1.8.0

## Alpha 详情与 ProdMemo 修复（#38）

- 区分 Alpha List 地址 `/alphas/<列表 ID>` 与 Alpha 地址 `/alpha/<Alpha ID>`，详情面板和 AI 描述助手使用实际选中的 Alpha。
- 修复列表详情卡片不显示、切换或关闭面板后出现旧卡片的问题；卡片先显示，再读取关联性数据，读取失败或超时会提供中文提示和重试按钮。
- 优化 ProdMemo 读取：优先按 Alpha 读取，共享参考分批读取并缓存元数据，减少重复扫描和切换时的等待。

## Windows 一键更新（#39）

- 新增 `update.bat`，双击即可下载最新正式 Release，并在原插件目录更新。无需安装 Git、Node.js 或 Python，所有更新提示均为中文。
- 更新前校验压缩包、备份待覆盖文件，覆盖失败时恢复原文件；保留浏览器配置、导入数据、缓存、共享 Key 和其他用户文件。
- 支持包含 `.git` 的目录；有 Git 时检查本次覆盖范围内的本地修改，没有 Git 时仍可更新并保留恢复备份。

## 升级步骤

1. 已有更新器：在原安装目录双击 `update.bat`。旧版没有更新器：先将新版中的 `update.bat` 和 `scripts/update-extension.ps1` 复制到原目录的对应位置，再双击运行。
2. 更新完成后，在 `chrome://extensions` 或 `edge://extensions` 找到 WorldQuant Scope，点击“重新加载”。
3. 刷新已打开的 WorldQuant 页面。请保留原安装目录和已安装的扩展，沿用原来的扩展 ID 和本地数据。

> [!IMPORTANT]
> 版本号遵循 x.y.z：x 为重大架构变更，y 为功能新增，z 为 Bug 修复。
