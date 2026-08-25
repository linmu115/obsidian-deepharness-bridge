# 0.1.4 反向链接保留 DSH Web Viewer

## 现象

在 Obsidian 内嵌的 DSH Web Viewer 中点击贴纸反向链接时，伴侣插件调用
`workspace.openLinkText(..., newLeaf = false)`。如果 Web Viewer 是当前活动页签，Obsidian
会直接把该页签改成 Markdown 笔记，因此用户看到 DSH 浏览器页面被关闭或替换。

## 原因

旧实现把“当前活动页签”误当成“主编辑区 Markdown 页签”，没有区分 `webviewer` 与
`markdown` 两种视图。后续行号定位还通过全局活动视图取编辑器，进一步绑定了这个错误
假设。

## 修复

- 删除反向链接路径中的 `workspace.openLinkText(..., false)`。
- 只遍历 Obsidian 主编辑区的 `markdown` leaves，绝不把 `webviewer` 作为打开目标。
- 多个 Markdown 页签并存时，优先复用最近活动文件所在的页签；没有 Markdown 页签时才
  新建一个主编辑区页签。
- 通过选定 leaf 的 `openFile()` 打开目标笔记，并保留原生块 ID 定位。
- 旧记录只有行列信息时，直接在选定 leaf 的 Markdown 编辑器中定位，不再查询全局活动
  视图。
- DSH 与 Obsidian 之间的 bridge 协议、反向链接数据和 Vault 文件格式均未改变。

## 修改位置

- `src/workspace/open-note.ts`：与 Obsidian UI 解耦的页签选择和定位流程。
- `src/workspace/obsidian-adapter.ts`：主编辑区 Markdown leaf 的 Obsidian API 适配。
- `src/main.ts`：反向链接回调改用新的主编辑区打开流程。
- `tests/open-note.test.ts`：Web Viewer 保留、最近 Markdown 页、新建页、块定位和行定位回归
  测试。
- `README.md`、`package.json`、`manifest.json`、`versions.json`：行为说明与 0.1.4 版本记录。

## 验证

- `pnpm check` 通过：8 个测试文件、34 项测试全部通过，类型检查和生产构建成功。
- 构建产物已部署到
  `D:\obsidian\obsidian21-4-25\math\.obsidian\plugins\obsidian-deepharness-bridge`。
- 源码与实际安装的 `main.js` SHA-256 一致。
- 停用并重新启用插件后，`127.0.0.1:18473/v1/health` 返回协议版本 1、状态 `ok`。
- 已安装产物包含 `iterateRootLeaves` 主编辑区选择流程，且不再包含旧 `openLinkText` 路径。

## 回滚

回滚到 `change/OBSIDIAN-DEEPHARNESS-BRIDGE-20260823-004` 可恢复 0.1.3。回滚只替换插件
代码，不删除或改写 Vault 笔记、贴纸、引用块和 pending citation 数据。
