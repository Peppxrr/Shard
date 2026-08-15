# Shard

Medal-style game clipper for Windows (Linux-ready architecture).

A C++ core embeds OBS Studio's libobs and runs a RAM replay buffer that
continuously captures the desktop or the foreground game (WGC — no injection,
so anti-cheat / borderless games work). A global hotkey saves the last
N seconds/minutes to a library; clips are viewable and editable in-app
(trim + cut, per-audio-track selection); edited clips export via ffmpeg to a
target size (default ≤ 10 MB for Discord). A storage-limit watchdog
auto-deletes the oldest unprotected clips, and known games are auto-detected
(toast + tagging + optional auto-record).

## Features

- **Capture modes** — `auto` (game window when a game is active, desktop otherwise),
  `screen` (desktop always), `game` (game only). The capture subject follows the
  game while its process is alive — clicking away doesn't stop it; switching
  between open games is debounced 10 s with the buffer kept.
- **Codecs** — H.264 (x264/NVENC) and AV1 (NVENC) capture; AV1 replay clips are
  keyframe-corrected so every save decodes cleanly.
- **Audio** — each configured audio source gets its own track in recordings and
  clips (plus a master mix); files are fragmented mp4 (crash-safe, no remux).
- **Library** — search (game / filename / date), sort (newest, oldest, favorites,
  duration, size, game), relative timestamps, live delete/favorite updates,
  drag-out to Discord/Explorer.
- **Editor** — result preview (plays the trimmed/cut output live), in/out +
  middle cuts, per-track audio selection on export.
- **Extras** — custom hotkeys with arbitrary durations, storage bar + capture
  indicator in a bottom status bar, configurable clip directory, overlay vs
  Windows notifications.

## Architecture

```
core/            C++ capture engine embedding OBS's libobs (GPL-2.0)
  └─ src/        boot, sources (capture-subject director), encoders,
                 replay ring, recorder, game detect, JSON-RPC server
app/             Electron + React + TypeScript shell
  ├─ src/main/   core client, settings, hotkeys, library DB, storage, export
  ├─ src/renderer/  library, viewer, editor, settings, status bar
  └─ src/shared/ contracts.ts — cross-language RPC/settings schema
vendor/obs-studio/  pinned OBS submodule (32.2.1)
scripts/         build.ps1, e2e.ps1 + e2e-client.mjs, fetch-ffmpeg.ps1
```

The core exposes a WebSocket JSON-RPC 2.0 server on `127.0.0.1` (ephemeral
port, printed as the first stdout line `PORT <n>`); the Electron main process
spawns the core and speaks JSON-RPC to it. All contracts live in
`app/src/shared/contracts.ts` and are mirrored exactly by the core's JSON
handlers.

## Building

Prerequisites: Windows 10 2004+ (19041+), Visual Studio 2022 Build Tools with
the "Desktop development with C++" workload, CMake, Git, Node.js 22+.

```powershell
powershell -File scripts/build.ps1        # core build + stage app/resources/core-bin
cd app
npm install                               # postinstall runs electron-rebuild (better-sqlite3)
npm run build                             # tsc renderer → vite build → tsc main (CJS)
npm run package                           # electron-builder: release\Shard Setup 0.1.0.exe + portable
```

`scripts/build.ps1` vendors obs-deps (auto-downloaded with pinned SHA-256
during CMake configure), builds the core, and stages
`app/resources/core-bin/`. The app icon lives in `app/build/` (icon.ico for
electron-builder, icon-256.png packaged as `resources/icon.png` for the tray).

Staged runtime layout:

```
app/resources/core-bin/
  clipcore.exe          obs.dll  libobs-d3d11.dll  obs-ffmpeg-mux.exe
  avcodec-62.dll ...    zlib.dll  libx264-164.dll  ffmpeg.exe  ffprobe.exe
  obs-plugins/64bit/*.dll      data/obs-plugins/<plugin>/...
  data/libobs/  (effects, locales)
```

FFmpeg/ffprobe are fetched by `scripts/fetch-ffmpeg.ps1` (pinned SHA-256).

## Running

```powershell
# Core selftest: boots WGC capture, warms the ring 10 s, saves 3 s
app\resources\core-bin\clipcore.exe --selftest --out $env:TMP\cf-selftest `
  --config-dir $env:TMP\cf-selftest\cfg --core-bin C:\Ai\Recording\app\resources\core-bin
# Expect stdout: SELFTEST {"ok":true,"path":"...","durationSec":3.x}

# E2E contract test (Node >= 22, no deps): 70 s warm, 60 s save, RPC assertions
powershell -File scripts/e2e.ps1
$env:CF_LONG='1'; powershell -File scripts/e2e.ps1 -KeepTemp   # long variant
```

Core CLI: `--config-dir <dir>` (required), `--core-bin <dir>`, `--port <n>`
(0 = pick free), `--games <games.json>`, `--selftest`, `--out <dir>`.
Exit codes: 2 = args/config/init, 3 = ring start, 4 = RPC bind.

## License

GPL-2.0 (see `LICENSE`). This project links and embeds OBS Studio's libobs;
see `NOTICE` for attribution required by GPL section 5.
