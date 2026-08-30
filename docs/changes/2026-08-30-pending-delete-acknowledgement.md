# 0.3.12 — Pending deletion acknowledgement

- Treat Core's pending-discard callback as a valid deletion acknowledgement even when eager local cleanup already removed the visible record.
- Clear the durable deletion request only after that Core callback arrives.
- Prevent an already-deleted pending reference from remaining in the Obsidian retry outbox forever.
