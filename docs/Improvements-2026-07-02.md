# BandCue Improvement Review - 2026-07-02

Focus: networking, timing, and stability, with a secondary pass over security, efficiency,
and process. This complements the living tracker (`Improvements.md`) and the 2026-06-25 audit.

Status of the 2026-06-25 audit at the time of this review:

- P2 (sanitize current-song updates): **done** (`room.ts` `updateCurrentSong` uses `sanitizeSong`).
- P3 (schema/size guardrails): **done** (`message-guards.ts`, `maxPayload` on the WS server).
- P4 (web reconnect timer lifecycle): **done** (`web/app.js` clears `clockTimer`/`reconnectTimer`).
- P1/P5 (token exposure via discovery, host role semantics): **resolved by documentation** —
  `Networking.md` now states the trusted-LAN model plainly. Optional hardening remains (see C2).
- P6 (discovery constants drift): **still open** (see B5).

Items below are ordered by priority within each section.
Ratings: 🔴 fix soon (correctness/stability bug), 🟡 meaningful improvement, 🟢 nice to have.

## Implementation Status (updated 2026-07-02, same day)

Shipped in the follow-up implementation pass (`npm test` 157 passed, `npm run check` clean,
`npm run test:android` BUILD SUCCESSFUL):

- **A1 done** — the background worker now dispatches transport commands to the content script
  `DISPATCH_LEAD_MS` (400 ms) ahead of the downbeat; the content script runs Songsterr prep
  (synth source, reset) during the count-in and burns the final stretch in a tight loop
  (`waitUntilLocalTime`). Multi-tab dispatch is parallel. A tab still loading at lead time gets
  until the downbeat before failure is reported.
- **A2 done** — web, extension, and Android reset the offset estimate to `undefined`/`null`
  instead of `0` on (re)connect, so the first fresh sample is adopted outright.
- **A3 done (server)** — room time comes from `src/server/server-clock.ts` (wall epoch anchored
  once, advanced by `performance.now()`); `RoomController` takes an injectable `now` provider.
  The extension's final wait also re-checks the clock right before firing. Android still
  computes a one-shot scheduler delay (acceptable residual risk).
- **A4 done (extension + Android)** — both adapters reconcile transport from `roomState`:
  a missed future play is scheduled (skipped when under 250 ms of lead remains), a missed
  *commanded* stop (manual / leader-disconnect) is executed. The coordinator's automatic stops
  are deliberately not reconciled. Android logic is pure and JVM-tested
  (`decideTransportReconciliation` in `CommandTiming.kt`).
- **B1 done** — token + room code persist in `.bandcue-room.json` (gitignored; delete to
  rotate; `BANDCUE_TOKEN`/`BANDCUE_ROOM_CODE`/`BANDCUE_STATE_FILE` override). Coordinator
  restarts no longer invalidate client URLs/QRs, which also removes the web-companion 401 loop.
- **B2 done** — `writeFrame` is `@Synchronized`; the read-thread pong can no longer interleave
  with scheduler-thread sends.
- **B3 done** — a 5 s `soTimeout` is set before the WebSocket handshake.
- **C1 done** — static-file guard compares against `publicDir + sep`.
- **C3 partial** — `broadcast()` serializes once per message instead of once per client.
  Catalog stripping and state diffing remain open.
- **C4 partial** — token comparison uses `crypto.timingSafeEqual`. Per-socket rate caps remain
  open.

Second pass (same day; `npm test` 165 passed incl. the new sync-accuracy harness,
`npm run check` clean, `npm run test:android` BUILD SUCCESSFUL):

- **A5 done** — `scheduleDelayForClients` in `transport.ts`: a play's count-in extends for
  transport-capable clients on slow/jittery measured paths (`RTT/2 + 4×jitter + 1 s prep
  budget`), capped at 5 s; companions never extend it.
- **A6 done** — adapters report `lastCommand.firedAtServerTime` (extension: when
  `media.play()` resolved; Android: when the control action executed). The host device list
  shows "started ±N ms vs schedule" while the sequence is current.
