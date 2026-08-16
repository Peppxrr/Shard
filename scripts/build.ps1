# ClipForge build orchestrator: vendored deps -> core build -> staged core-bin.
#
# Usage:
#   powershell -File scripts/build.ps1            # configure + build core (Release)
#   powershell -File scripts/build.ps1 -Clean     # wipe build dirs first
#   powershell -File scripts/build.ps1 -SkipApp   # core only (no electron app)
#   powershell -File scripts/build.ps1 -Config Debug   # debug core -> app/resources/core-bin-dev
#
# Staging: Release lands in app/resources/core-bin (used by the packaged app
# and the e2e/selftest runners); Debug lands in app/resources/core-bin-dev
# (used only by the dev runner - scripts/dev.ps1). The two never mix, so a
# dev session can't pollute the release staging area.
#
# Prereqs: Visual Studio 2022 Build Tools (Desktop C++ workload incl.
# Windows 11 SDK 10.0.26100), CMake >= 3.28, Git.
param(
  [ValidateSet("Release", "Debug")]
  [string]$Config = "Release",
  [switch]$Clean,
  [switch]$SkipApp
)
$ErrorActionPreference = "Stop"

$root = Split-Path $PSScriptRoot -Parent
$coreDir = Join-Path $root "core"
$buildDir = Join-Path $root "build_x64"
if ($Config -eq "Debug") {
  $stageDir = Join-Path $root "app/resources/core-bin-dev"
} else {
  $stageDir = Join-Path $root "app/resources/core-bin"
}
$config = $Config

# The OBS checkout stays pinned to upstream. Shard's narrowly scoped Game
# Capture changes are carried as a reproducible patch in the parent repo.
$obsDir = Join-Path $root "vendor/obs-studio"
$obsPatch = Join-Path $root "patches/obs-game-capture.patch"
if (-not (Test-Path $obsPatch)) { throw "OBS Game Capture patch not found: $obsPatch" }

git -C $obsDir apply --check $obsPatch 2>$null
if ($LASTEXITCODE -eq 0) {
  Write-Host "==> Applying Shard OBS Game Capture patch =="
  git -C $obsDir apply $obsPatch
  if ($LASTEXITCODE -ne 0) { throw "failed to apply OBS Game Capture patch ($LASTEXITCODE)" }
} else {
  git -C $obsDir apply --reverse --check $obsPatch 2>$null
  if ($LASTEXITCODE -ne 0) {
    throw "OBS checkout differs from both the pinned base and the expected Shard patch"
  }
}

if ($Clean) {
  Remove-Item -Recurse -Force $buildDir, (Join-Path $root "build_x86") -ErrorAction SilentlyContinue
}

New-Item -ItemType Directory -Force $stageDir | Out-Null

