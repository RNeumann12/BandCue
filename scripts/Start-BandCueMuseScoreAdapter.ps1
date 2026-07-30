param(
  [string]$Room,
  [string]$Name = "MuseScore ($env:COMPUTERNAME)",
  # Claims the cue combination system-wide on this machine, for the PC the Helix
  # (or any other pedal sending keystrokes) is plugged into. Without it the cue
  # only arrives while the host page has keyboard focus -- which MuseScore needs
  # for itself. Use on exactly one machine per room.
  [string]$CueHotkey
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

Write-Host "BandCue MuseScore bridge adapter" -ForegroundColor Cyan
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

$npmArgs = @("run", "dev:musescore", "--", "--name", $Name)
if ($Room) {
  $npmArgs += @("--room", $Room)
}
if ($CueHotkey) {
  $npmArgs += @("--cue-hotkey", $CueHotkey)
}

Write-Host ""
if ($Room) {
  Write-Host "Connecting to BandCue room '$Room' as '$Name'..." -ForegroundColor Cyan
} else {
  Write-Host "Searching this network for a running BandCue room, connecting as '$Name'..." -ForegroundColor Cyan
  Write-Host "(Pass -Room <code|host:port|URL> to skip discovery and target a specific host.)" -ForegroundColor DarkGray
}
if ($CueHotkey) {
  Write-Host "Claiming '$CueHotkey' system-wide as this room's cue, so it reaches BandCue whatever window has focus." -ForegroundColor Cyan
}
Write-Host "This gives the BandCue room full control of MuseScore on this machine. Keep this window open during rehearsal. Press Ctrl+C to stop." -ForegroundColor Cyan
Write-Host ""

& $npm @npmArgs
exit $LASTEXITCODE
