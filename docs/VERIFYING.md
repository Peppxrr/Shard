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
| Editor, export, playback, thumbnails, library imports/renaming | `-- editor` | App build + editor, preview, and library tests |
| Storage policy, automatic cleanup, library retention | `-- storage` | App build + library and storage policy/SQLite tests |
| Theme loader, manifests, options, or styling API | `-- themes` | App build + theme tests |
| Updater state, IPC, or UI | `-- updater` | App build + updater tests |
| Developer console, log streams, session export | `-- diagnostics` | App build + diagnostics tests |
| C++ logic/detection | `-- core` | Debug core build + detection/capture/audio-isolation unit tests |
| Captured frames/audio, replay/mux/timestamps, core capture settings | `-- capture` | Core scope + one E2E with duration/video/audio checks |
| Release, packaging/build pipeline, packaged-only regression | `-- release` | Release core, unit/JS tests, app packaging, artifact checks, size report |

Scopes combine: `npm --prefix app run verify -- editor updater` builds the app
once and runs both sets of tests. Add `--plan` to preview the selected steps.
Selection is explicit so unrelated changes in the working tree do not expand
the current task. Normal scopes assume dependencies and the core toolchain are
already installed. Release scope fetches pinned FFmpeg if its binaries are
missing; otherwise it reuses them.

Successful steps print one short result. Complete logs and a machine-readable
`summary.json` are kept under ignored `tmp/verify/<run>/`; the ten newest
successful and ten newest failed runs are retained, while active and older
unmarked runs are left alone. A failure stops the run and prints the last 20
log lines. Only open the full log if that is not enough to diagnose the
failure. Capture E2E temp data is removed on success and kept on failure.
Missing tools or failed checks are failures, never silently skipped.

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
build_x64\Debug\shard_capture_backend_fixture.exe "$PWD/app/resources/core-bin-dev" --check-wgc-properties
build_x64\Debug\shard_capture_backend_fixture.exe "$PWD/app/resources/core-bin-dev"
```

The property check loads the staged OBS module and verifies `force_sdr` is a
boolean on both modern WGC sources. The synthetic fixture checks SDR settings
through creation, retargeting, retry, recreation and full source rebuilds, with
no SDR setting added to the Game Capture payload. It also checks
loading-screen tolerance, visible WGC takeover, recreation of a
black hook, frozen-content hook takeover against animated WGC, recovery after
hook movement returns, independent probes when WGC dimensions disappear,
and downstream scene rebinding without healthy hook recreation. Pure native
tests simulate long outages/cooldowns, stale/unknown probes, static menus,
wake coalescing, desktop escalation and adapter-index/LUID selection without
waiting minutes. The existing
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

To verify same-aspect capture continuity at a fixed encoded size, run
`$env:CF_GC_CONTINUITY='1'; node scripts/game-capture-test.mjs`. This mode starts
the explicitly registered D3D11 fixture at 1280x720, replaces its window at
1600x900 and 1920x1080, and uses game-only capture with a 960x540 custom output
and bounded replay caps. It checks idle startup before the fixture launches,
preserved ring history and the `replay_preserved=true` diagnostics across both
replacements, fresh decodable clips at the fixed output size, and one continuous
decodable recording file.

To reproduce recording lag under GPU starvation, build
`shard_gpu_stress_fixture` (Debug, `EXCLUDE_FROM_ALL`). It is a windowed D3D11
"game" that pins the 3D engine on a schedule: `SHARD_STRESS_PHASES` is
`seconds:level,...` (default `10:0,40:1,60:0`; level 1 = uncapped heavy pixel
shading), `SHARD_STRESS_ITERATIONS` tunes the load and phase changes are
printed as `PHASE <level> <unix-ms>`. Register it as a user game and capture it
in Game only mode; the core's `perf.stats` events and `[perf]`/`[perf-session]`
log lines show render lag, encoder backlog, GPU 3D/VideoEncode utilization and
the classified cause per second, and saved clips carry `lag` segments. The
pure attribution/backlog logic is covered by `shard_perf_tests` in the `core`
scope, which also runs `shard_priority_tests` (Recording priority setup
decisions, runtime manifest and swap recovery on temporary directories) and
`shard_save_queue_tests` (clip-save acceptance across concurrent ring
stop/restart).

To verify game swapping with real hooks, run `node scripts/game-swap-test.mjs`
with `CF_COREBIN` and `CF_GC_FIXTURE` pointing at matching builds. It registers
two copies of the D3D11 fixture with different aspect ratios, then checks that
a newly launched game and a 2-second alt-tab do not take over, that held focus
swaps after the 5-second debounce, that returning to an already-injected game
reacquires hook frames through the existing hook, and that the replay ring
keeps one decodable history across every swap. `CF_GC_SWAP_MODE=auto` starts on
the desktop and also checks the return to desktop capture after both games
close. The test steals focus for about a minute.

For changes to the core's process supervisor (Job Object ownership of the
capture core), `powershell -File scripts/test-process-supervisor.ps1` builds
`shard_process_supervisor_fixture` and checks normal exit, forced and
stdin-EOF termination, and fail-closed setup, including that no descendant
outlives the supervisor.

The release workflow calls the same `release` scope. Do not also perform a full
local release run when CI has verified the same changes. Hosted CI does not
test interactive capture, so use the capture scope when capture behavior changed.
OBS signatures/hashes, app/core versions, updater metadata, and installer
checksums remain release gates: they protect every shipped build, not just the
first one. See [Releasing](RELEASING.md) for publication and the initial real
installed-update acceptance test.
