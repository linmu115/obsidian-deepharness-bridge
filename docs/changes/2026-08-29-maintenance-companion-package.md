# 0.3.6 - Maintenance companion package

- The safe local installer now deploys the complete packaged file set, while keeping versioned backups outside Obsidian's live plugin scan directory.
- The installed tree now matches the content-addressed package that Maintenance verifies and records as an external companion artifact.
- Runtime behavior from 0.3.5 is unchanged: ready DSH Web Viewer tabs are reused and blank tabs are force-navigated when necessary.
