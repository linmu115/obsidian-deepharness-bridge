# Recover existing blank DSH Web Viewer tabs

## Fixed

- Detect an existing same-origin DSH tab whose Obsidian state is still `mode: "blank"`.
- Reapply the authenticated DSH URL with `mode: "webview"` even when the URL itself has not changed.
- Keep using the existing tab instead of creating another duplicate during recovery.

## Verification

- Added a regression test for an authenticated URL that is already current but remains in blank mode.
