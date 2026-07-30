@echo off
setlocal
rem The full Helix setup for the machine the pedal is plugged into. Two things on
rem top of the plain Connect launcher:
rem
rem   -CueHotkey  claims BandCue's Play hotkey (Ctrl+Alt+P) system-wide, so the
rem               cue arrives whatever window has focus.
rem   -BridgePort opens the localhost bridge for the "BandCue Bridge" MuseScore
rem               plugin, which is what starts playback at bar 1 -- keystrokes
rem               cannot move MuseScore's playback position.
rem
rem Enable the plugin in MuseScore (Home > Plugins) and leave its window open.
rem Use this on one machine per room. Extra arguments are passed through (e.g.
rem -Room A4DB23), except -CueHotkey and -BridgePort which are already set.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\Start-BandCueMuseScoreAdapter.ps1" -CueHotkey "ctrl+alt+p" -BridgePort 4731 %*
if errorlevel 1 (
  echo.
  echo BandCue MuseScore bridge adapter failed to start.
  pause
)
