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
| `StopReason` | `manual` · `auto-duration` · `auto-playback-ended` · `leader-disconnect` *(legacy, never emitted)* |
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
  "lastCommand": { "action": "play", "sequenceId": 7, "status": "succeeded", "at": 1718900001234, "controlPath": "media-session", "startMeasure": 8 }
}
```

A MuseScore helper also sends **`scores`**: one entry per MuseScore song of the setlist that it
matched to a local score, `{ songId, relativePath, status, scoreId?, detail? }` with `status` one of
`queued`, `exporting`, `ready` (then `scoreId` names the uploaded files) or `failed`. Like
`catalog`, it is only sent when it changed; the room keeps the last list per helper, keeps it out
of `clients[].status`, and condenses it into `roomState.currentScore` / `setlistScores`.

`lastCommand.startMeasure` is the measure this adapter actually started the song from — `1` when
it had to fall back to the top, the song's `startMeasure` when it got there. It is only sent for a
play with `resetBeforePlay`, and unlike a song's `startMeasure` the value `1` is meaningful and
kept. The host compares it with what the current song asked for and warns when they differ,
because a device playing bar 1 while the band plays bar 8 is the loudest kind of out-of-sync.

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
{
  "type": "transportRequest",
  "action": "play",
  "requestedAt": 1718900000000,
  "cueAtServerTime": 1718899999955  // optional; room time of the external cue,
                                    // see Helix sync under SetlistSong
}
```

### `externalCue`

