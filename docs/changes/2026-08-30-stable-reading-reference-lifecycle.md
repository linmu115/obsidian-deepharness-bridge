# 0.3.10 - Stable reading reference lifecycle

- Preserve Obsidian's shared reading-selection context menu, including Copy and menu contributions from other plugins.
- Resolve repeated selected text through the Bridge-owned block marker so a referenced paragraph can be cited again.
- Delete committed Obsidian reference blocks immediately while retaining a durable Core synchronization outbox.
- Treat the later Core deletion commit as an acknowledgement, so a failed background delivery never restores the local reference.
