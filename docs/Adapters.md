# BandCue Adapters

An **adapter** is the bridge between an abstract BandCue command (`play` / `stop` / `open-song`)
and a real play/stop in a real player. Adapters connect to the room as `desktop-adapter` clients,
advertise their capabilities in `clientHello`, and continuously report `adapterStatus`.

BandCue ships three adapters:

| Adapter | Player | Platform | Source |
| --- | --- | --- | --- |
| Browser extension | Songsterr | Chrome / Edge (MV3) | [`extension/songsterr/`](../extension/songsterr) |
| Android app | Songsterr | Android (Kotlin) | [`android/`](../android) |
| MuseScore helper | MuseScore Studio | Windows (Node) | [`src/adapters/musescore-windows.ts`](../src/adapters/musescore-windows.ts) |

A shared design rule across all of them: **reset-before-play is best-effort and never blocks
playback**, and **Stop is state-aware, never toggle-like** — repeating Stop must never restart
playback. See the rationale in [Improvements.md](Improvements.md).

---

## Songsterr — Browser Extension

A Manifest V3 extension that drives Songsterr browser tabs.

**Layout**

| File | Role |
| --- | --- |
| `manifest.json` | MV3 manifest. Permissions: `storage`, `tabs`, `videoCapture`; host access to Songsterr + `http://*/*` + `ws://*/*`. |
| `background.js` | Service worker: holds the WebSocket connection, clock sync, discovery, reconnect, and connection intent. |
| `content-script.js` | Injected into Songsterr pages: finds the transport control / media element and performs play/stop/reset. |
| `popup.html` / `popup.css` / `popup.js` | The connect/disconnect UI and readiness panel. |

**Install (unpacked)**

1. `chrome://extensions` → enable **Developer mode** → **Load unpacked**.
2. Select `<project-folder>\extension\songsterr`.
3. Open a Songsterr song tab, click the BandCue icon.
4. Enter a room code, port (e.g. `4173`), or full room URL, or use **Scan QR** on the host join QR code → **Connect**.

Build a distributable zip with `npm run package:extension`.

**Behavior**

- **Discovery** can't use raw UDP from a browser, so a room code / port is resolved by checking
  the local machine, the OS mDNS name (`bandcue.local` / `bandcue-<code>.local`), and a scan of
  common LAN subnets. On an unusual subnet, enter `host:port` (e.g. `192.168.1.23:4173`).
- **QR join** uses the popup camera scanner to decode the host join QR code, fills the room URL,
  and connects immediately after a successful scan. Browsers without native QR decoding still
  support pasted room URLs.
- **Auto-open** — when a transport command arrives and no matching Songsterr tab is open, the
  adapter opens the current song's Songsterr URL first. The extension reuses an already-open
  Songsterr tab and pre-opens it at count-in start.
- **Per-member instrument** — each member picks **Guitar / Bass / Drums**, or **Auto** (the
  default), which inherits the category from the currently open Songsterr tab. Explicit
  per-song `songsterrBassUrl` / `songsterrDrumUrl` fields win for arrangements that live on
  different Songsterr pages. Otherwise the extension rewrites the host URL's instrument slug
  (`-bass-tab` / `-drum-tab`) so everyone lands on their own part. Songs are matched by a
  track-agnostic key (slug- and `t<n>`-agnostic) plus any explicit alternate URLs, so a member
  already on the current song is **never** reloaded onto the host's instrument. The choice is
  persisted per-machine in `chrome.storage.local`.
- **Stop** is no-op when playback already appears stopped, and **never** uses a Space-key
  fallback (which on Songsterr is a toggle and could restart play). It only pauses active media
  elements or clicks a confidently-labelled pause/stop control.
- **Duration** — the extension reports finite media duration and the current tab URL when
  available, which lets the coordinator auto-stop the host UI at end-of-song.
- **Explicit connection control** — the background stores an `autoConnectEnabled` intent. It only
  reconnects when that intent is set. **Disconnect** closes the socket, clears reconnect / clock /
  status timers, and persists "stay disconnected" — reloading the extension, browser, or tab will
  **not** reconnect until you press **Connect** again. The last room value is kept for convenience.
- **MuseScore-host toggle** — a popup option **"Don't auto-open Songsterr tabs (MuseScore host)"**
  stops this machine from popping Songsterr tabs while it plays from MuseScore in bridge mode.

---

## Songsterr — Android

A native Kotlin adapter for controlling the Songsterr Android app. Full phone-setup steps are in
[android/README.md](../android/README.md).

**Components** (`android/app/src/main/java/com/bandcue/songsterr/`)

| File | Role |
| --- | --- |
| `MainActivity.kt` | Connect UI, permission prompts, room entry. |
| `BandCueAdapterService.kt` | Foreground service: WebSocket, clock sync, scheduled command execution, status reporting. |
| `BandCueWebSocketClient.kt` | The room WebSocket client. |
| `BandCueNotificationListenerService.kt` | Reads Android **media sessions** to find Songsterr's `MediaController`. |
| `BandCueAccessibilityService.kt` | Opt-in accessibility fallback: taps visible Songsterr transport / reset controls. |
| `RoomLocator.kt`, `Clock.kt`, `CommandTiming.kt`, `ProtocolJson.kt`, `ResetControl.kt` | Kotlin mirrors of the shared discovery, clock, timing, protocol, and reset logic. |

**Build / install**

```powershell
npm run build:android       # writes android/app/build/outputs/apk/debug/app-debug.apk
adb install -r android/app/build/outputs/apk/debug/app-debug.apk
```

