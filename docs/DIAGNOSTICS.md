# Capture diagnostics

Enable **Developer console** in Settings. The console button appears above the storage meter in the app footer. Open it before reproducing a capture problem, then export the session log after the problem occurs.

The console captures both stdout and stderr from Shard's capture core, including startup output and the last partial line when the process exits. Stream labels describe where a message came from; stderr does not automatically mean an error. Source and severity filters and text search help narrow the visible messages. Copy uses the filtered view; session export includes the full session, including messages outside the visible history and messages hidden by filters. Pausing and clearing the view do not erase the session log.

## Session log files and retention

Shard writes one JSON Lines file per app session under `<userData>/logs/developer-console/`, named `dev-console-<start-time>-<process-id>.jsonl`. On Windows, `<userData>` is the app's Shard data directory under `%APPDATA%`. Each accepted console line is written as one JSON object followed by a newline. The live window retains at most 20,000 lines in memory; the session file keeps the complete output for that app launch unless logging reports a write failure.

At startup, Shard prunes older session files on a best-effort basis, keeping up to five prior files with a combined size of at most 100 MiB. The active session file is not included in that limit and has no configured size cap; it becomes eligible for pruning on a later startup. Files that cannot be deleted may remain beyond the retention target.

**Export session** opens a save dialog, defaulting to a timestamped `Shard-developer-console-<time>.jsonl` file in Documents. The export is a complete-record snapshot of the active session taken after the dialog closes. Clearing the live view only clears its in-memory history; it does not truncate the active session file. Copy still exports only the messages matching the current filters.

## Investigating a black image

Search for `capture-health`, `game-capture`, `WGC`, `hook`, or `encoder`. Include startup messages when sharing a report so the GPU, encoder, and capture initialization evidence is available.

- **Dimensions/readiness**: a nonzero source size means a texture is available. It does not prove the image contains the game or that its pixels are changing.
- **Content observations**: the existing small frame probes classify an image as content, black, or unknown. Unknown means no usable observation is available; black can also be a legitimate loading screen. Probe age helps distinguish current observations from old ones.
- **Selected backend**: which source Shard is currently showing, and whether a black hook was rejected while WGC had visible content.
- **Recovery**: retry/recreation records and their timestamps show what Shard attempted. Initialization and process errors provide additional evidence when neither backend is usable.

Health logging reuses the existing frame probes. It does not perform additional GPU readbacks or change capture selection. A log can explain Shard's decisions; diagnosing a particular GPU still requires a report from the affected machine while the issue is happening.
