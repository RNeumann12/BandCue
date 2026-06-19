# BandCue Improvements Plan

This document captures the next practical improvements after the working MVP. The current MVP proves the core idea: a local coordinator can schedule playback commands for Songsterr and MuseScore on the same network.

## Recommended Next Chunk

Start with **adapter status plus improved host UI**.

This gives the fastest payoff because every later improvement becomes easier to test when the host page clearly shows which device is ready, what command was sent, and whether the adapter believes it succeeded.

## Current Implementation Notes

- Adapter status, command feedback, host transport controls, and warnings are implemented.
- A simple setlist flow is now implemented: the host stores songs locally, selects the current song, and the coordinator broadcasts that current-song state to companions.
- Latency and jitter calibration is implemented: the host can view timing quality and set per-device manual offsets, persisted locally by device name.
- Safety controls are implemented: host arming is required before Play, Play disarms after acceptance, and the host can choose stop-control mode.
- Install/run polish is implemented for the current repo shape: preflight checks, one-command local rehearsal startup, and Songsterr extension zip packaging.
- MuseScore integration now has a bridge command lifecycle, bridge-reported playback/title status, current-song title mismatch warnings, and Windows keyboard control as the fallback.
- MuseScore songs remain manual in v1. BandCue does not auto-open MuseScore files yet.

## 1. Adapter Status And Command Feedback

### Goal

Show reliable per-device state instead of only assuming that a shortcut or click worked.

### Changes

- Track adapter states such as `ready`, `not ready`, `command pending`, `last command succeeded`, and `last command failed`.
- Have Songsterr report which control path it used, for example media element, player button, or fallback shortcut.
- Have MuseScore report whether the window was found and whether the keyboard command was sent successfully.
- Display last command time and result on the host page.

### Done When

- The host page shows clear status for each MuseScore and Songsterr client.
- Failed commands are visible without checking terminal output.
- Manual testing can identify which device missed a command.

## 2. Improved Host UI

### Goal

Make the leader workflow obvious during rehearsal.

### Changes

- Add a large transport area with Play, Stop, current state, countdown, and elapsed time.
- Show the current leader device.
- Show connected devices in a dense, readable list.
- Highlight warnings such as `MuseScore not ready`, `Songsterr tab missing`, or high clock jitter.
- Disable or warn on Play when no desktop adapter is ready.

### Done When

- The leader can understand the whole session at a glance.
- It is obvious whether pressing Play will control MuseScore, Songsterr, both, or neither.
- The UI works comfortably on a laptop screen and a phone companion screen.

## 3. Better MuseScore Integration

### Goal

Replace fragile keyboard-toggle behavior with a more reliable MuseScore control path.

### Status

Implemented for the current v1 bridge/fallback workflow. The Windows helper still supports keyboard control, but a localhost bridge can now claim and complete scheduled transport commands, report playback/title status, and warn when the active score does not match the current MuseScore setlist item.

### Options

- Build a MuseScore plugin or local helper against the bridge endpoints when direct MuseScore control is available.
- Improve the Windows helper with deeper UI automation if bridge control is not available.
- Keep the keyboard helper as a fallback.

### Done When

- Play and stop commands avoid accidental play toggles in fallback mode and can be completed directly by a bridge helper when available.
- The adapter can report whether MuseScore is currently playing when the bridge reports playback state.
- The adapter can identify the active score title from bridge status or the visible MuseScore window title.

## 4. Simple Setlist Flow

### Goal

Organize a rehearsal around songs instead of only a generic room.

### Status

Implemented for the v1 manual workflow.

### Changes

- Add a local setlist with song title, source type, and optional notes.
- For Songsterr songs, store the URL.
- For MuseScore songs, store a filename or human-readable score title.
- Add a `current song` state on the host page.
- Keep v1 behavior manual: songs still need to be opened and positioned by the user.

### Done When

- The host can step through a rehearsal list.
- Followers can see which song is active.
- BandCue does not yet need to auto-open files or URLs.

## 5. Latency And Jitter Calibration

### Goal

Make sync quality visible and tunable.

### Status

Implemented for host-visible timing telemetry and manual per-device start offsets.

### Changes

- Show each device's clock offset, round-trip time, and jitter.
- Warn when a device has unstable timing.
- Add optional per-device manual offset, for example `start this device 80 ms earlier`.
- Persist calibration locally per device name.

### Done When

- The host can see when Wi-Fi conditions are too unstable for tight sync.
- A slightly late or early display can be compensated without changing the global start delay.

## 6. Install And Run Polish

### Goal

Reduce setup friction for rehearsals.

### Status

Implemented for the developer workflow.

### Changes

- Add one command or launcher for the coordinator and MuseScore helper on the same machine.
- Add clearer startup checks for Node, Chrome extension installation, room URL, and MuseScore detection.
- Package the Chrome extension as a zip for easier loading.
- Later, build a small Windows app or tray app.

### Done When

- Starting a rehearsal no longer requires remembering multiple terminal commands.
- New band members can join with only the QR code.
- Desktop leaders have a repeatable startup flow.

## 7. Safety Controls

### Goal

Avoid accidental starts and stops during rehearsal.

### Status

Implemented.

### Changes

- Add an `armed` state before scheduled playback.
- Prevent double-clicked Play from sending duplicate requests.
- Add a mode where only the host can start or stop playback.
- Optionally allow `everyone can stop` as a rehearsal panic button mode.

### Done When

- Accidental clicks do not disrupt playback.
- The band can choose between strict host control and more relaxed rehearsal control.

## Suggested Implementation Order

1. Adapter status and command feedback.
2. Improved host UI.
3. MuseScore integration hardening.
4. Simple setlist flow.
5. Latency and jitter calibration.
6. Install and run polish.
7. Safety controls.
