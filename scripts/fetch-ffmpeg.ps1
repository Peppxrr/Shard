# Fetches the pinned shared FFmpeg win64 release (Gyan) into vendor/ffmpeg and
# verifies its SHA-256 checksum. ffmpeg.exe and ffprobe.exe share one set of
# FFmpeg DLLs; they are staged in core-bin/ffmpeg, apart from OBS's own
# FFmpeg DLLs. Re-run to refresh; the checksum is enforced on every fetch.
#
# Usage: powershell -File scripts/fetch-ffmpeg.ps1
param()
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

# Versioned release asset, not a moving latest URL or a short-lived daily build.
# Update URL, digest, archive directory and DLL list together after reviewing
# the upstream release.
$root = Split-Path $PSScriptRoot -Parent
$pins = Get-Content (Join-Path $root "runtime-dependencies.json") -Raw | ConvertFrom-Json
$url = $pins.ffmpeg.url
$sha256 = $pins.ffmpeg.sha256

$dir = Join-Path $root "vendor/ffmpeg"
New-Item -ItemType Directory -Force $dir | Out-Null

$fetchDir = Join-Path $dir ("fetch-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Force $fetchDir | Out-Null
$zip = Join-Path $fetchDir "ffmpeg.zip"
Write-Host "Downloading $url"
Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing

$actual = (Get-FileHash $zip -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actual -ne $sha256) {
  throw "SHA-256 mismatch`n  expected: $sha256`n  actual:   $actual`nRefusing to use an unpinned ffmpeg build."
}

Expand-Archive $zip $fetchDir -Force
$inner = Join-Path $fetchDir $pins.ffmpeg.archiveDirectory
# Replace the whole bin directory so files from an older pin cannot remain.
$binDir = Join-Path $dir "bin"
if (Test-Path -LiteralPath $binDir) { Remove-Item -LiteralPath $binDir -Recurse -Force }
New-Item -ItemType Directory -Force $binDir | Out-Null
foreach ($name in @("ffmpeg.exe", "ffprobe.exe") + @($pins.ffmpeg.runtimeDlls)) {
  $source = Join-Path $inner "bin/$name"
  if (-not (Test-Path -LiteralPath $source)) { throw "Pinned FFmpeg archive lacks bin/$name" }
  Copy-Item -LiteralPath $source $binDir -Force
}
# GPL v3 license text and the build's component/source summary ship with it.
Copy-Item -LiteralPath (Join-Path $inner "LICENSE") (Join-Path $binDir "LICENSE.txt") -Force
Copy-Item -LiteralPath (Join-Path $inner "README.txt") (Join-Path $binDir "README.txt") -Force
[IO.File]::WriteAllText((Join-Path $dir "pins.json"), ($pins.ffmpeg | ConvertTo-Json -Depth 4), (New-Object Text.UTF8Encoding $false))
# Verify the resolved temporary directory before recursive cleanup.
$resolvedFetch = [IO.Path]::GetFullPath($fetchDir)
if (-not $resolvedFetch.StartsWith([IO.Path]::GetFullPath($dir) + [IO.Path]::DirectorySeparatorChar)) {
  throw "Unsafe FFmpeg temporary directory: $resolvedFetch"
}
Remove-Item -LiteralPath $resolvedFetch -Recurse -Force
Write-Host "ffmpeg ready at vendor/ffmpeg/bin"
