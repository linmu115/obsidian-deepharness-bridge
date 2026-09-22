import { StateEffect, StateField, type Extension, type Range, type EditorState } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  WidgetType,
  type DecorationSet,
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
  referenceIds?: (marker: string) => readonly string[];
  label?: (marker: string) => string;
  onDetails?: (marker: string, chip: HTMLElement) => void;
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
  chip.append(actions.label?.(marker) ?? "DSH 引用");
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
  if (actions.onDetails !== undefined) {
    const details = document.createElement("button");
    details.type = "button";
    details.className = "dsh-block-id-details";
    details.textContent = "▾";
    details.title = "查看引用详情";
    details.setAttribute("aria-label", "查看引用详情");
    details.setAttribute("aria-haspopup", "dialog");
    details.addEventListener("click", event => {
      event.preventDefault(); event.stopPropagation();
      actions.onDetails?.(marker, chip);
    });
    chip.append(details);
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
  linkedReferenceIds: ReadonlySet<string> = new Set(),
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
      ...(linkedReferenceIds.has(entry.key.replace(/^marker:/, "")) ? {} : { widget: new DshReferenceBlockWidget(entry, false) }),
    });
    decorations.push(replacement.range(entry.from, entry.to));
    atomic.push(replacement.range(entry.from, entry.to));
  }
  return { decorations: Decoration.set(decorations, true), atomic: Decoration.set(atomic, true) };
}

/** Refresh labels and associations after persisted bridge state changes, without editing the note. */
export const refreshDshReferenceChips = StateEffect.define<null>();

export function linkedReferenceIds(markdown: string, actions: DshBlockIdChipActions): Set<string> {
  return new Set(collectCompactDshBlockIds(markdown).flatMap(({ marker }) => [...(actions.referenceIds?.(marker) ?? [])]));
}

export function createDshBlockIdCompactExtension(
  livePreviewField: StateField<boolean>,
  actions: DshBlockIdChipActions = {},
  resolveActions: (state: EditorState) => DshBlockIdChipActions = () => actions,
): Extension {
  const build = (state: EditorState, expanded: ReadonlySet<string>): DshReferenceBlockState => {
    const markdown = state.doc.toString();
    const enabled = state.field(livePreviewField, false) ?? false;
    const current = resolveActions(state);
    const blocks = buildDshReferenceBlockDecorations(markdown, enabled, expanded, linkedReferenceIds(markdown, current));
    const entries = collectManagedDshReferenceBlockEntries(markdown);
    const chips = enabled ? collectCompactDshBlockIds(markdown)
      .filter(({ from }) => !entries.some(entry => from >= entry.from && from < entry.to))
      .map(({ from, to, marker }) => Decoration.replace({ widget: new DshBlockIdWidget(marker, current) }).range(from, to)) : [];
    return { expanded, atomic: blocks.atomic, decorations: blocks.decorations.update({ add: chips, sort: true }) };
  };
  const field = StateField.define<DshReferenceBlockState>({
    create: state => build(state, new Set()),
    update(value, transaction) {
      let expanded = value.expanded;
      for (const effect of transaction.effects) {
        if (!effect.is(toggleDshReferenceBlock)) continue;
        const next = new Set(expanded);
        if (next.has(effect.value)) next.delete(effect.value); else next.add(effect.value);
        expanded = next;
      }
      if (!transaction.docChanged && expanded === value.expanded
        && !transaction.effects.some(effect => effect.is(refreshDshReferenceChips))
        && transaction.startState.field(livePreviewField, false) === transaction.state.field(livePreviewField, false)) return value;
      return build(transaction.state, expanded);
    },
    provide: field => [EditorView.decorations.from(field, value => value.decorations),
      EditorView.atomicRanges.of(view => view.state.field(field).atomic)],
  });
  return field;
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

export function hideRenderedDshReferenceBlocks(root: HTMLElement, linkedIds?: ReadonlySet<string>): number {
  const blocks: HTMLElement[] = [];
  if (root.matches(RENDERED_REFERENCE_SELECTOR)) blocks.push(root);
  blocks.push(...root.querySelectorAll<HTMLElement>(RENDERED_REFERENCE_SELECTOR));
  const matched = blocks.filter(block => linkedIds === undefined || [...block.querySelectorAll<HTMLAnchorElement>("a[href]")].some(link => {
    try { const id = new URL(link.getAttribute("href") ?? "").searchParams.get("referenceId"); return id !== null && linkedIds.has(id); }
    catch { return false; }
  }));
  for (const block of matched) block.remove();
  return matched.length;
}
