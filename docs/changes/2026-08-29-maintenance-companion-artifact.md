# 0.3.8 - Maintenance companion artifact

- Adds a deterministic Obsidian companion archive whose files exactly match the safe local installer output.
- Keeps strict content-addressed integrity checks enabled across Windows worktrees without treating this Obsidian plugin as a DSH profile bundle.
- The archive contains only the eight files deployed by the local installer and normalizes text files to UTF-8 with LF line endings.
