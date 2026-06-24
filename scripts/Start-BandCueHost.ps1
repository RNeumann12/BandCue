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

$process = [System.Diagnostics.Process]::new()
$process.StartInfo = $processInfo
$openedHost = $false

try {
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
  exit $process.ExitCode
} finally {
  if ($process -and -not $process.HasExited) {
    $process.Kill($true)
  }
}
