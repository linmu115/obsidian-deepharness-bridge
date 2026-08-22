import type { Constructor, MarkdownView, Menu, Plugin, TFile } from "obsidian";

import { PROTOCOL_VERSION } from "../protocol.ts";
import { contentRevision } from "../vault/session-notes.ts";
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

function normalize(value: string): string {
  return value.replace(/\r\n?/g, "\n").trim();
}

function findOccurrence(source: string, text: string, occurrence: number): number {
  let cursor = 0;
  for (let index = 0; index <= occurrence; index += 1) {
    const match = source.indexOf(text, cursor);
    if (match < 0) return -1;
    if (index === occurrence) return match;
    cursor = match + Math.max(1, text.length);
  }
  return -1;
}

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
  const source = view.getViewData();
  const offset = source.indexOf(text);
  if (offset < 0) return null;
  const occurrence = 0;
  const lineEndIndex = source.indexOf("\n", offset + text.length);
  const lineEnd = lineEndIndex < 0 ? source.length : lineEndIndex;
  const line = source.slice(source.lastIndexOf("\n", offset) + 1, lineEnd);
  const existingBlockId = /(?:^|\s)\^([A-Za-z0-9-]+)\s*$/.exec(line)?.[1];
  const heading = headingBefore(source, offset);
  return {
    protocolVersion: PROTOCOL_VERSION,
    type: "pending-citation",
    citationId: options.createCitationId?.() ?? crypto.randomUUID(),
    notePath: view.file.path,
    blockId: existingBlockId ?? makeBlockId(view.file.path, text, occurrence),
    ...(heading ? { heading } : {}),
    text,
    contentHash: contentRevision(source),
    occurrence,
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
    const offset = findOccurrence(content, selection.text, selection.occurrence);
    if (offset < 0) throw new Error("Selected paragraph changed before its block ID could be written");
    const lineEndIndex = content.indexOf("\n", offset + selection.text.length);
    const lineEnd = lineEndIndex < 0 ? content.length : lineEndIndex;
    const line = content.slice(content.lastIndexOf("\n", offset) + 1, lineEnd);
    if (/(?:^|\s)\^[A-Za-z0-9-]+\s*$/.test(line)) return content;
    return `${content.slice(0, lineEnd)} ^${selection.blockId}${content.slice(lineEnd)}`;
  });
  return { ...selection, contentHash: contentRevision(output), requiresBlockIdWrite: false };
}

export interface ReadingMenuOptions {
  markdownViewType: Constructor<MarkdownView>;
  createMenu(): Menu;
  onCitation(selection: NoteSelection): Promise<void>;
}

export function registerReadingSelectionMenu(plugin: Plugin, options: ReadingMenuOptions): void {
  plugin.registerDomEvent(document, "contextmenu", (event) => {
    const view = plugin.app.workspace.getActiveViewOfType(options.markdownViewType);
    const selection = document.getSelection();
    if (!view || !selection) return;
    const captured = captureReadingSelection(view, selection);
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
