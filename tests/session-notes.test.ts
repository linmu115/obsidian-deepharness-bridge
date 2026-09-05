import { describe, expect, it } from "vitest";

import {
  contentRevision,
  parseSessionNote,
  readSessionNote,
  renderSessionNote,
  saveSessionNote,
  sessionNotePath,
  type AtomicVaultTextAdapter,
} from "../src/vault/session-notes.ts";
import type { SessionNoteDocument, StickerRecord } from "../src/protocol.ts";

class MemoryVault implements AtomicVaultTextAdapter {
  readonly files = new Map<string, string>();
  writes = 0;
  private tail: Promise<unknown> = Promise.resolve();

  update(path: string, update: (content: string | null) => string): Promise<string> {
    const result = this.tail.then(async () => {
      const previous = this.files.get(path) ?? null;
      const next = update(previous);
      if (next !== previous) await this.write(path, next);
      return next;
    });
    this.tail = result.catch(() => undefined);
    return result;
  }

  async read(path: string): Promise<string | null> {
    return this.files.get(path) ?? null;
  }

  async write(path: string, content: string): Promise<void> {
    this.files.set(path, content);
    this.writes += 1;
  }
}

const sticker: StickerRecord = {
  stickerId: "9bb3a80e-230d-44d1-a37c-f7b79d2bf315",
  sessionId: "session-demo",
  anchorId: "user-node-42",
  role: "user",
  quote: "版本边界",
  quoteHash: "sha256:30101ebf",
  occurrence: 0,
  markdown: "内容",
  tags: ["架构"],
  color: "yellow",
  notePath: "DeepHarness/DSH会话-插件维护系统.md",
  blockId: "dsh-sticker-9bb3a80e",
};

function marker(value: StickerRecord): string {
  const { markdown: _markdown, ...metadata } = value;
  return [
    `<!-- dsh-sticker:${JSON.stringify(metadata)} -->`,
    `> [!note]+ ${value.quote}`,
    ...value.markdown.split("\n").map((line) => `> ${line}`),
    `^${value.blockId}`,
    "<!-- /dsh-sticker -->",
  ].join("\n");
}

