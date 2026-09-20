# Changelog

## 0.1.5

- Added a more powerful CSS theme API with stable page, component, and state hooks, plus styling controls for the editor, timeline, waveforms, icons, and overlays.
- Added optional theme manifests and customizable colors, toggles, sliders, and dropdowns, with settings saved separately for each theme.
- Themes now appear automatically when CSS files or theme folders are added. Saved CSS, font, image, and manifest changes reload without pressing Reload; failed loads keep the last working theme visible.
- Made local theme assets and CSS imports work consistently in development and installed builds, and prevented slow theme loads from overwriting a newer selection.
- Added a complete theme authoring guide, API reference, JSON schema, and the downloadable Afterglow example in the repository. Afterglow is not bundled with the app.
- Improved updates with startup and periodic checks, dismissible notifications, download progress, and a choice to install immediately or on the next launch.
- Made immediate updates install silently and added progress during deferred startup installation, with better recovery from missing downloads, damaged caches, or failed installer launches.
- Improved differential-update cache preservation and cleanup so compatible installed releases can download only changed data, with a verified full-download fallback when needed.
- Added persistent update/install diagnostics and Developer Console filtering, search, pause, and copy controls.
- Improved capture shutdown before updates and runtime replacement so failed dependency preparation preserves the previous usable runtime and successful upgrades remove obsolete files.

## 0.1.4

- Fixed replay timestamp handling that could cause uneven playback, preserving frame order and clean clip endings.
- Prevented replay-buffer stalls under tight memory limits and during capture restarts.
- Reduced capture interruptions caused by filesystem work while saving clips.
- Made export sizes depend on video quality and content instead of trying to fill the entire size limit. The selected size remains a hard maximum.
- Preserved the source frame rate during exports and avoided blocking the app while checking exported files.
- Improved playback diagnostics for short clips and paused playback, and clarified that measured playback FPS differs from the file's encoded frame rate.

## 0.1.3

- Made the playback timeline smoother and added brief play/pause feedback.
- Improved capture recovery after display wake and graphics resets, and kept retrying unavailable game hooks.
- Added “Copy playback diagnostics” to the player’s right-click menu to help investigate playback problems without sharing clip paths or contents.
- Added manual update checks in Settings → App, with release notes, download progress, and an explicit restart to install for installed Windows builds.
- Portable builds can check for updates and open the GitHub release for a safe manual replacement.
- Standardized version numbers and added a verified GitHub Releases build pipeline. Existing users must install this version manually once to receive the new updater.

## 0.1.2.1

- Refreshed the interface, settings, hotkeys, and Games page with consistent controls and icons.
- Expanded the clip library and recent clips; edited clips now have one clear blue badge.
- Made editor previews load progressively and reuse cached thumbnails.
- Fixed seeking after zoom, audio controls moving the playhead, and playback jitter. Added Ctrl+scroll zoom and finer timeline markings.
- Improved game detection across monitors and stopped Unity avatar projects from being detected as games.
- Made replay clips match the requested duration and stop at the save request.
- Improved NVIDIA, AMD, and Intel encoder detection and CPU fallback for capture and export.
- Enforced export size limits and corrected storage accounting for protected clips.
- Updated Shard naming, documentation, and source-build setup.

## 0.1.2

- Fixed live audio toggles and replay-buffer recovery for minimized games.
- Improved capture notifications, storage-folder selection, and interface sizing.

## 0.1.0

- Initial Windows release with replay capture, recording, a clip library, editing, and exports.
