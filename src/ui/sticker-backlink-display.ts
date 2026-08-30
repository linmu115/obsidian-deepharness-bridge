import { StateField, type Extension } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  WidgetType,
  type DecorationSet,
} from "@codemirror/view";

import { buildObsidianDshLink } from "../logical-link.ts";
import { stickerBacklinkTargetSchema, type StickerBacklinkTarget } from "../protocol.ts";

const DSH_STICKER_BACKLINK_SOURCE = String.raw`<!-- dsh-sticker-backlink:(\{[^\r\n]*\}) -->\r?\n[\s\S]*?\r?\n<!-- \/dsh-sticker-backlink -->`;
const STICKER_LOGICAL_LINK_SELECTOR = "a[href^='obsidian://deepharness']";
const STICKER_REFERENCE_CALLOUT_SELECTOR = '.callout[data-callout="dsh-reference"]';

export interface ManagedStickerBacklinkMatch {
  from: number;
  to: number;
  href: string;
  target: StickerBacklinkTarget;
}

function stickerBacklinkPattern(): RegExp {
  return new RegExp(DSH_STICKER_BACKLINK_SOURCE, "g");
}

function hrefForTarget(target: StickerBacklinkTarget): string {
  return buildObsidianDshLink({
    sessionId: target.sessionId,
    anchorId: target.anchorId,
    quoteHash: target.quoteHash,
    stickerId: target.stickerId,
  });
}

export function collectManagedStickerBacklinks(markdown: string): ManagedStickerBacklinkMatch[] {
  const matches: ManagedStickerBacklinkMatch[] = [];
  for (const match of markdown.matchAll(stickerBacklinkPattern())) {
    const parsed = stickerBacklinkTargetSchema.safeParse(parseMetadata(match[1] ?? ""));
    if (!parsed.success) continue;
    matches.push({
      from: match.index,
      to: match.index + match[0].length,
      href: hrefForTarget(parsed.data),
      target: parsed.data,
    });
  }
  return matches;
}

function parseMetadata(value: string): unknown {
  try { return JSON.parse(value); }
  catch { return undefined; }
}

function createStickerChip(document: Document, href: string): HTMLAnchorElement {
  const chip = document.createElement("a");
  chip.className = "dsh-block-id-chip dsh-block-id-chip-clickable dsh-sticker-backlink-chip";
  chip.href = href;
  chip.append("DSH 贴纸");
  chip.title = "打开对应 DSH 贴纸";
  chip.setAttribute("aria-label", "打开对应 DSH 贴纸");
  return chip;
}

class DshStickerBacklinkWidget extends WidgetType {
  constructor(private readonly href: string) { super(); }

  override eq(other: DshStickerBacklinkWidget): boolean {
    return other.href === this.href;
  }

  override toDOM(view: EditorView): HTMLElement {
    return createStickerChip(view.dom.ownerDocument, this.href);
  }
}

export function createDshStickerBacklinkCompactExtension(
  livePreviewField: StateField<boolean>,
): Extension {
  const decorations = (markdown: string): DecorationSet => Decoration.set(
    collectManagedStickerBacklinks(markdown).map(({ from, to, href }) => Decoration.replace({
      inclusive: true,
      widget: new DshStickerBacklinkWidget(href),
    }).range(from, to)),
    true,
  );
  return StateField.define<DecorationSet>({
    create(state) {
      return state.field(livePreviewField, false)
        ? decorations(state.doc.toString())
        : Decoration.none;
    },
    update(value, transaction) {
      const wasEnabled = transaction.startState.field(livePreviewField, false) ?? false;
      const enabled = transaction.state.field(livePreviewField, false) ?? false;
      if (!transaction.docChanged && wasEnabled === enabled) return value;
      return enabled ? decorations(transaction.state.doc.toString()) : Decoration.none;
    },
    provide: (field) => [
      EditorView.decorations.from(field),
      EditorView.atomicRanges.of((view) => view.state.field(field)),
    ],
  });
}

function stickerIdFromHref(href: string): string | undefined {
  try { return new URL(href).searchParams.get("sticker")?.trim() || undefined; }
  catch { return undefined; }
}

function renderedLogicalLinks(root: HTMLElement): HTMLAnchorElement[] {
  const links: HTMLAnchorElement[] = [];
  if (root.matches(STICKER_LOGICAL_LINK_SELECTOR)) links.push(root as HTMLAnchorElement);
  links.push(...root.querySelectorAll<HTMLAnchorElement>(STICKER_LOGICAL_LINK_SELECTOR));
  return links.filter((link) => stickerIdFromHref(link.href) !== undefined);
}

function removeRenderedStickerSourceLink(link: HTMLAnchorElement, stickerId: string): void {
  const scope = link.closest(STICKER_REFERENCE_CALLOUT_SELECTOR) ?? link.parentElement;
  if (scope === null) return;
  const shortId = stickerId.slice(0, 8);
  for (const candidate of scope.querySelectorAll<HTMLAnchorElement>("a.internal-link")) {
    const destination = candidate.dataset.href ?? candidate.getAttribute("href") ?? "";
    if (destination.includes(`#^dsh-sticker-${shortId}`)) candidate.remove();
  }
}

export function compactRenderedDshStickerBacklinks(root: HTMLElement): number {
  let count = 0;
  for (const link of renderedLogicalLinks(root)) {
    if (!link.isConnected) continue;
    const stickerId = stickerIdFromHref(link.href);
    if (stickerId === undefined) continue;
    const chip = createStickerChip(root.ownerDocument, link.href);
    const callout = link.closest<HTMLElement>(STICKER_REFERENCE_CALLOUT_SELECTOR);
    if (callout !== null) {
      callout.replaceWith(chip);
    } else {
      removeRenderedStickerSourceLink(link, stickerId);
      link.replaceWith(chip);
    }
    count += 1;
  }
  return count;
}
