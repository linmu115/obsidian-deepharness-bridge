import type { Editor, MarkdownFileInfo, Menu, Plugin } from "obsidian";

import { PROTOCOL_VERSION, type PendingCitation } from "../protocol.ts";
import { contentRevision } from "../vault/session-notes.ts";

export interface NoteSelection extends PendingCitation {
  occurrence: number;
  requiresBlockIdWrite: boolean;
}

export interface SelectionCaptureOptions {
  createCitationId?: () => string;
}

interface EditorLike {
  getSelection(): string;
  getValue(): string;
  getCursor(which: "from" | "to"): { line: number; ch: number };
  getLine(line: number): string;
  replaceRange(replacement: string, from: { line: number; ch: number }): void;
}

interface FileLike {
  path: string;
}

function normalizedSelection(value: string): string {
  return value.replace(/\r\n?/g, "\n").trim();
}

function stableBlockId(notePath: string, line: number, text: string): string {
  return `dsh-note-${contentRevision(`${notePath}:${line}:${text}`).slice("sha256:".length, "sha256:".length + 8)}`;
}

function nearestHeading(source: string, line: number): string | undefined {
  const lines = source.split(/\r?\n/);
  for (let index = Math.min(line, lines.length - 1); index >= 0; index -= 1) {
    const heading = /^#{1,6}\s+(.+?)\s*$/.exec(lines[index] ?? "");
    if (heading?.[1]) return heading[1];
  }
  return undefined;
}

function blockIdOnLine(value: string): string | undefined {
  return /(?:^|\s)\^([A-Za-z0-9-]+)\s*$/.exec(value)?.[1];
}

function occurrenceOf(source: string, text: string, beforeLine: number): number {
  const before = source.split(/\r?\n/).slice(0, beforeLine + 1).join("\n");
  let cursor = 0;
  let count = 0;
  while (true) {
    const index = before.indexOf(text, cursor);
    if (index < 0) return Math.max(0, count - 1);
    count += 1;
    cursor = index + Math.max(1, text.length);
  }
}

export function captureEditorSelection(
  editor: EditorLike,
  file: FileLike,
  options: SelectionCaptureOptions = {},
): NoteSelection | null {
  const text = normalizedSelection(editor.getSelection());
  if (!text) return null;
  const from = editor.getCursor("from");
  const to = editor.getCursor("to");
  const sourceBefore = editor.getValue();
  const targetLine = editor.getLine(to.line);
  let blockId = blockIdOnLine(targetLine);
  if (!blockId) {
    blockId = stableBlockId(file.path, from.line, text);
    editor.replaceRange(` ^${blockId}`, { line: to.line, ch: targetLine.length });
  }
  const source = editor.getValue();
  const heading = nearestHeading(source, from.line);
  return {
    protocolVersion: PROTOCOL_VERSION,
    type: "pending-citation",
    citationId: options.createCitationId?.() ?? crypto.randomUUID(),
    notePath: file.path,
    blockId,
    ...(heading ? { heading } : {}),
    text,
    contentHash: contentRevision(source),
    occurrence: occurrenceOf(sourceBefore, text, from.line),
    requiresBlockIdWrite: false,
  };
}

export function registerEditorSelectionMenu(
  plugin: Plugin,
  onCitation: (selection: NoteSelection) => Promise<void>,
): void {
  plugin.registerEvent(plugin.app.workspace.on("editor-menu", (menu: Menu, editor: Editor, info: MarkdownFileInfo) => {
    const file = info.file;
    if (!file || !normalizedSelection(editor.getSelection())) return;
    menu.addItem((item) => item
      .setTitle("引用到 DSH")
      .setIcon("quote")
      .onClick(async () => {
        const selection = captureEditorSelection(editor, file);
        if (selection) await onCitation(selection);
      }));
  }));
}
