import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));

describe("standalone Obsidian bundle", () => {
  it("does not leave the lifecycle protocol as a runtime package import", async () => {
    const bundle = await readFile(join(repositoryRoot, "main.js"), "utf8");
    expect(bundle).not.toContain('require("dsh-obsidian-bridge-protocol")');
  });
});
