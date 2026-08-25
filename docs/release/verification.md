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

The Workshop entry is intentionally `guided` with protocol `third-party`; it does not request DSH Registry installation authority. Failure-isolation, hot-reload, and removal evidence remain `null` until independently recorded.
