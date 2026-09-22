# Obsidian DeepHarness Bridge（Companion）

> 当前运行环境：**DSH 0.1.5-rc.2 实例 / web profile**（0.1.5rc2）。其他 DSH 版本尚未验收。本插件安装在 Obsidian，连接此版本的 DSH 实例。


**0.7.0-rc2.8 · Obsidian 侧插件 · 对接 DSH Obsidian Bridge**

在 Vault 中提供笔记选段引用、内嵌 DSH Viewer、定位和双链回执。每个 Vault 同时只连接一个 DSH 实例/profile。无 Maintenance、Launcher、Codex 或 Obsidian CLI 时，基础连接和引用仍可使用。

从本版本 Release 下载 `main.js`、`manifest.json`、`styles.css`，放入目标 Vault 的 `.obsidian/plugins/obsidian-deepharness-bridge/`，然后在第三方插件设置中启用。更新前备份，保留 `data.json`，重新加载插件和内嵌 DSH 页面。

先绑定，再从插件打开内嵌 DSH 页面并选择目标会话，最后在笔记中选文“引用到 DSH”。引用先显示等待接收，目标会话出现气泡后由用户发送。指定内嵌 Viewer 接收，其他窗口不争抢。关联或打开笔记不会自动把正文加入模型上下文。

断开不删除笔记和历史关系；跨端删除按对应引用/链接范围执行。不要复制其它 Vault 的身份或删除待处理记录来掩盖投递失败。

## 部署方法

建议使用桌面版 **Obsidian 1.13.7 及以上**（当前本机基线）；插件清单的最低版本仍为 **1.13.0**。这条教程建议不提高插件本身的最低版本限制。

**环境要求**：桌面版 Obsidian，以及已完成 DSH Obsidian Bridge 安装的目标 DSH 实例 `0.1.5-rc.2`。Companion 是 **Obsidian 侧插件**，不走 `dsh plugin` 命令。

1. 从 [Release v0.7.0-rc2.8](https://github.com/linmu115/obsidian-deepharness-bridge/releases/tag/v0.7.0-rc2.8) 下载 `main.js`、`manifest.json`、`styles.css`，或直接下载 `obsidian-deepharness-bridge-0.7.0-rc2.8.zip`。
2. 在 Obsidian 中**先停用**目标 Vault 的该插件。首次安装则建立 `<Vault>/.obsidian/plugins/obsidian-deepharness-bridge/`。
3. 把三个文件放进这个目录，**不要**多套一层 zip 文件夹。
4. 更新前备份原目录，**保留 `data.json`**（它保存 Vault 身份、绑定与历史引用）。
5. 在 Obsidian 设置 → 第三方插件启用 DeepHarness Bridge，必要时重新加载 Obsidian。按 Obsidian 自身提示确认本地插件。
6. 在 DSH 设置 → **Obsidian 连接**中发现并选择已打开的 Vault，然后连接。

**用法**：先绑定，再从插件打开内嵌 DSH 页面并选择目标会话，最后在笔记中选文「引用到 DSH」。引用先显示等待接收，目标会话出现气泡后由用户发送。指定内嵌 Viewer 接收，其他窗口不争抢。

**更新**：替换三个运行文件（`data.json` 保留不动），重新加载插件和内嵌 DSH 页面。核对实际加载版本，不要只看下载文件名。
**停用/卸载**：先在设置中停用；要移除代码时先备份目录，再通过 Obsidian 插件管理卸载。

DSH 侧可以连接多个 Vault；每个 Vault 同时只绑定一个 DSH 实例/profile。端口只是通信地址，不是实例身份。不要复制其它 Vault 的 `data.json` 冒充绑定，也不要删除待处理记录来掩盖投递失败。

完整说明（安装顺序、数据保留、故障定位）：[INSTALL.md](docs/INSTALL.md)。本批为预发布，当前能力和未完成验收见 [发布验证记录](docs/RELEASE-20260920.md)。

源码开发：[独立克隆、锁定依赖与打包](docs/BUILD.md)。