- **E2 done** — the coordinator logs one `[timing] <device>: <action>#<seq> fired ±N ms vs
  scheduled start` line per executed command (`logCommandTiming` in `room.ts`).
- **B4 done** — the Android read loop reassembles fragmented frames (FIN bit + opcode 0x0
  continuations) with a 1 MB cap instead of silently dropping them.
- **B6 done** — the coordinator re-checks `networkInterfaces()` every 30 s and warns loudly
  when the advertised LAN address is no longer present (skipped when `PUBLIC_HOST` pins it).
- **B7 done** — the server pings every socket every 4 s; browsers answer automatically and the
  Android read loop answers with pong.
- **C3 done** — catalog entries are no longer stored in or broadcast with room state; only
  counts and the match status survive (nothing in the room consumed the entries).
- **C4 done** — per-socket message budget (80 messages / 2 s sliding window) closes spamming
  sockets with WebSocket policy code 1008.
- **D1 done** — the content script detects `NotAllowedError` from `media.play()` and reports
  "Browser blocked autoplay for this tab. Click once inside the Songsterr tab" with
  `controlPath: autoplay-blocked` instead of a generic failure.
- **E1 done** — `src/server/sync-accuracy.test.ts`: a deterministic simulated rehearsal
  (seeded jitter/spikes, skewed device clocks, reconnect mid-session) drives the real
  `RoomController` and shared estimator pipeline and asserts the achieved start spread stays
  ≤ 30 ms and per-device deviation ≤ 20 ms.

Still open: B5 (discovery-constant drift tests), C2 (opt-in locked-room mode), state diffing
from C3, D2 (verify Android transport fire-path priority), D3 (battery-optimization hint),
E3 housekeeping (living-tracker refresh, README demo link).

---

## A. Timing & Sync

### A1. 🔴 Extension executes the downbeat *after* the scheduled time

**Finding.** The MV3 background worker holds the schedule timer
(`background.js:376`). When it fires, `sendTransportToSongsterr` first runs an async
`chrome.tabs.query` (`findSongsterrTabs`), then `chrome.tabs.sendMessage` to the content
script, which then walks the DOM / calls `media.play()`. All of that happens **after**
`scheduledServerTime`, so browser adapters start consistently late by the tab-query + IPC +
control-path latency (typically tens of ms, unbounded on a loaded machine). Android by
contrast fires the control action directly at the due time.

**Direction.**
- Pre-resolve the target tab at count-in start (where `ensureSongsterrTabs` already runs) and
  forward the command to the content script **immediately**, carrying `scheduledServerTime`,
  `serverOffsetMs`, and `manualOffsetMs`.
- Let the content script own the final wait; burn the last ~20–50 ms in a tight
  `performance.now()` loop so the control action lands on the beat.
- Alternatively (cheaper): measure the background→content→control latency once per session and
  subtract it from the delay.

**Acceptance.** The control action (button click / `media.play()`) executes within a few ms of
the offset-corrected scheduled time, verified with a timestamp log in the content script.

### A2. 🔴 Offset estimator restarts biased toward 0 on every (re)connect

**Finding.** On each socket open the offset is reset to `0` — `web/app.js:318`,
`extension/songsterr/background.js:297`, `BandCueAdapterService.kt:134`. `blendOffset` treats
`0` as a valid previous estimate, so any true offset **below the 250 ms jump threshold** is
slewed from zero: after the 8-sample warm-up at smoothing 0.3, a device with a true 200 ms
offset still carries a ~12 ms error, and more if fewer warm-up replies arrive. Reconnecting
mid-rehearsal (Wi-Fi blip) re-introduces this bias right when timing matters.

**Direction.** Reset the estimate to `undefined`/`null` instead of `0` so `blendOffset` adopts
the first fresh sample as-is (it already handles the undefined case). Optionally seed with the
last-known offset when the disconnect was brief and no clock step is suspected.

