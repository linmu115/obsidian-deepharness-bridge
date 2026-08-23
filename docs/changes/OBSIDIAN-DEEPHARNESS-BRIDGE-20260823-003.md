# 0.1.2 官方协议入口与 Vault 贴纸反向链接

## 现象

DSH 复制出的 `dsh://open/...` Markdown 链接在 Obsidian 中点击后没有打开 DSH Web Viewer。

## 原因

`dsh://` 不是 Obsidian 官方协议，旧实现只能依靠文档 DOM 捕获点击。未知协议可能先被
Obsidian 核心链接路由处理，因此页面监听不是稳定入口。

## 修复

- 注册官方 `registerObsidianProtocolHandler("deepharness", ...)`。
- 新贴纸链接格式为 `obsidian://deepharness?session=...&anchor=...&quoteHash=...&sticker=...`。
- 协议处理器复用既有 Web Viewer，再向本机 Bridge 投递精确定位动作。
- 解析器继续接受旧 `dsh://open/session/...`，不破坏已有笔记。
- 自动生成的新反向链接统一改用官方协议。
- 新增受 token 保护的 `GET /v1/sticker-backlinks`，由 Obsidian 端扫描 Vault Markdown。
- 含 `sticker` 的新链接按 UUID 匹配；旧链接按 `session + anchor + quoteHash` 匹配。
- 扫描结果包含笔记路径、标题、摘录、零基行列和可用块 ID，并按引用位置去重。
- DSH 点击结果时优先打开块 ID，没有块 ID 时用 Obsidian 编辑器行列定位。
- 扫描与定位不会静默插入块 ID，也不会改写现有用户笔记。

## 回滚

回滚到 `change/OBSIDIAN-DEEPHARNESS-BRIDGE-20260823-002` 可恢复 0.1.1。回滚不会修改
Vault 中的笔记正文。
