import { EditorState, StateField } from '@codemirror/state';
import { JSDOM } from 'jsdom';
import { describe, expect, it, vi } from 'vitest';
import type { DecorationSet, EditorView } from '@codemirror/view';
import { buildDshReferenceBlockDecorations, compactRenderedDshBlockIds, createDshBlockIdCompactExtension,
  hideRenderedDshReferenceBlocks, linkedReferenceIds, refreshDshReferenceChips } from '../src/ui/block-id-display.ts';

const block = (id: string) => `<!-- dsh-reference:{"referenceId":"${id}","blockId":"dsh-ref-other"} -->\n> [!dsh-reference]\n> record\n<!-- /dsh-reference -->`;
const note = `text ^dsh-note-source\n\n${block('one')}\n\n${block('two')}\n\n${block('orphan')}`;
const actions = { referenceIds: (marker: string) => marker === '^dsh-note-source' ? ['one', 'two'] : [] };
function widgets(set: DecorationSet) {
  const result: { from: number; to: number; widget: any }[] = [];
  set.between(0, Number.MAX_SAFE_INTEGER, (from, to, d) => { result.push({ from, to, widget: d.spec.widget }); });
  return result;
}

describe('one reference chip per source marker', () => {
  it('pairs through stored reference IDs, hides both duplicate controls and preserves the orphan', () => {
    const ids = linkedReferenceIds(note, actions);
    expect([...ids]).toEqual(['one', 'two']);
    const result = buildDshReferenceBlockDecorations(note, true, new Set(), ids);
    const entries = widgets(result.decorations);
    expect(entries).toHaveLength(3);
    expect(entries.slice(0, 2).every(entry => entry.widget === undefined)).toBe(true);
    expect(entries[2]?.widget).toBeDefined();
    expect(result.atomic.size).toBe(3);
    expect(note).toContain(block('one')); // decoration does not rewrite stored Markdown
  });

  it('keeps a record accessible after its source marker is removed', () => {
    const source = note.replace('^dsh-note-source', '');
    const ids = linkedReferenceIds(source, actions);
    expect(ids.size).toBe(0);
    expect(widgets(buildDshReferenceBlockDecorations(source, true, new Set(), ids).decorations).every(entry => entry.widget)).toBe(true);
  });

  it('keeps details, delete and keyboard navigation independent in the same capsule', () => {
    const dom = new JSDOM('<div id="root">text ^dsh-note-source</div>', { url: 'https://obsidian.local/note' });
    const root = dom.window.document.getElementById('root')!;
    const onOpen = vi.fn(), onDelete = vi.fn(), onDetails = vi.fn();
    compactRenderedDshBlockIds(root, { onOpen, onDelete, onDetails, label: () => 'DSH 引用 · 2' });
    const chip = root.querySelector<HTMLElement>('.dsh-block-id-chip')!;
    const details = root.querySelector<HTMLButtonElement>('.dsh-block-id-details')!;
    expect(chip.textContent).toBe('DSH 引用 · 2▾×');
    expect(details.getAttribute('aria-haspopup')).toBe('dialog');
    details.click();
    expect(onDetails).toHaveBeenCalledWith('^dsh-note-source', chip);
    expect(onOpen).not.toHaveBeenCalled(); expect(onDelete).not.toHaveBeenCalled();
    details.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(onOpen).not.toHaveBeenCalled();
    chip.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(onOpen).toHaveBeenCalledOnce();
    root.querySelector<HTMLButtonElement>('.dsh-block-id-delete')!.click();
    expect(onDelete).toHaveBeenCalledWith('^dsh-note-source');
    expect(onOpen).toHaveBeenCalledOnce(); expect(onDetails).toHaveBeenCalledOnce();
    expect(root.querySelector('.dsh-block-id-chip')).toBeNull();
  });

  it('refreshes pending state without editing text and keeps source mode unmodified', () => {
    const live = StateField.define({ create: () => true, update: v => v });
    let label = 'DSH 引用 · 待提交';
    const extension = createDshBlockIdCompactExtension(live, {}, () => ({ ...actions, label: () => label }));
    const field = extension as StateField<{ decorations: DecorationSet }>;
    let state = EditorState.create({ doc: note, extensions: [live, extension] });
    const dom = new JSDOM('<div></div>');
    const view = { dom: { ownerDocument: dom.window.document } } as unknown as EditorView;
    expect(widgets(state.field(field).decorations)[0]!.widget.toDOM(view).textContent).toContain('待提交');
    label = 'DSH 引用 · 2';
    state = state.update({ effects: refreshDshReferenceChips.of(null) }).state;
    expect(widgets(state.field(field).decorations)[0]!.widget.toDOM(view).textContent).toBe(label);
    expect(state.doc.toString()).toBe(note);
    const raw = StateField.define({ create: () => false, update: v => v });
    const rawExtension = createDshBlockIdCompactExtension(raw, actions);
    const rawState = EditorState.create({ doc: note, extensions: [raw, rawExtension] });
    expect(rawState.field(rawExtension as typeof field).decorations.size).toBe(0);
  });

  it('hides only matched reading-mode records, retaining legacy and orphan links', () => {
    const dom = new JSDOM(`<div id="root"><div class="callout" data-callout="dsh-reference"><a href="obsidian://deepharness?referenceId=one">one</a></div><div class="callout" data-callout="dsh-reference"><a href="obsidian://deepharness?referenceId=orphan">orphan</a></div><div class="callout" data-callout="dsh-reference">legacy</div></div>`);
    const root = dom.window.document.getElementById('root')!;
    expect(hideRenderedDshReferenceBlocks(root, new Set(['one']))).toBe(1);
    expect(root.querySelectorAll('.callout')).toHaveLength(2);
    expect(root.textContent).toContain('orphan'); expect(root.textContent).toContain('legacy');
  });
});
