# 从独立仓库构建

当前运行环境是 **DSH 0.1.5-rc.2 实例 / web profile**。其他 DSH 版本未验收。以下是开发和打包步骤，不会启动实例、修改绑定或向 Vault 写入。

工具链：Node.js **24.7.0**（见 `.node-version`）。安装步骤需要访问 npm registry；仓库内 SDK 已随源码提供，不需要其它作者工作树。使用锁文件安装，日常不要执行升级依赖命令。

```powershell
git clone https://github.com/linmu115/obsidian-deepharness-bridge.git
cd obsidian-deepharness-bridge
# 使用 pnpm 11.19.0，与 packageManager 声明一致
pnpm install --frozen-lockfile
pnpm build
pnpm typecheck
pnpm test
pnpm package:release
```

pnpm 由 `packageManager` 固定为 **11.19.0**；如本机未安装，可先执行 `npm install --global pnpm@11.19.0`。`pnpm-lock.yaml` 固定实际依赖版本，`pnpm-workspace.yaml` 只声明仓库内成员及构建脚本许可。

打包结果在 `.artifacts/`；打包脚本移除开发依赖、开发脚本和源码映射，并拒绝运行依赖里残留 `file:` / `link:` / `workspace:`。生成运行包前必须先成功构建。

## 固定 SDK

`vendor/SDK-SOURCES.json` 记录每个 SDK 的来源、版本和 SHA-256；tgz 文件也包含在 Git 仓库中。它们只用于编译和测试，运行依赖以发布包清单为准。升级 SDK 时应同步快照、来源记录和锁文件，然后重新执行干净构建。

Companion 仍使用 session-contracts 中的类型与校验规则，所以保留仓库内快照；这不要求构建时克隆或运行 Maintenance。Obsidian 安装使用生成的 main.js、manifest.json、styles.css，保留既有 data.json。
