# 0.3.13 — Silent reference deletion

- Remove all Obsidian notices from the user-triggered DSH-reference deletion path.
- Keep immediate chip removal as the only foreground UI response.
- Report cleanup failures only to the developer console while the durable outbox retries in the background.
