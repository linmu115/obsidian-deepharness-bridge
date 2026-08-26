import type { Editor, MarkdownFileInfo, Menu, Plugin } from "obsidian";

import type { ObsidianReferenceCaptureV2 } from "../protocol.ts";
import { contentRevision } from "../vault/session-notes.ts";
import { createObsidianReferenceCapture, selectionOffsets } from "../vault/reference-source.ts";

export interface NoteSelection extends ObsidianReferenceCaptureV2 {
  requiresBlockIdWrite: boolean;
  blockIdOwnership: "plugin-created" | "pre-existing";
}

export interface SelectionCaptureOptions {
  vaultId?: string;
  createReferenceId?: () => string;
  createActionId?: () => string;
  now?: () => number;
}

interface EditorLike {
  getSelection(): string;
  getValue(): string;
  getCursor(which: "from" | "to"): { line: number; ch: number };
  getLine(line: number): string;
  replaceRange(replacement: string, from: { line: number; ch: number }): void;
}

interface FileLike { path: string }

function normalizedSelection(value: string): string {
  return value.replace(/\r\n?/g, "\n").normalize("NFC").trim();
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

function offsetAt(source: string, position: { line: number; ch: number }): number {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  let offset = 0;
  for (let line = 0; line < position.line; line += 1) offset += (lines[line]?.length ?? 0) + 1;
  return offset + position.ch;
}

function occurrenceAt(source: string, text: string, selectedOffset: number): number {
  const offsets = selectionOffsets(source, text);
  const exact = offsets.indexOf(selectedOffset);
  if (exact >= 0) return exact;
  const nearest = offsets.findIndex((offset) => offset >= selectedOffset);
  if (nearest >= 0) return nearest;
  return Math.max(0, offsets.length - 1);
}

function captureOptions(options: SelectionCaptureOptions): Required<SelectionCaptureOptions> {
  return {
    vaultId: options.vaultId ?? "vault-unconfigured",
    createReferenceId: options.createReferenceId ?? (() => crypto.randomUUID()),
    createActionId: options.createActionId ?? (() => crypto.randomUUID()),
    now: options.now ?? Date.now,
  };
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
  const sourceBefore = editor.getValue().replace(/\r\n?/g, "\n");
  const selectedOffset = offsetAt(sourceBefore, from);
  const targetLine = editor.getLine(to.line);
  let blockId = blockIdOnLine(targetLine);
  const blockIdOwnership = blockId ? "pre-existing" as const : "plugin-created" as const;
  if (!blockId) {
    blockId = stableBlockId(file.path, from.line, text);
    editor.replaceRange(` ^${blockId}`, { line: to.line, ch: targetLine.length });
  }
  const source = editor.getValue().replace(/\r\n?/g, "\n");
  const values = captureOptions(options);
  return {
    ...createObsidianReferenceCapture({
      actionId: values.createActionId(),
      referenceId: values.createReferenceId(),
      vaultId: values.vaultId,
      notePath: file.path,
      ...(nearestHeading(source, from.line) ? { heading: nearestHeading(source, from.line)! } : {}),
      blockId,
      occurrence: occurrenceAt(sourceBefore, text, selectedOffset),
      selectedText: text,
      markdown: source,
      capturedAt: values.now(),
    }),
    requiresBlockIdWrite: false,
    blockIdOwnership,
  };
}

export function registerEditorSelectionMenu(
  plugin: Plugin,
  onCitation: (selection: NoteSelection) => Promise<void>,
  options: () => SelectionCaptureOptions = () => ({}),
): void {
  plugin.registerEvent(plugin.app.workspace.on("editor-menu", (menu: Menu, editor: Editor, info: MarkdownFileInfo) => {
    const file = info.file;
    if (!file || !normalizedSelection(editor.getSelection())) return;
    menu.addItem((item) => item
      .setTitle("引用到 DSH")
      .setIcon("quote")
      .onClick(async () => {
        const selection = captureEditorSelection(editor, file, options());
        if (selection) await onCitation(selection);
      }));
  }));
}
