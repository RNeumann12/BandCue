@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\Start-BandCueMuseScoreAdapter.ps1" %*
if errorlevel 1 (
  echo.
  echo BandCue MuseScore bridge adapter failed to start.
  pause
)
