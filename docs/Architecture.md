# BandCue Architecture

This document explains how BandCue is put together: the components, how they talk, how timing
and scheduling work, and the shape of the room state they all share.

## Overview

BandCue is a small star network. One **coordinator** process holds the authoritative state and
talks to many clients over WebSocket. Clients fall into three roles — **host**, **desktop-adapter**,
**companion** — described in the [README](../README.md#roles).

```
   host (web /host) ──────┐
                          │  transportRequest / setlistUpdate / safetyUpdate / calibrationUpdate
   companion (web /) ─────┤        (clients → server)
                          ▼
                  ┌───────────────┐   roomState / transportCommand / openSongCommand
                  │  Coordinator  │ ───────────────────────────────────────────────►  all clients
                  │ RoomController│        (server → clients, broadcast)
                  └───────────────┘
                          ▲
   adapters ──────────────┘  adapterStatus / clockSync / clockStatus
   (browser, Android, MuseScore)
```

Nothing leaves the LAN. The coordinator serves the web UI, exposes a single WebSocket endpoint,
and runs two discovery responders (UDP + mDNS).

## Components

### Coordinator (`src/server/`)

| File | Responsibility |
| --- | --- |
| [`index.ts`](../src/server/index.ts) | Process entry. Creates the HTTP server, serves `web/`, generates the room code + token, builds the room URLs, renders the QR SVG, upgrades `/ws` WebSocket connections (token-gated), and starts the discovery responders. |
| [`room.ts`](../src/server/room.ts) | `RoomController` — the heart of BandCue. Tracks clients, transport state, setlist, current song, safety, and per-client clocks; schedules transport and auto-stop; sanitizes all client input; broadcasts room state. |
| [`discovery.ts`](../src/server/discovery.ts) | UDP responder. Answers `bandcue.discovery.request` datagrams with the room code + HTTP port. |
| [`mdns.ts`](../src/server/mdns.ts) | Multicast-DNS responder. Resolves `bandcue.local` / `bandcue-<code>.local` to the server's LAN IP. |

The HTTP surface is intentionally tiny:

| Route | Purpose |
| --- | --- |
| `GET /` | Companion view (`web/index.html`) |
| `GET /host` | Host controls (same HTML; the page reads the path) |
| `GET /api/room` | Current room state as JSON (used by discovery probes) |
| `GET /qr.svg` | QR code encoding the companion URL |
| `GET /<static>` | Files under `web/` (path-traversal guarded) |
| `GET /ws?token=…` | WebSocket upgrade; rejected with 401 if the token is wrong |

### Web client (`web/`)

A single static page ([`index.html`](../web/index.html) + [`app.js`](../web/app.js) +
[`styles.css`](../web/styles.css)) acts as **both** the host control panel (`/host`) and the
companion display (`/`). It connects to `/ws`, renders the broadcast room state (countdown,
leader, elapsed time, ready adapters, current song), and — on the host page — sends setlist,
safety, calibration, and transport messages. Host-side state (setlist, per-device calibration)
is persisted in the browser's local storage, not on the server.

### Shared library (`src/shared/`)

Pure, dependency-light modules reused across the server and the Node adapters (and conceptually
mirrored in the extension and Android clients):

| File | Responsibility |
| --- | --- |
| [`protocol.ts`](../src/shared/protocol.ts) | All wire types — the single source of truth for the [protocol](Protocol.md). |
| [`clock.ts`](../src/shared/clock.ts) | NTP-style clock sample math: offset, RTT, jitter, median summary, and `delayUntilServerTime`. |
| [`transport.ts`](../src/shared/transport.ts) | `decideTransportRequest` — the pure rule that accepts/rejects play/stop given transport + safety + role. |
| [`room-locator.ts`](../src/shared/room-locator.ts) | Turns a user-entered locator (URL / `host:port` / room code / port) into discovery candidates; mDNS host names; LAN subnet list. |
| [`lan-discovery.ts`](../src/shared/lan-discovery.ts) | UDP broadcast discovery client + request/response parsing + broadcast address computation. |
| [`lan-address.ts`](../src/shared/lan-address.ts) | Picks the best LAN IP to advertise from the OS network interfaces. |
| [`song-sources.ts`](../src/shared/song-sources.ts) | Resolves a `SetlistSong` to its Songsterr / MuseScore reference (dedicated field wins, else `source`). |

### Adapters

See [Adapters.md](Adapters.md). In short: the **browser extension** (`extension/songsterr/`)
drives Songsterr tabs, the **Android app** (`android/`) drives Songsterr on a phone, and the
**MuseScore Windows helper** (`src/adapters/musescore-windows.ts`) drives MuseScore via keyboard
or a localhost bridge API. All three connect as `desktop-adapter` clients and report
`adapterStatus`.

### Tools (`src/tools/`)

| Script | Purpose |
| --- | --- |
| [`preflight.ts`](../src/tools/preflight.ts) | Pre-rehearsal checks: Node version, deps, extension/web files present, MuseScore window detected. |
| [`start-rehearsal.ts`](../src/tools/start-rehearsal.ts) | `npm run dev:all` — spawns the coordinator and the MuseScore helper together; handles bridge mode and `--public-host`. |
| [`package-extension.ts`](../src/tools/package-extension.ts) | Zips `extension/songsterr/` for distribution. |

## The Timing Model

The core problem BandCue solves is *starting together*. It does this with a synchronized clock
plus scheduled commands.

### Clock synchronization

Each client periodically sends a `clockSync { clientSentAt }`. The server replies with
`clockSyncResult { clientSentAt, serverReceivedAt, serverSentAt }`. From four timestamps the
client computes an NTP-style sample ([`clock.ts`](../src/shared/clock.ts)):

```
rtt    = (clientReceivedAt − clientSentAt) − (serverSentAt − serverReceivedAt)
offset = ((serverReceivedAt − clientSentAt) + (serverSentAt − clientReceivedAt)) / 2
```

Clients take several samples, keep the lowest-RTT ones, and report a summarized
`clockStatus { rttMs, offsetMs, jitterMs }` back. The server stores this per client and shows it
on the host page as **timing quality**. Recent clocks are cached by a client "identity" key
(role + device name + capabilities) for `RECENT_CLOCK_TTL_MS` (30 s), so a brief reconnect keeps
its calibration.

### Scheduled transport

When a play/stop request is accepted, the coordinator does **not** say "now". It picks a server
timestamp `scheduledServerTime = now + DEFAULT_SCHEDULE_DELAY_MS` (1500 ms) and broadcasts a
`transportCommand` carrying that time. Each client converts it to its own local clock:

```
localFireDelay = max(0, scheduledServerTime − (localNow + serverOffsetMs))
```

…and additionally applies its **manual calibration offset** (the per-device nudge). The result:
all devices fire at the same wall-clock instant despite different clocks and latencies. Stop is
scheduled for `now` (immediate).

### Reset-before-play

Every accepted **play** command sets `resetBeforePlay: true`. Each adapter seeks its player back
to the top of the song using that platform's official seek API on a best-effort basis, then plays
— so the band starts from the same bar. A failed reset must never block playback.

### Per-client manual offset

The host sends `calibrationUpdate { targetClientId, manualOffsetMs }` (clamped to ±1000 ms). The
server stores it on the target's clock and includes it in that client's `transportCommand` as
`manualOffsetMs`. Negative starts earlier, positive later. The host persists offsets by device
name locally and re-applies them on reconnect.

## Room State

`RoomController.getState()` produces the `roomState` object broadcast to everyone. Its parts:

| Field | Meaning |
| --- | --- |
| `roomCode`, `serverTime` | Identity + the server's current time (anchors countdowns). |
| `clients[]` | Every connected client: role, device name, capabilities, last adapter status, and clock (rtt/offset/jitter/manualOffset). |
| `transport` | `{ status: stopped \| scheduled \| running, leaderId, action, sequenceId, scheduledServerTime, startedServerTime }`. |
| `currentSong` | The published current setlist song + index/total. |
| `setlist` | The full ordered song list (host-owned). |
| `safety` | `{ armed, controlMode }`. |
| `companionUrl`, `hostUrl` | The canonical URLs (with token) for sharing / QR. |

### Transport lifecycle

```
 stopped ──play accepted──► scheduled ──(scheduledServerTime reached)──► running
    ▲                                                                       │
    └──────── stop accepted / leader disconnect / duration auto-stop ◄──────┘
```

- **scheduled → running**: a server timer fires at `scheduledServerTime` and flips the state.
- **Leader disconnect**: if the transport leader drops while not stopped, the server broadcasts a
  Stop and returns to stopped.
- **Duration auto-stop**: if the current song has a known `durationMs`, the server schedules an
  auto-stop at `startedServerTime + durationMs`. This updates the room/UI state to **stopped**
  but deliberately **does not broadcast a Stop command** — clients that already auto-stopped
  shouldn't be toggled. (Stop on toggle-like players is fragile; see [Improvements.md](Improvements.md).)

### Song duration discovery

Adapters may report `durationMs` in their `adapterStatus`. When a report matches the current song
(by normalized source URL, or by exact normalized title after stripping a Songsterr "… Tab by …"
suffix), the server records `durationSource: "adapter"` on the song and (re)arms the auto-stop
timer. This is how the host UI knows when a song ends without anyone pressing Stop.

## Safety & Permissions

`decideTransportRequest` ([`transport.ts`](../src/shared/transport.ts)) is the single gate for
every transport request. Summary of the rules:

- **Play** requires `safety.armed === true`, requires the room to be `stopped`, and — in
  `host-only` mode — requires the host. A non-host must be a *ready* adapter with both
  `canPlay` and `canStop` capabilities.
- **Stop** requires the room to be non-stopped. Permission depends on control mode:
  `host-only` (host only), `leader-stop` (host or the current leader), `everyone-can-stop` (anyone).
- Accepting a play **disarms** safety, so the host must re-Arm for the next start.

Host-only mutations (`setlistUpdate`, `currentSongUpdate`, `safetyUpdate`, `calibrationUpdate`,
`openSongRequest`) are rejected with an `error` message if they come from a non-host client.

## Input Hardening

The server treats all client input as untrusted. `RoomController` sanitizes everything it stores:
text fields are whitespace-collapsed and length-capped; durations are bounded to (0, 24 h];
catalog relative paths are normalized and rejected if absolute or containing `..`; manual offsets
are clamped; song source types are constrained to the known enum. The HTTP file handler refuses
any resolved path that escapes `web/`.

## Related Reading

- [Protocol.md](Protocol.md) — every message type on the wire.
- [Networking.md](Networking.md) — discovery, mDNS, and the token model.
- [Adapters.md](Adapters.md) — how each adapter turns a command into a real play/stop.
</content>