**Acceptance.** After reconnect, the reported `offsetMs` converges to the true offset within
the warm-up burst with no residual pull toward zero. Unit-testable in `clock.test.ts`.

### A3. 🟡 Scheduling is anchored to steppable wall clocks

**Finding.** Server time is `Date.now()` and client delays are computed once against
`Date.now()` / `System.currentTimeMillis()`. An OS NTP step on the **server** mid-session
shifts every client's offset simultaneously (the 250 ms jump rule adopts it, but in-flight
scheduled starts and the auto-stop timers computed before the step are wrong). A step on a
**client** during the 1.5 s count-in shifts that device's start.

**Direction.**
- Server: derive `serverTime` from a monotonic source anchored once at startup
  (`performance.now()` + fixed epoch) so room time can never step.
- Clients: compute the target as an offset-corrected instant but re-check it just before firing
  (chained short timeouts or a final `performance.now()` wait, which also helps A1).

**Acceptance.** Stepping the server or client OS clock during a scheduled count-in does not
move the actual start instant.

### A4. 🟡 No reconciliation of missed transport commands on (re)connect

**Finding.** Adapters act only on the `transportCommand` push. A device that reconnects during
the count-in (or was offline when Stop was broadcast) never executes the command, even though
the `roomState` it receives on join carries the full transport state including
`scheduledServerTime` and `sequenceId`.

**Direction.** On connect (and on every `roomState`), compare `transport.sequenceId` against
the last executed sequence: if `scheduled` with a future start and unexecuted, schedule it; if
`stopped` with a newer sequence than the last executed play, run the (idempotent) stop path.

**Acceptance.** Kill an adapter's Wi-Fi for 2 s during the count-in; on reconnect within the
window it still starts on the beat. An adapter that missed a Stop stops on reconnect.

### A5. 🟡 Fixed 1.5 s schedule delay regardless of room timing quality

**Finding.** `DEFAULT_SCHEDULE_DELAY_MS = 1500` is used unconditionally
(`transport.ts:3`). A room containing a high-RTT or not-yet-converged client fires anyway;
the host UI warns via `isClockConverged`, but the countdown length never adapts.

**Direction.** Compute the delay per play: `max(default, f(worst client RTT/jitter,
convergence state))`, cap it, and surface the chosen delay in the host UI. Optionally make the
default host-configurable for bands that want a longer count-in.

### A6. 🟡 No measured sync-error feedback loop

**Finding.** Calibration (`manualOffsetMs`) is set by ear. Adapters already report command
status but not *when* the control action actually fired, so the host can't see the achieved
start spread.

**Direction.** Add an optional `firedAtServerTime` (local fire time + offset) to the command
status report. Host UI shows per-device deviation after each play and can suggest a calibration
value ("this device started 40 ms late — apply −40 ms?"). This also gives regression data for
A1/A3.

---

## B. Networking & Connection Stability

### B1. 🔴 Coordinator restart invalidates the token and room code for everyone

**Finding.** `ROOM_TOKEN` and `ROOM_CODE` are random per process (`index.ts:22-23`). After a
coordinator restart mid-rehearsal, every saved URL/QR is dead: web companions reconnect with
the old token and get 401 forever with no guidance; the extension/Android recover only because
they re-run discovery every 4th attempt and mint a fresh token via `/api/room`.

**Direction.**
- Persist token + room code to a local state file (e.g. next to the repo or in the user profile)
  and reuse them on restart; keep `BANDCUE_TOKEN` as override. A restart then becomes invisible
  to clients — reconnect backoff just works.
- Web client: distinguish the 401/upgrade-rejected close from a transient drop and show
  "room restarted — rescan the QR" instead of silently retrying forever.

**Acceptance.** Restarting the coordinator during rehearsal requires no client action; all
device types rejoin automatically with their existing URLs.

### B2. 🔴 Android WebSocket client: unsynchronized pong write can corrupt the stream

