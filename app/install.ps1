<#
.SYNOPSIS
  Build the readout and mirror it into the running install directory.

.DESCRIPTION
  `npm run dist` only writes build/release/win-unpacked -- it never touches
  wherever you actually launch the app from, so a rebuild alone leaves the
  running app on the old bundle. This script does both steps: build, then
  robocopy /MIR the output over the install directory, refreshing a rollback
  copy first.

  Run this script itself rather than replicating its steps by hand -- it's
  plain build tooling (npm run dist + two robocopy /MIR calls), safe to
  invoke directly including from an agent. The point is not re-deriving the
  build/copy/rollback sequence inline; it's using the script that already
  encodes it.

.PARAMETER InstallDir
  Where the app is actually launched from. Pass an explicit -InstallDir.

.PARAMETER SkipBuild
  Reinstall the existing build/release/win-unpacked output without rebuilding.
#>
param(
  [Parameter(Mandatory = $true)]
  [string]$InstallDir,
  [switch]$SkipBuild
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
$appDir = Join-Path $repoRoot "app"
$buildOut = Join-Path $repoRoot "build\release\win-unpacked"
$previousDir = "$InstallDir (previous)"

$running = Get-Process | Where-Object { $_.Path -eq (Join-Path $InstallDir "Ravenswatcher.exe") }
if ($running) {
  Write-Error "Close '$InstallDir\Ravenswatcher.exe' first -- its DLLs are locked while it runs."
}

if (-not $SkipBuild) {
  Push-Location $appDir
  try {
    npm run dist
    if ($LASTEXITCODE -ne 0) { throw "npm run dist failed with exit code $LASTEXITCODE" }
  } finally {
    Pop-Location
  }
}

if (-not (Test-Path $buildOut)) {
  Write-Error "No build output at $buildOut -- run without -SkipBuild first."
}

if (Test-Path $InstallDir) {
  robocopy $InstallDir $previousDir /MIR | Out-Null
  if ($LASTEXITCODE -ge 8) { throw "robocopy to rollback slot failed with exit code $LASTEXITCODE" }
}

robocopy $buildOut $InstallDir /MIR | Out-Null
if ($LASTEXITCODE -ge 8) { throw "robocopy to install dir failed with exit code $LASTEXITCODE" }

Write-Host "Installed $buildOut -> $InstallDir (rollback copy at $previousDir)"
