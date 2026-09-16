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
  if ($existing) {
    $target = @($existing.Target)[0]
    if ($existing.LinkType -ne "Junction" -or [IO.Path]::GetFullPath($target) -ne [IO.Path]::GetFullPath($link.Value)) {
      throw "Unexpected directory at $($link.Key); expected a junction to $($link.Value)."
    }
  } else {
    New-Item -ItemType Junction -Path $link.Key -Target $link.Value | Out-Null
  }
}
