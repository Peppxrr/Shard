# Security Policy

## Reporting a vulnerability

Please do not publicly disclose a security vulnerability in a GitHub issue before the maintainer has had a reasonable opportunity to investigate it.

For now, if you discover a vulnerability and no private GitHub security-reporting option is available on the repository, open a minimal issue asking the maintainer for a private contact method. Do not include exploit details, secrets, private recordings, credentials, or sensitive logs in that public issue.

Useful information for a security report includes:

- affected Shard version or commit;
- Windows version and relevant environment details;
- a clear description of the issue and its impact;
- reproducible steps or a minimal proof of concept;
- relevant logs with private information removed;
- any suggested mitigation, if known.

## Scope

Security-sensitive areas include, but are not limited to:

- the local JSON-RPC interface;
- Electron IPC boundaries;
- file handling and clip-library operations;
- update or release distribution mechanisms;
- OBS Game Capture helper/hook staging and integrity validation;
- process discovery and capture target selection;
- FFmpeg invocation and user-controlled paths;
- dependency or installer vulnerabilities.

Shard intentionally does not require anti-cheat bypasses, kernel components, or reduced Windows security settings. Reports involving a proposed weakening of those boundaries may be rejected unless they demonstrate a genuine Shard vulnerability.

## Supported versions

Shard is currently early in development. Security fixes are generally made against the latest available release and current `main` branch rather than maintained across multiple old release lines.

## Public disclosure

After a fix is available, coordinated public disclosure is welcome. Please allow the maintainer time to prepare and publish the fix before releasing exploit details publicly.
