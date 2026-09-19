# Maintenance 独立管理 Vault 绑定

候选版本：0.7.0-rc2.4。Maintenance 可以为已登记、尚未启动的 DSH 实例创建或解除 Vault 绑定。Vault 仍需在 Obsidian 中打开并运行兼容桥插件。

新增仅限本机调用的绑定入口，验证 Maintenance 使用本机连接密钥签发的短期 HMAC 授权。授权关联 Vault、publisher、boot、稳定实例与 profile、操作 ID、预期修订和绑定意图；拒绝浏览器 Origin、伪造授权、过期授权和身份不匹配。既有绑定提供方负责最终持久化、修订检查与重复操作回执，不创建 DSH 运行身份或控制令牌。

共享契约位于配套 Maintenance 仓库的 packages/contracts/src/vault-bindings.ts，详细接口记录为 docs/project/records/interfaces/offline-vault-binding.md。构建产物包含契约实现，无外部 contracts 运行依赖。

验证：maintenance-binding、vault-binding、vault-location 共 21 项测试通过；类型检查及构建通过。测试使用合成目录和状态，覆盖 DSH 离线绑定、解绑、重复操作、旧修订、其他实例解绑及伪造/过期/错误身份授权拒绝。

本轮仅修改源码和构建候选，未安装到真实 Vault，未修改真实绑定或笔记。需与配套 Maintenance 版本共同部署；生产交互和 Windows 文件夹选择视觉未验收。

## 后续授权安装

同日用户授权提交推送和替换安装后，0.7.0-rc2.4 已备份安装到此前已绑定的 math Vault，通过官方 Obsidian CLI 明确选择原生 Vault ID 并重载成功。main.js 与本轮构建字节一致，manifest/style 按安装器换行规范一致；data.json 字节及原绑定修订 1 完全不变。配套 Maintenance Engine .45 的真实只读接口在 DSH 停止时返回 Vault 在线、可管理。安装版视觉及真实新建/解绑仍未验收，没有笔记编辑或绑定测试写入。

本次源码 d162f5b 已推送。此前 CLI 功能在 DSH 侧独立仓库 dsh-obsidian-bridge 的 d3b21f7，已核对远端 main 包含；无需在本仓库重复提交。

当前地图及开发历程由配套 Session Maintenance 项目维护：项目 ID 0d05f813-7097-47d9-9e88-3d523bb537d6，HIST-offline-vault-binding；激活报告 docs/reports/2026-09-19-engine45-binding-activation.md。本机安装证据在 artifacts/offline-vault-binding-20260919，不随源码推送。
