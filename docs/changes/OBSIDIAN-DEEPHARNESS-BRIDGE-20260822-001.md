# OBSIDIAN-DEEPHARNESS-BRIDGE-20260822-001

## 目标

建立 Obsidian 伴侣插件的独立仓库、插件身份和双向知识协议 v1 基线。

## 基线

- 修改前：仓库不存在。
- 修改后：`obsidian-deepharness-bridge@0.1.0`，Obsidian 最低版本 `1.13.0`，协议版本 `1`。
- 功能提交：`0ce37ac`（Vault 数据层）、`e47f664`/`cc4a2e1`（Obsidian 交互与设置）、`5d0552e`（Windows 关闭清理）。

## 改动

- 添加 Obsidian `manifest.json`、独立 pnpm workspace、锁文件与 TypeScript 配置。
- 定义与 DSH 端一致的五类协议消息和运行时校验。
- 明确 Vault 是知识层数据真源，DSH 原始会话保持只读。
- 添加固定绑定 `127.0.0.1` 的 HTTP bridge、精确 DSH Origin 白名单和 15 分钟短期 token。
- 添加按客户端确认的 FIFO 动作队列；citation resolve 使用 `citationId` 幂等并拒绝冲突重试。
- 限制 JSON 请求体为 128 KiB，并在插件释放时关闭监听端口与空闲连接。
- 添加伴生 Markdown 的 marker 解析、首次创建、贴纸更新/删除和 SHA-256 乐观并发控制。
- marker 外的 frontmatter 与用户正文逐字保留；损坏 marker 返回 `CORRUPT_MARKER`，禁止猜测覆盖。
- 在原笔记中生成可识别的 WikiLink、`dsh://` 逻辑链接、稳定 block ID 和可精确删除的反链块。
- 添加编辑模式与阅读模式选段入口，缺少 Obsidian block ID 时通过官方 Editor/Vault API 补写稳定 ID。
- 添加核心 `webviewer` 窄适配：优先复用相同 DSH origin 的分页，不可用时才创建新分页。
- `dsh://` 只在 Obsidian 页面内拦截，严格解析 session/anchor，并把 deep-link 动作送入本机 bridge。
- 添加插件设置页、pending citation 私有持久化和可部署的 CommonJS `main.js` 构建。
- 设置更新后深链接读取当前 DSH origin；Vault revision 冲突通过 bridge 明确返回 HTTP 409。
- 修正 Node 24/Playwright 收尾时的重复 socket 清理：`server.close()` 已负责空闲连接，不再同时调用 `closeIdleConnections()`，避免 Windows libuv 重复关闭断言。

## 验证

```powershell
pnpm typecheck
pnpm test -- bridge-server
pnpm test -- session-notes references
pnpm check
pnpm --dir ..\.. vitest run tests/knowledge-protocol-contract.test.ts
```

## 兼容与产物

- 验证 Obsidian API：`1.13.x`，插件 `minAppVersion` 为 `1.13.0`。
- 维护引擎 tgz 只包含 Obsidian 运行文件、README 和 LICENSE；源码、测试与变更日志保留在 Git，不进入部署包。最终 SHA-256 在本节下方记录。
- 维护引擎 tgz SHA-256：`dbcab8af6cc1ec60fafa7d0d3845440055c97015a3ec6a2711c1173c25221583`。
- `main.js` SHA-256：`48a7e93a72eaf7eff8046723e0ac2da7068835bbcb482bd69fd13fc1fb2b70f1`。
- 临时 Vault 中的 `.obsidian/plugins/obsidian-deepharness-bridge/` 已验证包含 `main.js`、`manifest.json` 和 `versions.json`；插件无独立 `styles.css`，界面仅使用 Obsidian 原生设置控件。
- 完整双向 journey 使用临时 Vault 通过；未安装到真实 Vault，未改写真实笔记。

## 回退

首个提交是仓库基线；后续通过 Git 标签和 DSH Maintenance generation 选择旧提交，不直接覆盖 Vault 或已发布插件。

首版回退标签：`change/OBSIDIAN-DEEPHARNESS-BRIDGE-20260822-001`。
