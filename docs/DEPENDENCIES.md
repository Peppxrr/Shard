# Updating bundled dependencies

Shard updates replace the entire installed application, including `resources/core-bin`.
The end user's updater never fetches OBS, hooks, FFmpeg, or codecs independently.
Only a Shard release built with deliberately changed pins upgrades those components.
User settings, libraries, recordings, and clips live outside the installation.

## Choosing a new runtime

`runtime-dependencies.json` selects the OBS version, official hook payload directory,
OBS dependency bundle/DLL list, and the shared FFmpeg archive URL, SHA-256 and DLL list.
The OBS submodule and its official payload's `manifest.json` pin the exact OBS commit.
Both must match; changing a version string alone is intentionally insufficient.
The packaged runtime includes its selected pins for diagnosis.

1. Review the desired upstream OBS release. Move the OBS submodule to that exact
   release commit and rebase `patches/obs-game-capture.patch` on it. Do not discard
   the patch's runtime payload verification or rebuild the injected hook payload.
2. Extract the official OBS release's signed `graphics-hook*.dll` and
   `inject-helper*.exe` into a new `vendor/obs-hook-payload/<version>` directory.
   Add its manifest with upstream URL/archive digest, OBS commit, file SHA-256s,
   and verified signer/certificate thumbprints. Retain Shard's uniquely named
   Vulkan manifests and review any upstream manifest/ABI changes.
3. Update `runtime-dependencies.json` to the selected version and payload directory.
   Match its OBS dependency directory and DLL list to that OBS release's pinned
   `buildspec.json`. Review staging targets/plugin data and required-file gates
   if upstream renames or adds runtime components. libobs loads every module in
   `obs-plugins/64bit`, so `scripts/build.ps1` stages only the modules the core
   uses and `app/scripts/verify-core-bin.mjs` rejects any other module.
4. To change the editor/export FFmpeg, update its version, versioned URL, archive
   directory, SHA-256 and `runtimeDlls` together, then run `scripts/fetch-ffmpeg.ps1`.
   Use a *shared* build: `ffmpeg.exe` and `ffprobe.exe` then share one copy of the
   codec libraries. It is staged in `core-bin/ffmpeg`, apart from OBS's FFmpeg
   DLLs, and must provide the encoders the editor offers (`app/src/main/ffmpeg.ts`)
   plus dav1d for AV1 previews. The fetch verifies the archive before writing a
   provenance record; stale or missing provenance blocks packaging. No moving
   `latest` URLs are used. OBS's own FFmpeg CLI was evaluated as a replacement
   and rejected: it lacks dav1d, x265 and Quick Sync.
5. Run `scripts/build.ps1 -Clean` for an OBS/dependency upgrade to discard upstream
   incremental build data, then `npm --prefix app run verify -- release capture`.
   Exercise game hooks, subject switching and minimized capture when OBS changes.
   The ordinary release pipeline runs in CI; avoid duplicating an already passed
   CI release build of the same changes.
6. Commit the submodule reference, pins, reviewed patch, official payload/manifest,
   and applicable notices together. Publish them only as an explicitly approved
   Shard release.

Every staging run assembles a fresh sibling tree and verifies it before replacing
its previous stage, so removed DLLs cannot remain in `core-bin`. NSIS removes the
previous installation's application files when upgrading. Its per-user app ID and
cache name remain stable. Signed OBS payload hashes and the core/app version checks
remain mandatory; never configure signing that re-signs OBS's helper executables.

Electron, electron-updater and native Node modules are selected in `app/package.json`
and locked in `app/package-lock.json`. C++ helper libraries (JSON, WebSocket, x265,
NASM) remain pinned in `core/CMakeLists.txt`; OBS's transitive libraries are pinned
by the chosen OBS checkout. Upgrade these deliberately, review licenses/ABI changes,
and run the relevant verification scope before preparing a release.

## OBS build options

`core/CMakeLists.txt` builds libobs-d3d11 with `GPU_PRIORITY_VAL=7`, matching OBS release builds, so libobs raises its own GPU scheduling priority (see `docs/CAPTURE.md`, Recording priority). Keep this when upgrading OBS; check that `D3D11 GPU priority setup` still appears in the core log.
