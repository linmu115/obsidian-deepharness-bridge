# OBSIDIAN-DEEPHARNESS-BRIDGE-20260822-001

## 目标

建立 Obsidian 伴侣插件的独立仓库、插件身份和双向知识协议 v1 基线。

## 基线

- 修改前：仓库不存在。
- 修改后：`obsidian-deepharness-bridge@0.1.0`，Obsidian 最低版本 `1.13.0`，协议版本 `1`。

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

## 验证

```powershell
pnpm typecheck
pnpm test -- bridge-server
pnpm test -- session-notes references
pnpm check
pnpm --dir ..\.. vitest run tests/knowledge-protocol-contract.test.ts
```

## 回退

首个提交是仓库基线；后续通过 Git 标签和 DSH Maintenance generation 选择旧提交，不直接覆盖 Vault 或已发布插件。
