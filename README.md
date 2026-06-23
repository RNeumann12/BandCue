# BandCue

**Local-first playback sync for band rehearsals.**

BandCue keeps a whole band on the same beat. One machine runs a **coordinator** on the
rehearsal Wi-Fi. It sends *scheduled* transport commands (play / stop) to desktop and mobile
**adapters** that drive real players — Songsterr in Chrome/Edge, Songsterr on Android, or
MuseScore on Windows — so every device starts the song together. Phones and tablets can also
join as **companion** displays that mirror the countdown, leader, and current-song state.

Everything runs on the local network. There is no cloud service, no account, and no internet
dependency once the dependencies are installed.

---

## Table of Contents

- [Why BandCue](#why-bandcue)
- [How It Works](#how-it-works)
- [Quick Start](#quick-start)
- [Roles](#roles)
- [Joining a Room](#joining-a-room)
- [Using the Host Controls](#using-the-host-controls)
  - [Setlist Flow](#setlist-flow)
  - [Safety Controls](#safety-controls)
  - [Timing Calibration](#timing-calibration)
- [Adapters](#adapters)
  - [Songsterr in Chrome / Edge](#songsterr-in-chrome--edge)
  - [Songsterr on Android](#songsterr-on-android)
  - [MuseScore on Windows](#musescore-on-windows)
- [Running the Host on MuseScore (Bridge Mode)](#running-the-host-on-musescore-bridge-mode)
- [V1 Limits](#v1-limits)
- [Documentation](#documentation)
- [Project Layout](#project-layout)
- [Development](#development)

---

## Why BandCue

When a band rehearses with tabs or scores on multiple screens, hitting "play" by hand never
lines up — one phone is a beat ahead, a laptop a beat behind. BandCue solves the coordination
problem rather than the audio problem:

- **Scheduled start.** Instead of "go now", the coordinator says "go at server-time T". Every
  device counts down to the same instant using a synchronized clock, so they start together.
- **Per-device calibration.** Devices with consistent lag can be nudged earlier or later.
- **Reset-to-top.** Pressing Play seeks each player back to the start of the song first, so the
  band stays together even after someone scrolled around.
- **Local-first.** The coordinator, the web UI, and discovery all live on the rehearsal LAN.

## How It Works

```
                    rehearsal Wi-Fi / LAN
   ┌───────────────────────────────────────────────────────────┐
   │                                                            │
   │   ┌──────────────┐         WebSocket (/ws?token=…)         │
   │   │  Coordinator │◄───────────────┬───────────────┬──────┐ │
   │   │  (Node.js)   │                │               │      │ │
   │   │              │  HTTP + QR     │               │      │ │
   │   │  - room state│  UDP discovery │               │      │ │
   │   │  - scheduling│  mDNS          │               │      │ │
   │   └──────┬───────┘                │               │      │ │
   │          │ serves                 │               │      │ │
   │   ┌──────▼───────┐        ┌───────▼──────┐ ┌──────▼────┐ │ │
   │   │  Web host /  │        │  Browser     │ │  Android  │ │ │
   │   │  companion   │        │  extension   │ │  adapter  │ │ │
   │   │  (web/)      │        │  (Songsterr) │ │(Songsterr)│ │ │
   │   └──────────────┘        └──────────────┘ └───────────┘ │ │
   │                           ┌──────────────┐               │ │
   │                           │  MuseScore   │◄──────────────┘ │
   │                           │  Win helper  │                 │
   │                           └──────────────┘                 │
   └───────────────────────────────────────────────────────────┘
```

The coordinator assigns a **room code** and a secret **token**, keeps the authoritative room
state (transport, setlist, current song, safety, connected clients), and broadcasts that state
to everyone over WebSocket. Adapters report their readiness and playback status back. A
synchronized clock (NTP-style offset/RTT/jitter measurement) lets the coordinator schedule a
start time that all devices honor at once.

For the full picture, see [docs/Architecture.md](docs/Architecture.md).

## Quick Start

Requires **Node.js 20+** on the coordinator machine.

```powershell
npm install
npm run dev
```

The coordinator prints a host URL, a companion URL, a room code, and a WebSocket endpoint. Open
the **host** URL on the coordinator machine to drive the rehearsal. Band members open the
**companion** URL (or scan the QR code at `/qr.svg`).

Check your setup before rehearsal:

```powershell
npm run preflight
```

Run the coordinator **and** the local MuseScore helper together on one Windows machine:

```powershell
npm run dev:all
```

Package the Chrome/Edge extension into a distributable zip:

```powershell
npm run package:extension
```

See [docs/Development.md](docs/Development.md) for every script, environment variable, and the
test/build workflow.

## Roles

Every connection identifies itself as one of three roles:

| Role              | What it is                                              | Can control transport? |
| ----------------- | ------------------------------------------------------- | ---------------------- |
| **host**          | The web control page (`/host`). Owns setlist & safety.  | Yes                    |
| **desktop-adapter** | A player driver: browser extension, Android app, MuseScore helper. | Yes, when ready and permitted by control mode |
| **companion**     | The web room page (`/`). A read-only mirror for screens. | No (display only)      |

## Joining a Room

Adapters and companions can reach the room several ways, in order of reliability:

1. **Full room URL** (with `?token=…`) — always works; copy it from the host page or terminal.
2. **`host:port`** — e.g. `192.168.1.23:4173`. Reliable when discovery is blocked.
3. **Room code** — the 6-character code (e.g. `47B06D`).
4. **Port only** — e.g. `4173`, when the coordinator is on a default subnet.

With a room code or port, adapters try (a) the local machine, (b) the OS mDNS resolver
(`bandcue.local` / `bandcue-<code>.local`), (c) a UDP broadcast (native clients only), and
(d) a scan of common rehearsal subnets. If your network uses an unusual subnet or blocks
broadcast/multicast, use the `host:port` or full-URL path. See
[docs/Networking.md](docs/Networking.md) for the discovery details.

> The **token** is the secret that authorizes a WebSocket connection. The room code is *not*
> secret — it only helps locate the host. Anyone with the token can join the room.

## Using the Host Controls

Open the host URL (`/host?token=…`). The host page is the only place the setlist, safety, and
calibration are edited; its state lives in that browser's local storage.

### Setlist Flow

Use the **Setlist** panel to add songs for the rehearsal. Each song can carry a title, a source
type, a Songsterr URL, a MuseScore score reference, optional notes, and (once known) a duration.

- **Make Current**, **Previous**, **Next** publish the current song to every companion.
- **Export** / **Import** move setlists between host browsers (the setlist is stored locally).
- **Open Current Song** asks connected adapters to open the current song's source. The Songsterr
  adapter also opens the current URL automatically before a transport command when no matching
  tab is present.
- A single setlist entry can target **both** Songsterr and MuseScore at once (a `songsterrUrl`
  for band mates, a `museScoreSource` for whoever drives MuseScore).

MuseScore songs open automatically when the MuseScore helper has a configured score folder and
exactly one local catalog entry matches the current item. The helper warns on a title mismatch,
or when the local match is missing or ambiguous.

### Safety Controls

The host must press **Arm** before **Play** is available. Play auto-disarms after a request is
accepted, preventing accidental double starts. The host picks a control mode:

- **Host only** — only the host can start or stop.
- **Leader can stop** — the host starts; the current transport leader or host can stop.
- **Everyone can stop** — any connected device can stop playback.

### Timing Calibration

The host page shows each device's round-trip time, clock offset, jitter, and an overall timing
quality. Use the **Timing** panel's manual offset when a device consistently starts early or
late: negative values start it earlier, positive later. Offsets are saved per device name in the
host browser and re-applied when that device reconnects.

## Adapters

Adapters are the drivers that turn a BandCue command into a real play/stop on a real player.
Full details for each one live in [docs/Adapters.md](docs/Adapters.md).

### Songsterr in Chrome / Edge

1. Open `chrome://extensions`, enable **Developer mode**, click **Load unpacked**.
2. Select `<project-folder>\extension\songsterr`.
3. Open a Songsterr song tab, click the BandCue extension icon.
4. Enter the room code, the coordinator port (e.g. `4173`), or the full room URL, then **Connect**.

The extension can't use raw UDP, so room-code/port lookup checks the local machine, the OS mDNS
name, and common LAN subnets. On an unusual subnet, enter `host:port`. **Disconnect** keeps the
extension offline until you press **Connect** again — it will not silently reconnect.

#### On iPad / iPhone

Chrome extensions **do not** run in Chrome or Safari on iPadOS/iOS. Use the
[Orion browser](https://browser.kagi.com/) instead — it supports loading Chrome/Firefox
extensions, so the BandCue Songsterr extension works there. On iPad/iPhone, auto-discovery
(room code, port, mDNS, LAN scan) does **not** work — you must connect with the full
`host:port` (e.g. `192.168.1.23:4173`) or the full room URL.

### Songsterr on Android

A native Android adapter lives in `android/`. Build the debug APK with `npm run build:android`,
install it (`adb install -r android/app/build/outputs/apk/debug/app-debug.apk`), enable
**Notification Access** (and optionally the opt-in **Accessibility Fallback**), and connect with
a room URL, `host:port`, room code, or port.

It connects as a Songsterr desktop adapter and uses Android **media sessions** to request
play/pause first; if Songsterr exposes no active media session, the opt-in accessibility fallback
taps the visible transport control while Songsterr is foreground. **Disconnect** stops reconnect,
clock sync, pending work, the socket, and the foreground service. See
[android/README.md](android/README.md) for phone setup.

### MuseScore on Windows

Keep `npm run dev` running. Open a score in MuseScore Studio, then start the helper:

```powershell
npm run dev:musescore -- --name "MuseScore laptop"
```

On the default local port no room URL is needed. If you changed the port, pass `--port 5000`;
you can also pass `--room ABC123` (the room code) or the full room URL to target another host.
Do not pass the literal placeholders `HOST`, `TOKEN`, `YOUR_HOST`, or `ROOM_TOKEN`.

The helper detects a MuseScore window, confirms Windows made it the foreground app, and sends
keyboard shortcuts (when no local bridge handles the command first). For Stop it sends `{ESC}`.
For Play the default is safer than a single toggle: `{ESC}`, a short wait, then `Space`, so an
already-playing score isn't accidentally toggled off. Use `--play-mode single-key` for the old
behavior.

To publish and auto-open local scores, pass one or more folders:

```powershell
npm run dev:musescore -- --score-folder "C:\Users\you\Documents\MuseScore4\Scores"
```

It scans `.mscz`/`.mscx` files recursively and publishes only titles plus folder-relative paths —
full local paths stay private. Every CLI flag is documented in
[docs/Configuration.md](docs/Configuration.md).

## Running the Host on MuseScore (Bridge Mode)

When you want *this* host to play from MuseScore while the rest of the band uses Songsterr:

```powershell
npm run dev:all:bridge
```

This is shorthand for `npm run dev:all -- --musescore-bridge`. It launches the coordinator and
starts the MuseScore helper with `--bridge-port 4731` instead of plain keyboard control. Pass a
custom port with `--musescore-bridge 5050`, or set `BANDCUE_MUSESCORE_BRIDGE=4731` (or `=1` for
the default port).

In bridge mode, also tick **Don't auto-open Songsterr tabs (MuseScore host)** in the extension
popup (or disconnect the extension) so this machine doesn't pop open Songsterr tabs.

External helpers (a MuseScore plugin or local script) can drive playback through the bridge HTTP
API on `127.0.0.1:4731`: report status to `POST /status`, poll `GET /commands`, claim/complete
with `POST /commands/{sequenceId}/claim` and `/result`, and read the privacy-safe local catalog
from `GET /catalog`. If no bridge helper handles a command within the fallback window
(`--bridge-fallback-ms`, default 900 ms after the scheduled time), the Windows keyboard path
runs as the fallback. The full bridge protocol is in [docs/Adapters.md](docs/Adapters.md#musescore-bridge-api).

## V1 Limits

- Same Wi-Fi only.
- MuseScore auto-open requires a configured score folder and a single matching local score;
  otherwise the host shows missing or ambiguous catalog status.
- Play / stop only.
- Phones are companion displays by default; Android phones can be app controllers only through
  the native adapter.
- Only the leader's device should feed audible click / backing audio to the mixer.

## Documentation

| Doc | What's inside |
| --- | --- |
| [docs/Architecture.md](docs/Architecture.md) | Components, data flow, timing model, room state, safety |
| [docs/Protocol.md](docs/Protocol.md) | WebSocket message reference (client ↔ server) |
| [docs/Adapters.md](docs/Adapters.md) | Browser, Android, and MuseScore adapters + the bridge API |
| [docs/Networking.md](docs/Networking.md) | Room locators, mDNS, UDP discovery, LAN scan, token/auth |
| [docs/Configuration.md](docs/Configuration.md) | Every CLI flag, env var, and default |
| [docs/Development.md](docs/Development.md) | Scripts, tests, building the extension and APK |
| [docs/Improvements.md](docs/Improvements.md) | Living tracker of active reliability work |

## Project Layout

```
src/
  server/      Coordinator: HTTP + WebSocket, room state, discovery responders
  shared/      Protocol types, clock math, transport rules, discovery/locator helpers
  adapters/    MuseScore Windows helper + local score catalog
  tools/       preflight, one-command rehearsal start, extension packaging
web/           Host controls + companion view (static HTML/CSS/JS)
extension/     Chrome/Edge MV3 Songsterr adapter
android/       Native Kotlin Songsterr adapter (sideload/debug APK)
docs/          This documentation set
scripts/       build-android.ps1
```

## Development

```powershell
npm run check    # type-check (tsc --noEmit)
npm test         # unit tests (vitest)
npm run build    # compile TypeScript
```

Android JVM tests run via `npm run test:android`. See [docs/Development.md](docs/Development.md)
for the full workflow, including how the Android build bootstraps Gradle without Android Studio.
</content>
</invoke>
