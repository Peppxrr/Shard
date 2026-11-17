# Builds the editor/export FFmpeg that scripts/fetch-ffmpeg.ps1 downloads
# (runtime-dependencies.json "ffmpeg"). Run it only to produce a new pinned
# archive; ordinary Shard builds fetch the published one.
#
#   powershell -File scripts/ffmpeg/build-windows.ps1 [-Msys C:\msys64]
#
# Without -Msys, a portable MSYS2 (pinned by SHA-256 in build-pins.json) is
# unpacked under vendor/ffmpeg-build; nothing is installed system-wide. The
# codec libraries are installed at their pinned package versions (pacman
# verifies MSYS2's package signatures); the toolchain is current MSYS2 and is
# recorded in the archive's README.txt. Output:
#   vendor/ffmpeg-build/shard-ffmpeg-<version>-<revision>-win64.zip and its SHA-256.
param([string]$Msys = "")
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$root = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$pins = Get-Content (Join-Path $PSScriptRoot "build-pins.json") -Raw | ConvertFrom-Json
$work = Join-Path $root "vendor/ffmpeg-build"
New-Item -ItemType Directory -Force $work | Out-Null

function Assert-Hash([string]$file, [string]$expected) {
  $actual = (Get-FileHash $file -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actual -ne $expected) { throw "SHA-256 mismatch for $file`n  expected: $expected`n  actual:   $actual" }
}

if (-not $Msys) {
  $Msys = Join-Path $work "msys64"
  if (-not (Test-Path (Join-Path $Msys "usr/bin/bash.exe"))) {
    $archive = Join-Path $work ([IO.Path]::GetFileName($pins.msys2.url))
    if (-not (Test-Path $archive)) { Invoke-WebRequest -Uri $pins.msys2.url -OutFile $archive -UseBasicParsing }
    Assert-Hash $archive $pins.msys2.sha256
    tar.exe -xf $archive -C $work
    if ($LASTEXITCODE -ne 0) { throw "Could not unpack MSYS2" }
  }
}
$bash = Join-Path $Msys "usr/bin/bash.exe"
if (-not (Test-Path $bash)) { throw "MSYS2 bash not found at $bash" }

function Invoke-Msys([string]$command, [switch]$AllowFailure) {
  $env:MSYSTEM = "UCRT64"; $env:CHERE_INVOKING = "1"
  & $bash -lc $command
  if ($LASTEXITCODE -ne 0 -and -not $AllowFailure) { throw "MSYS2 command failed ($LASTEXITCODE): $command" }
}

# The first update may replace the MSYS2 runtime and end its own shell; the
# second one must complete normally.
Invoke-Msys "pacman -Syu --noconfirm" -AllowFailure
Invoke-Msys "pacman -Syu --noconfirm"
Invoke-Msys ("pacman -S --noconfirm --needed " + ($pins.toolchain -join " "))
$urls = $pins.libraries | ForEach-Object { "https://repo.msys2.org/mingw/ucrt64/$_-any.pkg.tar.zst" }
Invoke-Msys ("pacman -U --noconfirm --needed " + ($urls -join " "))
# The x264 package depends on MSYS2's own FFmpeg (for the x264 CLI only). Its
# static libav* would otherwise be linked instead of the FFmpeg being built.
Invoke-Msys "pacman -Q mingw-w64-ucrt-x86_64-ffmpeg >/dev/null 2>&1 && pacman -Rdd --noconfirm mingw-w64-ucrt-x86_64-ffmpeg mingw-w64-ucrt-x86_64-ffms2 || true"

# FFmpeg's release tarball (its detached signature was checked when pinning).
$tarball = Join-Path $work "ffmpeg-$($pins.ffmpeg.version).tar.xz"
if (-not (Test-Path $tarball)) { Invoke-WebRequest -Uri $pins.ffmpeg.url -OutFile $tarball -UseBasicParsing }
Assert-Hash $tarball $pins.ffmpeg.sha256

# Windows PowerShell does not escape embedded double quotes for native
# programs, so the command uses MSYS paths and single quotes only.
function ConvertTo-MsysPath([string]$path) {
  $full = [IO.Path]::GetFullPath($path) -replace '\\', '/'
  return "/" + $full.Substring(0, 1).ToLowerInvariant() + $full.Substring(2)
}
$buildArgs = @((ConvertTo-MsysPath (Join-Path $PSScriptRoot "build-windows.sh")), (ConvertTo-MsysPath $work),
  $pins.ffmpeg.version, $pins.ffmpeg.url, $pins.ffmpeg.sha256, $pins.revision) | ForEach-Object { "'$_'" }
Invoke-Msys ("bash " + ($buildArgs -join " "))

$name = "shard-ffmpeg-$($pins.ffmpeg.version)-$($pins.revision)-win64"
$zip = Join-Path $work "$name.zip"
if (Test-Path $zip) { Remove-Item $zip -Force }
Compress-Archive -Path (Join-Path $work $name) -DestinationPath $zip
$hash = (Get-FileHash $zip -Algorithm SHA256).Hash.ToLowerInvariant()
Write-Host "Archive: $zip"
Write-Host "SHA-256: $hash"
Write-Host "Publish it, then set runtime-dependencies.json ffmpeg.url/sha256 and archiveDirectory=$name."
