# Verification

From the repository root, ordinary app work needs one command:

```powershell
npm --prefix app run verify
```

Choose the smallest scope that exercises the changed behavior:

| Change | Command suffix | What runs |
| --- | --- | --- |
| Documentation | None | Review the diff; no build |
| UI, main process, preload, app-only settings | Default or `-- app` | TypeScript + production app build |
| Editor, export, playback, thumbnails | `-- editor` | App build + editor and preview tests |
| Theme loader, manifests, options, or styling API | `-- themes` | App build + theme tests |
| Updater state, IPC, or UI | `-- updater` | App build + updater tests |
| C++ logic/detection | `-- core` | Debug core build + detection/capture unit tests |
| Captured frames/audio, replay/mux/timestamps, core capture settings | `-- capture` | Core scope + one E2E with duration/video/audio checks |
| Release, packaging/build pipeline, packaged-only regression | `-- release` | Release core, unit/JS tests, app packaging, artifact checks |

Scopes combine: `npm --prefix app run verify -- editor updater` builds the app
once and runs both sets of tests. Add `--plan` to preview the selected steps.
Selection is explicit so unrelated changes in the working tree do not expand
the current task. Normal scopes assume dependencies and the core toolchain are
already installed. Release scope fetches pinned FFmpeg if its binaries are
missing; otherwise it reuses them.

Successful steps print one short result. Complete logs and a machine-readable
`summary.json` are kept under ignored `tmp/verify/<run>/`. A failure stops the
run and prints the last 20 log lines. Only open the full log if that is not
enough to diagnose the failure. Missing tools or failed checks are failures,
never silently skipped.

After a pass, stop. Rerun only what later edits affect. Do not build installers,
run capture tests, inspect every screen, or audit unchanged dependencies for a
routine app fix. A visual change may need one focused UI check. Game-hook and
focus fixtures are for changes to those features; selftest/long E2E are
diagnostics for relevant problems. Passing capture E2E replaces the separate
selftest plus manual ffprobe/black-frame check. Keep a nonblack desktop visible
for capture tests; they take roughly 80 seconds and need a working Windows GPU.

For black-hook fallback changes, an isolated GPU fixture exercises the real
source manager with synthetic black/colored capture surfaces (no injection):

```powershell
cmake --build build_x64 --config Debug --target shard_capture_backend_fixture --parallel
$env:PATH = "$PWD\app\resources\core-bin-dev;$env:PATH"
build_x64\Debug\shard_capture_backend_fixture.exe "$PWD/app/resources/core-bin-dev"
```

It checks loading-screen tolerance, visible WGC takeover, recreation of a
black hook, and return to recovered hook output. The existing
`scripts/game-capture-test.mjs` separately verifies real signed-hook capture,
including minimized games. Neither fixture establishes compatibility with a
specific protected game on another machine.

The D3D11 fixture also accepts `WM_APP + 1` with width/height in its message
parameters to replace its window and swapchain without changing PID/title/class.
To check native aspect ratios and launch/replacement recovery, build
`shard_gc_d3d11_fixture`, point `CF_COREBIN` and `CF_GC_FIXTURE` at the matching
Debug paths, then run `node scripts/game-capture-test.mjs` with
`CF_GC_GEOMETRY=1` and `CF_GC_STATES=focused,four-three,laptop,ultrawide,minimized`.
`CF_GC_RECORDING=1` additionally checks that resolution changes finalize and
continue decodable recording segments. `CF_GC_IGNORE_EXES` is an optional
comma-separated exclusion list for games already running during the test; it
affects only the fixture's temporary profile.

The release workflow calls the same `release` scope. Do not also perform a full
local release run when CI has verified the same changes. Hosted CI does not
test interactive capture, so use the capture scope when capture behavior changed.
OBS signatures/hashes, app/core versions, updater metadata, and installer
checksums remain release gates: they protect every shipped build, not just the
first one. See [Releasing](RELEASING.md) for publication and the initial real
installed-update acceptance test.
