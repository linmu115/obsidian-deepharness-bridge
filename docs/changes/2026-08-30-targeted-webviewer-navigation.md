# 0.3.18 - Targeted Web Viewer navigation

- Assigns one persistent surface ID to Obsidian's DSH Web Viewer and appends it to the authenticated launch URL without exposing or replacing the launch token.
- Adds the surface ID to deep-link actions so Edge and unrelated DSH tabs cannot consume navigation intended for the Obsidian viewer.
- Filters queued navigation by the authenticated DSH surface and rejects acknowledgements from non-owning surfaces.
- Reloads an existing same-origin Web Viewer only when the routing identity first needs to be installed; later clicks reuse the running viewer.