Write-Host "==> Configuring (obs-deps auto-downloaded by obs-studio's CMake) =="
cmake -S $coreDir -B $buildDir `
  -G "Visual Studio 17 2022" `
  -A "x64,version=10.0.26100.0" `
  -DCMAKE_CONFIGURATION_TYPES="Release;Debug" `
  -DENABLE_FRONTEND=OFF `
  -DENABLE_SCRIPTING=OFF `
  -DENABLE_BROWSER=OFF `
  -DENABLE_WEBSOCKET=OFF `
  -DENABLE_VLC=OFF `
  "-DOBS_VERSION_OVERRIDE=32.2.1"
if ($LASTEXITCODE -ne 0) { throw "cmake configure failed ($LASTEXITCODE)" }

Write-Host "==> Building core + OBS plugins =="
# obs-studio's own targets; clipcore links libobs, the rest are shipped plugins.
$targets = @(
  "clipcore", "libobs-d3d11", "libobs-winrt", "obs-ffmpeg-mux", "obs-nvenc-test",
  "win-capture", "win-wasapi", "obs-x264", "obs-nvenc",
  "obs-ffmpeg", "obs-outputs", "obs-filters", "image-source", "text-freetype2"
)
cmake --build $buildDir --config $config --target $targets --parallel
if ($LASTEXITCODE -ne 0) { throw "cmake build failed ($LASTEXITCODE)" }

Write-Host "==> Staging core-bin =="
$rundir = Join-Path $buildDir "obs-studio/rundir/$config"
$bin64 = Join-Path $rundir "bin/64bit"
$plugins64 = Join-Path $rundir "obs-plugins/64bit"
$dataDir = Join-Path $rundir "data"

# 1. clipcore.exe (MSVC multi-config puts it at build_x64/<Config>/clipcore.exe)
$clipcoreExe = Join-Path $buildDir "$config/clipcore.exe"
if (-not (Test-Path $clipcoreExe)) {
  # Older layouts built into a per-target dir; fall back to the newest copy
  # of the requested config anywhere under the build dir.
  $clipcoreExe = Get-ChildItem -Recurse -Filter clipcore.exe $buildDir |
    Where-Object { $_.FullName -match "\\$config\\" } |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1 -ExpandProperty FullName
}
if (-not $clipcoreExe -or -not (Test-Path $clipcoreExe)) { throw "clipcore.exe not found for config $config" }
Copy-Item $clipcoreExe (Join-Path $stageDir "clipcore.exe") -Force

# 2. runtime DLLs + ffmpeg-mux helper next to the exe
foreach ($dll in @("obs.dll", "libobs-d3d11.dll", "libobs-winrt.dll", "w32-pthreads.dll", "obs-ffmpeg-mux.exe", "obs-nvenc-test.exe")) {
  $src = Join-Path $bin64 $dll
  if (Test-Path $src) { Copy-Item $src (Join-Path $stageDir $dll) -Force }
}

# 2b. Debug builds link the Debug CRT (/MDd), which is not installed into
# System32 on all machines - stage the DLLs so core-bin-dev is self-contained.
if ($Config -eq "Debug") {
  $vsRedist = "C:\Users\$env:USERNAME\AppData\Local\Microsoft\VisualStudio\2022\BuildTools\VC\Redist\MSVC"
  $debugCrt = Get-ChildItem $vsRedist -Directory -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -match '^\d+\.\d+' } | Sort-Object Name -Descending | Select-Object -First 1
  if ($debugCrt) {
    $crtDir = Join-Path $debugCrt.FullName "debug_nonredist\x64\Microsoft.VC143.DebugCRT"
    foreach ($dll in @("msvcp140d.dll", "vcruntime140d.dll", "vcruntime140_1d.dll", "concrt140d.dll")) {
      $src = Join-Path $crtDir $dll
      if (Test-Path $src) { Copy-Item $src (Join-Path $stageDir $dll) -Force }
    }
  }
  $ucrt = Get-ChildItem "C:\Program Files (x86)\Windows Kits\10\bin" -Directory -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -match '^\d+\.\d+' } | Sort-Object Name -Descending | Select-Object -First 1
  if ($ucrt) {
    $src = Join-Path $ucrt.FullName "x64\ucrt\ucrtbased.dll"
    if (Test-Path $src) { Copy-Item $src (Join-Path $stageDir "ucrtbased.dll") -Force }
  }
}

# 3. obs-deps runtime DLLs (FFmpeg, zlib, x264) that libobs/encoders import
$depsBin = Join-Path $root "vendor/obs-studio/.deps/obs-deps-2026-07-15-x64/bin"
foreach ($dll in @("avcodec-62.dll", "avformat-62.dll", "avutil-60.dll", "avdevice-62.dll", "avfilter-11.dll", "swscale-9.dll", "swresample-6.dll", "zlib.dll", "libx264-164.dll", "librist.dll", "datachannel.dll", "libcurl.dll", "srt.dll")) {
  $src = Join-Path $depsBin $dll
  if (Test-Path $src) { Copy-Item $src (Join-Path $stageDir $dll) -Force }
}

# 3. plugins
$shipPlugins = @(
  "win-capture", "win-wasapi", "obs-x264", "obs-nvenc",
  "obs-ffmpeg", "obs-outputs", "obs-filters", "image-source", "text-freetype2"
)
$pluginDest = Join-Path $stageDir "obs-plugins/64bit"
New-Item -ItemType Directory -Force $pluginDest | Out-Null
foreach ($p in $shipPlugins) {
  $dll = Join-Path $plugins64 "$p.dll"
  if (Test-Path $dll) { Copy-Item $dll (Join-Path $pluginDest "$p.dll") -Force }
}

# 4. plugin data dirs (win-capture carries graphics-hook64/32.dll + inject helpers)
$dataDest = Join-Path $stageDir "data/obs-plugins"
foreach ($p in $shipPlugins) {
  $src = Join-Path $dataDir "obs-plugins/$p"
  if (Test-Path $src) {
    Copy-Item $src $dataDest -Recurse -Force
  }
}

# 5. libobs core data (effects, locales)
$libobsDataSrc = Join-Path $dataDir "libobs"
if (Test-Path $libobsDataSrc) {
  Copy-Item $libobsDataSrc (Join-Path $stageDir "data") -Recurse -Force
}

# 5. ffmpeg binaries (static win64 build) if fetched
$ffmpegBin = Join-Path $root "vendor/ffmpeg/bin"
if (Test-Path (Join-Path $ffmpegBin "ffmpeg.exe")) {
  Copy-Item (Join-Path $ffmpegBin "ffmpeg.exe") (Join-Path $stageDir "ffmpeg.exe") -Force
  Copy-Item (Join-Path $ffmpegBin "ffprobe.exe") (Join-Path $stageDir "ffprobe.exe") -Force
}

Write-Host "==> core-bin staged at $stageDir =="
$files = Get-ChildItem $stageDir -Recurse -File
$sum = ($files | Measure-Object Length -Sum).Sum
Write-Host ("  {0} files, {1:N1} MB" -f $files.Count, ($sum / 1MB))
