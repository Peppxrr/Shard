# Shard repository guidance

Shard is a local-first Windows game clipper. A C++20 core embeds OBS/libobs for capture, replay buffering, recording, game detection, and a local JSON-RPC WebSocket server. An Electron + React/TypeScript app owns the UI, library, editor/export workflow, settings, hotkeys, themes, and updater.

Keep this file small. It contains rules that apply to nearly every task. Read the task-specific docs below only when the work touches that area.

## Source of truth

Current code and canonical repository docs outrank stale prose. If this file or a task-specific note disagrees with the implementation, inspect the current code before preserving old behavior, and update the stale guidance when appropriate.

The cross-language settings/RPC/event contract is `app/src/shared/contracts.ts`; corresponding C++ config and JSON-RPC handling must stay in sync.

## Read only when relevant

- General architecture or unfamiliar subsystem: `docs/ARCHITECTURE.md`
- Capture, OBS lifecycle, replay ring, recording, Game Capture, WGC: `docs/CAPTURE.md`
- Verification scope and diagnostics: `docs/VERIFYING.md`
- Themes or public UI hooks: `docs/THEME-API.md` and, for theme authoring, `docs/THEMES.md`
- Packaging, updater, versions, tags, or publication: `docs/RELEASING.md`
- OBS/FFmpeg/runtime dependency upgrades: `docs/DEPENDENCIES.md`
- Contributor workflow and security expectations: `CONTRIBUTING.md`

Do not preload all of these documents for unrelated work.

## Repository map

- `core/src/` — C++ core: OBS lifecycle, sources, encoders, replay ring, recording, game detection, JSON-RPC/server.
- `core/tests/` — native logic/capture-resilience tests and fixtures.
- `app/src/main/` — Electron main process: core lifecycle, IPC, library, export, hotkeys, themes, diagnostics, updater.
- `app/src/renderer/` — React UI, library/viewer/editor/settings/games surfaces.
- `app/src/shared/` — shared TypeScript contracts and theme types.
- `scripts/` — build, dev, verification, capture fixtures, dependency helpers.
- `patches/` — reproducible Shard changes to pinned OBS source.
- `vendor/obs-studio/` — pinned OBS submodule.
- `vendor/obs-hook-payload/` — verified official signed OBS injection payload.

## Non-negotiable invariants

- Keep `PORT <n>` as the core server's first normal stdout protocol line. Put diagnostics on stderr.
- Never rebuild, modify, or re-sign the official `graphics-hook*.dll` / `inject-helper*.exe` payload merely to make Game Capture work. Preserve the hash/signature gates and anti-cheat compatibility model.
- Preserve the single cross-language contract in `app/src/shared/contracts.ts`; change the C++ side in the same task when the contract changes.
- Preserve existing public theme hooks and document new themed regions/states/tokens in `docs/THEME-API.md`.
- Do not weaken integrity/security checks just to pass a build or test.
- Do not commit generated runtimes, release artifacts, fetched dependencies, temp logs, or private diagnostics.

For native capture/OBS work, the additional invariants in `docs/CAPTURE.md` are mandatory.

## UI work

Changed public UI must look intentional, not placeholder-quality. Reuse Shard's existing components, typography, spacing, tokens, icons, focus/interaction patterns, and loading/empty/error/disabled states.

New or redesigned themeable regions must expose a meaningful `data-shard-page`, `data-shard-component`, or `data-shard-slot` hook and use the public Theme API rather than DOM-depth selectors or undocumented implementation classes. Run the `themes` verification scope alongside other relevant scopes when theme-facing behavior changes.

## Code conventions

- C++: C++20, flat `shard::` namespace, RAII, mutexes for shared mutable state, atomics for simple cross-thread flags, style consistent with neighboring files.
- TypeScript/React: follow neighboring style; Electron main remains CommonJS while the renderer is bundled as ESM by Vite.
- Keep Windows-specific native code behind the existing platform boundaries; avoid spreading platform assumptions into otherwise portable code.
- Prefer focused fixes over unrelated refactors or formatting churn.

## Verification

Run the smallest relevant verification scope once after the final relevant edit:

```powershell
npm --prefix app run verify -- <scope>
```

Available scopes are `app`, `editor`, `storage`, `updater`, `themes`, `diagnostics`, `core`, `capture`, and `release`. Scopes may be combined when the change genuinely spans them. `app` is the default.

Use `docs/VERIFYING.md` to choose scopes. Documentation-only changes need diff inspection, not a build. Do not repeat a successful expensive check unless later edits affect what it covered, a check failed, or new evidence requires it. Do not run `release` for ordinary work.

## Change and release discipline

Keep ordinary work local unless the user explicitly asks for git publication actions. Do not automatically commit, push, merge, tag, create a release, or bump a version.

`app/package.json` is the application/core SemVer source. Release procedure, CI gates, updater requirements, and artifact rules live in `docs/RELEASING.md`; do not duplicate them here.

`changelog.txt` is an optional maintainer-local working record and remains ignored. If it exists in a maintainer checkout, append completed user-visible fixes/features when requested by the maintainer workflow. Never publish or stage it. Public release notes belong in `CHANGELOG.md` only during an explicitly requested release.

## Working style for agents

Search narrowly before reading large files. Reuse findings instead of repeating repository-wide exploration. When a task is already localized, inspect the relevant code directly rather than producing a broad repository summary.

Use a unique temporary directory for each test or UI preview and clean up its generated profiles, builds, and media after success, including ad hoc checks. Stop owned helper processes before cleanup. Retain only useful failure diagnostics or explicitly requested artifacts; keep original-file backups separate from disposable fixtures. Never broadly delete `tmp`: verify the exact owned path and preserve unrelated work.

If an existing test or comment appears to encode behavior that conflicts with current source, investigate the disagreement instead of blindly preserving either side. Report the concrete files changed, the verification scope run, and any actual blocker.
