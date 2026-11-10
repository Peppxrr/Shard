# OBS uses paths relative to the root CMake project. Supply its expected
# directories when it is embedded under Shard, including its x86 helper build.
param([string]$Root = (Split-Path $PSScriptRoot -Parent))
$ErrorActionPreference = "Stop"
$Root = [IO.Path]::GetFullPath($Root)
$obs = Join-Path $Root "vendor/obs-studio"
foreach ($name in @("deps", "shared", "cmake")) {
  if (-not (Test-Path (Join-Path $obs $name) -PathType Container)) {
    throw "OBS source is missing. Run git submodule update --init --recursive first."
  }
}
$x86 = Join-Path $Root "core/build_x86"
New-Item -ItemType Directory -Force $x86 | Out-Null
$links = @{
  (Join-Path $Root "core/deps") = (Join-Path $obs "deps")
  (Join-Path $Root "core/shared") = (Join-Path $obs "shared")
  (Join-Path $Root "core/cmake") = (Join-Path $obs "cmake")
  (Join-Path $obs "build_x86") = $x86
}
foreach ($link in $links.GetEnumerator()) {
  $existing = Get-Item -LiteralPath $link.Key -Force -ErrorAction SilentlyContinue
  if (-not $existing) {
    New-Item -ItemType Junction -Path $link.Key -Target $link.Value | Out-Null
    continue
  }
  # Junctions store absolute targets, so a moved or renamed checkout leaves
  # them pointing at the old path. They are generated state: repoint them.
  # A real directory is never replaced.
  if ($existing.LinkType -ne "Junction" -and $existing.LinkType -ne "SymbolicLink") {
    throw "Unexpected directory at $($link.Key); expected a junction to $($link.Value)."
  }
  $target = @($existing.Target)[0]
  if ($target -and [IO.Path]::GetFullPath($target) -eq [IO.Path]::GetFullPath($link.Value)) { continue }
  Write-Host "==> Repointing $($link.Key) -> $($link.Value)"
  # Directory.Delete removes the reparse point only; Remove-Item -Recurse would
  # follow it into the target's contents.
  if ($existing.LinkType -eq "Junction") { [IO.Directory]::Delete($link.Key) }
  else { Remove-Item -LiteralPath $link.Key -Force }
  New-Item -ItemType Junction -Path $link.Key -Target $link.Value | Out-Null
}
