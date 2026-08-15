# ClipForge core end-to-end contract test (no app needed).
#
# Usage:
#   powershell -File scripts/e2e.ps1 [-CoreBin <staged core-bin dir>]
#
# Starts the core with a temp config dir, connects over WebSocket JSON-RPC,
# warms the ring 70 s, saves 60 s, asserts clip.saved.actualSec in [58,62]
# and the produced mp4's ffprobe duration in range; toggles capture mode via
# config.set; asserts audio.listDevices reports Voicemeeter devices.
param(
  [switch]$KeepTemp,
  [string]$CoreBin = (Join-Path (Split-Path $PSScriptRoot -Parent) "app/resources/core-bin")
)
$ErrorActionPreference = "Stop"

$root = Split-Path $PSScriptRoot -Parent
$coreExe = Join-Path $CoreBin "clipcore.exe"
if (-not (Test-Path $coreExe)) { throw "clipcore.exe not found in $CoreBin" }

$temp = Join-Path $env:TMP "cf-e2e-$(Get-Date -Format yyyyMMddHHmmss)"
New-Item -ItemType Directory -Force $temp | Out-Null

Write-Host "==> Starting core (config-dir $temp)"
$proc = Start-Process -FilePath $coreExe -ArgumentList "--config-dir", $temp, "--core-bin", $CoreBin, "--port", "0" `
  -RedirectStandardOutput (Join-Path $temp "core.out") -RedirectStandardError (Join-Path $temp "core.err") `
  -PassThru -NoNewWindow

try {
  $port = $null
  $deadline = (Get-Date).AddSeconds(30)
  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 300
    if (Test-Path (Join-Path $temp "core.out")) {
      $line = Get-Content (Join-Path $temp "core.out") -ErrorAction SilentlyContinue | Where-Object { $_ -match "^PORT (\d+)$" } | Select-Object -First 1
      if ($line -match "^PORT (\d+)$") { $port = [int]$Matches[1]; break }
    }
    if ($proc.HasExited) { throw "core exited early: $(Get-Content (Join-Path $temp 'core.err') -Raw)" }
  }
  if (-not $port) { throw "core never printed PORT" }
  Write-Host "==> Core listening on port $port"

  $env:CF_PORT = "$port"
  $env:CF_TEMP = $temp
  $env:CF_COREBIN = $CoreBin
  node (Join-Path $PSScriptRoot "e2e-client.mjs")
  if ($LASTEXITCODE -ne 0) { throw "e2e client failed ($LASTEXITCODE)" }
  Write-Host "==> E2E PASSED"
}
finally {
  if (-not $proc.HasExited) {
    $proc.Kill()
    $proc.WaitForExit()
  }
  if (-not $KeepTemp) { Remove-Item -Recurse -Force $temp -ErrorAction SilentlyContinue }
  else { Write-Host "==> temp kept at $temp" }
}
