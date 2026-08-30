import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));

describe("local-first reference deletion contract", () => {
  it("does not ask for confirmation and skips backlink discovery without a receipt", async () => {
    const source = await readFile(join(repositoryRoot, "src/main.ts"), "utf8");
    expect(source).not.toContain("globalThis.confirm");

    const start = source.indexOf("private async cleanupLocalReferenceDeletion");
    const end = source.indexOf("private async deleteReferencesForMarker", start);
    const cleanup = source.slice(start, end);
    expect(cleanup).toContain("if (receipt === undefined) return;");
    expect(cleanup.indexOf("cleanupOwnedPendingMarker")).toBeLessThan(cleanup.indexOf("deleteCommittedReferenceBacklink"));
  });

  it("keeps user-triggered deletion and its background acknowledgement silent", async () => {
    const source = await readFile(join(repositoryRoot, "src/main.ts"), "utf8");
    const start = source.indexOf("private async deleteReferencesForMarker");
    const end = source.indexOf("private async startBridge", start);
    const deletionLifecycle = source.slice(start, end);

    expect(deletionLifecycle).not.toContain("new Notice");
  });
});
