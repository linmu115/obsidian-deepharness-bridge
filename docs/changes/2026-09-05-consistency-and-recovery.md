# Consistent note updates and recoverable delivery

The companion now checks a sticker save's revision in the same `Vault.process`
callback that computes the note update. An existing managed-block edit or an
unrelated user edit therefore produces a revision conflict instead of being
overwritten. The caller must reread the note and resolve the conflict. Backlink
unlinking removes only generated relation blocks from the callback's latest
content and preserves surrounding user prose. Invalid managed sticker markers
still stop a session save.

First creation is serialized by resolved Vault path, with parent-folder locks
shared across adapter instances. If an external creator wins, the save re-enters
the same atomic revision check against the created file. These locks coordinate
plugin work; the Obsidian Vault API supplies atomic modification of existing
files. Synthetic tests cover same-revision concurrent saves, first creation,
external creation, and unrelated text edited during unlink.

Reference claim/discard/commit transitions are serialized by reference ID on the
HTTP side and in a single plugin-state lane through note operations and durable
saves. A successful discard removes its capture and queued navigation. A pending
reference already claimed by DSH is still cancellable until its backlink is
committed. Committed relations and deletion outbox entries require the existing
committed-delete flow. A failed durable save does not report successful discard
or cancel active delivery. Completed cancellation receipts suppress late claims
and late navigation for the retained reference identity.

If the note write completed but its receipt save failed, discard checks the
managed note block before classifying the reference as unsent. Deletion retries
can discover and clean that block without a receipt, preserving recovery through
this persistence interruption.

Active capture/deletion deliveries are never removed merely to limit memory.
Finished actions retain at most 2,048 compact in-process receipts; those receipts
contain claim identity, not captured Markdown. Duplicate enqueue and identical
claim retries are idempotent within that receipt window. Older completed action
IDs may return unavailable; this bound does not delete durable pending references,
backlink receipts, or unacknowledged deletion requests. On startup, persisted
claimed records restore claim receipts without broadcasting captures again.
Deletion requests are persisted before local marker cleanup and replay after
restart until DSH commits their completion.

Settings edits are drafts until **Apply**. Applying a changed address, port, or
companion directory serializes persistence, closing the old bridge, and starting
the new one. Closing uses one completion promise, stops accepting new queue work,
and waits for accepted Vault callbacks even if their HTTP clients disconnect.
An unload barrier stored on the Obsidian host is awaited before a replacement
plugin instance loads its data. A Vault operation that never settles can delay
shutdown; the plugin does not interrupt an atomic write or declare it completed.

The persistent adapter maintains a rebuildable identity-to-file candidate index
and a reverse native-link index. Vault creation, modification, rename, deletion,
and metadata events invalidate affected data. Reference and sticker operations
still validate candidates against current file contents. A failed Markdown index
rebuild, or a Vault that changes continuously through two rebuild passes, falls
back to the full path list. Moved source refresh uses a unique block
candidate; duplicate markers require reselection. **Retry pending operations**
also invalidates cached lookup data before retrying durable work.
Companion paths are resolved explicitly for session-note operations; source paths
under the former default folder remain real Vault paths after a directory change.

The settings page shows waiting delivery, claimed references awaiting writeback,
synced receipt counts, outstanding deletion confirmation, and recent errors.
Its connection summary derives from active controller leases or authenticated
page activity in the last ten seconds, not just a successful startup. It does not
claim to know whether a DSH page currently has a usable conversation; that state
remains owned by DSH. Open-source actions can follow a uniquely indexed moved
note. Cancelling a committed relation continues through DSH's deletion flow.

All regression work uses synthetic in-memory Vaults, stub Obsidian hosts, and
ephemeral loopback HTTP servers. A 501-note lookup test confirms that repeated
queries do not reread unchanged files; a 10,000-claim test checks bounded finished
history while retaining pending deletion/capture entries. These counts are not
measurements of real Vault latency or browser frame rate. No real Vault notes,
installed plugin state, or running DSH profiles were modified during verification.

The bundled schemas come from the neutral Bridge Protocol `/data` module; Core's
annotation schemas/hashes remain the annotation authority. The wire versions stay
annotation 2, sticker 1, lifecycle 3. Stable logical identity, targeted navigation,
and the existing managed reference cleanup format are unchanged.

Companion verification on 2026-09-05: all 26 test files / 158 tests passed after a
fresh standalone build, with TypeScript and diff whitespace checks passing.
This adds 38 regressions to the 120-test baseline. Suite compatibility and
installation provenance are verified separately by the coordinating release.
