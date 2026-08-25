import type { Constructor, MarkdownView, Menu, Plugin, TFile } from "obsidian";

import { documentHash } from "../protocol.ts";
import { contentRevision } from "../vault/session-notes.ts";
import { createObsidianReferenceCapture, selectionOffsets } from "../vault/reference-source.ts";
import type { NoteSelection, SelectionCaptureOptions } from "./editor-menu.ts";

interface SelectionLike {
  rangeCount: number;
  toString(): string;
  getRangeAt(index: number): { commonAncestorContainer: unknown };
}

interface ReadingViewLike {
  file: { path: string } | null;
  containerEl: { contains(node: unknown): boolean };
  getViewData(): string;
}

interface ProcessVaultLike {
  process(file: TFile, callback: (content: string) => string): Promise<string>;
}

function normalize(value: string): string { return value.replace(/\r\n?/g, "\n").normalize("NFC").trim(); }

function headingBefore(source: string, offset: number): string | undefined {
  const lines = source.slice(0, offset).split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const heading = /^#{1,6}\s+(.+?)\s*$/.exec(lines[index] ?? "");
    if (heading?.[1]) return heading[1];
  }
  return undefined;
}

function makeBlockId(path: string, text: string, occurrence: number): string {
  return `dsh-note-${contentRevision(`${path}:${occurrence}:${text}`).slice(7, 15)}`;
}

function blockIdFromDom(node: unknown): string | undefined {
  if (!node || typeof node !== "object") return undefined;
  const candidate = node as {
    parentElement?: unknown;
    closest?: (selector: string) => unknown;
    getAttribute?: (name: string) => string | null;
    dataset?: { blockId?: string };
  };
  const element = typeof candidate.closest === "function" ? candidate : candidate.parentElement as typeof candidate | undefined;
  const block = element && typeof element.closest === "function"
    ? element.closest("[data-block-id], [id]") as typeof candidate | null
    : null;
  const raw = block?.dataset?.blockId ?? block?.getAttribute?.("data-block-id") ?? block?.getAttribute?.("id") ?? undefined;
  return raw?.replace(/^block-/, "") || undefined;
}

function lineForOffset(source: string, offset: number): { start: number; end: number; text: string } {
  const start = source.lastIndexOf("\n", offset) + 1;
  const endAt = source.indexOf("\n", offset);
  const end = endAt < 0 ? source.length : endAt;
  return { start, end, text: source.slice(start, end) };
}

function occurrenceFromDomOrUniqueness(source: string, text: string, node: unknown): number | undefined {
  const offsets = selectionOffsets(source, text);
  if (offsets.length === 1) return 0;
  const domBlockId = blockIdFromDom(node);
  if (!domBlockId) return undefined;
  const matching = offsets.findIndex((offset) => lineForOffset(source, offset).text.includes(`^${domBlockId}`));
  return matching < 0 ? undefined : matching;
}

export function captureReadingSelection(
  view: ReadingViewLike,
  selection: SelectionLike,
  options: SelectionCaptureOptions = {},
): NoteSelection | null {
  if (!view.file || selection.rangeCount !== 1) return null;
  const range = selection.getRangeAt(0);
  if (!view.containerEl.contains(range.commonAncestorContainer)) return null;
  const text = normalize(selection.toString());
  if (!text) return null;
  const source = view.getViewData().replace(/\r\n?/g, "\n");
  const occurrence = occurrenceFromDomOrUniqueness(source, text, range.commonAncestorContainer);
  if (occurrence === undefined) return null;
  const offset = selectionOffsets(source, text)[occurrence];
  if (offset === undefined) return null;
  const line = lineForOffset(source, offset).text;
  const existingBlockId = /(?:^|\s)\^([A-Za-z0-9-]+)\s*$/.exec(line)?.[1];
  const blockId = existingBlockId ?? makeBlockId(view.file.path, text, occurrence);
  const values = {
    vaultId: options.vaultId ?? "vault-unconfigured",
    referenceId: options.createReferenceId?.() ?? crypto.randomUUID(),
    actionId: options.createActionId?.() ?? crypto.randomUUID(),
    capturedAt: options.now?.() ?? Date.now(),
  };
  return {
    ...createObsidianReferenceCapture({
      actionId: values.actionId,
      referenceId: values.referenceId,
      vaultId: values.vaultId,
      notePath: view.file.path,
      ...(headingBefore(source, offset) ? { heading: headingBefore(source, offset)! } : {}),
      blockId,
      occurrence,
      selectedText: text,
      markdown: source,
      capturedAt: values.capturedAt,
    }),
    requiresBlockIdWrite: !existingBlockId,
  };
}

export async function ensureReadingBlockId(
  vault: ProcessVaultLike,
  file: TFile,
  selection: NoteSelection,
): Promise<NoteSelection> {
  if (!selection.requiresBlockIdWrite) return selection;
  const output = await vault.process(file, (content) => {
    const source = content.replace(/\r\n?/g, "\n");
    const offset = selectionOffsets(source, selection.source.selectedText)[selection.source.locator.occurrence];
    if (offset === undefined) throw new Error("Selected paragraph changed before its block ID could be written");
    const line = lineForOffset(source, offset);
    if (/(?:^|\s)\^[A-Za-z0-9-]+\s*$/.test(line.text)) return source;
    return `${source.slice(0, line.end)} ^${selection.source.locator.blockId}${source.slice(line.end)}`;
  });
  return {
    ...selection,
    source: {
      ...selection.source,
      snapshot: {
        markdown: output,
        documentHash: documentHash(output),
        capturedAt: selection.source.snapshot.capturedAt,
        freshness: "captured",
      },
    },
    requiresBlockIdWrite: false,
  };
}

export interface ReadingMenuOptions {
  markdownViewType: Constructor<MarkdownView>;
  createMenu(): Menu;
  captureOptions?(): SelectionCaptureOptions;
  onCitation(selection: NoteSelection): Promise<void>;
}

export function registerReadingSelectionMenu(plugin: Plugin, options: ReadingMenuOptions): void {
  plugin.registerDomEvent(document, "contextmenu", (event) => {
    const view = plugin.app.workspace.getActiveViewOfType(options.markdownViewType);
    const selection = document.getSelection();
    if (!view || !selection) return;
    const captured = captureReadingSelection(view, selection, options.captureOptions?.());
    if (!captured) return;
    event.preventDefault();
    const menu = options.createMenu();
    menu.addItem((item) => item
      .setTitle("引用到 DSH")
      .setIcon("quote")
      .onClick(async () => {
        const file = view.file;
        if (!file) return;
        const ready = await ensureReadingBlockId(plugin.app.vault, file, captured);
        await options.onCitation(ready);
      }));
    menu.showAtMouseEvent(event);
  });
}
