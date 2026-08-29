# 0.3.2 - Safe live installation

- New installations target the current official DSH Web origin at
  `http://127.0.0.1:3080`.
- The local installer stores recoverable backups under
  `.obsidian/plugin-backups`, outside Obsidian's live plugin scan directory.
  This prevents an older backup with the same manifest ID from shadowing the
  newly installed Bridge.
- Existing settings and `data.json` continue to be preserved during updates.