(`npm run build:android` bootstraps Gradle into `android/.gradle-bootstrap/` and uses the
installed Android SDK — no Android Studio required. Tests: `npm run test:android`.)

**Control path**

1. **Media session first.** `play` calls `MediaController.TransportControls.play()`; `stop` calls
   `pause()` on the active Songsterr media session and reports playback `stopped`.
2. **Per-member instrument.** The Android UI also has **Auto / Guitar / Bass / Drums**. Auto uses
   the main Songsterr URL; explicit Bass/Drums use `songsterrBassUrl` / `songsterrDrumUrl` when
   present, otherwise they fall back to the same slug rewrite as the browser extension.
3. **Accessibility fallback (opt-in).** Only when no Songsterr media session is visible, and only
   while Songsterr is foreground, it taps the visible play/pause control. It's opt-in because
   Android treats accessibility as a powerful permission.
4. **Reset-to-start** is located with a layout-aware scorer over the visible toolbar controls
   (anchored on speed / sound-mode / play), with recently-successful geometry cached per layout
   signature. When reset can't be identified confidently it reports skipped/missing rather than
   faking success — and play still proceeds.
5. If Songsterr is missing or neither path is available, it reports a clear not-ready / failed
   state instead of pretending to be controllable.

**Disconnect** persists offline intent and stops reconnect, clock sync, pending transport tasks,
the socket, and the foreground service (the service no longer restarts sticky after a user
disconnect). Reopen and press **Connect** for the next rehearsal.

---

## MuseScore on Windows

A Node helper that drives MuseScore Studio. It has two control paths: a **localhost bridge API**
(preferred, for a plugin or external helper) and a **Windows keyboard fallback**.

**Run**

```powershell
npm run dev:musescore -- --name "MuseScore laptop"
```

On the default local port no room URL is needed. Pass `--port`, `--room <CODE>`, or a full room
URL to target a specific host. Every flag is in [Configuration.md](Configuration.md#musescore-helper-flags).

**Keyboard control**

The helper detects a MuseScore window, confirms Windows made it foreground, then sends shortcuts
(only when no bridge helper handled the command first):

- **Stop** → `{ESC}`.
- **Play** (default `--play-mode stop-then-play`) → `{ESC}`, brief wait, then `Space`. This keeps
  an already-playing score from being toggled off by a Play command. `--play-mode single-key`
  restores the single-key toggle.
- **Reset-before-play** → `^{HOME}` (Ctrl+Home) to move the cursor to the start of the score.

The host page shows the active MuseScore window title, whether playback is inferred playing or
stopped from the last successful command, and a visible failure if Windows could not activate the
MuseScore window.

**Local score catalog & auto-open**

Pass one or more score folders to publish a privacy-safe catalog and auto-open scores:

```powershell
npm run dev:musescore -- --score-folder "C:\Users\you\Documents\MuseScore4\Scores"
```

- Scans `.mscz` / `.mscx` recursively (toggle with `--score-recursive 0`).
- Publishes only **title + folder-relative path** — absolute local paths stay private.
- A MuseScore setlist item matches by title, extensionless score name, or relative path such as
  `CCR\Bad Moon Rising`.
- The host UI shows `matched` / `ambiguous` / `missing` / `not-applicable` and warns when the
  active score title doesn't match the current MuseScore setlist item.
- Auto-open requires **exactly one** match; ambiguous or missing matches are reported, not opened.

### MuseScore Bridge API

When started with `--bridge-port` (e.g. `4731`), the helper exposes a small HTTP API on
`127.0.0.1` so a MuseScore plugin or external script can take over playback with real playback
state instead of relying on simulated keystrokes.

| Method & path | Purpose |
| --- | --- |
| `GET /status` | Current bridge status, current song, and `{ fallbackMs, lastSeenAt }`. |
| `GET /catalog` | The privacy-safe local score catalog (title + relative path). |
| `GET /commands` | Queued/claimed BandCue commands, soonest first. Each carries `sequenceId`, `action`, `dueLocalAt`, `scheduledServerTime`, `resetBeforePlay`, and the current MuseScore song. |
| `POST /commands/{sequenceId}/claim` | Claim a command (body `{ "controlPath": "musescore-plugin" }`). |
| `POST /commands/{sequenceId}/result` | Report the outcome (`{ "status": "succeeded", "playback": "playing", "title": "…", "controlPath": "…" }`). |
| `POST /status` | Push status to the helper (`{ "ready": true, "title": "…", "playback": "playing" }`). |

**Example flow** (PowerShell):

```powershell
# Poll for work
Invoke-RestMethod http://127.0.0.1:4731/commands

# Claim sequence 12
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:4731/commands/12/claim `
  -Body '{"controlPath":"musescore-plugin"}' -ContentType application/json

# Report the result after executing it
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:4731/commands/12/result `
  -Body '{"status":"succeeded","playback":"playing","title":"Song Title","controlPath":"musescore-plugin"}' `
  -ContentType application/json
```

**Fallback timing.** If a bridge helper has contacted the adapter but no result arrives within
`--bridge-fallback-ms` (default **900 ms**) after the scheduled time, the Windows keyboard path
runs. If no helper is polling at all, the keyboard fallback runs immediately at the scheduled
time. The bridge queue carries `open-song` commands too, completed through the same claim/result
endpoints; if no helper handles `open-song`, the Windows helper opens the single matched local
score itself.

For driving the host entirely from MuseScore while the band stays on Songsterr, see
[Running the Host on MuseScore (Bridge Mode)](../README.md#running-the-host-on-musescore-bridge-mode).
</content>
