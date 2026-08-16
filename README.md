# Shard

**A local-first Windows game clipper built on OBS.**

Shard keeps a rolling replay buffer in RAM, detects running games, and saves the last few seconds or minutes with a global hotkey. The Electron desktop app includes a searchable clip library, video viewer, non-destructive editor, multi-track audio controls, and target-size exports for services such as Discord.

> **Status:** early development. Windows is the supported runtime today; the core keeps platform-specific capture code isolated for future Linux work.

## Highlights

- **RAM replay buffer** — bounded by duration and memory, anchored to video keyframes, and written only when a clip is saved.
- **Automatic game detection** — Steam and other launcher discovery, process monitoring, known-game management, session tracking, and optional automatic recording.
- **Flexible capture** — automatic game/desktop switching, screen-only mode, or game-only mode.
- **Minimized-game support** — Windows Graphics Capture for normal use, with an OBS-compatible Game Capture hook underneath for applications that permit it.
- **Hardware encoding** — H.264 through NVENC when available with x264 fallback; NVENC AV1 is also supported.
- **Independent audio tracks** — master mix plus per-source tracks for editing and export.
- **Crash-tolerant recording** — fragmented MP4 output avoids a separate remux step for normal recordings.
- **Clip library** — search, sorting, favorites/protection, thumbnails, import, deletion, storage limits, and drag-out to Explorer or Discord.
- **Editor and export** — trim ranges, remove middle sections, choose audio tracks, preview the result, and export to a target file size.
- **Configurable hotkeys** — multiple replay durations with automatic re-registration after transient Windows shortcut failures.

## How it works

```mermaid
flowchart LR
    Game[Game or desktop] --> Capture[WGC + OBS Game Capture]
    Capture --> OBS[Embedded libobs]
    OBS --> Ring[RAM replay ring]
    OBS --> Recorder[Fragmented MP4 recorder]
    Ring --> Mux[obs-ffmpeg-mux]
    Mux --> Clips[Clip files]
    Core[clipcore.exe] <-->|JSON-RPC over localhost WebSocket| Main[Electron main]
    Main <-->|typed IPC| UI[React renderer]
    Main --> Library[(SQLite library)]
    Main --> Export[FFmpeg editor/export pipeline]
```

### Capture strategy

Shard layers two Windows capture backends for a detected game:

1. **Windows Graphics Capture** is the normal path. It works while a game is focused, unfocused, or covered without injecting into the game.
2. **OBS-compatible Game Capture** uses the architecture-matched OBS helper and graphics hook when in-process capture is required, primarily for genuinely minimized windows.

The compatibility path is validated with x64 D3D11, x64 D3D12, and x86 D3D11 targets. Anti-cheat software may still reject an unsigned third-party capture hook. The exact implementation, safety boundaries, test matrix, and current VRChat/EAC result are documented in [`GAME_CAPTURE_AUDIT.md`](GAME_CAPTURE_AUDIT.md).

Shard does not bypass anti-cheat, reuse another vendor's signed binaries, install kernel components, or require reduced Windows security settings.

## Repository layout

```text
app/
  src/main/       Electron lifecycle, core client, hotkeys, library, storage, export
  src/renderer/   Capture, games, library, viewer, editor, and settings UI
  src/shared/     TypeScript settings, RPC, event, and hotkey contracts
core/
  src/            C++20 capture engine, replay ring, recorder, game system, JSON-RPC
  tests/          Detection tests and animated D3D11/D3D12 capture fixtures
patches/          Reproducible Shard patch applied to the pinned OBS checkout
scripts/          Build, development, selftest/E2E, and capture diagnostics
vendor/
  obs-studio/     Pinned OBS Studio 32.2.1 submodule
  ffmpeg/         Pinned FFmpeg runtime fetched locally; not committed
```

`app/src/shared/contracts.ts` is the cross-language contract. Changes to its RPC methods, events, or settings must be mirrored by the handlers in `core/src/jsonrpc.cpp`.

## Requirements

