# Maintenance 独立管理 Vault 绑定

候选版本：0.7.0-rc2.4。Maintenance 可以为已登记、尚未启动的 DSH 实例创建或解除 Vault 绑定。Vault 仍需在 Obsidian 中打开并运行兼容桥插件。

新增仅限本机调用的绑定入口，验证 Maintenance 使用本机连接密钥签发的短期 HMAC 授权。授权关联 Vault、publisher、boot、稳定实例与 profile、操作 ID、预期修订和绑定意图；拒绝浏览器 Origin、伪造授权、过期授权和身份不匹配。既有绑定提供方负责最终持久化、修订检查与重复操作回执，不创建 DSH 运行身份或控制令牌。

共享契约位于配套 Maintenance 仓库的 packages/contracts/src/vault-bindings.ts，详细接口记录为 docs/project/records/interfaces/offline-vault-binding.md。构建产物包含契约实现，无外部 contracts 运行依赖。

验证：maintenance-binding、vault-binding、vault-location 共 21 项测试通过；类型检查及构建通过。测试使用合成目录和状态，覆盖 DSH 离线绑定、解绑、重复操作、旧修订、其他实例解绑及伪造/过期/错误身份授权拒绝。

本轮仅修改源码和构建候选，未安装到真实 Vault，未修改真实绑定或笔记。需与配套 Maintenance 版本共同部署；生产交互和 Windows 文件夹选择视觉未验收。