A host hotkey captured by an adapter that claimed the combination system-wide (see
[Configuration.md](Configuration.md#external-cue-helix-and-other-pedals)) rather than by the host
page's own keydown handler. The historical message name is retained for compatibility.

```jsonc
{
  "type": "externalCue",
  "action": "next-song",                 // optional; omitted means Play for older adapters
  "cueAtServerTime": 1718899999955,      // room time of the input itself
  "source": "Ctrl+Alt+N on MASTASURFACE" // optional; defaults to the sender's device name
}
```

Deliberately **not** a `transportRequest`. Who may start playback is a room policy — in
`host-only` mode nobody but the host may — and an adapter that owns a hotkey has gained no
authority it did not already have. The coordinator relays the action to every host client, where it
runs through the same handler as the matching local shortcut. Play then issues the host's ordinary
`transportRequest` carrying the same `cueAtServerTime`, so every safety rule applies unchanged.

Answered with an `error` when the stamp is more than 250 ms in the future or older than
`HELIX_MAX_CUE_AGE_MS` (3 s) — it could no longer anchor a count-in — or when no host is connected
to act on it. A small future lead from normal clock-sync jitter is accepted and clamped to the
coordinator's current time before relay.

---

## Server → Client messages

A `ServerMessage` is one of: `serverHello`, `clockSyncResult`, `transportCommand`,
`openSongCommand`, `roomState`, `error`, `helixScheduleUpdate`, `externalCue` (relayed to hosts,
same shape as above).

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
  "currentScore": { "songId": "…", "status": "ready", "scoreId": "17f7362bc4ba3106f1fe88a7cae1b128" },
  "setlistScores": [ { "songId": "…", "status": "exporting" } ],
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
  "tempoPercent": 92,               // optional legacy default 100; integer 15..175
  "museScoreSource": "CCR/Bad Moon Rising",  // optional, relative path or title for MuseScore
  "durationMs": 138000,             // optional
  "durationSource": "adapter",      // adapter | manual
  "startMeasure": 8,                // optional; 1-based, 2..999. Play starts here instead of the top
  "helixSyncEnabled": true,         // optional; Helix sends Play at measure 1 beat 1
  "helixBpm": 120,                  // optional; constant-BPM v1
  "helixBeatsPerMeasure": 4,        // optional; defaults to 4 in host UI
  "helixTargetMeasure": 2,          // optional; complete count-in measures (defaults to 2)
  "helixOffsetMs": -80,             // optional; whole-room offset against Helix timeline
  "notes": "capo 2"                 // optional
}
```

A single song can target multiple apps. `song-sources.ts` resolves each app's reference: the
dedicated field (`songsterrUrl` / `museScoreSource`) wins, else `source` is used when the
primary `sourceType` matches that app. For Songsterr adapters, `songsterrBassUrl` and
`songsterrDrumUrl` override the main Songsterr URL for members who selected those instruments.
When `helixSyncEnabled` is true, the server schedules Play from the Helix fields instead of the
normal adaptive count-in.

`startMeasure` moves the *whole room's* starting point into the song. The server sanitizes it to
2..999 and drops anything that means "from the top" (missing, 1, out of range), so adapters only
ever see a measure worth seeking to. It is not a separate message: every play already carries
`currentSong`, and each adapter reads the measure off the song there, resolves it in its own
player's measure numbering, and seeks during the count-in — never on the downbeat. Adapters report
back which measure they really started from in `lastCommand.startMeasure` (see below); the host
warns when one of them differs from the song's `startMeasure`.

The count-in is measured from the **cue**, not from when its request reached the coordinator. A
`transportRequest` may carry `cueAtServerTime` -- the requester's room-time stamp of the keystroke
the Helix sent (host page: the keydown's `event.timeStamp` converted with the measured clock
offset). The server subtracts the time the cue spent in input handling, Wi-Fi, and its own queue
from the count-in, so the downbeat lands one count-in after the *Helix's* beat instead of a
transit time later -- and the jitter of that path stops showing up as room-vs-Helix wobble. Stamps
that are missing, in the future, or older than 3 s are ignored (the count-in is then timed from
now, as before). Plays without an external cue -- the Play button, setlist auto-start -- omit the
field.

The floor a Helix start has to clear is only what the connected devices actually need
(`max(rtt/2 + 4*jitter, requiredLeadMs) + 1 s` prep budget), **not** the room's default count-in:
that default is a comfort setting for button presses, and rounding a Helix start up to it would
push the band off the backing track's downbeat for no device's benefit.

The Helix cue fires once and keeps its own timeline regardless of BandCue, so if the count-in is
still shorter than that floor, the server does *not* roll the start forward to the next complete
measure -- that would start BandCue a full measure behind a Helix count-in that can't be extended.
Instead it holds the delay to exactly the floor. Right after such a Play request, the server
broadcasts a `helixScheduleUpdate` message so host UIs can show whether that happened and by how
much:

```jsonc
{
  "type": "helixScheduleUpdate",
  "countInMs": 1200,          // count-in + offset, measured from the Helix cue
  "cueLatencyMs": 45,         // cue -> coordinator travel time, already deducted below
  "requestedDelayMs": 1155,   // countInMs - cueLatencyMs, before any floor
  "minimumDelayMs": 1400,     // device-prep floor for this room right now
  "appliedDelayMs": 1400,     // delay actually scheduled: max(requestedDelayMs, minimumDelayMs)
  "extendedMs": 245,          // appliedDelayMs - requestedDelayMs; 0 when honored as-is
  "measureDurationMs": 1200   // one Helix measure at this song's BPM and meter
}
```

### `ScoreAvailability`
`roomState.currentScore` (the current song, only when it is a MuseScore song) and
`roomState.setlistScores` (every MuseScore song of the setlist): `{ songId, status, scoreId?, detail? }`.
`ready` means the coordinator holds the export under `scoreId`; `exporting` means a helper is still
on it; `missing` says why there are no notes in `detail` (no helper connected, no matching score,
export failed). A published export stays `ready` while its helper reconnects, until the song is
pointed at a different score.

### Score view files (HTTP)
`/api/scores/<scoreId>/<file>`, with the room or host token as `?token=` (an `<img>` cannot send
headers). `scoreId` is a hash of the score file and the exporter version, so the bytes under an id
never change and are served `Cache-Control: immutable`.

| Method | Who | |
| --- | --- | --- |
| `GET` / `HEAD` | anyone in the room | Serves a file. Stored gzip and sent with `Content-Encoding: gzip` (unpacked for clients that do not accept it). 401 without a token, 404 for anything else. |
| `PUT` | a **connected desktop adapter**, named by its room client id in `x-bandcue-client-id` | Stores a file, raw or `Content-Encoding: gzip`. 403 for any other client, 413 over 32 MB. |

Only these names exist: `manifest.json`, `<voice>.timing.json`, `<voice>-<page>.svg` (lower-case
letters, digits, `-`, `_`), and `source.gp` (a Songsterr import, see below). The helper uploads `manifest.json` last, so a score counts as stored
once its manifest is there.

### Songsterr imports (HTTP)
`POST /api/score-imports?token=…&songId=…&key=s<digits>&revision=YYYY-MM-DD`, body: a Guitar Pro file
(GP7 `.gp`, GPX or GP3–5), at most 16 MB. Only a **connected desktop adapter** may send one
(`x-bandcue-client-id`, like `PUT` above); the Songsterr extension sends what Songsterr's
*Download › Guitar Pro* produced for one of the song's Songsterr URLs. `key` is that URL's Songsterr
song id and must be one of the song's own URLs (`songsterrUrl`, `songsterrBassUrl`,
`songsterrDrumUrl`, or `source` of a Songsterr song). The coordinator stores the file as
`/api/scores/<importId>/source.gp` (`importId`: a content hash) and records
`{ key, importId, revision, importedAt }` in the song's `scoreImports`, replacing an earlier import
of the same key. Answers `{ importId, roles }`; 400 for a non-Guitar-Pro body, 403 for other
clients, 409 for an unknown song or key.

The host page starts an import with `scoreImportRequest { songId }`. The room sends
`scoreImportCommand { requestId, song }` to every connected Songsterr extension whose `clientHello`
capability has `canImportScores` (an extension drops it after finding its browser without Songsterr
Plus, and gets it back after an import works); each answers with `scoreImportProgress { requestId,
state: "running" | "done" | "failed", detail }`. `RoomState.scoreImportJobs` lists the latest job per
song with each browser's progress (a browser that leaves mid-import counts as failed). Errors: not a
host, no Songsterr URL, or no extension that can import.

The MuseScore helper fetches `source.gp`, converts it (`MuseScore4.exe -o x.mscz x.gp`, in its own
cache, never the score folders), exports it like a local score and reports it in `scores` with
`importKey`/`importId`. The room then writes the export's `scoreId` into the import, so it stays
served (and persisted with the setlist) without the helper. `ScoreAvailability.imports` lists each
import with `roles` (`main`/`bass`/`drums`: which of the song's URLs it came from), `status` and
`scoreId`. Host setlist and current-song updates merge their `scoreImports` with the room's, per Songsterr
song the newer import (`importedAt`) winning, so a host page with an out-of-date copy never drops
a newer import and a setlist file brings its imports back; an import whose URL is removed from the
song is dropped. The host page copies the room's imports into its own setlist, its local storage
and exported setlist files.

`manifest.json` (`ScoreManifest`) lists the voices, the full score first:
`{ version: 1, scoreId, title, relativePath, museScoreVersion, exportedAt, parts: [{ id, name, pages, timing, measureCount, durationMs }] }`.

`<voice>.timing.json` (`ScoreTiming`) is MuseScore's own playback timeline in SVG units of the pages:

```jsonc
{
  "version": 1,
  "pages": [{ "width": 9924, "height": 14028 }],
  // Index = measure index (0-based); BandCue's measure N is index N - 1.
  "measures": [{ "page": 0, "x": 1315.3, "y": 2114.2, "w": 790.6, "h": 4389.1 }],
  // Measures as played, repeats and jumps unrolled: start/end in ms at 100 % tempo,
  // and the cursor anchors [ms, x] of every note onset in that pass.
  "events": [{ "m": 1, "t": 500, "e": 2500, "b": [[500, 2176.4], [1000, 2490.2], [2500, 3701.6]] }],
  "durationMs": 34500,
  // Exporter v3 on, both optional: rehearsal marks and time signatures by measure index.
  "sections": [{ "m": 2, "label": "Verse" }],
  "meters": [{ "m": 0, "n": 4, "d": 4 }]
}
```

A play's `TransportState` carries the song it started: `song: { id, startMeasure?, tempoPercent? }`
(scheduled and running only). The current song may change while it plays; the score view moves a
song's cursor only for a play of that song, from that play's own start measure and tempo.

### `SongCatalogStatus` / `SongCatalogEntry` / `SongCatalogMatch`
Privacy-safe local MuseScore library data published by a bridge/helper. Entries carry only a
`title` and a folder-`relativePath` (never an absolute path). `songMatch` reports whether the
current song resolved to `matched`, `ambiguous`, `missing`, or `not-applicable`. See
[Adapters.md](Adapters.md#musescore-on-windows).
</content>
