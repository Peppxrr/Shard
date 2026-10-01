# Capture and OBS invariants

Read this before changing OBS startup, source creation/ordering, Game Capture/WGC behavior, replay/recording encoders, muxing, capture recovery, or native capture tests.

These notes describe constraints that are easy to break while making a locally reasonable change. Current source remains authoritative when implementation details evolve.

## OBS initialization and scene output

WGC capability in the OBS win-capture module depends on the active graphics device at module-load time. Shard must establish its D3D11 video context before loading OBS modules. Reordering startup so modules load before graphics initialization can silently fall back to a capture path that is black for GPU-rendered windows.

The main scene must be connected to the primary OBS output view with `obs_set_output_source(0, obs_scene_get_source(scene))`. Without that connection the video mix is empty, producing black video and preventing scene audio sources from becoming active. Clear the output source before releasing the scene during shutdown.

Shard explicitly adds the libobs data path. Do not add duplicate module paths simply because a plugin is not found; the staged working-directory/layout and OBS's default module paths are intentional. Diagnose the actual staging or startup-order problem first.

Process DPI awareness is established before OBS/window capture setup so Win32 client geometry and WGC physical-pixel surfaces agree on scaled monitors.

On Windows, startup enumerates DXGI adapters and selects a D3D11-capable hardware adapter using Windows' high-performance preference. Its LUID is mapped back to the normal `EnumAdapters1` index required by OBS; preference-list indices must never be passed directly to OBS. Software adapters are excluded. Older DXGI implementations fall back to the hardware adapter with the most dedicated memory, independent of vendor. All adapters and the actual selected index/name/vendor/LUID are logged. Selection is fixed for the graphics-device lifetime: `obs_reset_video` rebuilds the video mix while retaining the device. There is currently no user adapter override.

## Capture sources

Desktop capture uses OBS `monitor_capture` with WGC selected and resolves the configured monitor to the device identifier expected by the modern monitor source.

Game capture keeps two backends alive:

- `game_capture`, using the official signed OBS graphics-hook/injection payload, is the preferred backend when healthy;
- `window_capture` using WGC remains available as the fallback.

Scene ordering currently places the WGC window source below the Game Capture source, so healthy hook frames cover the fallback. Recovery logic can promote WGC when the hook is present but not producing usable frames, while leaving both sources alive so the hook can recover.

WGC keeps the complete window surface. Client-area cleanup is applied through validated scene-item geometry/cropping instead of configuring the source so bad Win32 geometry can suppress the entire capture.

Video geometry uses the validated WGC client extent before its small caption-boundary inset. That inset remains display cleanup; it must not manufacture a new aspect ratio/output format when transitioning between WGC and the hook.

Do not replace the signed hook/helper payload with locally rebuilt or re-signed binaries. Shard's build verifies the official payload hashes/signatures against the pinned OBS release and applies its source changes separately through `patches/obs-game-capture.patch`.

## Capture subject and game sessions

Game detection and capture selection are separate responsibilities.

A game session may contain multiple related PIDs, including helpers. Session probing examines the available PIDs/windows and can move representation toward the PID that owns the useful game window. Avoid assuming the process that launched first is necessarily the capture target.

Focus-driven primary selection lives in `GameSystem::applyFocusPrimary`. `GameSystem::updateCaptureSubject` should only propagate the already-selected primary into `SourceManager`. Do not introduce a second competing primary-selection algorithm inside capture code.

Focusing a normal non-game window does not by itself end the game session or force the primary away from the running game. Sessions are tied to process/session lifetime rather than only to foreground focus.

## Recovery/watchdog

`SourceManager` owns capture health and recovery. It samples actual rendered capture state and handles source retry/recreation around no-frame conditions, display/power transitions, and graphics-device loss. Keep potentially blocking source teardown/update work off the OBS graphics callback.

When changing recovery behavior, preserve the distinction between:

- target/session still exists but a backend is temporarily unhealthy;
- target metadata/window geometry changed and sources need retargeting;
- target/session actually ended.

Use the existing capture-resilience logic/tests instead of accumulating unrelated timing checks directly in the watchdog.

Source existence and nonzero dimensions establish readiness, not health. Independent 64x36 interior samples at 2 Hz observe hook, WGC (or desktop monitor), and the actual main composed texture after rendering. Each successful map records content, a fingerprint from the same pixels, observation age, and time since fingerprint change. Failed maps/staging and skipped callbacks do not refresh observation timestamps. Observations older than 2.5 seconds are degraded/unknown. A scheduling gap discards pending samples and resets sustained failure evidence. Graphics callbacks only sample with `try_lock`; teardown/recreation stays on the watchdog.

Black hook versus content WGC still rejects the hook after three seconds. A content-bearing hook unchanged for at least 30 seconds is also rejected when WGC has sustained movement evidence for five seconds (at least three changes spanning two seconds). Frozen rejection requires a subsequent hook change and two seconds of content before restoring preference. Both static content sources remain healthy; their unchanged fingerprints alone never initiate recovery. Minimized games and sleeping displays suspend failure escalation.

