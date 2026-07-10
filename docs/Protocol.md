# BandCue Protocol Reference

BandCue clients and the coordinator exchange JSON messages over a single WebSocket. This document
describes every message type. The authoritative definition is
[`src/shared/protocol.ts`](../src/shared/protocol.ts) — if this doc and the types disagree, the
types win.

## Transport & Framing

- **Endpoint:** `ws://<host>:<port>/ws?token=<ROOM_TOKEN>`. A missing or wrong token is rejected
  with `HTTP 401` during the upgrade.
- **Encoding:** each WebSocket message is a single UTF-8 JSON object with a `type` discriminator.
- **Handshake:** the client's **first** message must be a `clientHello`. Anything else closes the
  socket with code `1008`.
- **Unparseable messages** are ignored (server) rather than crashing the connection.

```
client                                   server
  │ ── clientHello ───────────────────────►│
  │ ◄──────────────────────── serverHello ──│
  │ ◄─────────────────────────── roomState ─│   (broadcast on every change)
  │ ── clockSync ──────────────────────────►│
  │ ◄────────────────────── clockSyncResult │
  │ ── clockStatus ────────────────────────►│
  │ ── transportRequest ───────────────────►│
  │ ◄──────── transportCommand (broadcast) ─│
  │ ◄──────── roomState (broadcast) ────────│
```

## Common Enums

| Type | Values |
| --- | --- |
| `ClientRole` | `host` · `desktop-adapter` · `companion` |
| `AppType` | `musescore` · `songsterr` · `mock` |
| `TransportAction` | `play` · `stop` |
| `AdapterCommandAction` | `play` · `stop` · `open-song` |
| `TransportStatus` | `stopped` · `scheduled` · `running` |
| `StopReason` | `manual` · `auto-duration` · `auto-playback-ended` · `leader-disconnect` |
| `SongSourceType` | `songsterr` · `musescore` · `other` |
| `ControlMode` | `host-only` · `leader-stop` · `everyone-can-stop` |
| `AdapterState` | `ready` · `not-ready` · `command-pending` · `last-command-succeeded` · `last-command-failed` |
| `AdapterPlaybackState` | `playing` · `stopped` · `unknown` |
| `AdapterCommandStatus` | `pending` · `succeeded` · `failed` |
| `CatalogMatchStatus` | `matched` · `ambiguous` · `missing` · `not-applicable` |
| `SongDurationSource` | `adapter` · `manual` |

---

## Client → Server messages

A `ClientMessage` is one of: `clientHello`, `clockSync`, `clockStatus`, `calibrationUpdate`,
`adapterStatus`, `currentSongUpdate`, `setlistUpdate`, `safetyUpdate`, `openSongRequest`,
`transportRequest`.

### `clientHello`
First message after connecting. Declares who you are and what you can do.

```jsonc
{
  "type": "clientHello",
  "deviceName": "MuseScore laptop",
  "role": "desktop-adapter",
  "capabilities": [{ "app": "musescore", "canPlay": true, "canStop": true }]
}
```

### `clockSync`
Requests a clock sample. The server echoes its receive/send timestamps.

```jsonc
{ "type": "clockSync", "clientSentAt": 1718900000000 }
```

### `clockStatus`
Reports the client's summarized clock so the host can show timing quality.

```jsonc
{ "type": "clockStatus", "rttMs": 12, "offsetMs": -4, "jitterMs": 2 }
```

### `calibrationUpdate` *(host only)*
Sets a per-device manual start offset (clamped to ±5000 ms). Negative = earlier, positive = later.

```jsonc
{ "type": "calibrationUpdate", "targetClientId": "…", "manualOffsetMs": -30 }
```

### `adapterStatus` *(adapters)*
Reports readiness, playback, current title/source, optional duration, optional local catalog, and
the result of the last command. The server merges this into the client summary and may bind a
matching `durationMs` to the current song.

```jsonc
{
  "type": "adapterStatus",
  "ready": true,
  "app": "songsterr",
  "state": "last-command-succeeded",
  "playback": "playing",
  "playbackDetail": "media element playing",
  "title": "Bad Moon Rising Tab by CCR",
  "source": "https://www.songsterr.com/a/wsa/…",
  "durationMs": 138000,
  "durationSource": "adapter",
  "catalog": { "total": 12, "entries": [{ "title": "Bad Moon Rising", "relativePath": "CCR/Bad Moon Rising.mscz" }] },
  "songMatch": { "status": "matched", "title": "Bad Moon Rising", "relativePath": "CCR/Bad Moon Rising.mscz" },
  "detail": "…",
  "lastCommand": { "action": "play", "sequenceId": 7, "status": "succeeded", "at": 1718900001234, "controlPath": "media-session" }
}
```

### `currentSongUpdate` *(host only)*
Publishes which setlist song is current (1-based `index` of `total`).

```jsonc
{ "type": "currentSongUpdate", "song": { "...SetlistSong" }, "index": 2, "total": 8, "updatedAt": 1718900000000 }
```

### `setlistUpdate` *(host only)*
Replaces the whole setlist. The server sanitizes every song and re-derives the current song's
index, or clears it if the current song was removed.

```jsonc
{ "type": "setlistUpdate", "songs": [ { "...SetlistSong" } ], "updatedAt": 1718900000000 }
```

### `safetyUpdate` *(host only)*
Arms/disarms and/or sets the control mode. Omitted fields keep their current value.

```jsonc
{ "type": "safetyUpdate", "armed": true, "controlMode": "leader-stop", "updatedAt": 1718900000000 }
```

