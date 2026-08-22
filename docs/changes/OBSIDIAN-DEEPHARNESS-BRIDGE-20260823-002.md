# OBSIDIAN-DEEPHARNESS-BRIDGE-20260823-002

## 问题

Bridge 端口启动失败时，`onload()` 将异常重新抛给 Obsidian。Obsidian 因此卸载整个插件，设置页也不会登记；用户只能看到已启用开关，无法查看底层错误。

真实环境诊断进一步确认，旧默认端口 `27124` 位于 Windows 的 TCP 排除范围 `27116-27215`，因此即使没有进程占用也会返回 `listen EACCES`。

## 修复

- 先登记选段菜单、回跳拦截器和设置页，再启动 Bridge。
- Bridge 失败时保留插件的降级运行状态，不再使整个插件加载失败。
- 在设置页的“连接状态”中保留完整底层错误，同时通过 Notice 提示。
- 默认 Bridge 端口改为 `18473`；维护引擎安装时仍会按本机可用性选择并写入最终端口。

## 验证

- `pnpm check`
- 真实 Obsidian 1.13.7 Vault 中重新加载，检查设置页和最终选择的 loopback 端口。
- 冷重启 Obsidian 后 `127.0.0.1:18473` 恢复监听，`/v1/health` 返回协议版本 1 和 `status: ok`。
- 设置页显示“已连接 http://127.0.0.1:18473”，笔记选段右键菜单显示“引用到 DSH”。

## 回退

回退到 `change/OBSIDIAN-DEEPHARNESS-BRIDGE-20260822-001`。
