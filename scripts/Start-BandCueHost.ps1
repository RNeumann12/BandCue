param(
  [switch]$MuseScoreBridge
)

$ErrorActionPreference = "Stop"
$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
Set-Location $RepoRoot

function Stop-WithMessage($Message) {
  Write-Host ""
  Write-Host $Message -ForegroundColor Red
  Write-Host ""
  Write-Host "Install Node.js 20+ from https://nodejs.org/ and run this launcher again." -ForegroundColor Yellow
  exit 1
}

function Resolve-Command($Names) {
  foreach ($name in $Names) {
    $command = Get-Command $name -ErrorAction SilentlyContinue
    if ($command) {
      return $command.Source
    }
  }
  return $null
}

$node = Resolve-Command @("node.exe", "node")
if (-not $node) {
  Stop-WithMessage "Node.js was not found."
}

$nodeVersion = (& $node -p "process.versions.node").Trim()
$nodeMajor = [int]($nodeVersion.Split(".")[0])
if ($nodeMajor -lt 20) {
  Stop-WithMessage "BandCue needs Node.js 20 or newer. Found Node.js $nodeVersion."
}

$npm = Resolve-Command @("npm.cmd", "npm")
if (-not $npm) {
  Stop-WithMessage "npm was not found with Node.js."
}

Write-Host "BandCue public beta host" -ForegroundColor Cyan
Write-Host "Repo: $RepoRoot"
Write-Host "Node.js: $nodeVersion"
Write-Host ""

if (-not (Test-Path (Join-Path $RepoRoot "node_modules"))) {
  Write-Host "Installing BandCue dependencies. This is only needed the first time..." -ForegroundColor Yellow
  & $npm install
  if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
  }
}

Write-Host ""
Write-Host "Running preflight checks..." -ForegroundColor Cyan
& $npm run preflight
if ($LASTEXITCODE -ne 0) {
  exit $LASTEXITCODE
}

$scriptName = if ($MuseScoreBridge) { "dev:all:bridge" } else { "dev" }
Write-Host ""
Write-Host "Starting BandCue with npm run $scriptName" -ForegroundColor Cyan
Write-Host "Keep this window open during rehearsal. Press Ctrl+C to stop BandCue."
Write-Host ""

$processInfo = [System.Diagnostics.ProcessStartInfo]::new()
$processInfo.FileName = $env:ComSpec
$processInfo.Arguments = "/d /s /c `"`"$npm`" run $scriptName`""
$processInfo.WorkingDirectory = $RepoRoot
$processInfo.UseShellExecute = $false
$processInfo.RedirectStandardOutput = $true
$processInfo.RedirectStandardError = $false

$openedHost = $false
# If BandCue exits on its own mid-rehearsal (a crash, not Ctrl+C -- Ctrl+C ends
# this script too), start it again: every device reconnects by itself and the
# host page republishes the setlist. Give up if it keeps dying right away.
$recentCrashes = @()
$process = $null

try {
  while ($true) {
    $process = [System.Diagnostics.Process]::new()
    $process.StartInfo = $processInfo
    [void]$process.Start()
    while (-not $process.StandardOutput.EndOfStream) {
      $line = $process.StandardOutput.ReadLine()
      Write-Host $line
      if (-not $openedHost -and $line -match "Host controls:\s+(http://\S+)") {
        $openedHost = $true
        Start-Process $Matches[1]
      }
    }
    $process.WaitForExit()
    $exitCode = $process.ExitCode
    if ($exitCode -eq 0) {
      exit 0
    }

    $now = Get-Date
    $recentCrashes = @($recentCrashes | Where-Object { ($now - $_).TotalSeconds -lt 60 }) + $now
    if ($recentCrashes.Count -gt 5) {
      Write-Host ""
      Write-Host "BandCue keeps stopping (exit code $exitCode); not restarting it again." -ForegroundColor Red
      exit $exitCode
    }
    Write-Host ""
    Write-Host "BandCue stopped unexpectedly (exit code $exitCode). Restarting in 2 seconds..." -ForegroundColor Yellow
    Write-Host "Devices reconnect by themselves; keep the host page open." -ForegroundColor Yellow
    Start-Sleep -Seconds 2
  }
} finally {
  if ($process -and -not $process.HasExited) {
    $process.Kill($true)
  }
}