describe("session companion Markdown", () => {
  it.each(["# Original user heading\n", null])("allows only one simultaneous save for revision %s", async (source) => {
    const vault = new MemoryVault();
    const path = sessionNotePath(sticker.sessionId);
    if (source !== null) vault.files.set(path, source);
    const revision = contentRevision(source ?? "");
    const document: SessionNoteDocument = { protocolVersion: 1, type: "session-note", sessionId: sticker.sessionId, revision, stickers: [sticker] };
    const outcomes = await Promise.allSettled([
      saveSessionNote(vault, document, revision),
      saveSessionNote(vault, { ...document, stickers: [{ ...sticker, markdown: "concurrent writer" }] }, revision),
    ]);
    expect(outcomes.map((outcome) => outcome.status)).toEqual(["fulfilled", "rejected"]);
    expect(outcomes[1]).toMatchObject({ reason: { code: "REVISION_CONFLICT" } });
    expect(vault.writes).toBe(1);
    expect(parseSessionNote(vault.files.get(path)!, sticker.sessionId).document.stickers[0]?.markdown).toBe(sticker.markdown);
  });

  it("checks a user edit inside the atomic callback rather than accepting a stale read", async () => {
    const vault = new MemoryVault();
    const path = sessionNotePath(sticker.sessionId);
    const original = `user prose\n${marker(sticker)}\n`;
    vault.files.set(path, original);
    const document = await readSessionNote(vault, sticker.sessionId);
    vault.files.set(path, original.replace("> 内容", "> manually edited"));
    await expect(saveSessionNote(vault, { ...document, stickers: [] }, document.revision))
      .rejects.toMatchObject({ code: "REVISION_CONFLICT" });
    expect(vault.files.get(path)).toContain("manually edited");
    expect(vault.writes).toBe(0);
  });

  it("creates a readable companion note on the first sticker save", async () => {
    const vault = new MemoryVault();
    const document: SessionNoteDocument = {
      protocolVersion: 1,
      type: "session-note",
      sessionId: "session-demo",
      revision: contentRevision(""),
      stickers: [sticker],
    };

    await saveSessionNote(vault, document, document.revision);
    const output = vault.files.get(sessionNotePath(document.sessionId)) ?? "";
    expect(output.startsWith("# DSH 会话 session-demo\n\n")).toBe(true);
    expect(output).toContain(sticker.stickerId);
  });

  it("renders multiline sticker quotes as one managed callout title", async () => {
    const vault = new MemoryVault();
    const multiline = {
      ...sticker,
      quote: "第一行引用\n第二行引用",
      markdown: "用户备注",
    };
    const document: SessionNoteDocument = {
      protocolVersion: 1,
      type: "session-note",
      sessionId: "session-demo",
      revision: contentRevision(""),
      stickers: [multiline],
    };

    await saveSessionNote(vault, document, document.revision);
    const output = vault.files.get(sessionNotePath(document.sessionId)) ?? "";

    expect(output).toContain("> [!note]+ 第一行引用 第二行引用\n> 用户备注");
    expect(output).not.toContain("\n第二行引用\n");
    expect(parseSessionNote(output, document.sessionId).document.stickers).toEqual([multiline]);
  });

  it("round-trips managed sticker blocks without rewriting user Markdown", () => {
    const original = `---\ntitle: 手写标题\n---\n\n自由正文\n\n${marker(sticker)}\n\n尾部正文\n`;
    const parsed = parseSessionNote(original, "session-demo");

    expect(parsed.document.stickers).toEqual([sticker]);
    expect(renderSessionNote(parsed)).toBe(original);
  });

  it("updates and deletes marker blocks while preserving text outside them", async () => {
    const vault = new MemoryVault();
    const path = sessionNotePath("session-demo");
    const original = `---\nowner: user\n---\n\n不可改正文\n\n${marker(sticker)}\n\n结尾原文\n`;
    vault.files.set(path, original);
    const read = await readSessionNote(vault, "session-demo");
    const second: StickerRecord = {
      ...sticker,
      stickerId: "048a8418-98e9-4c60-8b2b-d44535fd1299",
      anchorId: "assistant-node-43",
      role: "assistant",
      quote: "完整组合",
      markdown: "新增贴纸",
      color: "blue",
      blockId: "dsh-sticker-048a8418",
    };
    const changed: SessionNoteDocument = { ...read, stickers: [second] };

    const saved = await saveSessionNote(vault, changed, read.revision);
    const output = vault.files.get(path) ?? "";
    expect(saved.revision).toBe(contentRevision(output));
    expect(output).toContain("---\nowner: user\n---\n\n不可改正文\n\n");
    expect(output).toContain("\n\n结尾原文\n");
    expect(output).not.toContain(sticker.stickerId);
    expect(output).toContain(second.stickerId);
  });

  it("rejects stale revisions before writing", async () => {
    const vault = new MemoryVault();
    const path = sessionNotePath("session-demo");
    vault.files.set(path, "外部修改\n");
    const document: SessionNoteDocument = {
      protocolVersion: 1,
      type: "session-note",
      sessionId: "session-demo",
      revision: "sha256:old",
      stickers: [sticker],
    };

    await expect(saveSessionNote(vault, document, "sha256:old")).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
    expect(vault.writes).toBe(0);
  });

  it("diagnoses damaged markers and never overwrites them", async () => {
    const vault = new MemoryVault();
    const path = sessionNotePath("session-demo");
    vault.files.set(path, "正文\n<!-- dsh-sticker:{bad json} -->\n> 内容\n<!-- /dsh-sticker -->\n");

    await expect(readSessionNote(vault, "session-demo")).rejects.toMatchObject({ code: "CORRUPT_MARKER" });
    expect(vault.writes).toBe(0);
  });
});
