# Prefer ready DSH Web Viewer tabs

## Fixed

- Prefer an existing same-origin tab already running in Obsidian's `webview` mode over an earlier blank or error tab.
- Reauthenticate the ready tab with the current DSH launch URL after a DSH restart.
- When no ready tab exists and a blank tab already has the exact target URL, force a real navigation by cycling through `about:blank`; Obsidian 1.13 ignores the persisted `mode` field when the URL is unchanged.

## Verification

- Added regressions for ready-tab preference and two-step recovery of an already-authenticated blank tab.
- The build-time Annotation Core protocol source follows its maintained compatibility branch instead of pinning one commit.
