# 0.1.3 Obsidian 原生贴纸反向链接

## 现象

0.1.2 为发现贴纸反链，会读取 Vault 中全部 Markdown，再用正则匹配
`obsidian://deepharness` 和 `dsh://`。这条路径与 Obsidian 原生链接索引重复，而且外部协议
链接本身不是 Obsidian 链接图中的引用。

## 修复

- 删除外部协议正则、旧链接身份匹配和 `listMarkdownFiles()` 全库扫描接口。
- 通过 `metadataCache.resolvedLinks` 获取指向贴纸伴生文件的源笔记候选。
- 通过 `getFileCache(source).links` 和 `getFirstLinkpathDest()` 核对精确的贴纸块 ID。
- 从缓存返回链接行列、最近标题和已有源块 ID，只读取实际命中的源笔记生成摘要。
- 对结果执行协议校验、位置去重和稳定排序。
- 没有源块 ID 时，打开笔记后设置光标并滚动到引用行。

`obsidian://deepharness` 继续只承担“回到 DSH”的执行职责，不参与反向链接索引。

## 验证

- Obsidian 类型检查、单元测试和生产构建通过。
- 新增原生索引测试，覆盖目标解析、精确块匹配、行列、标题、源块和摘要。
- 确认反链实现不再调用 Vault 全量 Markdown 列举。

## 回滚

回滚到 `change/OBSIDIAN-DEEPHARNESS-BRIDGE-20260823-003` 可恢复 0.1.2。回滚代码不会
删除 Vault 中的 WikiLink、协议链接或贴纸伴生笔记。
