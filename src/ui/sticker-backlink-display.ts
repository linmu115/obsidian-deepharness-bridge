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

export interface DshStickerBacklinkChipActions {
  onDelete?: (target: StickerBacklinkTarget) => void;
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

function createStickerChip(
  document: Document,
  href: string,
  target: StickerBacklinkTarget,
  actions: DshStickerBacklinkChipActions = {},
): HTMLSpanElement {
  const chip = document.createElement("span");
  chip.className = "dsh-block-id-chip dsh-block-id-chip-clickable dsh-sticker-backlink-chip";
  const link = document.createElement("a");
  link.className = "dsh-sticker-backlink-open";
  link.href = href;
  link.append("DSH 贴纸");
  link.title = "打开对应 DSH 贴纸";
  link.setAttribute("aria-label", "打开对应 DSH 贴纸");
  chip.append(link);
  if (actions.onDelete !== undefined) {
    const button = document.createElement("button");
    button.className = "dsh-block-id-delete dsh-sticker-backlink-delete";
    button.type = "button";
    button.textContent = "×";
    button.title = "解除当前笔记与 DSH 贴纸的双链";
    button.setAttribute("aria-label", "删除 DSH 贴纸引用");
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      chip.remove();
      actions.onDelete?.(target);
    });
    chip.append(button);
  }
  return chip;
}

class DshStickerBacklinkWidget extends WidgetType {
  constructor(
    private readonly href: string,
    private readonly target: StickerBacklinkTarget,
    private readonly actions: DshStickerBacklinkChipActions,
  ) { super(); }

  override eq(other: DshStickerBacklinkWidget): boolean {
    return other.href === this.href
      && other.actions.onDelete === this.actions.onDelete;
  }

  override toDOM(view: EditorView): HTMLElement {
    return createStickerChip(view.dom.ownerDocument, this.href, this.target, this.actions);
  }

  override ignoreEvent(): boolean {
    return true;
  }
}

export function createDshStickerBacklinkCompactExtension(
  livePreviewField: StateField<boolean>,
  actions: DshStickerBacklinkChipActions = {},
): Extension {
  const decorations = (markdown: string): DecorationSet => Decoration.set(
    collectManagedStickerBacklinks(markdown).map(({ from, to, href, target }) => Decoration.replace({
      inclusive: true,
      widget: new DshStickerBacklinkWidget(href, target, actions),
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

function targetFromHref(href: string): StickerBacklinkTarget | undefined {
  try {
    const url = new URL(href);
    const parsed = stickerBacklinkTargetSchema.safeParse({
      stickerId: url.searchParams.get("sticker"),
      sessionId: url.searchParams.get("session"),
      anchorId: url.searchParams.get("anchor"),
      quoteHash: url.searchParams.get("quoteHash"),
    });
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
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

export function compactRenderedDshStickerBacklinks(
  root: HTMLElement,
  actions: DshStickerBacklinkChipActions = {},
): number {
  let count = 0;
  for (const link of renderedLogicalLinks(root)) {
    if (!link.isConnected) continue;
    const stickerId = stickerIdFromHref(link.href);
    const target = targetFromHref(link.href);
    if (stickerId === undefined || target === undefined) continue;
    const chip = createStickerChip(root.ownerDocument, link.href, target, actions);
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
