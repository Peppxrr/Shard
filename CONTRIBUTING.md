# Contributing to Shard

Thanks for contributing to Shard.

Shard is an early-stage Windows game clipping application. Bug fixes, diagnostics, documentation improvements, compatibility fixes, tests, and focused UI improvements are welcome.

## Contribution workflow

1. Fork the repository or create a feature branch if you have collaborator access.
2. Create a focused branch for one change.
3. Make and test your changes.
4. Open a pull request against `main`.
5. Explain what changed, why it changed, and how you tested it.
6. Address review feedback before merge.

All changes to `main` are intended to go through pull-request review. Repository maintainers make the final merge decision.

## Keep changes focused

Please avoid mixing unrelated refactors, formatting changes, dependency updates, and feature work into the same pull request. Smaller pull requests are easier to review and safer to merge.

For bug fixes, include enough information to reproduce the issue when practical, such as:

- Windows version
- GPU and driver version
- affected game or application
- relevant Shard logs
- expected behavior
- actual behavior

Do not include private data, authentication credentials, personal recordings, API keys, signing certificates, or other secrets in issues, logs, commits, or pull requests.

## Building and testing

Follow the build instructions in `README.md`.

Depending on the area changed, useful verification includes:

```powershell
powershell -File scripts/build.ps1 -Config Debug
powershell -File scripts/e2e.ps1
cmake --build build_x64 --config Debug --target shard_tests --parallel
build_x64\Debug\shard_tests.exe
node scripts/game-capture-test.mjs
```

Not every change requires every test. In your pull request, state which checks you ran and whether any relevant checks were not run.

## Capture and anti-cheat changes

Changes involving Game Capture, graphics-hook behavior, process injection, signed OBS payloads, anti-cheat compatibility, or runtime integrity checks require extra care.

Do not submit changes that:

- bypass anti-cheat protections;
- weaken Windows security settings as a requirement;
- replace validated signed payloads without documenting the reason;
- disable integrity or signature checks merely to make a test pass.

Explain compatibility-related changes clearly and include reproducible evidence where practical.

## Licensing

Shard is distributed under the GNU General Public License v2.0. By submitting a contribution, you agree that your contribution may be distributed as part of Shard under that license.

Shard incorporates OBS Studio components and other third-party software. Preserve existing copyright notices, license notices, attribution, and third-party licensing information when modifying those components.

## AI-assisted contributions

AI-assisted development is allowed, but contributors remain responsible for reviewing what they submit. Please verify generated code, test relevant behavior, and avoid introducing code whose origin or licensing is unclear.

## Questions and bugs

For bugs or feature discussions, open a GitHub issue with enough detail for someone else to understand and reproduce the problem.
