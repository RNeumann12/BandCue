@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\Start-BandCueHost.ps1" -MuseScoreBridge
if errorlevel 1 (
  echo.
  echo BandCue host startup failed.
  pause
)