Movement evidence requires at least 5% of the sampled interior pixels to change by eight RGB levels, excluding cursor-sized motion and small noise from proving a frozen hook. Any fingerprint change is still reported diagnostically. An absent, stale, or persistently unknown hook probe yields to verified content WGC after 15 seconds of continuous disagreement, including sources that have dimensions but have never supplied mapped pixels.

After frozen-hook takeover, a now-static WGC menu does not cause repeated hook destruction: WGC stays selected, and frozen-hook recreation resumes only with changing comparison content. The hook can still restore preference by demonstrating its own recovery.

For a live non-minimized target, persistently black/unknown/stale paths first get a target settings retry after 120 seconds, then hook recreation after another 30 seconds, WGC recreation after 30 more seconds, and video-source rebuild after 60 more seconds. Desktop capture shares the policy with retry then video-source rebuild. Source-only actions preserve audio and encoded-output continuity. Successful source and composed-content observations clear escalation; source rebuilds do not erase failure progress, and action cooldowns survive evidence resets. Fresh both-black output may retry later but never warrants a video reset by itself.

Healthy source content with black/unknown/stale composed output targets the downstream path: rebind the scene, visibility, ordering and transforms after 15 seconds, without reinjecting healthy sources. Persistent downstream failure can request a video-mix reset after 120 seconds. An otherwise unusable capture can request that reset only after at least 300 seconds with stale composed observations and exhausted source recovery. Hard resets are limited to one per five minutes and run on the RPC/main lifecycle thread using the existing recorder/replay stop/reset/restart sequence. This can finalize a recording segment and clear replay history. It resets the OBS video mix, not the D3D11 device; actual device-loss rebuilds remain OBS's existing driver recovery path, with wake/reset source recovery coalesced to avoid duplicate loops.

Every automatic retry/recreation/escalation emits a pre-action `capture-recovery` snapshot with reason, action/level, previous backend, PID/HWND, dimensions, classifications, fingerprint-change/probe ages, retry counts, and time since previous recovery. Routine `capture-health` snapshots remain bounded by state changes and ten-second heartbeats.

## Encoded output media wiring

Replay and recording use encoded OBS outputs. Wire encoders directly to the global media objects with `obs_encoder_set_video(..., obs_get_video())` and `obs_encoder_set_audio(..., obs_get_audio())`. Do not switch these encoded outputs to `obs_output_set_media`; that is not the supported wiring for this path.

Multi-source audio depends on separate OBS mixes and one audio encoder per used mix. The replay output must retain `OBS_OUTPUT_MULTI_TRACK`; otherwise only the first track survives.

## Replay ring

The RAM ring retains encoded packets and purges on both time and byte caps while preserving decodable keyframe boundaries. It intentionally retains extra decode preroll beyond the user-visible history so an exact requested interval still has a preceding keyframe.

AV1 keyframe handling is special: the ring parses AV1 OBUs because relying only on the encoder packet keyframe flag is insufficient for the supported NVENC path.

On restart, the save worker's run flag must be re-armed before the save thread starts. Be cautious when modifying output lifecycle or restart behavior; a ring can appear active while saves silently stop if worker lifecycle is broken.

Game-only startup waits for a capture subject instead of briefly buffering empty video. Once a ring starts, initial source acquisition and later target/window transitions share the 15-second inactivity grace; a skipped readiness signal must not immediately discard newly buffered packets.

Stable source geometry uses live scene transforms when its aspect ratio and effective encoded dimensions/FPS match the current video path. For example, a 2560x1440 game with custom 1920x1080 output can fill the existing 1920x1080 canvas without resetting OBS, clearing replay history, or splitting recording. Native output-size, aspect-ratio or FPS changes still require a video reset and a new recording segment. The 1.5-second source-size stability gate remains in place. `capture-geometry` logs distinguish preserved history from a necessary format boundary, while `replay-ring` logs a sustained inactivity stop. The displayed counter reflects retained encoded packets, not an independent timer.

Clip snapshots keep a preceding video keyframe as decode-only negative-timestamp preroll, normalize packet timestamps in their stream timebases, and mux with an MP4 edit list so presentation still begins at the requested interval.

## Recording and muxing

Recorder output uses fragmented MP4 (`frag_keyframe+empty_moov`) so an interrupted recording is substantially safer and does not require a normal final remux step.

Replay saves pipe encoded packets to OBS's `obs-ffmpeg-mux` helper. `ffm_packet_info` is the wire-format struct from the OBS mux helper interface; do not casually change its layout or serialization assumptions.

`obs-ffmpeg-mux.exe` is a staged runtime dependency. Treat a missing helper as a build/staging problem, not as a reason to rewrite the capture pipeline.

## Diagnostics and verification

Normal protocol output must not be polluted with debug logging. The core announces `PORT <n>` on stdout; capture/diagnostic logging belongs on stderr.

For capture/replay/source/encoder changes, run the `capture` verification scope unless `docs/VERIFYING.md` says a narrower core-only check is sufficient for the exact change. The capture scope already includes the required native build/tests and E2E content checks; do not automatically stack old selftest/E2E rituals on top of it.

Changes to the OBS/runtime dependency pins or packaging gates follow `docs/DEPENDENCIES.md` and may require release verification as described there.
