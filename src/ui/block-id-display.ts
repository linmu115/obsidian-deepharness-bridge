import type { Extension, StateField } from "@codemirror/state";
import {
  Decoration,
  MatchDecorator,
  ViewPlugin,
  WidgetType,
  type DecorationSet,
  type EditorView,
  type ViewUpdate,
} from "@codemirror/view";

const DSH_BLOCK_ID_SOURCE = String.raw`(?<!\S)\^dsh-note-[A-Za-z0-9_-]+(?=[ \t]*$)`;
const SKIPPED_READING_ELEMENTS = "a, code, pre, script, style, textarea, .dsh-block-id-chip";

export interface CompactDshBlockIdMatch {
  from: number;
  to: number;
  marker: string;
}

function blockIdPattern(): RegExp {
  return new RegExp(DSH_BLOCK_ID_SOURCE, "gm");
}

export function collectCompactDshBlockIds(markdown: string): CompactDshBlockIdMatch[] {
  return [...markdown.matchAll(blockIdPattern())].map((match) => ({
    from: match.index,
    to: match.index + match[0].length,
    marker: match[0],
  }));
}

export function shouldCompactDshBlockIds(livePreview: boolean): boolean {
  return livePreview;
}

function createChip(document: Document, marker: string, onDelete?: (marker: string) => void): HTMLSpanElement {
  const chip = document.createElement("span");
  chip.className = "dsh-block-id-chip";
  chip.append("DSH 引用");
  chip.title = marker;
  chip.dataset.dshBlockId = marker;
  chip.setAttribute("aria-label", `DSH 引用块标记 ${marker}`);
  if (onDelete !== undefined) {
    const button = document.createElement("button");
    button.className = "dsh-block-id-delete";
    button.type = "button";
    button.textContent = "×";
    button.title = "删除 DSH 双向引用";
    button.setAttribute("aria-label", "删除 DSH 引用");
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      onDelete(marker);
    });
    chip.append(button);
  }
  return chip;
}

class DshBlockIdWidget extends WidgetType {
  constructor(private readonly marker: string, private readonly onDelete?: (marker: string) => void) {
    super();
  }

  override eq(other: DshBlockIdWidget): boolean {
    return other.marker === this.marker && other.onDelete === this.onDelete;
  }

  override toDOM(view: EditorView): HTMLElement {
    return createChip(view.dom.ownerDocument, this.marker, this.onDelete);
  }

  override ignoreEvent(): boolean {
    return true;
  }
}

export function createDshBlockIdCompactExtension(
  livePreviewField: StateField<boolean>,
  onDelete?: (marker: string) => void,
): Extension {
  const decorator = new MatchDecorator({
    regexp: new RegExp(DSH_BLOCK_ID_SOURCE, "g"),
    decoration: (match) => Decoration.replace({
      widget: new DshBlockIdWidget(match[0], onDelete),
    }),
  });

  const isEnabled = (view: EditorView): boolean => shouldCompactDshBlockIds(
    view.state.field(livePreviewField, false) ?? false,
  );

  return ViewPlugin.fromClass(class {
    decorations: DecorationSet;
    private enabled: boolean;

    constructor(view: EditorView) {
      this.enabled = isEnabled(view);
      this.decorations = this.enabled ? decorator.createDeco(view) : Decoration.none;
    }

    update(update: ViewUpdate): void {
      const enabled = isEnabled(update.view);
      if (!enabled) {
        this.enabled = false;
        this.decorations = Decoration.none;
        return;
      }
      this.decorations = this.enabled
        ? decorator.updateDeco(update, this.decorations)
        : decorator.createDeco(update.view);
      this.enabled = true;
    }
  }, {
    decorations: (value) => value.decorations,
  });
}

function readingTextNodes(root: HTMLElement): Text[] {
  const nodes: Text[] = [];
  const walker = root.ownerDocument.createTreeWalker(root, 4);
  let current = walker.nextNode();
  while (current !== null) {
    if (current.nodeType === 3) nodes.push(current as Text);
    current = walker.nextNode();
  }
  return nodes;
}

export function compactRenderedDshBlockIds(root: HTMLElement, onDelete?: (marker: string) => void): number {
  let replacementCount = 0;
  for (const node of readingTextNodes(root)) {
    const parent = node.parentElement;
    if (parent === null || parent.closest(SKIPPED_READING_ELEMENTS) !== null) continue;
    const matches = collectCompactDshBlockIds(node.data);
    if (matches.length === 0) continue;

    const fragment = root.ownerDocument.createDocumentFragment();
    let cursor = 0;
    for (const match of matches) {
      fragment.append(node.data.slice(cursor, match.from));
      fragment.append(createChip(root.ownerDocument, match.marker, onDelete));
      cursor = match.to;
      replacementCount += 1;
    }
    fragment.append(node.data.slice(cursor));
    node.replaceWith(fragment);
  }
  return replacementCount;
}