**Finding.** `sendText` is `@Synchronized`, but the read loop answers server pings by calling
`writeFrame` directly (`BandCueWebSocketClient.kt:205`), so a pong from the read thread can
interleave bytes with a concurrent `clockSync` write from the scheduler thread → corrupted
frame → connection drop. Low probability per write, but clock sync runs at 1 Hz for a whole
rehearsal.

**Direction.** Make `writeFrame` itself `synchronized` (or route the pong through a
synchronized send method).

### B3. 🔴 Android WebSocket handshake has no read timeout

**Finding.** `soTimeout` is set **after** `performHandshake`
(`BandCueWebSocketClient.kt:53-58`). If the TCP connect succeeds but the peer never answers the
upgrade (wedged server, wrong service on the port), `readHttpHeaders` blocks the connect thread
indefinitely and reconnect scheduling stalls.

**Direction.** Set `soTimeout` before writing the upgrade request (a shorter handshake-specific
value is fine, e.g. 5 s), then relax to `READ_TIMEOUT_MS` for the frame loop.

### B4. 🟡 Android read loop ignores fragmented frames

**Finding.** `readLoop` never checks the FIN bit and treats continuation frames (opcode `0x0`)
as no-ops (`BandCueWebSocketClient.kt:198-208`). The `ws` server library doesn't fragment
today, so this is latent — but any future server change (or proxy) that fragments a large
`roomState` silently drops/garbles messages.

**Direction.** Either implement continuation-frame reassembly (small addition to the loop), or
replace the hand-rolled client with OkHttp's WebSocket, which also removes B2/B3 by
construction. Given how load-bearing this socket is, OkHttp is the more durable fix.

### B5. 🟡 Discovery constants still triplicated (audit P6, open)

**Finding.** Subnet lists, mDNS naming, and locator behavior are hand-copied across
`src/shared/room-locator.ts`, `extension/songsterr/background.js`, and `RoomLocator.kt`, with
comments pleading for sync. Drift shows up as platform-specific "can't find the room" bugs.

**Direction.** Add a shared JSON fixture asserted by tests on all three platforms (TS test,
Android JVM test, extension test), or generate the copies from the TypeScript source at build
time.

### B6. 🟡 Advertised LAN IP and mDNS answer are frozen at startup

**Finding.** `lanAddress` is selected once (`index.ts:27-28`); the QR, printed URLs, and the
mDNS A-record answer all use it. A DHCP renewal to a new address or switching Wi-Fi mid-session
leaves everything stale, and on multi-NIC machines the single answer may be reachable from only
one interface.

**Direction.** Re-check `networkInterfaces()` periodically (or on mDNS query); log a prominent
warning and refresh host/companion URLs + QR when the address changes. Consider answering mDNS
queries with the address of the interface the query arrived on.

### B7. 🟢 Server never initiates WS ping

**Finding.** Half-open detection relies on client clockSync cadence + the 12 s idle sweep +
TCP keepalive at 30 s. That works, but a server-initiated ws ping every ~4 s would detect dead
peers faster, exercise the Android pong path, and keep NAT/AP state warm. Also worth
documenting the timeout hierarchy in one place (web heartbeat 6 s < Android read timeout 8 s <
server sweep 12 s < TCP keepalive 30 s) so future edits don't invert it.

---

## C. Server Robustness & Security

### C1. 🔴 Static-file path check allows sibling-directory prefix escape

**Finding.** `index.ts:72` guards with `resolved.startsWith(publicDir)`. A request resolving to
a **sibling directory whose name starts with `web`** (e.g. `E:\...\webfoo\x` vs `publicDir`
`E:\...\web`) passes the check. `join` normalizes `..` from the pathname, so this needs a
crafted path, but the guard is simply wrong as written.

**Direction.** Compare against `publicDir + path.sep` (or use `path.relative` and reject
results starting with `..`).

### C2. 🟡 Optional "locked room" hardening (audit P1 follow-up)

