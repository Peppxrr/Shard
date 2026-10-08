# Shard architecture notes for contributors and coding agents

This is a routing map, not a frozen specification. Current implementation is authoritative. Keep this document focused on subsystem boundaries and stable contracts so it ages slowly.

## Top-level flow

Shard has two primary processes:

1. `shardcore.exe`, a C++20 process embedding OBS/libobs.
2. The Electron application, whose main process owns desktop integration and whose React renderer owns the UI.

The core captures the selected desktop/game source, encodes replay/recording streams, tracks games/sessions, and exposes a JSON-RPC server bound to localhost. The Electron main process starts the core, parses its announced port, sends RPC requests, receives core events, and exposes controlled IPC to the renderer.

The broad data path is:

```text
Game / desktop
    -> OBS sources (Game Capture and/or WGC)
    -> libobs scene/video/audio
    -> encoders
       -> RAM replay ring -> saved MP4 clips
       -> recorder        -> fragmented MP4 recordings

C++ core <-> localhost WebSocket JSON-RPC <-> Electron main <-> preload IPC <-> React renderer
                                                        |
                                                        +-> SQLite clip library
                                                        +-> FFmpeg editor/export helpers
                                                        +-> themes / hotkeys / updater / OS integration
```

## Cross-language contract

`app/src/shared/contracts.ts` is the TypeScript definition of settings, RPC methods, events, and shared application data. It explicitly mirrors the C++ config and JSON-RPC handlers.

When changing an RPC method, event shape, setting, or other core/app boundary:

- update `app/src/shared/contracts.ts`;
- update the corresponding C++ config/JSON-RPC/event code;
- update app main/preload/renderer consumers as needed;
- use the smallest relevant verification scopes from `docs/VERIFYING.md`.

Do not create a second competing schema.

## C++ core

Important areas in `core/src/`:

- `main.cpp` — CLI, process/DPI setup, core construction and ordered shutdown.
- `app.*` — OBS startup, graphics/audio initialization, module loading, scene ownership, pipeline restarts.
- `sources.*` — monitor/window/Game Capture sources, capture subject retargeting, source transforms/crops, watchdog/recovery, audio sources.
- `audio_isolation.*` — pure per-app audio isolation routing (which rows are isolated/filtered, process-tree/session partition).
- `audio_isolation_capture.*` — Windows process-loopback OBS source and the controller that keeps isolated App rows and filtered Desktop rows in sync with processes and endpoint sessions.
- `capture_geometry.h`, `capture_resilience.h` — isolated geometry/recovery decision logic used by native capture code/tests.
- `encoders.*` — runtime video/audio encoder selection and settings.
- `replay_ring.*`, `save_queue.h` — encoded RAM ring and clip snapshot/save path; save acceptance synchronized with the save worker.
- `recorder.*` — direct fragmented-MP4 recording.
- `mux.*` — pipe protocol to OBS's ffmpeg mux helper.
- `process_monitor.*`, `detector.*`, `launchers.*`, `game_registry.*`, `game_session.*`, `game_system.*` — process evidence, launcher product hints, qualification, persistence, sessions, primary selection, and capture-subject handoff.
- `jsonrpc.*` — RPC dispatch and config side effects.
- `server.*` — local WebSocket server and port announcement.
- `log.*` — asynchronous stderr logger (libobs log handler included) and libobs log facts (GPU priority result, hook API/transport).
- `perf_monitor.*`, `perf_analysis.h`, `gpu_engines.*`, `system_info.*` — frame pacing/GPU engine sampling, lag cause classification, `perf.stats`, clip lag segments, session diagnostics.
- `priority_task.*`, `priority_runtime.*`, `priority_policy.h` — opt-in Recording priority scheduled task, bridge and elevated entry; protected runtime copy/manifest/swap; pure setup decisions (see `docs/CAPTURE.md`).

### Game detection/session model

Launcher discovery supplies product metadata/evidence, but live processes still pass the detector before becoming active game sessions. A session can aggregate multiple related PIDs. The system probes those PIDs to find the useful game window instead of assuming the first/parent/helper process owns it.

`GameSystem::applyFocusPrimary` owns focus-driven primary-session selection. Focusing a non-game does not inherently discard the current game primary. `updateCaptureSubject` consumes the chosen primary and tells `SourceManager` what to capture; it should not become a second primary-selection policy.

Keep detection evidence explainable through the existing `game.detectExplain` path instead of adding opaque executable-specific hacks where structural evidence can solve the problem.

## Electron main process

Important files under `app/src/main/` include:

- `main.ts` — app lifecycle, windows/tray, IPC registration, core startup, subsystem wiring.
- `core-client.ts` — core process spawn/port parsing/RPC connection and restart handling.
- `settings.ts` — settings persistence and defaults integration.
- `library.ts`, `storage.ts` — SQLite-backed clip metadata and storage cleanup.
- `ffmpeg.ts`, `export*.ts`, `timeline-previews.ts` — media probing, editor previews, export graph/encoding.
- `hotkeys.ts` — global shortcuts.
- `themes.ts` — custom theme loading/protocol/watching.
- `overlay.ts`, `sound.ts` — clip feedback.
- `dev-console.ts`, `playback-diagnostics.ts` — diagnostics surfaces.
- `perf-timeline.ts`, `diagnostics-bundle.ts`, `recording-priority.ts` — perf.stats history, Export diagnostics zip, Recording priority task control.
- `updater.ts`, `update-controller.ts`, `update-storage.ts`, `update-log.ts` — update lifecycle.

The Electron main process is CommonJS. The renderer is built through Vite as ESM. Do not casually change that module boundary.

## Renderer and themes

`app/src/renderer/` contains the React UI. Shared theme validation/types live in `app/src/shared/themes.ts`, filesystem/protocol behavior in `app/src/main/themes.ts`, and renderer application logic in the renderer theme manager.

Theme API compatibility is public behavior. See `docs/THEME-API.md` before changing themeable markup or tokens. See `docs/THEMES.md` when working on actual theme packages/examples.

## Build/runtime layout

Release native runtime is staged to `app/resources/core-bin/`; Debug development runtime goes to `app/resources/core-bin-dev/`. `scripts/build.ps1` builds into a fresh staging sibling and only replaces the usable stage after validation, avoiding stale DLL/data leftovers. The core-bin root holds `shardcore.exe`, libobs, only the OBS modules the core uses, and OBS's FFmpeg DLLs; the editor/export `ffmpeg.exe`/`ffprobe.exe` live in `core-bin/ffmpeg/` with their own shared FFmpeg DLLs and are spawned only for probing, thumbnails, editor previews and exports. The renderer lazily loads the Editor, Settings, Games and Developer Console views.

Runtime dependency pins live in `runtime-dependencies.json`. OBS source is pinned by the submodule, Shard's OBS changes live in `patches/`, and the official signed Game Capture injection payload is kept separately under `vendor/obs-hook-payload/` and verified during build/package.

For dependency upgrades, follow `docs/DEPENDENCIES.md`. For packaging/version/publication behavior, follow `docs/RELEASING.md`.

## Verification

`scripts/verify.mjs` is the verification router. The supported scopes are currently
`app`, `editor`, `storage`, `updater`, `themes`, `diagnostics`, `core`, `capture`
and `release`.

The runner deduplicates shared work, prints a compact summary, and writes full logs under ignored `tmp/verify/`. See `docs/VERIFYING.md`; do not recreate its decision table here.
