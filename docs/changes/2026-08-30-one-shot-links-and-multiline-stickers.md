# 0.3.15 - One-shot links and multiline stickers

- Consume completed navigation and deletion commands globally so a remounted DSH client cannot replay an old session switch.
- Cancel queued navigation for a reference as soon as that Obsidian reference is deleted.
- Preserve the sticker ID in Obsidian-to-DSH actions for exact target resolution.
- Flatten multiline selected quotes only in the callout title while retaining the original quote in managed metadata.
