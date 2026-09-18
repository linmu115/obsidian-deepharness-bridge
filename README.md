# Obsidian DeepHarness Bridge

当前版本 **0.7.0-rc2.1**，面向 **DSH 0.1.5-rc.2**。这是安装在 Obsidian Vault 中的伴侣插件，提供笔记选段引用、内嵌 DSH 会话、笔记与会话双向链接、会话贴纸入口和可恢复的同步。DSH 侧需使用配套的 [Obsidian Session Reference Suite](https://github.com/linmu115/dsh-obsidian-session-reference-suite/blob/codex/rc2-session-context-graph/README.md)。

## 先为此 Vault 选择实例

打开插件设置中的“此 Vault 的 DSH 实例”，刷新本机发现，或填写不含令牌的 DSH Web 地址并核验。选择已核验实例后点击“绑定 / 改绑所选实例”。一个 Vault 同时绑定一个实例及 profile；同一实例可以连接多个 Vault。绑定成功以设置中的已保存修订为准，发现候选不会自动授权。

新版共享通道需要支持 `vault-instance-binding-v1` 的配套 Bridge 和 Protocol 0.4.0-rc2.1。旧固定地址仅作为手动发现候选，不会根据最后连接的控制器自动永久绑定。新 Companion 未绑定时保留本地笔记和既有记录，跨端操作需先完成绑定；不宣称旧 Bridge 支持多 Vault。

端口设为 0 可自动选择；固定端口冲突时也会选择可用端口，连接状态显示实际地址。本机发现只发布无令牌的身份及地址，Viewer 登录地址仍由已核验的绑定实例通过控制器租约提供。

改绑只影响后续操作。历史链接保留原实例，旧排队引用显示为暂停，不会改投新实例。Maintenance 缺席时普通 Bridge 连接仍可用，维护知识同步不会启动。详见[修改报告](docs/changes/2026-09-18-vault-instance-binding.md)。

## 三种不同的操作

| 操作 | 作用 | 是否加入本轮上下文 |
| --- | --- | --- |
| 打开关联笔记 / 打开会话 | 双向导航，定位笔记、块或完整 DSH 会话 | 否 |
| 关联到 DSH 会话 / 创建或挂接会话贴纸 | 建立可复用关系，连接已有会话或新建真实独立会话 | 否，不自动发送 |
| 引用到 DSH / 引用到本轮 | 把用户选择的材料加入目标会话的待发送引用气泡 | 发送并提交后，由引用流程处理 |

关联不会自动把整篇笔记灌入模型上下文。会话仍在对应 DSH 实例的 Agent 环境运行；内嵌 Viewer 是会话界面，不是另一套独立引擎。

## 从笔记引用到 DSH

1. 在 Obsidian 的内嵌 DSH Web Viewer 中打开目标会话。
2. 在编辑或阅读模式下选取笔记文字，选择 **引用到 DSH**。
3. 插件先显示“等待 DSH 接收”；目标页面领取后出现待发送引用气泡。检查原草稿及引用，再自行发送问题。
4. 引用随真实提问提交后，笔记中的 **DSH 引用** 标签可返回对应会话、提问与引用详情。同一位置有多个已提交引用时，先选择目标。

新投递只允许该 Vault 配置的内嵌 Viewer 领取。页面身份保存在登录跳转不会清除的 URL 片段中，Bridge 在读取队列、领取和重试时核对页面及实例；同一实例的独立 DSH 窗口不会抢走引用。未配置或尚未打开接收页面时，引用保留在待处理队列。

内嵌页复用已有会话页面，不因每次回链或气泡点击重新加载。独立窗口仍支持已有导航、回链与删除能力。不要把 Viewer 的带认证地址复制到公开文档；常规操作通过插件入口完成。

## 关联笔记与真实会话

使用命令 **将当前笔记关联到会话**，或文件菜单的 **关联到 DSH 会话**。选择器先展示工作区，再按需列出会话；也可以选择 **新建独立会话并关联**。

对选段使用 **创建或挂接会话贴纸**，可建立带来源定位的会话贴纸和双链。此操作保存有界选文、来源身份与真实会话标识，不自动发起模型请求。

关联后，DSH 会话输入区域显示常驻关联笔记气泡：

- **在 Obsidian 打开**：回到原笔记或块。
- **引用到本轮**：校验当前笔记材料，加入该实例、会话及引用集的待发送气泡，保留原草稿。

第二种路径直接绑定当前目标，不进入自动领取队列，因此也不会被其它窗口抢走。选段已改变、来源块缺失或重复、关联解除、实例或 profile 不匹配时会明确拒绝；整篇材料超过预算时，应回到 Obsidian 选取需要的段落。

笔记移动或改名后按稳定笔记/块身份解析；身份有歧义时不猜测替代来源。命令 **核对并修复会话知识链接** 会分批检查同步进度。已有引用需要转为知识网络关联时，使用 **迁移已提交引用到知识网络**，不要手改插件记录冒充迁移完成。

## 双向打开与删除

DSH 回跳通过 Obsidian 官方协议入口进入插件，再在 Obsidian 内打开或聚焦本机 DSH Viewer。DSH 打开笔记时使用 Obsidian API 定位，只复用主编辑区的 Markdown 页签，不替换当前 Viewer。贴纸 WikiLink 回链使用 Obsidian 的原生索引查询，不为建立索引改写用户笔记。

| 删除入口 | 删除的范围 |
| --- | --- |
| DSH 未发送引用气泡的删除 | 取消该引用并移除 Bridge 待处理记录。 |
| DSH 已提交引用的删除 | 解除对应引用并清理其 Obsidian 回链，保留原会话与笔记正文。 |
| Obsidian “DSH 引用”标签的叉 | 先解除本地引用关系，再通过持久删除记录同步 Core 对应注释/引用；断线或失败后重试，不把本地引用自动恢复回来。 |
| 某条“DSH 贴纸”回链气泡的叉 | 只解除当前笔记与该贴纸的双链，不删除贴纸本体或其它笔记中的同一贴纸回链。 |
| 笔记与会话关联的解除 | 解除该关联，不删除笔记或会话，也不代替其它独立引用的删除。 |

### 共享 Owned 标记的清理

插件创建的 `^dsh-note-*` 定位标记会在实时预览和阅读模式显示为紧凑的“DSH 引用”标签；源码模式保留原始块标记。

**删除一条引用不一定删除该位置的标记。** 有效引用、已提交回链、尚在选择的引用，以及未解除的笔记/会话关联，都可能共同使用该位置。只有最后一个对应使用方解除后，插件才清理自己创建且保留了归属记录的 Owned 标记。

- 用户已有块 ID 不会被清理。
- 清理失败会保留记录，重试或重载后继续核对。
- 标记重复、定位有歧义时停止删除，不猜测来源。
- 原笔记存在但标记已消失时，不会到其它笔记删除同名标记。
- 对升级前已经丢失归属信息的孤立标记，不仅凭名称推断它属于插件。

机制和验证范围见[共享标记清理说明](docs/2026-09-14-shared-marker-cleanup.md)。

## 数据保存在哪里

当前 Maintenance 集成流程中，**会话、已迁入的贴纸、知识链接及图结构以 Maintenance 为结构真源；Vault 继续拥有笔记正文。**

Companion 保存稳定笔记身份、链接回执、同步进度、待处理引用、删除记录及 Owned 标记归属，用于完成跨应用投递和恢复。笔记里保留需要的可见回链、块定位与伴生 Markdown；这些内容不是另一套完整会话历史。知识登记不会为每个关联或每轮操作复制整篇笔记、全库正文或会话快照。

尚未迁移的旧伴生贴纸数据保留兼容路径。迁移通过冻结旧写入、导入、核对回执后启用新所有者的流程完成，不能把“Maintenance 为真源”理解为可以直接删除旧文件。

## 安装与设置

本仓库提供源码和本地打包/安装脚本；当前版本号不代表已经存在可下载的 npm 或 GitHub Release 包。准备对应构件后，可用整套维护部署流程安装，或从本仓库构建后执行：

```powershell
.\scripts\install-local.ps1 -VaultPath "D:\MyVault"
```

请把示例替换为实际 Vault，并先完成下文构建。脚本要求 Vault 中已有 `.obsidian` 目录，安装到 `.obsidian/plugins/obsidian-deepharness-bridge`，原插件备份存入 `.obsidian/plugin-backups`。备份不放在可加载插件目录中。更新后重新加载伴侣插件。

在 Obsidian **设置 → DeepHarness Bridge** 中配置并点击 **应用**：

| 设置 | 说明 |
| --- | --- |
| DSH Web 地址 | 本机 DSH Web origin，默认初始值为 `http://127.0.0.1:3080`；应与实际实例一致，不是 Bridge 地址。 |
| DSH 启动日志 | 可选。需要时从包含 `dsh web:` 的本机日志获取当前登录地址。 |
| Bridge 端口 | 默认 `18473`，本机监听；应与 DSH Lifecycle 的 `bridgeOrigin` 端口一致。 |
| 伴生笔记目录 | 默认 `DeepHarness`，用于伴生笔记。 |

配套 Lifecycle 会提供真实 Web 服务的当前 Viewer 地址与实例身份，适配 Launcher 动态端口。页面身份由插件管理，不需要手工复制到多个窗口。DSH 的 Lifecycle、Core、Reference Adapter 和 Maintenance 必须使用同一目标实例/profile，具体版本与配置见 [Suite README](https://github.com/linmu115/dsh-obsidian-session-reference-suite/blob/codex/rc2-session-context-graph/README.md)。

如果投递没有完成，先检查两端连接。Obsidian 设置中的 **待处理引用** 和 **引用同步** 支持查看状态、打开笔记、重试与丢弃；DSH 的 Better Sidebar **Obsidian** 面板也有对应状态和重试。不要删除记录来绕过错误或创建第二个 Bridge 争抢同一端口。

## 从源码构建

使用 [package.json](package.json) 指定的 pnpm。当前依赖包含本地 Protocol/Core 归档以及 Maintenance contracts 的链接；需先准备对应路径和构建输出，或在开发分支更新依赖路径与锁文件。新机器上的 `pnpm install` 不会凭空生成这些本机构件。

依赖准备好后，在本仓库目录执行：

```powershell
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
pnpm package:companion
```

`package:companion` 使用已构建的 `main.js`，输出 `.artifacts/obsidian-deepharness-bridge-0.6.4-rc2.6.tgz`；不会自动部署 Vault。整套源码链接和组合核对流程见 Suite。

本版同版本号可能对应后续修复构建，复现和部署应核对实际构件摘要及安装收据。自动测试使用合成笔记与会话；真实内嵌页面、双应用点击、模型应答及 Vault 性能应以相应部署验收记录为准。

更多说明：[CHANGELOG](CHANGELOG.md)、[关联笔记与按需引用](docs/2026-09-14-linked-note-rail.md)、[内嵌接收页面隔离](docs/changes/2026-09-13-obsidian-viewer-routing.md)和[结构同步与来源定位修复](docs/changes/2026-09-14-system-audit-fixes.md)。
