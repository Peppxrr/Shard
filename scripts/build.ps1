# Shard build orchestrator: vendored deps -> core build -> staged core-bin.
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
$hookPayloadDir = Join-Path $root "vendor/obs-hook-payload/32.2.1"
$hookPayloadManifestPath = Join-Path $hookPayloadDir "manifest.json"
if (-not (Test-Path $hookPayloadManifestPath)) {
  throw "Official OBS Game Capture payload manifest not found: $hookPayloadManifestPath"
}
$hookPayloadManifest = Get-Content $hookPayloadManifestPath -Raw | ConvertFrom-Json
if ($hookPayloadManifest.obsVersion -ne "32.2.1") {
  throw "OBS Game Capture payload version mismatch: expected 32.2.1, got $($hookPayloadManifest.obsVersion)"
}

$obsCommit = (git -C $obsDir rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0 -or $obsCommit -ne $hookPayloadManifest.obsCommit) {
  throw "Embedded win-capture and official payload release mismatch: expected OBS commit $($hookPayloadManifest.obsCommit), got $obsCommit"
}

function Assert-ObsHookPayload {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)]$Expected,
    [Parameter(Mandatory = $true)][string]$ExpectedSigner
  )

  if (-not (Test-Path $Path -PathType Leaf)) {
    throw "Official OBS Game Capture payload missing: $Path"
  }
  $actualHash = (Get-FileHash $Path -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actualHash -ne $Expected.sha256.ToLowerInvariant()) {
    throw "Official OBS Game Capture payload hash mismatch for $Path`: expected $($Expected.sha256), got $actualHash"
  }

  $signature = Get-AuthenticodeSignature $Path
  $actualSigner = if ($signature.SignerCertificate) {
    $signature.SignerCertificate.GetNameInfo(
      [System.Security.Cryptography.X509Certificates.X509NameType]::SimpleName,
      $false
    )
  } else {
    "<missing>"
  }
  $actualThumbprint = if ($signature.SignerCertificate) {
    $signature.SignerCertificate.Thumbprint
  } else {
    "<missing>"
  }
  if ($signature.Status -ne [System.Management.Automation.SignatureStatus]::Valid) {
    throw "Official OBS Game Capture payload Authenticode verification failed for $Path`: $($signature.Status) $($signature.StatusMessage)"
  }
  if ($actualSigner -ne $ExpectedSigner -or $actualThumbprint -ne $Expected.signerThumbprint) {
    throw "Official OBS Game Capture payload signer mismatch for $Path`: expected '$ExpectedSigner'/$($Expected.signerThumbprint), got '$actualSigner'/$actualThumbprint"
  }
}

$hookPayloadFiles = @(
  "graphics-hook64.dll",
  "graphics-hook32.dll",
  "inject-helper64.exe",
  "inject-helper32.exe"
)
foreach ($name in $hookPayloadFiles) {
  $expected = $hookPayloadManifest.files.PSObject.Properties[$name].Value
  Assert-ObsHookPayload (Join-Path $hookPayloadDir $name) $expected $hookPayloadManifest.signer
}
Write-Host "==> Verified official signed OBS Studio $($hookPayloadManifest.obsVersion) Game Capture payload =="
if (-not (Test-Path $obsPatch)) { throw "OBS Game Capture patch not found: $obsPatch" }

# Apply a Shard patch to the pinned obs-studio checkout. Idempotent: if the
# patch no longer applies (already applied), the reverse check must succeed
# or the checkout drifted from both the pinned base and the expected patch.
# NOTE: only the OBS Game Capture patch is applied here. The injected hook
# payload (graphics-hook*.dll / inject-helper*.exe) is the official signed
# OBS build verified above — never rebuild or modify it, anti-cheat
# compatibility depends on the signed payload matching upstream hashes.
function Invoke-ObsPatch([string]$Path, [string]$Label) {
  if (-not (Test-Path $Path)) { throw "$Label patch not found: $Path" }
  $previousErrorActionPreference = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  git -C $obsDir apply --check $Path 2>$null
  $patchApplies = $LASTEXITCODE -eq 0
  $ErrorActionPreference = $previousErrorActionPreference
  if ($patchApplies) {
    Write-Host "==> Applying Shard $Label patch =="
    git -C $obsDir apply $Path
    if ($LASTEXITCODE -ne 0) { throw "failed to apply $Label patch ($LASTEXITCODE)" }
  } else {
    $ErrorActionPreference = "Continue"
    git -C $obsDir apply --reverse --check $Path 2>$null
    $patchAlreadyApplied = $LASTEXITCODE -eq 0
    $ErrorActionPreference = $previousErrorActionPreference
    if (-not $patchAlreadyApplied) {
      throw "OBS checkout differs from both the pinned base and the expected Shard $Label patch"
    }
  }
}

