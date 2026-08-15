# Fetches a pinned static ffmpeg win64 build (BtbN) into vendor/ffmpeg and
# verifies the SHA-256 checksum. Re-run to refresh; checksum is enforced on
# every fetch. Linux port later swaps to a distro/static Linux build.
#
# Usage: powershell -File scripts/fetch-ffmpeg.ps1
param()
$ErrorActionPreference = "Stop"

# Pin: BtbN ffmpeg-master-latest-win64-gpl. When master moves the sha changes;
# bump BOTH the URL and the hash together (see https://github.com/BtbN/FFmpeg-Builds/releases).
$url = "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip"
$sha256 = "9a3444ae8216f2ba9ba47d9870ca46e653e9ba1310e3e1a5615819202292dc49"

$root = Split-Path $PSScriptRoot -Parent
$dir = Join-Path $root "vendor/ffmpeg"
New-Item -ItemType Directory -Force $dir | Out-Null

$zip = Join-Path $env:TEMP "ffmpeg-static.zip"
Write-Host "Downloading $url"
Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing

$actual = (Get-FileHash $zip -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actual -ne $sha256) {
  throw "SHA-256 mismatch`n  expected: $sha256`n  actual:   $actual`nRefusing to use an unpinned ffmpeg build."
}

Expand-Archive $zip $dir -Force
$inner = Get-ChildItem $dir -Directory | Select-Object -First 1
if ($inner) {
  $exeDir = Join-Path $root "vendor/ffmpeg/bin"
  New-Item -ItemType Directory -Force $exeDir | Out-Null
  Copy-Item (Join-Path $inner.FullName "bin/ffmpeg.exe") $exeDir -Force
  Copy-Item (Join-Path $inner.FullName "bin/ffprobe.exe") $exeDir -Force
  Remove-Item $inner.FullName -Recurse -Force
}
Remove-Item $zip -Force
Write-Host "ffmpeg ready at vendor/ffmpeg/bin"
