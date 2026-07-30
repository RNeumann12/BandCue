@echo off
setlocal
rem Same as "BandCue MuseScore Bridge - Connect.cmd", but this machine also claims
rem BandCue's Play hotkey (Ctrl+Alt+P) system-wide, so a Helix cue reaches BandCue
rem whatever window has focus -- and MuseScore is free to keep the foreground.
rem Use this on the one machine the Helix is plugged into. Extra arguments are
rem passed through (e.g. -Room A4DB23), except -CueHotkey which is already set.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\Start-BandCueMuseScoreAdapter.ps1" -CueHotkey "ctrl+alt+p" %*
if errorlevel 1 (
  echo.
  echo BandCue MuseScore bridge adapter failed to start.
  pause
)
