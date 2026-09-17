# Multiline reference refresh

Send-time refresh previously required the entire selection to fit on the block
marker's line. Reading capture places the marker on the first selected line;
editor capture uses the final line. Refresh now matches the selected span against
its marker line, removing only trailing Bridge marker metadata (and the exact
target block marker) from matching text while retaining line boundaries.
The original snapshot is located using the same rule before comparing occurrence
identity. Genuine text edits, missing/duplicate markers and shifted duplicate
occurrences remain blocked.

Validation on 2026-09-17: TypeScript and production build passed; 33 test files,
236 tests passed. Read-only validation against five local pending references
accepted all five; two had previously returned selection-changed. No reference
refresh API was invoked during verification, since that could advance a snapshot
before DSH acknowledges it.

Deployment patches only occurrenceAtBlock and refreshObsidianReference in the
installed 0.6.4-rc2.6 bundle, preserving other local bundle changes. The original
bundle and source map were backed up; the stale source map link is disabled.
No vault data or pending queue was edited. Activation requires reloading the
Obsidian plugin; a disk update alone does not change the loaded module. End-to-end
sending remains to be confirmed after activation.