### `openSongRequest` *(host only)*
Asks adapters to open the current song's source. Rejected unless the current song applies to
Songsterr or MuseScore. The server answers with a broadcast `openSongCommand`.

```jsonc
{ "type": "openSongRequest", "requestedAt": 1718900000000 }
```

### `transportRequest`
Asks to play or stop. Runs through `decideTransportRequest`; on rejection the requester receives
an `error`, on acceptance everyone receives a `transportCommand` + new `roomState`.

```jsonc
{ "type": "transportRequest", "action": "play", "requestedAt": 1718900000000 }
```

---

## Server → Client messages

A `ServerMessage` is one of: `serverHello`, `clockSyncResult`, `transportCommand`,
`openSongCommand`, `roomState`, `error`.

### `serverHello`
Sent once, right after `clientHello`. Gives the client its id, the room code, the server clock,
and the default scheduling delay.

```jsonc
{ "type": "serverHello", "clientId": "…", "roomCode": "47B06D", "serverTime": 1718900000000, "defaultScheduleDelayMs": 1500 }
```

### `clockSyncResult`
The reply to `clockSync`; the four timestamps feed the offset/RTT computation.

```jsonc
{ "type": "clockSyncResult", "clientSentAt": 1718900000000, "serverReceivedAt": 1718900000005, "serverSentAt": 1718900000006 }
```

### `transportCommand` *(broadcast)*
The scheduled play/stop. `scheduledServerTime` is the agreed start instant in server time; each
client converts it to local time and applies its own `manualOffsetMs`. `resetBeforePlay` is
`true` for play, asking adapters to seek to the top first. `currentSong` carries the song context
so adapters can open the right tab/score.

```jsonc
{
  "type": "transportCommand",
  "action": "play",
  "leaderId": "…",
  "sequenceId": 7,
  "scheduledServerTime": 1718900001500,
  "manualOffsetMs": -30,
  "resetBeforePlay": true,
  "currentSong": { "...CurrentSongState" }
}
```

### `openSongCommand` *(broadcast)*
Asks adapters to open the current song without changing transport.

```jsonc
{ "type": "openSongCommand", "leaderId": "…", "sequenceId": 3, "requestedAt": 1718900000000, "currentSong": { "...CurrentSongState" } }
```

### `roomState` *(broadcast)*
The full authoritative state, sent on every change (clock-only changes are debounced ~400 ms).
See [Architecture.md → Room State](Architecture.md#room-state) for the field meanings.

```jsonc
{
  "type": "roomState",
  "roomCode": "47B06D",
  "serverTime": 1718900000000,
  "clients": [ { "id": "…", "deviceName": "…", "role": "desktop-adapter", "capabilities": [], "status": {…}, "clock": {…} } ],
  "transport": { "status": "stopped", "leaderId": "…", "action": "stop", "sequenceId": 8, "scheduledServerTime": 1718900140000, "stopReason": "auto-playback-ended" },
  "currentSong": { "song": {…}, "index": 2, "total": 8, "updatedAt": 1718900000000 },
  "setlist": { "songs": [], "updatedAt": 1718900000000 },
  "safety": { "armed": false, "controlMode": "leader-stop", "updatedAt": 1718900000000 },
  "companionUrl": "http://192.168.1.10:4173/?token=…",
  "hostUrl": "http://192.168.1.10:4173/host?token=…"
}
```

### `error`
A targeted failure reply (e.g. a rejected transport request or a non-host mutation).

```jsonc
{ "type": "error", "message": "Playback is not armed." }
```

---

## Key data shapes

### `SetlistSong`

```jsonc
{
  "id": "…",
  "title": "Bad Moon Rising",
  "sourceType": "songsterr",        // songsterr | musescore | other
  "source": "https://…",            // primary reference (URL or score name)
  "songsterrUrl": "https://…",      // optional, lets one entry also open in Songsterr
  "songsterrBassUrl": "https://…",  // optional bass override when it is a different Songsterr page
  "songsterrDrumUrl": "https://…",  // optional drums override when it is a different Songsterr page
  "museScoreSource": "CCR/Bad Moon Rising",  // optional, relative path or title for MuseScore
  "durationMs": 138000,             // optional
  "durationSource": "adapter",      // adapter | manual
  "helixSyncEnabled": true,         // optional; Helix sends Play at measure 1 beat 1
  "helixBpm": 120,                  // optional; constant-BPM v1
  "helixBeatsPerMeasure": 4,        // optional; defaults to 4 in host UI
  "helixTargetMeasure": 2,          // optional; start after measure 1 by default
  "helixOffsetMs": -80,             // optional; whole-room offset against Helix timeline
  "notes": "capo 2"                 // optional
}
```

A single song can target multiple apps. `song-sources.ts` resolves each app's reference: the
dedicated field (`songsterrUrl` / `museScoreSource`) wins, else `source` is used when the
primary `sourceType` matches that app. For Songsterr adapters, `songsterrBassUrl` and
`songsterrDrumUrl` override the main Songsterr URL for members who selected those instruments.
When `helixSyncEnabled` is true, the server schedules Play from the Helix fields instead of the
normal adaptive count-in. The target must still leave enough lead time for the room; otherwise Play
is rejected rather than started late.

### `SongCatalogStatus` / `SongCatalogEntry` / `SongCatalogMatch`
Privacy-safe local MuseScore library data published by a bridge/helper. Entries carry only a
`title` and a folder-`relativePath` (never an absolute path). `songMatch` reports whether the
current song resolved to `matched`, `ambiguous`, `missing`, or `not-applicable`. See
[Adapters.md](Adapters.md#musescore-on-windows).
</content>
