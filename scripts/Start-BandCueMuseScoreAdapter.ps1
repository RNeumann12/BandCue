param(
  [string]$Room,
  [string]$Name = "MuseScore ($env:COMPUTERNAME)",
  # Claims host shortcuts system-wide on this machine. CueHotkey remains the
  # backward-compatible name for Play; the others mirror the host page actions.
  [Alias("PlayHotkey")]
  [string]$CueHotkey,
  [string]$ArmHotkey,
  [string]$StopHotkey,
  [string]$NextSongHotkey,
  [string]$PreviousSongHotkey,
  [string]$OpenSongHotkey,
  [string]$AutoAdvanceHotkey,
  [string]$AutoStartHotkey,
  # Opens the localhost bridge on this port so the BandCue MuseScore plugin can
  # attach. Without it the plugin has nothing to connect to, and playback falls
  # back to keystrokes -- which cannot reset the playhead to the start of a score.
  [int]$BridgePort
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
if ($ArmHotkey) {
  $npmArgs += @("--arm-hotkey", $ArmHotkey)
}
if ($StopHotkey) {
  $npmArgs += @("--stop-hotkey", $StopHotkey)
}
if ($NextSongHotkey) {
  $npmArgs += @("--next-song-hotkey", $NextSongHotkey)
}
if ($PreviousSongHotkey) {
  $npmArgs += @("--previous-song-hotkey", $PreviousSongHotkey)
}
if ($OpenSongHotkey) {
  $npmArgs += @("--open-song-hotkey", $OpenSongHotkey)
}
if ($AutoAdvanceHotkey) {
  $npmArgs += @("--auto-advance-hotkey", $AutoAdvanceHotkey)
}
if ($AutoStartHotkey) {
  $npmArgs += @("--auto-start-hotkey", $AutoStartHotkey)
}
if ($BridgePort -gt 0) {
  $npmArgs += @("--bridge-port", "$BridgePort")
}

Write-Host ""
if ($Room) {
  Write-Host "Connecting to BandCue room '$Room' as '$Name'..." -ForegroundColor Cyan
} else {
  Write-Host "Searching this network for a running BandCue room, connecting as '$Name'..." -ForegroundColor Cyan
  Write-Host "(Pass -Room <code|host:port|URL> to skip discovery and target a specific host.)" -ForegroundColor DarkGray
}
if ($CueHotkey -or $ArmHotkey -or $StopHotkey -or $NextSongHotkey -or $PreviousSongHotkey -or $OpenSongHotkey -or $AutoAdvanceHotkey -or $AutoStartHotkey) {
  Write-Host "Claiming configured BandCue shortcuts system-wide, so they work whatever window has focus." -ForegroundColor Cyan
}
if ($BridgePort -gt 0) {
  Write-Host "Bridge open on 127.0.0.1:$BridgePort - enable the 'BandCue Bridge' plugin in MuseScore and leave its window open." -ForegroundColor Cyan
}
Write-Host "This gives the BandCue room full control of MuseScore on this machine. Keep this window open during rehearsal. Press Ctrl+C to stop." -ForegroundColor Cyan
Write-Host ""

& $npm @npmArgs
exit $LASTEXITCODE
