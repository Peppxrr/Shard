# Shard development runner: builds the C++ core (Debug by default) and boots
# the Electron app straight from source with hot reload.
#
#   powershell -File scripts/dev.ps1           # build core (Debug) + run dev app
#   powershell -File scripts/dev.ps1 -SkipCore # skip the core build (already built)
#   powershell -File scripts/dev.ps1 -Release  # build a Release core into core-bin-dev
#   powershell -File scripts/dev.ps1 -Clean    # wipe build dirs, full rebuild
#
# What it does:
#   1. Ensures app dependencies (npm install when node_modules is missing).
#   2. Builds the C++ core via scripts/build.ps1 -Config Debug and stages it
#      into app/resources/core-bin-dev - separate from the Release staging
#      used by the e2e/selftest runners and the packaged app.
#   3. Runs scripts/dev.mjs: Vite dev server (renderer HMR), tsc --watch for
#      the Electron main/preload (CJS), and Electron itself, restarted
#      automatically whenever the compiled main process changes.
#
# The installer build (`npm run package` -> electron-builder) is reserved for
# release testing; this runner never packages anything.
param(
  [switch]$SkipCore,
  [switch]$Release,
  [switch]$Clean
)
$ErrorActionPreference = "Stop"

$root = Split-Path $PSScriptRoot -Parent
$appDir = Join-Path $root "app"
$coreBinDev = Join-Path $appDir "resources/core-bin-dev"

if (-not (Test-Path (Join-Path $appDir "node_modules"))) {
  Write-Host "==> Installing app dependencies (first run) =="
  Push-Location $appDir
  try { npm install; if ($LASTEXITCODE -ne 0) { throw "npm install failed ($LASTEXITCODE)" } }
  finally { Pop-Location }
}

if (-not $SkipCore) {
  $cfg = if ($Release) { "Release" } else { "Debug" }
  Write-Host "==> Building C++ core ($cfg) =="
  $args = @("-File", (Join-Path $PSScriptRoot "build.ps1"), "-Config", $cfg)
  if ($Clean) { $args += "-Clean" }
  & powershell @args
  if ($LASTEXITCODE -ne 0) { throw "core build failed ($LASTEXITCODE)" }
} elseif (-not (Test-Path (Join-Path $coreBinDev "clipcore.exe"))) {
  throw "core-bin-dev is missing clipcore.exe - run without -SkipCore first"
}

Write-Host "==> Starting dev app (Vite HMR + Electron main watch) =="
Write-Host "    core: $coreBinDev"
node (Join-Path $PSScriptRoot "dev.mjs")
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
