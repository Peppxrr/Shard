# Changelog

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
