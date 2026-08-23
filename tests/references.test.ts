import { describe, expect, it } from "vitest";

import type { PendingCitation, ResolvedCitation } from "../src/protocol.ts";
import {
  insertResolvedCitation,
  removeResolvedCitation,
} from "../src/vault/references.ts";
import { contentRevision, type VaultTextAdapter } from "../src/vault/session-notes.ts";

class MemoryVault implements VaultTextAdapter {
  readonly files = new Map<string, string>();
  writes = 0;

  async read(path: string): Promise<string | null> {
    return this.files.get(path) ?? null;
  }

  async write(path: string, content: string): Promise<void> {
    this.files.set(path, content);
    this.writes += 1;
  }
}

const notePath = "架构/DSH维护引擎.md";
const original = "# Generation\n\nGeneration 保存某个时刻完整、可部署的插件组合。\n";
const pending: PendingCitation = {
  protocolVersion: 1,
  type: "pending-citation",
  citationId: "76213b70-7f6e-41be-b2e3-1b195cbf1268",
  notePath,
  blockId: "generation-definition",
  heading: "Generation",
  text: "Generation 保存某个时刻完整、可部署的插件组合。",
  contentHash: contentRevision(original),
};
const resolved: ResolvedCitation = {
  protocolVersion: 1,
  type: "resolved-citation",
  citationId: pending.citationId,
  sessionId: "session-demo",
  anchorId: "user-node-42",
  role: "user",
  quoteHash: "sha256:30101ebf",
};

describe("DSH backlink blocks", () => {
  it("writes a WikiLink, logical dsh link and stable block ID", async () => {
    const vault = new MemoryVault();
    vault.files.set(notePath, original);

    const location = await insertResolvedCitation(vault, pending, resolved);
    const output = vault.files.get(notePath) ?? "";
    expect(location).toMatchObject({ notePath, blockId: "dsh-ref-76213b70" });
    expect(output).toContain("[[DSH会话-session-demo#^user-node-42|DSH 用户提问]]");
    expect(output).toContain("[打开 DSH 会话](obsidian://deepharness?session=session-demo&anchor=user-node-42&quoteHash=sha256%3A30101ebf)");
    expect(output).toContain("引用内容：Generation 保存某个时刻完整、可部署的插件组合。");
    expect(output).toContain("^dsh-ref-76213b70");
  });

  it("makes identical retries idempotent", async () => {
    const vault = new MemoryVault();
    vault.files.set(notePath, original);
    const first = await insertResolvedCitation(vault, pending, resolved);
    const second = await insertResolvedCitation(vault, pending, resolved);

    expect(second).toEqual(first);
    expect(vault.writes).toBe(1);
  });

  it("rejects external note changes and removes only its managed block", async () => {
    const vault = new MemoryVault();
    vault.files.set(notePath, `${original}\n外部追加\n`);
    await expect(insertResolvedCitation(vault, pending, resolved)).rejects.toMatchObject({ code: "REVISION_CONFLICT" });

    vault.files.set(notePath, original);
    const inserted = await insertResolvedCitation(vault, pending, resolved);
    const withUserTail = `${vault.files.get(notePath)}\n用户尾注\n`;
    vault.files.set(notePath, withUserTail);
    const removed = await removeResolvedCitation(vault, notePath, pending.citationId, contentRevision(withUserTail));
    const output = vault.files.get(notePath) ?? "";
    expect(removed.removed).toBe(true);
    expect(output).toContain("用户尾注");
    expect(output).not.toContain("dsh-ref-76213b70");
  });
});