Invoke-ObsPatch $obsPatch "OBS Game Capture"

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
# obs-studio's own targets; shardcore links libobs, the rest are shipped plugins.
$targets = @(
  "shardcore", "libobs-d3d11", "libobs-winrt", "obs-ffmpeg-mux", "obs-nvenc-test",
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

# 1. shardcore.exe (MSVC multi-config puts it at build_x64/<Config>/shardcore.exe)
$shardcoreExe = Join-Path $buildDir "$config/shardcore.exe"
if (-not (Test-Path $shardcoreExe)) {
  # Older layouts built into a per-target dir; fall back to the newest copy
  # of the requested config anywhere under the build dir.
  $shardcoreExe = Get-ChildItem -Recurse -Filter shardcore.exe $buildDir |
    Where-Object { $_.FullName -match "\\$config\\" } |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1 -ExpandProperty FullName
}
if (-not $shardcoreExe -or -not (Test-Path $shardcoreExe)) { throw "shardcore.exe not found for config $config" }
Remove-Item (Join-Path $stageDir "clipcore.exe") -Force -ErrorAction SilentlyContinue
Copy-Item $shardcoreExe (Join-Path $stageDir "shardcore.exe") -Force

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

# 4. plugin data dirs. The target-side Game Capture payload is not built from
# source: overwrite any incremental rundir copies with the exact official,
# signed OBS 32.2.1 release files from Shard's pinned payload directory.
$dataDest = Join-Path $stageDir "data/obs-plugins"
foreach ($p in $shipPlugins) {
  $src = Join-Path $dataDir "obs-plugins/$p"
  if (Test-Path $src) {
    Copy-Item $src $dataDest -Recurse -Force
  }
}

$winCaptureDataDest = Join-Path $dataDest "win-capture"
New-Item -ItemType Directory -Force $winCaptureDataDest | Out-Null
foreach ($name in $hookPayloadFiles) {
  Copy-Item (Join-Path $hookPayloadDir $name) (Join-Path $winCaptureDataDest $name) -Force
}
foreach ($manifest in @("shard-vulkan32.json", "shard-vulkan64.json")) {
  Copy-Item (Join-Path $hookPayloadDir $manifest) (Join-Path $winCaptureDataDest $manifest) -Force
}

# Stock names and misplaced incremental copies can register or select a second
# hook. Shard registers only its uniquely named, app-owned Vulkan manifests.
foreach ($name in $hookPayloadFiles) {
  Remove-Item (Join-Path $dataDest $name) -Force -ErrorAction SilentlyContinue
}
foreach ($manifest in @("obs-vulkan32.json", "obs-vulkan64.json")) {
  Remove-Item (Join-Path $winCaptureDataDest $manifest) -Force -ErrorAction SilentlyContinue
}

foreach ($name in $hookPayloadFiles) {
  $expected = $hookPayloadManifest.files.PSObject.Properties[$name].Value
  Assert-ObsHookPayload (Join-Path $winCaptureDataDest $name) $expected $hookPayloadManifest.signer
}

# The staging dir is never wiped (incremental builds depend on it), so old
# layouts and build symbols accumulate. Strip everything the packaged app
# must not carry: *.pdb anywhere (the payload's official binaries ship
# symbol-free; pdbs next to them are stale from-source build leftovers) and
# pre-patch layout copies at the data/obs-plugins root, which can register a
# second hook. verify-core-bin.mjs (wired into npm run package) enforces this
# at packaging time.
Get-ChildItem $stageDir -Recurse -Filter *.pdb | Remove-Item -Force
foreach ($name in @("obs-vulkan32.json", "obs-vulkan64.json", "compatibility.json", "locale",
                    "graphics-hook32.dll", "graphics-hook64.dll", "inject-helper32.exe", "inject-helper64.exe",
                    "get-graphics-offsets32.exe", "get-graphics-offsets64.exe")) {
  Remove-Item (Join-Path $dataDest $name) -Recurse -Force -ErrorAction SilentlyContinue
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
