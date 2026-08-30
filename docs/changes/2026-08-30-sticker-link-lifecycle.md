# 0.3.19 - Stable Web Viewer routing and sticker backlink lifecycle

- Move the dedicated Obsidian Web Viewer surface identity from the launch-token query to a redirect-safe URL fragment.
- Provision each live Web Viewer leaf once so repeated reference and sticker opens do not reload DSH.
- Let Obsidian reject and clean a deleted sticker target before revealing DSH.
- Add managed sticker-backlink deletion across the Vault, including legacy two-line links and generated callouts.
- Advertise `sticker-backlink-delete-v1` and expose an authenticated idempotent deletion route.
