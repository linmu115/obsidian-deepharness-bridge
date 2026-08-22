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

## 验证

```powershell
pnpm typecheck
pnpm --dir ..\.. vitest run tests/knowledge-protocol-contract.test.ts
```

## 回退

首个提交是仓库基线；后续通过 Git 标签和 DSH Maintenance generation 选择旧提交，不直接覆盖 Vault 或已发布插件。
