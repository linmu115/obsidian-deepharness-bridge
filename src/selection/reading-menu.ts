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

interface ReadingDocumentLike {
  getSelection(): SelectionLike | null;
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
  if (!element || typeof element.closest !== "function") return undefined;

  // The Bridge's reading post-processor replaces a trailing ^dsh-note marker
  // with a compact chip. Obsidian 1.13 does not expose that block ID on the
  // paragraph itself, so recover it from the chip in the same rendered block.
  const semanticBlock = element.closest("p, li, blockquote, h1, h2, h3, h4, h5, h6") as {
    querySelector?: (selector: string) => unknown;
  } | null;
  const ownedChip = semanticBlock?.querySelector?.("[data-dsh-block-id]") as {
    dataset?: { dshBlockId?: string };
    getAttribute?: (name: string) => string | null;
  } | null;
  const ownedMarker = ownedChip?.dataset?.dshBlockId ?? ownedChip?.getAttribute?.("data-dsh-block-id") ?? undefined;
  const ownedBlockId = ownedMarker?.replace(/^\^/, "");
  if (ownedBlockId && /^[A-Za-z0-9-]+$/.test(ownedBlockId)) return ownedBlockId;

  // Obsidian's rendered Markdown block is the authoritative anchor. A child
  // decoration may also have an unrelated `id`, so a combined
  // `[data-block-id], [id]` selector can stop at the wrong element and make a
  // repeated quote impossible to resolve after the first DSH reference.
  const dataBlock = element.closest("[data-block-id]") as typeof candidate | null;
  const dataBlockId = dataBlock?.dataset?.blockId ?? dataBlock?.getAttribute?.("data-block-id") ?? undefined;
  if (dataBlockId && /^[A-Za-z0-9-]+$/.test(dataBlockId)) return dataBlockId;

  const idBlock = element.closest('[id^="block-"]') as typeof candidate | null;
  const id = idBlock?.getAttribute?.("id")?.replace(/^block-/, "");
  return id && /^[A-Za-z0-9-]+$/.test(id) ? id : undefined;
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
    blockIdOwnership: existingBlockId ? "pre-existing" : "plugin-created",
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
    blockIdOwnership: selection.blockIdOwnership,
  };
}

export interface ReadingMenuOptions {
  markdownViewType: Constructor<MarkdownView>;
  /** The document is injectable so the event contract can be tested without a browser global. */
  document?: ReadingDocumentLike;
  /** Return Obsidian's not-yet-shown menu for this context-menu event. */
  menuForEvent(event: MouseEvent): Menu;
  copyText?(text: string): Promise<void> | void;
  captureOptions?(): SelectionCaptureOptions;
  onCitation(selection: NoteSelection): Promise<void>;
}

export function registerReadingSelectionMenu(plugin: Plugin, options: ReadingMenuOptions): void {
  const ownerDocument = options.document ?? document;
  plugin.registerDomEvent(ownerDocument as Document, "contextmenu", (event) => {
    const view = plugin.app.workspace.getActiveViewOfType(options.markdownViewType);
    const selection = ownerDocument.getSelection();
    if (!view || !selection) return;
    const captured = captureReadingSelection(view, selection, options.captureOptions?.());
    if (!captured) return;
    const menu = options.menuForEvent(event);
    // Calling Menu.forEvent intentionally replaces Electron's native
    // selection menu. Re-add its Copy action, then append the Bridge action;
    // every other plugin calling Menu.forEvent(event) receives the same shared
    // menu and can keep contributing its own entries.
    menu.addItem((item) => item
      .setTitle("复制")
      .setIcon("copy")
      .onClick(async () => {
        if (options.copyText !== undefined) await options.copyText(captured.source.selectedText);
        else await navigator.clipboard.writeText(captured.source.selectedText);
      }));
    menu.addItem((item) => item
      .setTitle("引用到 DSH")
      .setIcon("quote")
      .onClick(async () => {
        const file = view.file;
        if (!file) return;
        const ready = await ensureReadingBlockId(plugin.app.vault, file, captured);
        await options.onCitation(ready);
      }));
  // Obsidian resolves and shows its event-bound menu from a bubble listener.
  // Observe in capture phase so our item is present before the host displays
  // that same Menu; a document bubble listener is too late (or is skipped when
  // the host stops propagation), leaving only the native Copy item.
  }, { capture: true });
}
