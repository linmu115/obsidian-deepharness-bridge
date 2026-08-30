# Obsidian DeepHarness Bridge

Obsidian 伴侣插件：管理本机 bridge、Vault 伴生 Markdown、选段引用和 DSH Web Viewer 回跳。

DSH 回跳使用 Obsidian 官方协议入口 `obsidian://deepharness?...`。伴侣插件接收后只在
Obsidian 内部打开或聚焦 loopback DSH Web Viewer。

Bridge 通过 Obsidian 原生 `metadataCache` 查询引用指定贴纸块的 WikiLink，并返回笔记路径、
标题、行列和块 ID。它不扫描外部协议文本。DSH 点击反向链接后由 Obsidian 官方 API 打开
笔记并定位，不会为索引而改写用户笔记。打开动作只复用主编辑区的 Markdown 页签，当前
DSH Web Viewer 页签不会被替换或关闭。

Vault 是贴纸、高亮、标签和引用关系的唯一真源；插件不修改 DSH 原始会话。

引用提交后会先显示非阻塞的“等待 DSH 接收”提示，DSH 真正领取后再提示成功。删除已经提交的
“DSH 引用”时，Obsidian 会立即移除本地引用块和关系；Bridge 保留删除墓碑，由 Core 在后台删除
DSH 会话中的对应注释，失败会自动重试而不会恢复本地引用。删除 DSH 中尚未发送的引用气泡也会
同步删除 Bridge 记录。只有插件自动创建、且未被其他引用或回链共享的 `dsh-note-*` 块标记会从
笔记中移除，用户原有块 ID 不会被修改。笔记在引用后被移动也可以按唯一块标记安全定位；若出现
重复标记，插件会停止删除并保留记录等待处理。

插件自动生成的长块标记在 Obsidian 实时预览和阅读模式中显示为紧凑的“DSH 引用”标签，悬停
可查看完整 ID；源码模式始终保留并显示原始 `^dsh-note-*` 文本，笔记内容和链接行为不变。

Bridge 默认使用 `127.0.0.1:18473`。通过 DSH Maintenance Engine 安装时会先检测
Windows 端口可用性，再把同一端口写入 Obsidian 配置和 DSH 浏览器产物。

新安装默认连接 DSH Web 的 `http://127.0.0.1:3080`。本地更新可运行
`scripts/install-local.ps1 -VaultPath <Vault 路径>`；脚本把旧版备份放在
`.obsidian/plugin-backups`，不会把同 ID 的备份留在 `.obsidian/plugins` 中被
Obsidian 误识别为另一份可加载插件。
