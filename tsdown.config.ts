import { defineConfig } from "tsdown";

// String entries match exact specifiers. Include subpaths such as the shared
// protocol /data export, since the installed plugin has no node_modules.
const bundledDependencies = [
  /^zod(?:\/|$)/,
  /^dsh-annotation-core(?:\/|$)/,
  /^dsh-obsidian-bridge-protocol(?:\/|$)/,
];
const hostDependencies = ["obsidian", "electron", "@codemirror/state", "@codemirror/view"];

export default defineConfig({
  entry: { main: "src/main.ts" },
  outDir: ".",
  format: "cjs",
  platform: "node",
  target: "node20",
  clean: false,
  dts: false,
  sourcemap: true,
  deps: {
    neverBundle: hostDependencies,
    alwaysBundle: bundledDependencies,
    onlyBundle: bundledDependencies,
    onlyImport: hostDependencies,
  },
  outputOptions: {
    entryFileNames: "main.js",
  },
});
