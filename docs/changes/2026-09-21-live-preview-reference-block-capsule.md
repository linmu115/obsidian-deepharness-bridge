# Inline capsule for managed DSH reference blocks in live preview

Live preview replaced every managed `<!-- dsh-reference:… --> … <!-- /dsh-reference -->` block with an empty `Decoration.replace` and declared the same span atomic. The block stayed invisible, so a selection or deletion that crossed it could remove the whole citation without the user ever seeing what disappeared.

The replacement now carries one small inline capsule widget with a sentinel at each end. It stays on the text line: the widget reports no line breaks and an estimated height below CodeMirror's block threshold, and the stylesheet keeps it `inline-flex` with `white-space: nowrap`. The collapsed span is still a single atomic range, so it cannot be cut in half, and both sentinels live inside that range so a partial selection can never leave one behind. Clicking the capsule dispatches a toggle effect keyed by the block's own `referenceId` (falling back to its raw text) that drops the replacement for that block only: its source becomes visible and editable, and clicking again collapses it. Source mode still builds no decorations.

Reading-view behaviour is explicitly unchanged by this change: `hideRenderedDshReferenceBlocks` still removes the rendered callout, so the block remains invisible in reading view exactly as before. No write path, marker ownership, sticker backlink logic or note content was touched.

Validation: TypeScript noEmit passed; all 39 test files / 275 tests passed, including five new live preview assertions (a visible widget instead of an empty replacement, both sentinels, the atomic range, per-block expansion and raw source mode). Temporarily restoring the empty replacement fails exactly the two assertions that guard the capsule. Candidate version is 0.7.0-rc2.7.
