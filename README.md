# Obsidian DeepHarness Bridge（Companion）

**0.7.0-rc2.6 · Obsidian 侧插件 · 对接 DSH Obsidian Bridge**

在 Vault 中提供笔记选段引用、内嵌 DSH Viewer、定位和双链回执。每个 Vault 同时只连接一个 DSH 实例/profile。无 Maintenance、Launcher、Codex 或 Obsidian CLI 时，基础连接和引用仍可使用。

从本版本 Release 下载 `main.js`、`manifest.json`、`styles.css`，放入目标 Vault 的 `.obsidian/plugins/obsidian-deepharness-bridge/`，然后在第三方插件设置中启用。更新前备份，保留 `data.json`，重新加载插件和内嵌 DSH 页面。

先绑定，再从插件打开内嵌 DSH 页面并选择目标会话，最后在笔记中选文“引用到 DSH”。引用先显示等待接收，目标会话出现气泡后由用户发送。指定内嵌 Viewer 接收，其他窗口不争抢。关联或打开笔记不会自动把正文加入模型上下文。

断开不删除笔记和历史关系；跨端删除按对应引用/链接范围执行。不要复制其它 Vault 的身份或删除待处理记录来掩盖投递失败。

## 安装、配置与使用

[完整命令行与手动安装教程](docs/INSTALL.md) · [下载本版本附件](https://github.com/linmu115/obsidian-deepharness-bridge/releases/tag/v0.7.0-rc2.6)

本批为预发布，安装顺序、数据保留、更新卸载和故障定位均在教程中。无需用户的 LLM 才能完成基础配置。当前能力和未完成验收见 [发布验证记录](docs/RELEASE-20260920.md)。
