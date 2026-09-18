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

Settings → App → Updates shows the installed version. Nothing is checked,
downloaded, or installed at startup. Users choose **Check for updates**, then
**Download update**, then **Restart & update**. Closing normally after a
download does not install it. A later session must check/download again; the
updater may reuse a verified cached download. Release notes are plain text.
Downloads use electron-updater's GitHub provider and SHA-512 validation.

Portable and extracted `win-unpacked` builds check the same release metadata
but only offer **Open GitHub release**. Download the new portable EXE, close
Shard, and replace the old EXE manually. They never download or launch an
installer from the updater. Development builds show updating as disabled.

This acceptance checklist is for initial updater rollout and subsequent changes
to installer/signing/update lifecycle, not every routine app edit or release.
After publishing `0.1.3`, verify **up to date** from the installed build. A full
production update test requires a subsequent higher, real release (for example
`0.1.4`) with generated metadata:

1. Install `0.1.3` on a test Windows account/VM; create settings and a clip.
2. Publish the higher release with this workflow.
3. Launch `0.1.3`: no network check should occur until the button is clicked.
4. Check, inspect notes/version, download, and verify progress and ready state.
5. Quit normally: it must not install. Reopen, check/download again, then use
   **Restart & update**, with close-to-tray enabled. Stop recording/export first.
6. Confirm the old app/core exit, NSIS runs, Shard restarts at the new version,
   and settings, custom clip locations, library entries, and playback survive.
7. Check the portable build: a newer release opens on GitHub and the running
   EXE is never overwritten. Test offline/retry and low-disk-space behavior.

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