- Windows 10 version 2004 or newer; Windows 11 recommended
- Visual Studio 2022 Build Tools
  - Desktop development with C++
  - MSVC v143
  - Windows 11 SDK `10.0.26100.0`
- CMake 3.28 or newer
- Git with submodule support
- Node.js 22 or newer and npm
- A Direct3D 11-capable GPU

NVIDIA NVENC is optional. Shard falls back to x264 when a supported hardware encoder is unavailable.

## Clone and build

Clone with the OBS submodule:

```powershell
git clone --recurse-submodules <repository-url> Shard
cd Shard
```

If the repository was cloned without submodules:

```powershell
git submodule update --init --recursive
```

Fetch the pinned FFmpeg build:

```powershell
powershell -File scripts/fetch-ffmpeg.ps1
```

Build the C++ core, OBS plugins, compatibility helpers/hooks, and staged runtime:

```powershell
powershell -File scripts/build.ps1
```

The build script applies `patches/obs-game-capture.patch` idempotently to the pinned OBS checkout before compiling. Release runtime files are staged under `app/resources/core-bin/`.

Install and build the desktop app:

```powershell
cd app
npm install
npm run build
```

Create the installer and portable build:

```powershell
npm run package
```

Packaged artifacts are written under `app/release/`.

## Development

Run the integrated development workflow from the repository root:

```powershell
powershell -File scripts/dev.ps1
```

This uses the Debug core in `app/resources/core-bin-dev/`, starts the Vite renderer, watches Electron main-process TypeScript, and restarts Electron when required.

Useful build variants:

```powershell
powershell -File scripts/build.ps1 -SkipApp
powershell -File scripts/build.ps1 -Config Debug
powershell -File scripts/build.ps1 -Clean
```

## Verification

### Core selftest

Boot capture, warm the replay ring, save a short clip, and verify that muxing succeeds:

```powershell
$coreBin = (Resolve-Path app/resources/core-bin).Path
$out = Join-Path $env:TMP 'shard-selftest'
& "$coreBin/clipcore.exe" --selftest --out $out `
  --config-dir "$out/cfg" --core-bin $coreBin
```

Successful output contains one line beginning with:

```text
SELFTEST {"ok":true,...}
```

### JSON-RPC end-to-end test

```powershell
powershell -File scripts/e2e.ps1
$env:CF_LONG = '1'
powershell -File scripts/e2e.ps1 -KeepTemp
```

The short test exercises startup, settings, the replay ring, a 60-second save, ffprobe duration, capture-mode changes, audio enumeration, game persistence, events, and clean shutdown.

### Detection unit tests

```powershell
cmake --build build_x64 --config Debug --target shard_tests --parallel
build_x64\Debug\shard_tests.exe
```

### Game Capture compatibility test

```powershell
node scripts/game-capture-test.mjs
$env:CF_GC_API = 'D3D12'
node scripts/game-capture-test.mjs
```

The test records focused, unfocused, covered, and genuinely minimized states and compares decoded frame hashes to detect frozen output.

## Runtime contract

`clipcore.exe` accepts:

```text
--config-dir <dir>   Required configuration directory
--core-bin <dir>     Staged OBS/runtime directory
--port <n>           JSON-RPC port; 0 selects a free port
--games <file>       Optional games.json path
--selftest           Run the capture/mux selftest
--out <dir>          Selftest output directory
```

For normal server startup, `PORT <n>` is always the first stdout line. Diagnostics are written to stderr so the Electron launcher can safely parse the port.

## Data and privacy

- Capture, indexing, editing, and export run locally.
- The core listens only on `127.0.0.1`.
- Settings and the game registry are stored in the app configuration directory.
- Clip metadata is stored in a local SQLite database.
- Shard does not upload clips or telemetry.

## License

Shard is licensed under **GPL-2.0**. See [`LICENSE`](LICENSE).

Shard embeds and modifies OBS Studio components under GPL-2.0. Attribution and related notices are in [`NOTICE`](NOTICE). FFmpeg and other staged runtime components retain their respective upstream licenses.
