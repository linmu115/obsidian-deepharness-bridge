# Obsidian DeepHarness Bridge

Obsidian 伴侣插件：管理本机 bridge、Vault 伴生 Markdown、选段引用和 DSH Web Viewer 回跳。

DSH 回跳使用 Obsidian 官方协议入口 `obsidian://deepharness?...`。伴侣插件接收后只在
Obsidian 内部打开或聚焦 loopback DSH Web Viewer。

Bridge 通过 Obsidian 原生 `metadataCache` 查询引用指定贴纸块的 WikiLink，并返回笔记路径、
标题、行列和块 ID。它不扫描外部协议文本。DSH 点击反向链接后由 Obsidian 官方 API 打开
笔记并定位，不会为索引而改写用户笔记。打开动作只复用主编辑区的 Markdown 页签，当前
DSH Web Viewer 页签不会被替换或关闭。

Obsidian Web Viewer 的专属路由身份保存在登录重定向不会清除的 URL 片段中；同一页面只初始化一次，
因此贴纸回链和引用气泡不会在每次点击时重载 DSH，也不会被其他浏览器页面抢先消费。

Vault 是贴纸、高亮、标签和引用关系的唯一真源；插件不修改 DSH 原始会话。

引用提交后会先显示非阻塞的“等待 DSH 接收”提示，DSH 真正领取后再提示成功。删除已经提交的
“DSH 引用”时，Obsidian 会立即移除本地引用块和关系；Bridge 保留删除墓碑，由 Core 在后台删除
DSH 会话中的对应注释，失败会自动重试而不会恢复本地引用。删除 DSH 中尚未发送的引用气泡也会
同步删除 Bridge 记录。只有插件自动创建、且未被其他引用或回链共享的 `dsh-note-*` 块标记会从
笔记中移除，用户原有块 ID 不会被修改。笔记在引用后被移动也可以按唯一块标记安全定位；若出现
重复标记，插件会停止删除并保留记录等待处理。

Sticker Board 复制的 Obsidian 贴纸回链使用受管 Markdown 边界。删除 DSH 贴纸时，Bridge 会先删除
Vault 中所有对应的受管回链，并识别 0.3.18 及更早版本生成的两行链接和引用 callout。点击已经失效的
旧回链时，Bridge 会直接清理它，不会再打开或重载 DSH。受管贴纸回链在实时预览和阅读模式中显示为
紧凑的“DSH 贴纸”气泡；点击主体保留原有跳转，点击叉会立即移除气泡并只解除当前笔记与贴纸的双链，
不删除贴纸本体，也不影响其他笔记中的同一贴纸回链。源码模式和非目标生命周期数据不变。

插件自动生成的长块标记在 Obsidian 实时预览和阅读模式中显示为紧凑的“DSH 引用”标签。回答完成后
点击标签主体会打开对应 DSH 会话、定位用户提问并打开准确的引用详情；点击叉仍然只执行双端删除。
同一来源块关联多个已提交引用时会先显示目标选择菜单。源码模式始终保留原始 `^dsh-note-*` 文本。

Bridge 默认使用 `127.0.0.1:18473`。通过 DSH Maintenance Engine 安装时会先检测
Windows 端口可用性，再把同一端口写入 Obsidian 配置和 DSH 浏览器产物。

新安装默认连接 DSH Web 的 `http://127.0.0.1:3080`。本地更新可运行
`scripts/install-local.ps1 -VaultPath <Vault 路径>`；脚本把旧版备份放在
`.obsidian/plugin-backups`，不会把同 ID 的备份留在 `.obsidian/plugins` 中被
Obsidian 误识别为另一份可加载插件。
