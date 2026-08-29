# Obsidian 1.13 Web Viewer mode fix

## Fixed

- Open authenticated DSH pages with the explicit Obsidian Web Viewer `webview` mode instead of leaving newly created tabs in the blank mode.
- Reuse an existing DSH Web Viewer by loopback origin even after DSH replaces the tab title with the active session title.
- Preserve the full annotation deep-link action while the existing viewer is reauthenticated and revealed.

## Verification

- Added a regression test for an existing DSH tab whose title has changed to a session title.
- Updated Web Viewer state assertions to require `mode: "webview"`.
