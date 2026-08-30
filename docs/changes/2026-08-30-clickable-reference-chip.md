# 0.3.14 — Clickable Obsidian reference chip

- Make the compact `DSH 引用` chip open its committed DSH conversation target in both Live Preview and Reading View.
- Recover `sessionId`, `userAnchorId`, `setId`, and `referenceId` from the durable backlink metadata already written to the Vault, so existing references work without being recreated.
- Keep the delete button isolated from navigation and support keyboard activation of the chip.
- Show a target menu when one source block is linked to multiple committed DSH references.
- Add regression coverage for chip open/delete event isolation and committed navigation-target recovery.
