import { defineConfig } from "tsdown";

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
    neverBundle: ["obsidian", "electron", "@codemirror/state", "@codemirror/view"],
    alwaysBundle: ["zod", "dsh-annotation-core", "dsh-obsidian-bridge-protocol"],
    onlyBundle: ["zod", "dsh-annotation-core", "dsh-obsidian-bridge-protocol"],
  },
  outputOptions: {
    entryFileNames: "main.js",
  },
});
