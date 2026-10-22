# Linux (Wayland) port

Status: test foundation. The UI, library, editor/export, game detection and
capture run on Fedora KDE Plasma 6 (Wayland). X11 sessions are not supported.
Windows behavior is unchanged by the port.

## How the code is split

```text
core/src/                         platform-neutral core (capture model, recovery, replay, detection rules, RPC)
core/src/platform/platform.h      process entry, libobs display/modules/graphics, monitors, system info
core/src/platform/window_system.h top-level windows + foreground process
core/src/platform/capture_backend.h  OBS source ids/settings, target windows, displays, system events, audio
core/src/platform/windows/        Win32/DXGI/WGC/WASAPI/WMI implementations (moved, not rewritten)
core/src/platform/linux/          Wayland/PipeWire//proc/KWin implementations
```

`core/CMakeLists.txt` compiles exactly one platform directory
(`src/platform/<os>/*_<os>.cpp`). Shared files must not include OS headers;
when a shared component needs something new from the OS, extend the relevant
header in `core/src/platform/` and implement it for both platforms. Some
classes (`ProcessMonitor`, `GpuEngineMonitor`, `LauncherDiscovery::defaults`)
keep one declaration with their OS-specific members defined in the platform
file.

## Build and run

Fedora with [RPM Fusion](https://rpmfusion.org/Configuration) (free) enabled:

```bash
git clone --recurse-submodules https://github.com/Peppxrr/Shard.git && cd Shard
sudo bash scripts/linux/install-deps-fedora.sh
bash scripts/linux/build.sh               # Release core -> app/resources/core-bin
cd app && npm ci && npm run package:linux # app/release/Shard-<version>-x86_64.AppImage
```

Development: `bash scripts/linux/build.sh --config Debug` stages
`app/resources/core-bin-dev`, then `node scripts/dev.mjs`.
`npm --prefix app run verify -- core` runs the Linux build plus the native
tests; the Windows-only capture E2E and `release` scope are not available on
Linux. `.github/workflows/linux.yml` builds the core, runs the native tests and
uploads an unsigned AppImage on a Fedora container. For `v*` tags it also
attaches the AppImage and a `.sha256` checksum to the GitHub release once the
Windows release is published (see [Releasing](RELEASING.md)). The AppImage
does not update itself; download the newer one from the release page.

libobs and its plugins link the system FFmpeg/x264, so the runtime is not yet
portable to other distributions. The editor/export tools use
`core-bin/ffmpeg/ffmpeg` when bundled, otherwise `ffmpeg`/`ffprobe` from `PATH`
(RPM Fusion's full build is recommended).

## Capture

| Subject | Backend |
| --- | --- |
| Desktop | monitor-only `pipewire-desktop-capture-source` through xdg-desktop-portal ScreenCast (`pipewire-screen-capture-source` when the former is not registered) |
| Game, preferred | `vkcapture-source` from obs-vkcapture (in-game Vulkan layer / OpenGL preload) |
| Game, fallback | the same desktop screencast, cropped to the game window when it is windowed |

- **First start shows the portal picker.** Choose the monitor to record (the
  picker offers screens only: a window chosen in the combined picker can never
  be restored). The portal's restore token is saved in `<userData>/core/linux-capture.json`
  (`~/.config/Shard/core/` for the AppImage), so later starts and source
  rebuilds are silent. Changing the configured monitor asks again.
- **Game capture needs opt-in per game.** At startup the core copies the
  vkcapture layer to `~/.local/share/shard/vkcapture/` and registers
  `~/.local/share/vulkan/implicit_layer.d/shard_obs_vkcapture_64.json`. The
  layer stays dormant unless the game runs with `OBS_VKCAPTURE=1`; for Steam
  (including Proton/DXVK games such as VRChat) set the launch option
  `OBS_VKCAPTURE=1 %command%`. Native OpenGL games need the OpenGL capture
  library preloaded as well (upstream's `obs-gamecapture` wrapper does this):
  `LD_PRELOAD=$HOME/.local/share/shard/vkcapture/libobs_glcapture.so`. Games
  inside Flatpak sandboxes (Flatpak Minecraft launchers) cannot see the layer
  and use the desktop fallback. If a distribution `obs-vkcapture` package is
  installed, its system layer is used instead of registering a second one.
- Only one process can host the vkcapture server socket: OBS Studio with its
  own obs-vkcapture plugin running at the same time takes game capture away
  from Shard (the core logs `Cannot bind unix socket`).
- When a game runs without the layer or OpenGL library loaded, the fallback
  records the screen area of the game window, including anything drawn over
  it. The core reports this as `capture.method {method:
  "pipewire_desktop_window", reason: "vkcapture_not_enabled"}` (checked in
  `/proc/<pid>/maps`); every method/reason change is sent as a
  `capture.method` event.
- Recreating the vkcapture source does not reconnect a game, so hook recovery
  re-targets instead of recreating (`capture::hookRecreationResets()`), and the
  window fallback is not retried separately because it aliases the desktop.
- HDR/advanced-color display diagnostics report `unknown`.

## Game detection

- Processes come from a `/proc` snapshot every tick (no unprivileged process
  event source exists). Wine/Proton processes are reported under their Windows
  executable name and path, so Steam metadata and user mappings match them.
  Runtime evidence comes from `/proc/<pid>/maps` (Proton maps the game's DLLs).
- Steam libraries are read from `~/.local/share/Steam`, `~/.steam/steam` or the
  Flatpak Steam home. Registry-based launchers (GOG Galaxy, Ubisoft, EA,
  Battle.net, Microsoft Store) have no Linux equivalent.
- Windows, focus and geometry come from a generated KWin script that reports to
  the core over the session D-Bus (`platform/linux/window_system_linux.cpp`).
  On other compositors window information is unavailable: detection then relies
  on identity evidence (user mappings, launcher metadata, engine runtimes,
  Minecraft's Java entry point), focus-driven game switching is inactive, and
  the window fallback is uncropped.

## Audio and encoding

- Desktop and microphone rows use `pulse_output_capture`/`pulse_input_capture`
  served by PipeWire. Per-application audio and Desktop isolation are not
  available yet.
- Encoders: x264, x265, NVENC and VA-API (`*_vaapi_tex`). libobs renders with
  OpenGL on the compositor's GPU; on hybrid laptops where that is the iGPU,
  NVENC works through system-memory frames (`zero_copy=false`). Fedora's free
  Intel media driver exposes only AV1 encode; H.264/HEVC VA-API needs RPM
  Fusion's `intel-media-driver`.

## App behavior

- Global hotkeys (uiohook cannot observe Wayland input): after every core
  (re)connect and settings change the app sends the full set to the core
  (`hotkeys.bind`), which registers it with KDE's kglobalaccel as component
  `com.shard.app` (visible and editable in System Settings → Shortcuts) and
  reports presses as `hotkey.pressed` events. Defaults are F8/F9/F10 as on
  Windows. While the shortcut editor listens for keys the set is unbound.
  Without kglobalaccel (non-KDE desktops) the app falls back to Electron's
  XDG GlobalShortcuts portal path; Electron 43 (electron/electron#52223) maps
  F-keys and shortcuts without Ctrl/Alt to one portal id there, so those are
  rejected with a message. The portal needs the installed
  `com.shard.app.desktop` entry (AppImage desktop integration).
- The clip overlay cannot place or raise itself on Wayland. On KDE the app
  keeps a KWin window rule (`[shard-clip-overlay]` in `~/.config/kwinrulesrc`,
  matched on the exact title "Shard clip overlay"): on-screen-display type
  (above fullscreen windows), top-left of the primary work area, borderless,
  unfocusable, not in taskbar/pager/switcher. Other rules are left alone and
  KWin reloads only when the rule changes.
- Settings → Capture → "Game capture for all Vulkan/Proton games" writes
  `~/.config/environment.d/90-shard-vkcapture.conf` (`OBS_VKCAPTURE=1`),
  effective for games started after the next login. The Capture page explains
  the screencast fallback while `capture.method` is `pipewire_desktop_window`.
- "Launch at login" writes `~/.config/autostart/shard.desktop`.
- Not available on Linux: Recording priority, in-app updates, GPU engine
  utilization counters.

## Known gaps

- Portal picker on first run is a manual step; game capture needs the
  Settings switch plus a new login, or a per-game `OBS_VKCAPTURE=1` launch option.
- Self-contained runtime (bundled FFmpeg and libraries) for non-Fedora systems.
- Per-application audio (PipeWire node capture) and Desktop isolation.
- Window information on GNOME and other compositors.
- Hotkeys on non-KDE desktops are limited by the Electron portal bug above.
- Game and App audio artwork (`app/src/main/app-icons.ts`) comes from Steam's
  library icon cache and installed `.desktop` entries (PNG or SVG from the
  hicolor theme or pixmaps). Electron cannot extract icons from executables
  on Linux, so a game with neither shows the generic icon; the user's active
  icon theme is not searched.
