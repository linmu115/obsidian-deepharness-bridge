import { describe, expect, it } from "vitest";

import type { PendingCitation, ResolvedCitation } from "../src/protocol.ts";
import type { BacklinkCommitV2, ReferenceDeleteCommitV2 } from "../src/protocol.ts";
import {
  commitReferenceBacklink,
  deleteCommittedReferenceBacklink,
  insertResolvedCitation,
  removeResolvedCitation,
} from "../src/vault/references.ts";
import { createObsidianReferenceCapture } from "../src/vault/reference-source.ts";
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

  async process(path: string, update: (content: string) => string): Promise<string> {
    const output = update(this.files.get(path) ?? "");
    if (output !== this.files.get(path)) {
      this.files.set(path, output);
      this.writes += 1;
    }
    return output;
  }

  async listMarkdownPaths(): Promise<string[]> {
    return [...this.files.keys()].filter((path) => path.endsWith(".md"));
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

  it("commits protocol-v2 backlinks atomically and recovers a missing receipt from the marker", async () => {
    const vault = new MemoryVault();
    vault.files.set(notePath, original);
    const capture = createObsidianReferenceCapture({
      actionId: "action-1",
      referenceId: pending.citationId,
      vaultId: "vault-1",
      notePath,
      heading: "Generation",
      blockId: "generation-definition",
      occurrence: 0,
      selectedText: pending.text,
      markdown: original,
      capturedAt: 100,
    });
    const commit: BacklinkCommitV2 = {
      annotationProtocolVersion: 2,
      type: "backlink-commit",
      referenceId: capture.referenceId,
      setId: "set-1",
      profileId: "web",
      sessionId: "session-demo",
      userMessageId: "user-message-42",
      userAnchorId: "user-node-42",
      userTextHash: "sha256:30101ebf30101ebf30101ebf30101ebf30101ebf30101ebf30101ebf30101ebf",
    };

    const first = await commitReferenceBacklink(vault, capture, commit, undefined, 200);
    const recovered = await commitReferenceBacklink(vault, capture, commit, undefined, 300);
    expect(recovered).toEqual({ ...first, writtenAt: 300 });
    expect(vault.writes).toBe(1);
    expect(vault.files.get(notePath)).toContain(`"referenceId":"${capture.referenceId}"`);
    expect(vault.files.get(notePath)).toContain(`"setId":"set-1"`);
  });

  it("rejects conflicting retries and concurrent note revisions without overwriting", async () => {
    const vault = new MemoryVault();
    vault.files.set(notePath, original);
    const capture = createObsidianReferenceCapture({
      actionId: "action-1", referenceId: pending.citationId, vaultId: "vault-1", notePath,
      blockId: "generation-definition", occurrence: 0, selectedText: pending.text, markdown: original, capturedAt: 100,
    });
    const commit: BacklinkCommitV2 = {
      annotationProtocolVersion: 2, type: "backlink-commit", referenceId: capture.referenceId,
      setId: "set-1", profileId: "web", sessionId: "session-demo", userMessageId: "user-1", userAnchorId: "anchor-1",
      userTextHash: "sha256:30101ebf30101ebf30101ebf30101ebf30101ebf30101ebf30101ebf30101ebf",
    };
    const receipt = await commitReferenceBacklink(vault, capture, commit, undefined, 200);
    await expect(commitReferenceBacklink(vault, capture, { ...commit, setId: "set-2" }, receipt, 300))
      .rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });

    const secondVault = new MemoryVault();
    secondVault.files.set(notePath, `${original}\n用户修改\n`);
    await expect(commitReferenceBacklink(secondVault, capture, commit, undefined, 200))
      .rejects.toMatchObject({ code: "REVISION_CONFLICT" });
    expect(secondVault.writes).toBe(0);
  });

  it("deletes the exact committed block after a note move and makes retries idempotent", async () => {
    const vault = new MemoryVault();
    vault.files.set(notePath, original);
    const capture = createObsidianReferenceCapture({
      actionId: "action-delete", referenceId: pending.citationId, vaultId: "vault-1", notePath,
      blockId: "generation-definition", occurrence: 0, selectedText: pending.text, markdown: original, capturedAt: 100,
    });
    const commit: BacklinkCommitV2 = {
      annotationProtocolVersion: 2, type: "backlink-commit", referenceId: capture.referenceId,
      setId: "set-delete", profileId: "web", sessionId: "session-delete", userMessageId: "user-delete",
      userAnchorId: "anchor-delete",
      userTextHash: "sha256:30101ebf30101ebf30101ebf30101ebf30101ebf30101ebf30101ebf30101ebf",
    };
    await commitReferenceBacklink(vault, capture, commit, undefined, 200);
    const movedPath = "归档/DSH维护引擎.md";
    vault.files.set(movedPath, vault.files.get(notePath) ?? "");
    vault.files.delete(notePath);
    const deletion: ReferenceDeleteCommitV2 = {
      annotationProtocolVersion: 2, type: "reference-delete-commit", referenceId: capture.referenceId,
      profileId: commit.profileId, sessionId: commit.sessionId, setId: commit.setId, deletedAt: 300,
    };

    await expect(deleteCommittedReferenceBacklink(vault, deletion, notePath)).resolves.toMatchObject({
      removed: true,
      notePath: movedPath,
    });
    expect(vault.files.get(movedPath)).toContain("Generation 保存某个时刻完整、可部署的插件组合。");
    expect(vault.files.get(movedPath)).not.toContain("dsh-reference");
    await expect(deleteCommittedReferenceBacklink(vault, deletion, notePath)).resolves.toEqual({ removed: false });
  });

  it("refuses to delete a generated block belonging to another DSH relation", async () => {
    const vault = new MemoryVault();
    vault.files.set(notePath, original);
    const capture = createObsidianReferenceCapture({
      actionId: "action-conflict", referenceId: pending.citationId, vaultId: "vault-1", notePath,
      blockId: "generation-definition", occurrence: 0, selectedText: pending.text, markdown: original, capturedAt: 100,
    });
    const commit: BacklinkCommitV2 = {
      annotationProtocolVersion: 2, type: "backlink-commit", referenceId: capture.referenceId,
      setId: "set-real", profileId: "web", sessionId: "session-real", userMessageId: "user-real", userAnchorId: "anchor-real",
      userTextHash: "sha256:30101ebf30101ebf30101ebf30101ebf30101ebf30101ebf30101ebf30101ebf",
    };
    await commitReferenceBacklink(vault, capture, commit, undefined, 200);
    const before = vault.files.get(notePath);
    await expect(deleteCommittedReferenceBacklink(vault, {
      annotationProtocolVersion: 2, type: "reference-delete-commit", referenceId: capture.referenceId,
      profileId: commit.profileId, sessionId: commit.sessionId, setId: "set-other", deletedAt: 300,
    }, notePath)).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    expect(vault.files.get(notePath)).toBe(before);
  });
});
