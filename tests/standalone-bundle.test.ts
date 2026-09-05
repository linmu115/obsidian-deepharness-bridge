import { readFile } from "node:fs/promises";
import { createRequire, isBuiltin } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Script } from "node:vm";

import { describe, expect, it } from "vitest";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const bundlePath = process.env.DSH_OBSIDIAN_BUNDLE_PATH ?? join(repositoryRoot, "main.js");
const hostRequire = createRequire(import.meta.url);
const hostPackages = new Set(["obsidian", "electron", "@codemirror/state", "@codemirror/view"]);

describe("standalone Obsidian bundle", () => {
  it("only imports modules provided by the Obsidian host, including deferred imports", async () => {
    const bundle = await readFile(bundlePath, "utf8");
    const imports = [...bundle.matchAll(/\b(?:require|import)\s*\(\s*["']([^"']+)["']\s*\)/g)]
      .map((match) => match[1]!);
    expect(imports).toContain("obsidian");
    expect(imports.filter((id) => !isBuiltin(id) && !hostPackages.has(id))).toEqual([]);
  });

  it("evaluates the compiled CommonJS entry without access to development dependencies", async () => {
    const bundle = await readFile(bundlePath, "utf8");
    class Plugin {}
    // Only the host base classes are needed during module evaluation. Do not
    // resolve arbitrary packages through this checkout's node_modules: that
    // masks missing bundled dependencies such as the protocol /data subpath.
    const isolatedRequire = (id: string): unknown => {
      if (id === "obsidian") return { Plugin, PluginSettingTab: class {} };
      if (isBuiltin(id) || id === "@codemirror/state" || id === "@codemirror/view") {
        return hostRequire(id);
      }
      throw new Error(`Standalone plugin cannot require ${id}`);
    };
    const pluginModule = { exports: {} as unknown };
    const evaluate = new Script(`(function(require, module, exports) {\n${bundle}\n})`, {
      filename: bundlePath,
    }).runInThisContext() as (require: typeof isolatedRequire, module: typeof pluginModule, exports: unknown) => void;
    evaluate(isolatedRequire, pluginModule, pluginModule.exports);
    const PluginEntry = pluginModule.exports as new () => Plugin & { onload: () => Promise<void> };
    const instance = new PluginEntry();
    expect(instance).toBeInstanceOf(Plugin);
    expect(instance.onload).toBeTypeOf("function");
  });
});
