# 0.3.0 — 可删除的 DSH 双向引用

- 「DSH 引用」标记增加删除按钮；点击确认后由 Annotation Core 统一解除 DSH 与 Obsidian 的双向关系。
- 已发送引用使用持久删除请求与提交回执，重启或短暂离线后仍会继续同步；历史 DSH 消息保持不可变。
- Bridge 只删除带有同一 `referenceId/profileId/sessionId/setId` 的生成块，且支持笔记移动后的全库定位与幂等重试。
- 深链完整传递 `setId/referenceId`，配合 Sticker 0.4.0 在目标会话渲染后定位并打开对应引用。
- Web Viewer 会从当前 DSH 启动日志读取带鉴权信息的地址，避免 Obsidian 内嵌页面因缺少凭据而打不开。
