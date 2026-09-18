# Vault 与实例绑定 — 2026-09-18

版本：Companion 0.7.0-rc2.1，Protocol 0.4.0-rc2.1。目标环境 DSH 0.1.5-rc.2；使用支持 vault-instance-binding-v1 的 Bridge。本次仅本地源码及合成验证，未部署、未读写用户 Vault、未 push。

## 行为与边界

- 每个 Vault 持久绑定一个稳定 instanceId/profileId；revision 单调增长，operationId 持久幂等，设置与控制接口共用一个写入口。磁盘失败不发布成功。
- 候选发现和绑定授权分开；注册 metadata 不含 token、authenticatedUrl 或 Viewer 登录地址。手动地址也需核验当前身份及 boot。复制 Vault / 相同实例身份冲突时停止自动选择。
- 公共身份和绑定读取只读；HTTP 修改需通过已核验 controller 的认证令牌，并与目标实例、profile、candidate origin/boot 匹配。
- Viewer 只来自匹配绑定的 controller 租约。数据与控制握手核验 Vault、revision、profile 和 DSH boot；旧页面/旧实例不得续租或冒领。
- 新建持久作业保存不可变 Vault/instance/profile/revision 路由。既有未标记作业保持原数据并显示暂停；改绑不会重新标记它们。
- 同名笔记由独立 Vault 通道处理；notes、backlinks、open-note、旧 session-note 携带可选 vaultId，显式错误目标拒绝。历史实例身份不重写。
- 自动可用端口避开浏览器禁用端口。公共注册只发布实际监听地址，独立 Vault 退出不影响其他 Vault。
- SM 缺席时不启动维护知识同步；历史会话可用性由 DSH 的 Maintenance 服务判定，本侧保留错误 code/message。既有冻结迁移与 Core 引用提交协议保留。

## 主要实现

`src/binding/provider.ts` 承载单一写入口、CAS/幂等、活跃身份核验；`src/binding/discovery.ts` 负责候选扫描和 Vault 注册；`src/ui/binding-settings.ts` 提供显式选择/绑定/解除及异步状态。

`src/bridge/server.ts` 承载认证、绑定及 boot fence、独立端口；`src/main.ts` 保存 jobRoutes、保留历史身份并接入 Viewer 与可选知识服务。`src/migrations/v1-pending.ts` 保留新持久字段且不推断旧作业目标。

## 验证

使用源码链接的 Core 0.3.12-rc2.19 与 Protocol 0.4.0-rc2.1。TypeScript 检查、正式 standalone bundle 构建通过；35 个测试文件、246 项测试通过（完整套件）。新增真实 loopback HTTP 测试覆盖双 Vault 同路径、CAS 并发、失败落盘、持久重放、解绑认证重放、旧 token/boot、改绑队列隔离、其他实例不能抢 Viewer、端口冲突和禁用端口。设置使用合成 DOM 验证明确选择及失败反馈；注册使用临时目录验证超大/过期/污染/身份冲突。

真实 Obsidian 桌面点击和真实用户数据演练不在本次验证范围，跨仓组合验收由 Suite 执行。
