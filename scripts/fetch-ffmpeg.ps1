# Fetches a pinned static ffmpeg win64 release (Gyan) into vendor/ffmpeg and
# verifies the SHA-256 checksum. Re-run to refresh; checksum is enforced on
# every fetch. Linux port later swaps to a distro/static Linux build.
#
# Usage: powershell -File scripts/fetch-ffmpeg.ps1
param()
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

# Versioned release asset, not a moving latest URL or a short-lived daily build.
# Update URL and digest together after reviewing the upstream release.
$root = Split-Path $PSScriptRoot -Parent
$pins = Get-Content (Join-Path $root "runtime-dependencies.json") -Raw | ConvertFrom-Json
$url = $pins.ffmpeg.url
$sha256 = $pins.ffmpeg.sha256

$dir = Join-Path $root "vendor/ffmpeg"
New-Item -ItemType Directory -Force $dir | Out-Null

$fetchDir = Join-Path $dir ("fetch-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Force $fetchDir | Out-Null
$zip = Join-Path $fetchDir "ffmpeg-static.zip"
Write-Host "Downloading $url"
Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing

$actual = (Get-FileHash $zip -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actual -ne $sha256) {
  throw "SHA-256 mismatch`n  expected: $sha256`n  actual:   $actual`nRefusing to use an unpinned ffmpeg build."
}

Expand-Archive $zip $fetchDir -Force
$inner = Join-Path $fetchDir $pins.ffmpeg.archiveDirectory
$exeDir = Join-Path $dir "bin"
New-Item -ItemType Directory -Force $exeDir | Out-Null
Copy-Item (Join-Path $inner "bin/ffmpeg.exe") $exeDir -Force
Copy-Item (Join-Path $inner "bin/ffprobe.exe") $exeDir -Force
[IO.File]::WriteAllText((Join-Path $dir "pins.json"), ($pins.ffmpeg | ConvertTo-Json -Depth 4), (New-Object Text.UTF8Encoding $false))
# Verify the resolved temporary directory before recursive cleanup.
$resolvedFetch = [IO.Path]::GetFullPath($fetchDir)
if (-not $resolvedFetch.StartsWith([IO.Path]::GetFullPath($dir) + [IO.Path]::DirectorySeparatorChar)) {
  throw "Unsafe FFmpeg temporary directory: $resolvedFetch"
}
Remove-Item -LiteralPath $resolvedFetch -Recurse -Force
Write-Host "ffmpeg ready at vendor/ffmpeg/bin"
