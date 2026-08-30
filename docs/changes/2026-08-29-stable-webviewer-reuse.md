# 0.3.9 - Stable DSH Web Viewer reuse

- Prefer a same-origin Web Viewer that has already reached a real DSH session title over an earlier blank or bootstrap tab.
- Stop replaying the one-time DSH launch token into an already running Web Viewer on every reference click.
- Retain authenticated navigation only for new tabs and for leaves that Obsidian has left outside `webview` mode.
