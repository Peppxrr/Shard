param(
  [string]$BuildDirectory = (Join-Path $PSScriptRoot '../build_x64'),
  [string]$Configuration = 'Release',
  [string]$FixturePath,
  [switch]$SkipBuild
)
$ErrorActionPreference = 'Stop'
if (-not $FixturePath) {
  $BuildDirectory = [IO.Path]::GetFullPath($BuildDirectory)
  if (-not $SkipBuild) {
    & cmake --build $BuildDirectory --config $Configuration --target shard_process_supervisor_fixture
    if ($LASTEXITCODE -ne 0) { throw 'Supervisor fixture build failed' }
  }
  $FixturePath = Join-Path $BuildDirectory "$Configuration/shard_process_supervisor_fixture.exe"
}
$FixturePath = (Resolve-Path -LiteralPath $FixturePath).Path
foreach ($mode in @('normal', 'force', 'eof', 'setup-failure')) {
  $supervisor = $null
  $descendant = $null
  try {
    $start = [Diagnostics.ProcessStartInfo]::new($FixturePath)
    $start.UseShellExecute = $false
    $start.RedirectStandardInput = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    if ($mode -in @('force', 'eof')) { $start.Arguments = '--hang' }
    if ($mode -eq 'setup-failure') { $start.Arguments = '--fail-setup' }
    $supervisor = [Diagnostics.Process]::Start($start)
    $stderr = $supervisor.StandardError.ReadToEndAsync()
    if ($mode -ne 'setup-failure') {
      $ready = $false
      $leafId = 0
      $deadline = [DateTime]::UtcNow.AddSeconds(5)
      while (-not $ready -or -not $leafId) {
        $remaining = [Math]::Max(0, [int]($deadline - [DateTime]::UtcNow).TotalMilliseconds)
        $read = $supervisor.StandardOutput.ReadLineAsync()
        if (-not $read.Wait($remaining)) { throw "${mode}: readiness timeout" }
        $line = $read.Result
        if ($null -eq $line) { throw "${mode}: exited before readiness" }
        if ($line -eq 'SUPERVISOR READY') { $ready = $true }
        if ($line -match '^LEAF (\d+)$') {
          $leafId = [int]$Matches[1]
          # Keep the process handle, rather than later trusting a reusable PID.
          # The normal case may already have completed the helper's teardown.
          try { $descendant = [Diagnostics.Process]::GetProcessById($leafId); $null = $descendant.Handle }
          catch [ArgumentException] { $descendant = $null }
        }
      }
      if ($mode -eq 'force') { $supervisor.StandardInput.Write('!'); $supervisor.StandardInput.Flush() }
      if ($mode -eq 'eof') { $supervisor.StandardInput.Close() }
    }
    if (-not $supervisor.WaitForExit(8000)) { throw "${mode}: exit timeout" }
    $expected = if ($mode -eq 'normal') { 17 } elseif ($mode -eq 'setup-failure') { 125 } else { 1 }
    if (-not $stderr.Wait(1000)) { throw "${mode}: stderr remained open" }
    if ($supervisor.ExitCode -ne $expected) { throw "${mode}: exit $($supervisor.ExitCode), expected $expected; $($stderr.Result)" }
    if ($descendant -and -not $descendant.WaitForExit(0)) { throw "${mode}: descendant remained alive after supervisor exit" }
    if ($mode -eq 'setup-failure' -and $stderr.Result -notmatch 'tree exit unproven') { throw 'Missing fail-closed diagnostic' }
    Write-Output "$mode passed (exit $expected)"
  } finally {
    # These handles refer only to this fixture invocation's owned processes.
    if ($supervisor) {
      try { if (-not $supervisor.HasExited) { $supervisor.StandardInput.Close(); if (-not $supervisor.WaitForExit(7000)) { $supervisor.Kill(); $null = $supervisor.WaitForExit(2000) } } } finally { $supervisor.Dispose() }
    }
    if ($descendant) {
      try { if (-not $descendant.HasExited) { $descendant.Kill(); $null = $descendant.WaitForExit(2000) } } finally { $descendant.Dispose() }
    }
  }
}
