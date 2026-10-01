# Capture diagnostics

Enable **Developer console** in Settings. The console button appears above the storage meter in the app footer. Open it before reproducing a capture problem, then export the session log after the problem occurs.

The console captures both stdout and stderr from Shard's capture core, including startup output and the last partial line when the process exits. Stream labels describe where a message came from; stderr does not automatically mean an error. Source and severity filters and text search help narrow the visible messages. Copy uses the filtered view; session export includes the full session, including messages outside the visible history and messages hidden by filters. Pausing and clearing the view do not erase the session log.

## Session log files and retention

Shard writes one JSON Lines file per app session under `<userData>/logs/developer-console/`, named `dev-console-<start-time>-<process-id>.jsonl`. On Windows, `<userData>` is the app's Shard data directory under `%APPDATA%`. Each accepted console line is written as one JSON object followed by a newline. The live window retains at most 20,000 lines in memory; the session file keeps the complete output for that app launch unless logging reports a write failure.

At startup, Shard prunes older session files on a best-effort basis, keeping up to five prior files with a combined size of at most 100 MiB. The active session file is not included in that limit and has no configured size cap; it becomes eligible for pruning on a later startup. Files that cannot be deleted may remain beyond the retention target.

**Export session** opens a save dialog, defaulting to a timestamped `Shard-developer-console-<time>.jsonl` file in Documents. The export is a complete-record snapshot of the active session taken after the dialog closes. Clearing the live view only clears its in-memory history; it does not truncate the active session file. Copy still exports only the messages matching the current filters.

## Investigating a black image

Search for `capture-health`, `capture-recovery`, `capture-adapter`, `game-capture`, `WGC`, `hook`, or `encoder`. Include startup messages when sharing a report so the GPU, encoder, and capture initialization evidence is available.

- **Dimensions/readiness**: a nonzero source size means a texture is available. It does not prove the image contains the game or that its pixels are changing.
- **Content observations**: the existing small frame probes classify an image as content, black, or unknown. Unknown means no usable observation is available; black can also be a legitimate loading screen. Probe age helps distinguish current observations from old ones.
- **Freshness and movement**: `hook_frame_changed`, `wgc_frame_changed`, `scene_frame_changed`, their `*_unchanged_age_ms`, and individual `*_probe_age_ms` describe actual sampled pixels. A changed fingerprint is evidence of image movement, not proof of game correctness. Probes older than 2.5 seconds are degraded/unknown even when dimensions remain nonzero. `*_pixels_observed` distinguishes having read pixels from readiness; content can legitimately be static.
- **Selected backend**: which source Shard is currently showing, and whether a black or frozen hook was rejected against working WGC evidence. `hook_healthy` includes rejection and freshness; `hook_health` describes the probe classification/freshness alone.
- **Composed scene**: `scene_content` observes OBS's actual main texture. `hook=content wgc=content scene=black` points downstream toward scene/video composition; `hook=black wgc=content scene=content` indicates successful fallback. Desktop capture also reports `monitor_content` and monitor freshness/movement.
- **Recovery**: each `capture-recovery` line contains the pre-action backend, reason, action/level, PID/HWND, source and scene dimensions/content/change ages, probe ages, retry counts, and previous recovery age. Short both-black loading screens and static menus do not cause destructive recovery. Extended outages use cooldowns and graduated source recovery; sustained downstream failure targets scene repair before a last-resort video-mix reset. See [Capture recovery](CAPTURE.md#recoverywatchdog) for thresholds and continuity limits.
- **Adapters**: `capture-adapter` lists the detected DXGI adapters with vendor/device IDs, LUID, memory and D3D11 capability, followed by the selected OBS adapter index and selection reason. The preference is vendor-neutral. Canvas resets retain the initially selected device, so startup records identify the adapter actually in use.

Source fingerprints reuse the existing mapped probes; only the composed-scene observation adds a tiny staged readback. Health logs remain bounded to state changes and ten-second heartbeats, while recovery actions log immediately. A log explains Shard's decisions; diagnosing a particular GPU still requires a report from the affected machine while the issue is happening.

## Investigating a buffer counter reset

The counter measures retained encoded history. Search for `capture-geometry`, `replay-ring`, `capture-pipeline`, and encoder startup messages around the reset. A compatible source resize logs `replay_preserved=true` and retains both replay packets and the recording file. A necessary output-format or aspect-ratio change logs the previous canvas/output, desired output and `replay_preserved=false`, then restarts the buffer. `reason=capture_inactive grace_ms=15000` identifies an extended capture loss. Game-only startup with no subject leaves the ring idle; initial acquisition receives the same inactivity grace as later window transitions. Include these messages when reporting repeated startup resets so they can be separated from health recovery actions.
