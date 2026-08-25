import { describe, expect, it } from "vitest";

import { DEFAULT_SETTINGS } from "../src/settings.ts";
import {
  migrateStoredPluginData,
  releaseMigratedReference,
  type MigrationVaultReader,
  type StoredPluginDataV2,
} from "../src/migrations/v1-pending.ts";
import { documentHash } from "../src/protocol.ts";

class MemoryVault implements MigrationVaultReader {
  constructor(readonly files = new Map<string, string>()) {}
  async read(path: string): Promise<string | null> { return this.files.get(path) ?? null; }
}

const notePath = "架构/维护系统.md";
const markdown = "# 维护系统\n\nGeneration 保存完整组合。 ^generation-definition\n";
const legacy = {
  protocolVersion: 1,
  type: "pending-citation",
  citationId: "76213b70-7f6e-41be-b2e3-1b195cbf1268",
  notePath,
  blockId: "generation-definition",
  heading: "维护系统",
  text: "Generation 保存完整组合。",
  contentHash: documentHash(markdown),
};

const options = (vault: MemoryVault) => ({
  vault,
  defaultSettings: DEFAULT_SETTINGS,
  createVaultId: () => "vault-stable-1",
  createActionId: () => "migration-action-1",
  now: () => 100,
});

describe("v1 pending citation migration", () => {
  it("backfills current full Markdown but waits for explicit targeted release", async () => {
    const vault = new MemoryVault(new Map([[notePath, markdown]]));
    const migrated = await migrateStoredPluginData({ settings: {}, pendingCitations: [legacy] }, options(vault));
    expect(migrated).toMatchObject({ dataVersion: 2, vaultId: "vault-stable-1" });
    expect(migrated.pendingReferences).toHaveLength(1);
    expect(migrated.pendingReferences[0]).toMatchObject({
      state: "migrated-ready",
      capture: {
        referenceId: legacy.citationId,
        source: { snapshot: { markdown }, locator: { vaultId: "vault-stable-1", occurrence: 0 } },
      },
    });

    const released = releaseMigratedReference(migrated, legacy.citationId);
    expect(released.changed).toBe(true);
    expect(released.data.pendingReferences[0]).toMatchObject({ state: "queued", capture: { referenceId: legacy.citationId } });
    expect(releaseMigratedReference(released.data, legacy.citationId).changed).toBe(false);
  });

  it("quarantines malformed or missing records independently and is idempotent on v2 data", async () => {
    const migrated = await migrateStoredPluginData({
      pendingCitations: [legacy, { citationId: "broken", notePath: 42 }],
    }, options(new MemoryVault()));
    expect(migrated.pendingReferences).toEqual([
      expect.objectContaining({ state: "needs-reselect", referenceId: legacy.citationId, reason: "note-missing" }),
      expect.objectContaining({ state: "needs-reselect", referenceId: "legacy-invalid-2", reason: "invalid-record" }),
    ]);
    expect(await migrateStoredPluginData(migrated, options(new MemoryVault()))).toEqual(migrated);
  });

  it("does not resurrect a citation whose managed backlink marker already exists", async () => {
    const withMarker = `${markdown}\n<!-- dsh-reference:{"referenceId":"${legacy.citationId}"} -->\n> existing\n<!-- /dsh-reference -->\n`;
    const migrated = await migrateStoredPluginData({ pendingCitations: [legacy] }, options(new MemoryVault(new Map([[notePath, withMarker]]))));
    expect(migrated.pendingReferences).toEqual([]);
  });

  it("leaves claimed and queued v2 records unchanged across restart", async () => {
    const base = await migrateStoredPluginData({ pendingCitations: [legacy] }, options(new MemoryVault(new Map([[notePath, markdown]]))));
    const released = releaseMigratedReference(base, legacy.citationId).data;
    const claimed: StoredPluginDataV2 = {
      ...released,
      pendingReferences: released.pendingReferences.map((record) => record.state === "queued" ? {
        state: "claimed" as const,
        capture: record.capture,
        claim: {
          annotationProtocolVersion: 2,
          type: "reference-claim" as const,
          referenceId: record.capture.referenceId,
          profileId: "web",
          sessionId: "session-1",
          setId: "set-1",
        },
      } : record),
    };
    expect((await migrateStoredPluginData(released, options(new MemoryVault()))).pendingReferences[0]?.state).toBe("queued");
    expect((await migrateStoredPluginData(claimed, options(new MemoryVault()))).pendingReferences[0]?.state).toBe("claimed");
  });
});