**Finding.** The trusted-LAN model is now documented, which closes the audit item as a
docs/reality mismatch. For bands on shared/venue Wi-Fi, an opt-in stricter mode would still be
valuable: `/api/room` without a token returns only `{roomCode, port, version}`; the
token-bearing URLs require the token. Discovery still locates the host; joining needs the QR.

### C3. 🟡 Room broadcast cost: full state, per-client stringify, catalog included

**Finding.** `broadcast` JSON-stringifies the same `roomState` once **per client**
(`room.ts:751-772`), and that state embeds each MuseScore adapter's catalog (up to 500 entries)
plus the full setlist — re-sent to every client on every status change and every 400 ms clock
rebatch. On rehearsal Wi-Fi this is needless airtime and phone battery.

**Direction.**
- Stringify once in `broadcast()` and pass the string to `send`.
- Strip `catalog.entries` from the broadcast client summaries (keep `total` and `songMatch`;
  the host can fetch entries on demand if a browse UI ever needs them).
- Longer term: only rebroadcast the changed slice (clock-only updates don't need the setlist).

### C4. 🟢 Minor hardening

- Token comparison on upgrade is not constant-time (`index.ts:93`) — use
  `crypto.timingSafeEqual` on padded buffers.
- No per-socket message-rate cap; `message-guards` bounds size but a misbehaving client can
  still spam mutating messages. A simple token-bucket per socket closes this.

---

## D. Platform Notes

### D1. 🟡 Extension: autoplay policy can silently defeat `media.play()`

If the Songsterr tab has never been interacted with, `media.play()` may reject under Chrome's
autoplay policy and the click/Space paths become the only hope. Detect the rejection in the
content script and surface a specific status ("click inside the Songsterr tab once") instead of
a generic failure.

### D2. 🟡 Android: keep transport fire-path off the discovery executor

Verify that the scheduled transport execution can't queue behind long-running work
(LAN scan / `resolveRoomEndpoint`) on the same `scheduler`. If a single-threaded scheduler
handles both, a discovery retry coinciding with the downbeat delays the start — give transport
execution its own thread or priority.

### D3. 🟢 Android: battery-optimization guidance

The foreground service keeps the adapter alive, but aggressive OEM battery managers (Samsung
"sleeping apps" included) can still kill it between songs. Add an in-app hint to exempt BandCue
from battery optimization when the user connects.

---

## E. Process, Testing, Docs

### E1. 🟡 End-to-end sync-accuracy harness

There is no automated measurement of the thing BandCue exists for: start spread across devices.
Build a Node test harness that spins up the coordinator plus N fake adapter clients with
injected latency/jitter/clock-offset (fake timers), issues Play, and asserts the achieved
spread stays under a budget (e.g. ±30 ms). This turns A1–A5 into regression-testable behavior.

### E2. 🟢 Per-play timing log for post-rehearsal diagnosis

Log one structured line per play on the coordinator: sequenceId, per-client RTT/offset/jitter,
manual offsets, and (once A6 lands) fired-at deviations. "We were out of sync on song 4" becomes
answerable after the fact.

### E3. 🟢 Housekeeping

- `docs/Improvements.md` header says "Last updated 2026-06-23"; items 1 and 3 are marked
  In Progress though later notes suggest they largely shipped — refresh statuses.
- README still contains the "Replace the demo link" placeholder note.
- `.gradle-user-home` cache noise under `android/` pollutes searches; ensure it's ignored by
  tooling configs where possible.

---

## Suggested Order

1. **B2, B3, C1, A2** — small, confirmed bugs with outsized stability/timing payoff.
2. **A1** — the largest systematic timing error for browser devices.
3. **B1** — coordinator-restart resilience (biggest real-rehearsal stability win).
4. **A4, A3** — missed-command reconciliation, monotonic time base.
5. **C3, B4 (or OkHttp swap), A5, A6, B5, B6** — efficiency and robustness follow-ups.
6. **E1** — lock it all in with the sync-accuracy harness.
