import { StateField, type Extension } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  MatchDecorator,
  ViewPlugin,
  WidgetType,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";

const DSH_BLOCK_ID_SOURCE = String.raw`(?<!\S)\^dsh-note-[A-Za-z0-9_-]+(?=[ \t]*$)`;
const DSH_REFERENCE_BLOCK_SOURCE = String.raw`<!-- dsh-reference:\{[^\r\n]*\} -->\r?\n[\s\S]*?\r?\n<!-- \/dsh-reference -->`;
const SKIPPED_READING_ELEMENTS = "a, code, pre, script, style, textarea, .dsh-block-id-chip";
const RENDERED_REFERENCE_SELECTOR = '.callout[data-callout="dsh-reference"]';

export interface CompactDshBlockIdMatch {
  from: number;
  to: number;
  marker: string;
}

export interface ManagedDshReferenceBlockMatch {
  from: number;
  to: number;
}

export interface DshBlockIdChipActions {
  onOpen?: (marker: string, chip: HTMLElement) => void;
  onDelete?: (marker: string) => void;
}

function blockIdPattern(): RegExp {
  return new RegExp(DSH_BLOCK_ID_SOURCE, "gm");
}

function referenceBlockPattern(): RegExp {
  return new RegExp(DSH_REFERENCE_BLOCK_SOURCE, "g");
}

export function collectCompactDshBlockIds(markdown: string): CompactDshBlockIdMatch[] {
  return [...markdown.matchAll(blockIdPattern())].map((match) => ({
    from: match.index,
    to: match.index + match[0].length,
    marker: match[0],
  }));
}

export function collectManagedDshReferenceBlocks(markdown: string): ManagedDshReferenceBlockMatch[] {
  return [...markdown.matchAll(referenceBlockPattern())].map((match) => ({
    from: match.index,
    to: match.index + match[0].length,
  }));
}

export function shouldCompactDshBlockIds(livePreview: boolean): boolean {
  return livePreview;
}

function createChip(document: Document, marker: string, actions: DshBlockIdChipActions = {}): HTMLSpanElement {
  const chip = document.createElement("span");
  chip.className = "dsh-block-id-chip";
  chip.append("DSH 引用");
  chip.title = actions.onOpen === undefined ? marker : `打开对应 DSH 会话（${marker}）`;
  chip.dataset.dshBlockId = marker;
  chip.setAttribute("aria-label", actions.onOpen === undefined
    ? `DSH 引用块标记 ${marker}`
    : `打开对应 DSH 会话，引用块标记 ${marker}`);
  if (actions.onOpen !== undefined) {
    chip.classList.add("dsh-block-id-chip-clickable");
    chip.setAttribute("role", "link");
    chip.tabIndex = 0;
    const open = (event: MouseEvent | KeyboardEvent): void => {
      if (event.target !== chip) return;
      event.preventDefault();
      event.stopPropagation();
      actions.onOpen?.(marker, chip);
    };
    chip.addEventListener("click", open);
    chip.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") open(event);
    });
  }
  if (actions.onDelete !== undefined) {
    const button = document.createElement("button");
    button.className = "dsh-block-id-delete";
    button.type = "button";
    button.textContent = "×";
    button.title = "删除 DSH 双向引用";
    button.setAttribute("aria-label", "删除 DSH 引用");
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      chip.remove();
      actions.onDelete?.(marker);
    });
    chip.append(button);
  }
  return chip;
}

class DshBlockIdWidget extends WidgetType {
  constructor(private readonly marker: string, private readonly actions: DshBlockIdChipActions) {
    super();
  }

  override eq(other: DshBlockIdWidget): boolean {
    return other.marker === this.marker
      && other.actions.onOpen === this.actions.onOpen
      && other.actions.onDelete === this.actions.onDelete;
  }

  override toDOM(view: EditorView): HTMLElement {
    return createChip(view.dom.ownerDocument, this.marker, this.actions);
  }

  override ignoreEvent(): boolean {
    return true;
  }
}

export function createDshBlockIdCompactExtension(
  livePreviewField: StateField<boolean>,
  actions: DshBlockIdChipActions = {},
): Extension {
  const hiddenReferenceBlocks = (markdown: string): DecorationSet => Decoration.set(
    collectManagedDshReferenceBlocks(markdown).map(({ from, to }) => Decoration.replace({
      inclusive: true,
    }).range(from, to)),
    true,
  );
  const managedReferenceField = StateField.define<DecorationSet>({
    create(state) {
      return state.field(livePreviewField, false)
        ? hiddenReferenceBlocks(state.doc.toString())
        : Decoration.none;
    },
    update(value, transaction) {
      const wasEnabled = transaction.startState.field(livePreviewField, false) ?? false;
      const enabled = transaction.state.field(livePreviewField, false) ?? false;
      if (!transaction.docChanged && wasEnabled === enabled) return value;
      return enabled ? hiddenReferenceBlocks(transaction.state.doc.toString()) : Decoration.none;
    },
    provide: (field) => [
      EditorView.decorations.from(field),
      EditorView.atomicRanges.of((view) => view.state.field(field)),
    ],
  });
  const decorator = new MatchDecorator({
    regexp: new RegExp(DSH_BLOCK_ID_SOURCE, "g"),
    decoration: (match) => Decoration.replace({
      widget: new DshBlockIdWidget(match[0], actions),
    }),
  });

  const isEnabled = (view: EditorView): boolean => shouldCompactDshBlockIds(
    view.state.field(livePreviewField, false) ?? false,
  );

  const compactBlockIds = ViewPlugin.fromClass(class {
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
  return [managedReferenceField, compactBlockIds];
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

export function compactRenderedDshBlockIds(
  root: HTMLElement,
  actions: DshBlockIdChipActions = {},
): number {
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
      fragment.append(createChip(root.ownerDocument, match.marker, actions));
      cursor = match.to;
      replacementCount += 1;
    }
    fragment.append(node.data.slice(cursor));
    node.replaceWith(fragment);
  }
  return replacementCount;
}

export function hideRenderedDshReferenceBlocks(root: HTMLElement): number {
  const blocks: HTMLElement[] = [];
  if (root.matches(RENDERED_REFERENCE_SELECTOR)) blocks.push(root);
  blocks.push(...root.querySelectorAll<HTMLElement>(RENDERED_REFERENCE_SELECTOR));
  for (const block of blocks) block.remove();
  return blocks.length;
}
