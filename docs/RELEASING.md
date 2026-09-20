# Releasing Shard

## Versions and first rollout

`app/package.json` is the version source. Use stable SemVer `major.minor.patch`
(for example `0.1.3`, then `0.1.4`). `npm version` updates the lockfile;
CMake reads the same version for the core. Electron-builder derives Windows
file versions as `major.minor.patch.0`. Displayed versions, artifact names,
`latest.yml`, and Git tags (`v<version>`) all use the three-part version.
Do not use four-part tags or `+metadata` for updates: SemVer ignores build
metadata when comparing releases. Stable releases only are supported today.

`0.1.3` is the first version with the updater. Existing `0.1.2.1` users must
download and run its installer once. Keep the existing app ID/product name and
NSIS installation identity: settings, library, and clips remain in place.
Do not retag or replace the historic release or invent metadata for it.

## Publish

1. Finish changes and run the relevant scope in [Verification](VERIFYING.md).
   Use capture/game-specific QA only when those behaviors changed. Hosted
   runners do not provide reliable interactive WGC/game capture.
2. From `app`, run `npm version patch --no-git-tag-version` (or an explicit
   version). For the first rollout, `0.1.3` is already set; do not bump it again
   unless another release has taken that number.
3. Add a `## <version>` section to `CHANGELOG.md`, with clean user-facing
   notes. The local `changelog.txt` remains ignored and must never be published.
4. Commit the release changes, then create and push the matching tag after
   pushing the commit. CI performs the full release gate; the local release
   command below is an alternative, not an additional required run:

   ```powershell
   git tag v0.1.3
   git push origin main
   git push origin v0.1.3
   ```

5. The **Release Windows** workflow checks out recursive OBS submodules,
   rebuilds native Electron dependencies and the C++/OBS runtime, verifies the
   official OBS payload signatures/hashes, runs core and JS tests, then runs
   the normal packaging gate. It verifies packaged bytes and metadata before
   generating checksums. A separate publish job creates a draft, uploads all
   assets, and only then makes it the latest public release.

Expected public assets (keep the exact generated names):

- `Shard-Setup-<version>.exe`
- `Shard-Setup-<version>.exe.blockmap`
- `Shard-<version>-portable.exe`
- `latest.yml` (references the NSIS installer, never the portable EXE)
- `SHA256SUMS.txt` (covers both EXEs, the blockmap, and metadata)

The workflow uses the normal `GITHUB_TOKEN` with `contents: write` only in
the publish job. Enable Actions and allow that permission in repository/org
policy. No personal token or signing secret is required. Protect release tags
and restrict who can push them. A manual workflow dispatch builds downloadable
Actions artifacts without publishing when run on a branch; dispatching a
version tag follows the same publish rules as a tag push.

A failed upload leaves a draft that can be completed by rerunning the job.
A rerun refuses to overwrite a public release. Fix a published build by
incrementing its version. Do not mark an older version as latest. Do not remove
the installer or metadata of a release clients may still be downloading.

## Local verification without publication

```powershell
npm --prefix app run verify -- release
```

`npm run package` always passes `--publish never`; CI publishes only after
verification. `node scripts/release.mjs validate v0.1.3` checks the proposed tag.
The wrapper runs each build/test once and saves full logs under `tmp/verify/`.
Install dependencies with `npm ci --prefix app` when setting up the checkout
or after dependency changes; do not reinstall them for every verification run.
The artifact gate checks SHA-512 against `latest.yml`, inspects `app.asar` and
the embedded `app-update.yml`, and reruns the core payload gate on the packaged
runtime, including the core's Windows version resource. The FFmpeg fetch uses a versioned upstream full-build archive and a
fixed SHA-256; update both together when changing dependencies. It never
trusts a moving `latest` download or bypasses a checksum mismatch.

Updater tests include isolated state/lifecycle tests and the actual NSIS
updater against a localhost YAML feed: version precedence, download opt-in,
missing metadata, checksum rejection, and disabled install-on-quit. They
never execute an installer or publish a release.

## User experience and end-to-end acceptance

Settings → App → Updates checks at startup and every 12 hours; downloads still
require an explicit click. A dismissible status-bar notice opens the update panel.
Dismissal persists for that version without hiding future versions. Release notes,
version, transferred bytes, speed and progress remain visible in the panel.

**Update & restart** stops capture and starts NSIS silently, then opens the updated
app. **Install on next launch** saves the choice without installing during exit or
Windows shutdown. On the next launch, a compact progress window appears before
capture starts. Shard rechecks GitHub metadata and verifies the cached installer
before installing. Offline/slow metadata checks return to normal startup within
12 seconds and retain the choice. Missing/corrupt cached files require a fresh
user-requested download. An interrupted installation does not trigger an endless
automatic retry loop. Save editor work before requesting an immediate restart.

The installed updater keeps `%LOCALAPPDATA%/shard-updater/installer.exe` and its
matching `current.blockmap` as the next differential baseline. Successful-install
confirmation removes pending installers and temporary download files. A protected
copy of the old block map survives interrupted downloads. A full installer is a
fallback when the old bytes differ, the cache is unavailable, or range download or
verification fails. Local and CI installers of the *same version* are not identical:
install the published artifact when testing a published differential update.

Update/install diagnostics are in `%APPDATA%/Shard/logs/updates.log`, with one rotated
backup and a 2 MB limit per file. Developer Console → **Updates** filters the live
and startup history; text search, pause/resume and copying filtered messages are
available. Signed download query strings are omitted from persistent logs.

Portable and extracted `win-unpacked` builds check release metadata but only offer
**View GitHub release**. Development builds disable updates. The installer is a
branded one-click per-user installer; updates use its silent mode. Bundled runtime
upgrades are owner-controlled; see [Updating dependencies](DEPENDENCIES.md).

For changes to installer/signing/update lifecycle, verify on an isolated Windows
account or test installation using two increasing versions:

1. Install the earlier version; keep representative settings and a clip.
2. Start it and inspect the startup notice, notes, dismissal, and download progress.
3. Update immediately with close-to-tray enabled. Confirm no installer wizard,
   app/core shutdown, relaunch at the new version, and preserved user data.
4. Repeat with **Install on next launch**. Exit normally (no installation), then
   launch again and confirm the progress window and automatic completion.
5. Repeat deferred startup offline, with a missing/corrupt download, and after
   interrupted installation. Confirm normal startup/retry instead of a loop.
6. Confirm only the current installer/block map remain after successful cleanup;
   verify differential reconstruction against the published baseline, SHA-512
   rejection of corrupted bytes, portable behavior, and installer fallback logs.

## Signing

Shard is currently unsigned. `win.signExecutable: false` makes that explicit;
no certificates or publisher identity are fabricated. Unsigned updates have
HTTPS plus manifest SHA-512 integrity, not Authenticode publisher identity.
Windows may show SmartScreen warnings.

Before adding signing, configure a real signing provider and a selective
electron-builder signing callback/exclusion policy that signs **only Shard's**
executables/installers. Never re-sign official OBS `inject-helper*.exe` or
`graphics-hook*.dll`. Keep the post-package pinned-hash gate and upstream
signature checks. Then enable signing, set the actual publisher identity for
electron-updater verification, and test signed-to-signed upgrades on a VM.
Do not simply add a certificate to the current configuration or disable update
signature verification to work around an identity mismatch.

References: [electron-builder v26 updater documentation](https://www.electron.build/v26/docs/features/auto-update/)
and [GitHub workflow token permissions](https://docs.github.com/en/actions/tutorials/authenticate-with-github_token).
