# 0.3.7 - Reproducible companion install

- Text files are installed with canonical LF line endings so the active Obsidian plugin tree exactly matches the content-addressed package built in Maintenance's detached worktree.
- Runtime JavaScript remains byte-for-byte copied.
- This keeps strict companion integrity verification enabled on Windows instead of weakening it to ignore line-ending drift.
