# 0.2.0 统一注释协议 v2 与可恢复全文快照

## 目标

Obsidian 选段引用不再走独立的 `pending-citation` 对话框文本管线，而是作为
`dsh-annotation-core` 的 `obsidian-note` 来源进入统一注释集合。引用会携带稳定的 Vault、
笔记、块、出现次数和哈希身份，同时保存引用时的整篇 Markdown，以便 DSH 在发送前检查
并刷新来源。

## 数据与协议变化

- 插件版本、Manifest 和版本映射提升到 `0.2.0`。
- 保存状态提升为 `dataVersion: 2`，包含稳定 `vaultId`、待处理引用和反向链接提交回执。
- 新选段先写入 Obsidian 插件数据，再通知本机 Bridge，避免通知成功而本地状态丢失。
- Bridge 新增协议 v2 健康检查、握手、待处理动作、全局认领、来源刷新、丢弃、反向链接
  提交和打开笔记接口。
- DSH 对引用认领成功后，其他 DSH 客户端不再收到同一动作；相同认领可重试，不同会话或
  注释集合的认领返回冲突。
- 来源刷新以 Bridge 持有的 `referenceId` 和已知文档哈希为边界；块或选段消失时明确阻止，
  不静默改用其他文本。
- 反向链接使用 `app.vault.process()` 原子校验并写入，回执和 Markdown marker 共同提供
  幂等恢复。写入前笔记已变化时返回 revision conflict，不覆盖用户编辑。

## 选段与旧数据迁移

- 编辑模式会在需要时先写入块 ID，再基于写入后的完整 Markdown 生成快照。
- 阅读模式对重复文本只在 DOM 能给出已有块 ID 时定位；仍有歧义就拒绝引用，不再默认
  `occurrence = 0`。
- 可恢复的 v1 待处理引用迁移为 `migrated-ready`，不会自动投递给碰巧打开的 DSH 会话。
- 设置页逐条提供“打开笔记”“发送到 DSH”和“丢弃”；只有用户点击“发送到 DSH”才会
  持久化转换为 `queued` 并通知 Bridge，重复点击不会重复创建动作。
- 缺失笔记、缺失块、内容变化或格式损坏的旧记录逐条隔离为 `needs-reselect`。单条坏记录
  不会阻止插件启动，设置页会显示原因并允许打开原笔记或丢弃。
- 已经存在 `dsh-reference` marker 的旧引用不会在迁移后复活。

## 历史兼容边界

- 继续支持既有贴纸、会话笔记、打开笔记和 DSH 深链的协议 v1 数据与接口。
- 继续解析旧的 v1 pending citation，仅用于一次性迁移和既有 marker 工具函数。
- 删除活跃的 `/v1/citations/resolve` 引用管线；v1 action 客户端也不会收到 v2 引用动作。
- 不扫描任意旧外部协议链接，不批量改写 Vault。
- `dsh-annotation-core/protocol` 和 Zod 被打入 Obsidian `main.js`；运行时只外置 Obsidian
  自身模块，不要求 Obsidian 安装 DSH 插件或 Node 包。

## 修改位置

- `src/protocol.ts`：协议 v2 类型、哈希函数和 v1 历史边界。
- `src/selection/`、`src/vault/reference-source.ts`：全文快照、块定位和刷新。
- `src/migrations/v1-pending.ts`：v1 待处理引用的隔离迁移与手动释放。
- `src/bridge/queue.ts`、`src/bridge/server.ts`：持久队列通知、全局认领和 v2 路由。
- `src/vault/references.ts`、`src/vault/obsidian-adapter.ts`：原子反链写入与回执恢复。
- `src/main.ts`：保存优先、重启恢复、Bridge 回调和状态持久化。
- `src/ui/settings-tab.ts`、`src/ui/pending-reference-list.ts`：迁移记录的人工确认界面。
- `tests/`：协议、迁移、选择、刷新、反链、Bridge 与设置页回归测试。

## 验证

- `pnpm check` 通过：12 个测试文件、52 项测试全部通过，类型检查和生产构建成功。
- `pnpm pack` 成功，只包含 `LICENSE`、`main.js`、Manifest、版本映射、README 和
  `package.json`。
- 构建产物中没有运行时 `require("dsh-annotation-core...")` 或 `require("zod")`。
- 构建产物和源码中均不存在活跃的 `/v1/citations/resolve` 路由。
- 本任务只构建本地产物，尚未写入正式 Obsidian Vault 或正式 DSH profile；正式部署和
  交互验收留在实施计划的集成阶段。

## 回滚

回滚到本分支修改前提交 `33822e2` 可恢复 0.1.4。回滚代码不会删除或批量改写 Vault；
如果 0.2.0 已经运行过，应保留插件 `data.json` 和 Vault 中的 `dsh-reference` marker，再由
迁移工具决定是否降级，不能直接把 v2 待处理记录当作 v1 数据覆盖。
