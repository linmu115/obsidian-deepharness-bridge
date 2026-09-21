import { StateEffect, StateField, type Extension, type Range, type Transaction } from "@codemirror/state";
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

/** A managed reference block plus the stable key that remembers whether its source is expanded. */
export interface ManagedDshReferenceBlockEntry extends ManagedDshReferenceBlockMatch {
  key: string;
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

/**
 * Prefer the markers inside the block so that editing its body keeps the expansion state;
 * a block whose markers are being rewritten falls back to its own raw text.
 */
function referenceBlockKey(source: string): string {
  const metadata = /^<!-- dsh-reference:(\{[^\r\n]*\}) -->/.exec(source);
  if (metadata?.[1] !== undefined) {
    try {
      const parsed = JSON.parse(metadata[1]) as { referenceId?: unknown; blockId?: unknown };
      for (const value of [parsed.referenceId, parsed.blockId]) {
        if (typeof value === "string" && value !== "") return `marker:${value}`;
      }
    } catch { /* Keep the raw text as the key until the markers parse again. */ }
  }
  return `source:${source}`;
}

export function collectManagedDshReferenceBlockEntries(markdown: string): ManagedDshReferenceBlockEntry[] {
  return [...markdown.matchAll(referenceBlockPattern())].map((match) => ({
    from: match.index,
    to: match.index + match[0].length,
    key: referenceBlockKey(match[0]),
  }));
}

export function collectManagedDshReferenceBlocks(markdown: string): ManagedDshReferenceBlockMatch[] {
  return collectManagedDshReferenceBlockEntries(markdown).map(({ from, to }) => ({ from, to }));
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

/** Toggles the inline expansion of one managed reference block, keyed by {@link ManagedDshReferenceBlockEntry.key}. */
export const toggleDshReferenceBlock = StateEffect.define<string>();

export interface DshReferenceBlockDecorations {
  decorations: DecorationSet;
  atomic: DecorationSet;
}

interface DshReferenceBlockState extends DshReferenceBlockDecorations {
  expanded: ReadonlySet<string>;
}

/**
 * The collapsed span has no width of its own, so the two sentinels live at the capsule's own ends:
 * "▸ 引用 ◂" reads as "from here to here there is a managed block". Keeping both inside the replaced
 * range also keeps them consistent with the atomic range — a partial selection can never leave a
 * sentinel behind.
 */
function createReferenceCapsule(view: EditorView, entry: ManagedDshReferenceBlockEntry, expanded: boolean): HTMLElement {
  const document = view.dom.ownerDocument;
  const capsule = document.createElement("span");
  capsule.className = expanded ? "dsh-reference-capsule dsh-reference-capsule-expanded" : "dsh-reference-capsule";
  capsule.dataset.dshReferenceKey = entry.key;

  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "dsh-reference-capsule-toggle";
  toggle.setAttribute("aria-expanded", String(expanded));
  toggle.setAttribute("aria-label", expanded ? "折叠 DSH 引用源码" : "展开 DSH 引用源码");
  toggle.title = expanded ? "折叠这段 DSH 引用的源码" : "展开这段 DSH 引用的源码，可查看并编辑";

  const start = document.createElement("span");
  start.className = "dsh-reference-sentinel dsh-reference-sentinel-start";
  start.setAttribute("aria-hidden", "true");
  start.textContent = "▸";

  const label = document.createElement("span");
  label.className = "dsh-reference-capsule-label";
  label.textContent = "引用";

  const end = document.createElement("span");
  end.className = "dsh-reference-sentinel dsh-reference-sentinel-end";
  end.setAttribute("aria-hidden", "true");
  end.textContent = "◂";

  toggle.append(start, label, end);
  toggle.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    view.dispatch({ effects: [toggleDshReferenceBlock.of(entry.key)] });
  });
  capsule.append(toggle);
  return capsule;
}

class DshReferenceBlockWidget extends WidgetType {
  constructor(
    private readonly entry: ManagedDshReferenceBlockEntry,
    private readonly expanded: boolean,
  ) { super(); }

  override eq(other: DshReferenceBlockWidget): boolean {
    return other.entry.key === this.entry.key && other.expanded === this.expanded;
  }

  /**
   * Keep the capsule on the text line. CodeMirror treats a widget whose estimated height reaches 5px,
   * or that reports a line break, as a replacement that occupies a line of its own.
   */
  override get estimatedHeight(): number { return -1; }

  override toDOM(view: EditorView): HTMLElement {
    return createReferenceCapsule(view, this.entry, this.expanded);
  }

  override ignoreEvent(): boolean { return true; }
}

/**
 * Live preview decorations for managed reference blocks. A collapsed block becomes one inline capsule
 * that is still a single atomic unit; an expanded block keeps the capsule but drops the replacement, so
 * its source stays visible and editable. Source mode builds nothing and keeps the raw text.
 */
export function buildDshReferenceBlockDecorations(
  markdown: string,
  livePreview: boolean,
  expanded: ReadonlySet<string> = new Set(),
): DshReferenceBlockDecorations {
  if (!livePreview) return { decorations: Decoration.none, atomic: Decoration.none };
  const decorations: Range<Decoration>[] = [];
  const atomic: Range<Decoration>[] = [];
  for (const entry of collectManagedDshReferenceBlockEntries(markdown)) {
    if (expanded.has(entry.key)) {
      decorations.push(Decoration.widget({
        widget: new DshReferenceBlockWidget(entry, true),
        side: -1,
      }).range(entry.from));
      continue;
    }
    const replacement = Decoration.replace({
      inclusive: true,
      widget: new DshReferenceBlockWidget(entry, false),
    });
    decorations.push(replacement.range(entry.from, entry.to));
    atomic.push(replacement.range(entry.from, entry.to));
  }
  return { decorations: Decoration.set(decorations, true), atomic: Decoration.set(atomic, true) };
}

function referenceBlockState(
  markdown: string,
  livePreview: boolean,
  expanded: ReadonlySet<string>,
): DshReferenceBlockState {
  return { expanded, ...buildDshReferenceBlockDecorations(markdown, livePreview, expanded) };
}

function expandedReferenceBlocks(
  expanded: ReadonlySet<string>,
  transaction: Transaction,
): ReadonlySet<string> {
  let next: Set<string> | undefined;
  for (const effect of transaction.effects) {
    if (!effect.is(toggleDshReferenceBlock)) continue;
    next ??= new Set(expanded);
    if (next.has(effect.value)) next.delete(effect.value);
    else next.add(effect.value);
  }
  return next ?? expanded;
}

export function createDshBlockIdCompactExtension(
  livePreviewField: StateField<boolean>,
  actions: DshBlockIdChipActions = {},
): Extension {
  const managedReferenceField = StateField.define<DshReferenceBlockState>({
    create(state) {
      return referenceBlockState(
        state.doc.toString(),
        state.field(livePreviewField, false) ?? false,
        new Set(),
      );
    },
    update(value, transaction) {
      const wasEnabled = transaction.startState.field(livePreviewField, false) ?? false;
      const enabled = transaction.state.field(livePreviewField, false) ?? false;
      const expanded = expandedReferenceBlocks(value.expanded, transaction);
      if (!transaction.docChanged && wasEnabled === enabled && expanded === value.expanded) return value;
      return referenceBlockState(transaction.state.doc.toString(), enabled, expanded);
    },
    provide: (field) => [
      EditorView.decorations.from(field, value => value.decorations),
      EditorView.atomicRanges.of((view) => view.state.field(field).atomic),
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
