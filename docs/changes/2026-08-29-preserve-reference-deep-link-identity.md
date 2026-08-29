# 0.3.1 - Preserve reference identity in live Obsidian clicks

- Rendered `obsidian://deepharness` links are intercepted inside Obsidian and parsed from their full raw URL before the operating-system protocol handler can normalize parameters.
- External protocol opens accept parameter names case-insensitively, preserving `setId` and `referenceId` on Obsidian versions that normalize query keys.
- Existing links remain readable; no note migration is required.
