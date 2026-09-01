# Changelog

## 0.4.0 - 2026-09-01

- Add the versioned `/control/v1` lifecycle plane with stable instance identity, per-load boot identity, controller/surface roles, renewable leases, drain and resume.
- Fence control mutations to the current `bootId`; browser surfaces cannot acquire the controller role or drain the external Bridge.
- Reject new data-plane work while draining, finish in-flight requests up to the requested deadline, and expose live lease/request counts.

Focused verification: all 20 test files / 117 tests, typecheck, build and package dry run.

## 0.3.23 - 2026-08-31

- Persist Maintenance `logicalSessionId` and `logicalAnchorId` in DSH links and managed reference metadata while retaining native session and anchor fallbacks.
- Preserve logical identity from the DSH claim through the committed Obsidian backlink, so opening a reference can resolve the current Launcher projection.
- Carry the same identity through reference deletion; local removal remains immediate and Core cleanup remains an idempotent background operation.
- Match managed sticker backlink removal by globally unique sticker identity, allowing unlink after the DSH native session ID changes.
- Avoid declaring a logical sticker link stale by checking only its historical native session note before DSH has resolved the active projection.

Focused verification: protocol-v2, reference persistence, reference deletion and sticker backlink lifecycle tests, typecheck and build.

## 0.3.22 - 2026-08-31

- Added a delete control to compact `DSH 贴纸` chips in Live Preview and Reading mode.
- Deletion removes the chip immediately, then deletes only the managed backlink blocks for that sticker from the active Obsidian note. The DSH sticker itself and backlinks in other notes are preserved.
- The DSH-side reverse relationship now disappears from the next live backlink read because the Vault remains the single source of truth.
- Recorded the Alpha.2 deployment failure found during reference verification: the Launcher profile copied `settings.yaml` with `agent-presets.default: anchored-standard` but omitted `.agent-presets`, causing session resume to fail with `preset "anchored-standard" not found`. The profile must migrate the referenced preset assets together with settings.
