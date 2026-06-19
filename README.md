# BandCue

Local-first playback sync for band rehearsals.

BandCue runs a coordinator on the rehearsal Wi-Fi and sends scheduled transport commands to desktop adapters. Phones and tablets join as companion views and show the same countdown/timer state.

## Quick Start

```powershell
npm install
npm run dev
```

Open the printed host URL on the coordinator machine. Band members scan the QR code or open the companion URL.

Before rehearsal, you can run:

```powershell
npm run preflight
```

On a single Windows machine that runs both the coordinator and MuseScore helper, use:

```powershell
npm run dev:all
```

To package the Chrome/Edge extension as a zip:

```powershell
npm run package:extension
```

## Setlist Flow

Open the host controls URL and use the Setlist panel to add songs for the rehearsal. The setlist is stored locally in the host browser. Selecting **Make Current**, **Previous**, or **Next** publishes the current song to every connected companion view.

Songs can include a source type, a Songsterr URL, a MuseScore score name, and short notes. Use **Export** and **Import** to move setlists between host browsers. If the current song is a Songsterr URL, **Open Songsterr** on the host page asks every connected Songsterr adapter to open the same current song. The Songsterr adapter will also open the current URL automatically before a transport command when no matching tab is available.

MuseScore songs still need the score opened manually. The MuseScore helper warns when the active score title does not appear to match the current MuseScore setlist item.

## Safety Controls

The host must press **Arm** before **Play** becomes available. Play automatically disarms after a request is accepted, which prevents accidental double starts.

The host can choose a control mode:

- **Host only**: only the host can start or stop.
- **Leader can stop**: the host can start, and the current transport leader or host can stop.
- **Everyone can stop**: any connected device can stop playback.

## Timing Calibration

The host page shows each connected device's round-trip time, clock offset, jitter, and timing quality. Use the Timing panel's manual offset when a device consistently starts early or late. Negative values start that device earlier; positive values start it later. Values are saved in the host browser by device name and are re-applied when the device reconnects.

### MuseScore on Windows

Keep `npm run dev` running in one terminal. Open a score in MuseScore Studio, then start the MuseScore helper in a second terminal.

On the default local port, no room URL is needed:

```powershell
npm run dev:musescore -- --name "MuseScore laptop"
```

If you changed the coordinator port, pass the port instead of copying the full token URL:

```powershell
npm run dev:musescore -- --port 5000 --name "MuseScore laptop"
```

You can also pass the printed room code with `--room ABC123`, or still use the full room URL when you need to target another host explicitly. Do not run the literal placeholder values `HOST`, `TOKEN`, `YOUR_HOST`, or `ROOM_TOKEN`.

When you pass a room code or port, the helper first checks the local machine, then broadcasts a small LAN discovery request. The coordinator replies with its HTTP port, and the helper verifies the room through `/api/room` before connecting.

The helper detects a MuseScore window, verifies that Windows made it the foreground app, and sends keyboard shortcuts to the app when no local bridge handles the command first. This keeps the v1 setup pragmatic while allowing a MuseScore plugin or local helper to provide more reliable playback state and score title reporting.

For MuseScore, BandCue sends `{ESC}` for stop. For play, the default is safer than a single toggle: it sends `{ESC}` first, waits briefly, then sends `Space`. That keeps an already-playing score from being accidentally toggled off by a BandCue play command. If your setup needs the old single-key behavior, pass `--play-mode single-key`.

If your MuseScore setup needs different shortcuts or a stricter window match, pass options such as:

```powershell
npm run dev:musescore -- --name "MuseScore laptop" --stop-key "{ESC}" --play-key " " --process-match "MuseScore|mscore" --title-match "Song Title"
```

For a more reliable plugin or local helper path, the MuseScore adapter can expose a small localhost bridge:

```powershell
npm run dev:musescore -- --name "MuseScore laptop" --bridge-port 4731
```

The bridge accepts `POST http://127.0.0.1:4731/status` with JSON such as:

```json
{ "ready": true, "title": "Song Title", "playback": "playing" }
```

External helpers can poll `GET http://127.0.0.1:4731/commands` for scheduled BandCue transport commands. Each command includes `sequenceId`, `action`, `dueLocalAt`, `scheduledServerTime`, and the current MuseScore setlist song when one is selected.

Helpers should optionally claim the command:

```powershell
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:4731/commands/12/claim -Body '{"controlPath":"musescore-plugin"}' -ContentType application/json
```

Then report the result after it executes:

```powershell
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:4731/commands/12/result -Body '{"status":"succeeded","playback":"playing","title":"Song Title","controlPath":"musescore-plugin"}' -ContentType application/json
```

If a bridge helper has contacted the adapter but no bridge result arrives within 900 ms after the scheduled time, the Windows keyboard path runs as the fallback. When no helper is polling the bridge at all, fallback runs immediately at the scheduled time. You can tune the bridge wait window with `--bridge-fallback-ms 1500`.

The host page shows the active MuseScore window title, whether playback is inferred as playing or stopped from the last successful BandCue command, and a visible failure if Windows could not activate the MuseScore window.

### Songsterr in Chrome/Edge

1. Open `chrome://extensions`.
2. Enable Developer mode.
3. Click **Load unpacked**.
4. Select `<project-folder>\extension\songsterr`.
5. Open a Songsterr song tab.
6. Click the BandCue extension icon.
7. Enter the printed room code, the coordinator port such as `4173`, or the full room URL.
8. Click **Connect**.

The extension cannot use raw UDP discovery, so room-code or port lookup checks the local machine and scans common rehearsal LAN ranges. If your network uses a different subnet, enter `host:port`, for example `192.168.1.23:4173`.

### Songsterr on Android

BandCue also includes a native Android adapter in `android/`. Build the debug APK with `npm run build:android`, install it with `adb install -r android/app/build/outputs/apk/debug/app-debug.apk`, enable **Notification Access** or the opt-in **Accessibility Fallback** for BandCue Songsterr, and connect with the printed room URL, `host:port`, room code, or port.

The Android adapter connects as a Songsterr desktop adapter and first uses Android media sessions to request play and pause from the Songsterr app. If Songsterr does not expose an active media session, the opt-in Accessibility fallback taps the visible Songsterr transport control while Songsterr is foreground. If Songsterr is not installed or permissions are missing, the host page shows that state instead of treating the phone as controllable.

## V1 Limits

- Same Wi-Fi only.
- MuseScore songs must already be open and positioned; Songsterr setlist URLs can be opened from the host page.
- Play/stop only.
- Phones are companion displays by default; Android phones can be app controllers only through the native adapter.
- Only the leader's device should feed audible click/backing audio to the mixer.
