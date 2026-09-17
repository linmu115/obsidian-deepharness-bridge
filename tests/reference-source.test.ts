import { describe, expect, it } from "vitest";

import { documentHash } from "../src/protocol.ts";
import {
  createObsidianReferenceCapture,
  refreshObsidianReference,
  type ReferenceVaultReader,
} from "../src/vault/reference-source.ts";

class MemoryReader implements ReferenceVaultReader {
  constructor(readonly files = new Map<string, string>()) {}
  async read(path: string): Promise<string | null> { return this.files.get(path) ?? null; }
}

const path = "架构/维护系统.md";
const original = "# 维护系统\n\nGeneration 保存完整组合。 ^generation-definition\n";

function capture(markdown = original) {
  return createObsidianReferenceCapture({
    actionId: "action-1",
    referenceId: "reference-1",
    vaultId: "vault-1",
    notePath: path,
    heading: "维护系统",
    blockId: "generation-definition",
    occurrence: 0,
    selectedText: "Generation 保存完整组合。",
    markdown,
    capturedAt: 100,
  });
}

describe("Obsidian reference source snapshots", () => {
  it.each([
    'first line ^dsh-note-test\nsecond line\n',
    'first line\nsecond line ^dsh-note-test\n',
    'first line ^dsh-note-other\nsecond line ^dsh-note-test\n',
  ])('refreshes a multiline selection anchored by either capture mode: %s', async markdown => {
    const value = createObsidianReferenceCapture({ actionId:'a', referenceId:'r', vaultId:'v', notePath:path,
      blockId:'dsh-note-test', occurrence:0, selectedText:'first line\nsecond line', markdown, capturedAt:100 });
    const reader = new MemoryReader(new Map([[path, markdown + '\nUnrelated append\n']]));
    expect(await refreshObsidianReference(reader, value)).toMatchObject({kind:'refreshed'});
    reader.files.set(path, markdown.replace('first line', 'edited line'));
    expect(await refreshObsidianReference(reader, value)).toEqual({kind:'blocked',reason:'selection-changed'});
  });

  it('ignores only trailing Bridge markers while keeping the selected text and identity', async () => {
    const markdown = 'first line\nsecond line ^dsh-note-test\n';
    const value = createObsidianReferenceCapture({ actionId:'a', referenceId:'r', vaultId:'v', notePath:path,
      blockId:'dsh-note-test', occurrence:0, selectedText:'first line\nsecond line', markdown, capturedAt:100 });
    const reader = new MemoryReader(new Map([[path, markdown.replace('first line', 'first line ^dsh-note-new')]]));
    expect(await refreshObsidianReference(reader, value)).toMatchObject({kind:'refreshed',source:{selectedText:value.source.selectedText,locator:value.source.locator}});
    reader.files.set(path, markdown.replace('first line', 'first line ^dsh-note-new real content'));
    expect(await refreshObsidianReference(reader, value)).toEqual({kind:'blocked',reason:'selection-changed'});
  });

  it('does not recover the quote from a different block or guess between occurrences', async () => {
    const value = capture();
    const elsewhere = '# title\nchanged block ^generation-definition\nGeneration 保存完整组合。\n';
    expect(await refreshObsidianReference(new MemoryReader(new Map([[path, elsewhere]])), value))
      .toEqual({kind:'blocked',reason:'selection-changed'});
    const duplicateBefore = 'Generation 保存完整组合。\n\n' + original;
    expect(await refreshObsidianReference(new MemoryReader(new Map([[path, duplicateBefore]])), value))
      .toEqual({kind:'blocked',reason:'ambiguous'});
  });
  it("follows a uniquely indexed moved note without changing its stable block identity", async () => {
    const moved = "Moved/source.md";
    const reader: ReferenceVaultReader = {
      read: async (notePath) => notePath === moved ? original : null,
      findMarkdownPaths: async (kind, id) => {
        expect([kind, id]).toEqual(["block", "generation-definition"]); return [moved];
      },
    };
    expect(await refreshObsidianReference(reader, capture(), 200)).toMatchObject({ kind: "refreshed", source: { locator: { notePath: moved, blockId: "generation-definition" }, snapshot: { markdown: original } } });
  });

  it("refuses to guess among moved notes or duplicate block markers", async () => {
    const reader: ReferenceVaultReader = { read: async (notePath) => notePath === path ? null : original, findMarkdownPaths: async () => ["a.md", "b.md"] };
    expect(await refreshObsidianReference(reader, capture())).toEqual({ kind: "blocked", reason: "ambiguous" });
    expect(await refreshObsidianReference(new MemoryReader(new Map([[path, original + original]])), capture()))
      .toEqual({ kind: "blocked", reason: "ambiguous" });
  });

  it("captures the complete Markdown and both content identities", () => {
    const value = capture();
    expect(value.source.snapshot).toEqual({
      markdown: original,
      documentHash: documentHash(original),
      capturedAt: 100,
      freshness: "captured",
    });
    expect(value.source.locator).toMatchObject({ vaultId: "vault-1", blockId: "generation-definition", occurrence: 0 });
  });

  it("refreshes changed Markdown only while the same block and selection remain", async () => {
    const changed = `${original}\n新增正文\n`;
    const reader = new MemoryReader(new Map([[path, changed]]));
    const result = await refreshObsidianReference(reader, capture(), 200);
    expect(result).toMatchObject({ kind: "refreshed", source: { snapshot: { markdown: changed, freshness: "refreshed", capturedAt: 200 } } });

    reader.files.set(path, "# 维护系统\n\n选段已删除。\n");
    await expect(refreshObsidianReference(reader, capture(), 300)).resolves.toEqual({ kind: "blocked", reason: "block-missing" });
  });

  it("reports missing notes and returns unchanged for the captured document", async () => {
    await expect(refreshObsidianReference(new MemoryReader(), capture(), 200)).resolves.toEqual({ kind: "blocked", reason: "note-missing" });
    await expect(refreshObsidianReference(new MemoryReader(new Map([[path, original]])), capture(), 200))
      .resolves.toMatchObject({ kind: "unchanged", source: { snapshot: { documentHash: documentHash(original) } } });
  });
});
