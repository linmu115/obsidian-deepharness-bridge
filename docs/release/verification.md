# Release verification

This file records author-side release evidence. Workshop verification and Registry admission remain independent maintainer decisions.

## Clean-checkout gate

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
pnpm pack --dry-run --json
```

Acceptance criteria:

- annotation protocol types resolve from a public, full Git commit rather than a local path;
- all bridge, migration, workspace, selection, and vault tests pass;
- `main.js`, `manifest.json`, and `versions.json` carry the same release version;
- the GitHub Release contains `main.js`, `manifest.json`, and `versions.json` as directly downloadable assets.
- compact sticker backlink chips retain their DSH jump target and expose an independent delete control;
- deleting one sticker chip removes only the active note's managed backlink and preserves the DSH sticker and other notes' backlinks;
- Launcher Alpha.2 profiles that select a custom Agent Preset include the matching `.agent-presets` assets, so Core can resume historical sessions before claiming Obsidian references.

The Workshop entry is intentionally `guided` with protocol `third-party`; it does not request DSH Registry installation authority. Failure-isolation, hot-reload, and removal evidence remain `null` until independently recorded.
