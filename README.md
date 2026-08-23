# Obsidian DeepHarness Bridge

Obsidian 伴侣插件：管理本机 bridge、Vault 伴生 Markdown、选段引用和 DSH Web Viewer 回跳。

DSH 回跳使用 Obsidian 官方协议入口 `obsidian://deepharness?...`。伴侣插件接收后只在
Obsidian 内部打开或聚焦 loopback DSH Web Viewer；旧 `dsh://` 链接继续兼容。

Bridge 可扫描 Vault 中引用指定贴纸的 Markdown 链接，并返回笔记路径、标题、行列和块 ID。
DSH 点击反向链接后由 Obsidian 官方 API 打开笔记并定位，不会为索引而改写用户笔记。

Vault 是贴纸、高亮、标签和引用关系的唯一真源；插件不修改 DSH 原始会话。

Bridge 默认使用 `127.0.0.1:18473`。通过 DSH Maintenance Engine 安装时会先检测
Windows 端口可用性，再把同一端口写入 Obsidian 配置和 DSH 浏览器产物。
