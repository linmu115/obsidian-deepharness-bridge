# 0.3.11 - Immediate and durable reference deletion

- Remove the Obsidian reference chip immediately without a confirmation dialog.
- Delete the source marker before local state and Core synchronization, retaining durable retry state on failure.
- Skip committed-backlink discovery when no receipt exists and use the recorded note directly when one does.
- Ignore unrelated malformed reference markers while recovering a backlink from a moved note.
- Give each restarted Bridge action queue a new identity so DSH can replay low cursors safely.
- Include a guarded repair utility for the one audited orphan closing marker.
