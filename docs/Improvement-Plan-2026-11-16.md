# BandCue Improvement Plan — 2026-11-16

Stability and usability of the **web page (host and companion)** and the **coordinator**, at commit
`29c6ddf` (v1.8.2). The Android app is left out (deprecated). The extension and the MuseScore helper
are only mentioned where the page or coordinator depends on them.

[Audit-2026-11-13.md](Audit-2026-11-13.md) covers security and repository hygiene. This plan does
not repeat it; where an audit item belongs in the same piece of work it is named (for example
"audit L5").

## Status

| Step | State |
| --- | --- |
| 1 — S1, S2 (small fixes), S3, S4, S8, with tests | **Done 2026-11-16**, not yet released. See the "Unreleased › Fixed" entries in [CHANGELOG.md](../CHANGELOG.md) and `e2e/room-failures.spec.ts`. |
| 2 — S5, S6, S7, with tests | **Done 2026-11-16**, not yet released. See `e2e/score-view-network.spec.ts`. |
| 3 – 6 | Open. |

Notes on step 1:

- **S2** is no longer only read: the new two-host browser test fails on the code before the fix
  with the room armed while the auto-started song plays.
- **S2, "disarm when a Play is rejected"** was not done. With arm-and-play in one request the
  auto-start never arms, so there is nothing to undo; and disarming on any refused Play would let
  a bandmate's refused request cancel the host's arm.
- **S4:** pressing Stop only to call off a song that is still loading does not send a Stop to the
  devices (they are busy loading and would report a Stop they could not carry out).
- **S1** also gives up a connection attempt that neither opens nor fails after 8 s; without that
  the page noticed the drop quickly but then sat in "connecting" for minutes.
- **Audit H1** (`externalCue`) was left out: its fix needs a decision on how the MuseScore helper
  proves it may relay hotkeys.
- The page still shows the last notices over the bottom of the window; a tablet in "Notes only"
  sees them too. Say if errors should stay off the music stands.

Notes on step 2:

- **S5, S6 and S7 are no longer only read:** each has a browser test that fails on the code before
  the fix (a blank third page, "Loading the notes…" standing, "Bar 1" shown mid-song after a
  reconnect).
- **S5, fetching ahead** warms the browser's HTTP cache with `fetch` instead of loading every page
  image at once, so a long score does not hold all its pages in memory from the start. It relies on
  the files being served `immutable`. The test passes in Chromium and in Playwright's WebKit; it
  was **not** run on a real iPad, whose Safari decides for itself what it keeps in its cache. The
  retry (first bullet of S5) does not depend on that.
- **S7** keeps the last clock estimate for display only. After a device slept through a clock step
  the cursor can be off until the new connection's first sample is back (one round trip).

## How this was made

| What | How |
| --- | --- |
| `web/app.js`, `web/host-logic.js`, `web/index.html`, `src/server/index.ts`, `src/server/room.ts`, `src/shared/transport.ts`, `message-guards.ts`, `room-state-file.ts` | Read in full. |
| `web/score-view.js` | First 900 lines in full; the rest searched for network, error and storage handling. |
| `web/styles.css`, `web/score-timing.js` | Searched only. |
| Host and companion pages | Run against a scratch coordinator with two fake adapters and three songs; screenshots at 390, 834, 1194 and 1366 px wide (light theme only). |
| Dead-connection behaviour | **Measured** with a TCP proxy that stops forwarding without closing (item S1). |

Each finding says whether it was **measured**, **seen** in the running page, or **read** from the
code and not reproduced. Nothing in the repository was changed.

Sizes are rough: **S** up to half a day, **M** one to two days, **L** several days.

## The short version

| # | Item | Kind | Size |
| --- | --- | --- | --- |
| [S1](#s1-a-dead-connection-goes-unnoticed-for-68-seconds) | A dead connection goes unnoticed for 68 s; the page keeps showing "Stopped", buttons enabled | Stability, measured | S |
| [S2](#s2-auto-start-can-leave-the-room-armed-and-say-playing-when-nothing-plays) | Auto-start can leave the room armed and say "Playing" when nothing plays | Stability, read | S |
| [S3](#s3-error-messages-disappear-within-a-second) | Server error messages are overwritten within about a second | Stability, read | S |
| [S4](#s4-no-stop-when-the-room-thinks-it-is-stopped) | No way to stop devices when the room thinks it is stopped (after a coordinator restart mid-song) | Stability, read | S–M |
| [S5](#s5-score-pages-that-fail-to-load-stay-blank) – [S7](#s7-a-reconnect-mid-song-sends-the-cursor-back-to-the-start-bar) | Score view: blank pages after a Wi-Fi blip, endless "Loading the notes…", cursor jumps to bar 1 on reconnect | Stability, read | S each |
| [S9](#s9-setlist-automation-runs-in-the-hosts-browser-tab) | Setlist automation runs in the host's browser tab | Stability, read | L |
| [S10](#s10-calibration-control-mode-and-helix-settings-are-not-room-state) | Calibration, control mode and Helix settings live in one browser's storage or in memory | Stability, read | M |
| [U1](#u1-what-the-host-needs-during-a-song-is-spread-over-the-page) – [U3](#u3-setlist-rows-are-hard-to-hit) | Host page: controls far from the setlist on a phone, 16-field song form, 15 px-high row actions | Usability, seen | M each |
| [C1](#c1-the-companion-page-is-the-host-page-with-the-controls-removed) | Companion page leads with the room code, never shows the song's notes field, and has no Stop | Usability, seen | M |

Recommended order is at the [end](#suggested-order).

---

## Part 1 — Stability

### S1. A dead connection goes unnoticed for 68 seconds

**Measured.** A host page was loaded through a proxy; the proxy then stopped forwarding in both
directions while keeping the sockets open (what a Wi-Fi drop looks like to a browser). Chromium
showed `connection: open`, badge "stopped", Arm enabled for **67,978 ms** before the offline banner
appeared. After the network returned it was back in 1.7 s.

**Why.** The heartbeat notices after 6 s and calls `socket.close()`
([app.js:605](../web/app.js#L605)). On a dead connection the close handshake never completes, and
the `close` event — the only place that sets "offline" and reconnects
([app.js:703](../web/app.js#L703)) — waits for the browser's own timeout (60 s in Chromium).

**What the host sees for that minute:** a normal-looking page with a stale room. Play pressed in the
first 6 s is "sent" into the dead socket and `transportRequestPending` then holds both transport
buttons disabled until the close arrives. A tablet on a music stand shows no "Offline" either.

**Fix.** On heartbeat timeout, treat the socket as dead at once: set the state to offline, drop the
socket (the `ws !== socket` guards already make an abandoned socket harmless) and call `connect()`.
Do not wait for `close`.

**Done when** the same proxy test shows offline within 8 s and a new connection attempt at once. Add
the proxy harness to `e2e/` (see [T1](#t1-tests-for-the-failure-cases)).

### S2. Auto-start can leave the room armed and say "Playing" when nothing plays

**Read, not reproduced.**

1. `playCurrentSongForRun` sends `safetyUpdate { armed: true }` and then Play
   ([app.js:1702](../web/app.js#L1702)), and sets the status to "Playing … – auto-advances at the
   end" without waiting for an answer ([app.js:1708](../web/app.js#L1708)).
2. The load decision in front of it checks ready adapters and clock sync, but not tempo
   ([host-logic.js:747](../web/host-logic.js#L747)). The coordinator does check tempo and rejects
   the Play ([room.ts:1039](../src/server/room.ts#L1039)).
3. Nothing disarms after a rejected Play. The room stays armed, the status line says "Playing", and
   the error is gone within a second (S3).

The same end state is reachable with two host pages that both have auto-load on: the second page's
arm arrives after the first page's Play has disarmed, and its own Play is rejected. The coordinator
accepts an arm at any time, also while a song runs ([room.ts:1016](../src/server/room.ts#L1016)).

An armed room that nobody armed starts on the next stray Play hotkey or Helix cue.

**Fix (small, independent of S9):**

- Coordinator: accept `armed: true` only while the transport is stopped; disarm when a Play is
  rejected.
- Add an atomic "arm and play" for the auto-start (one message, or a flag on the transport request),
  so there is no window between the two.
- Page: include `tempoBlockedReason` in `setlistLoadDecision`; set "Playing" only when the room
  state says scheduled.
- Decide: should an armed room disarm by itself after a few minutes? See
  [open decisions](#open-decisions).

### S3. Error messages disappear within a second

**Read.** A server `error` is written to the subline and the host warning line
([app.js:683](../web/app.js#L683)). Both are rewritten by ordinary rendering:

- the subline on every `roomState` while stopped — `renderState` → `syncCountdownTimer` →
  `updateCountdown` sets "Waiting for a transport command" ([app.js:2247](../web/app.js#L2247));
- the host warning line on every full render ([app.js:981](../web/app.js#L981)).

A `roomState` arrives at least once a second (every client's clock report triggers one). So "Only
the host can…", "…has not applied 80% tempo", "No Songsterr extension that can import is connected"
and the relayed-hotkey note are on screen for under a second, or not at all. The result of "Open
Current Song" ([app.js:2031](../web/app.js#L2031)) has the same problem.

**Fix.** One notice area for things that *happened* (errors, hotkey relays, open-song results):
each stays at least 6 s or until dismissed, newest on top, the last few kept under "Recent
messages". The host warning line keeps its one job: the standing reason why Play is not available.

### S4. No Stop when the room thinks it is stopped

**Read.** Stop is rejected while the transport is stopped
([transport.ts:321](../src/shared/transport.ts#L321)) and the button is disabled
([app.js:1606](../web/app.js#L1606)). The transport is not saved
([room.ts:123](../src/server/room.ts#L123)), so after a coordinator restart mid-song the room is
"stopped" while every device plays on. Same after a duration auto-stop when a device that reports no
playback state is still running, or when someone started a device by hand.

The adapters' Stop is already a safe no-op when nothing plays (Improvements.md, item 1), so a
"stop everything" costs nothing.

**Fix.** Let a host send Stop at any time. The coordinator broadcasts the Stop command with a new
sequence even from "stopped". The button is enabled whenever the page is connected; its label says
"Stop all devices" when the room is stopped but an adapter reports `playback: "playing"`.

### S5. Score pages that fail to load stay blank

**Read.** Page images get no `error` listener ([score-view.js:436](../web/score-view.js#L436)). Only
the first two pages load eagerly; the others load as the cursor nears them
(`loadPagesAround`). A request that fails in a Wi-Fi blip leaves a blank page for the rest of the
song — a browser does not retry a failed `<img>`.

**Fix.**

- `error` listener on every page image and on the drum key: retry with a short backoff, and show
  "Page 3 – loading again…" on the page meanwhile.
- When a song's first pages are on screen and nothing runs, fetch the rest of that song's pages in
  the background. The files are served `immutable` for a year, so after that a drop mid-song has
  nothing left to fetch.

### S6. Score fetches have no timeout

**Read.** `fetchJson` is a bare `fetch(url)` ([score-view.js:1663](../web/score-view.js#L1663)).
`load` keeps `loadingScoreId` until it settles, and the 3 s retry only runs after a *failure*
([score-view.js:379](../web/score-view.js#L379)). A request that stalls shows "Loading the notes…"
until the browser gives up, which takes minutes.

**Fix.** Abort after about 8 s (`AbortController` and a timer; `AbortSignal.timeout` is missing on
older iPads) and go through the existing retry path.

### S7. A reconnect mid-song sends the cursor back to the start bar

**Read.** Every new connection clears the clock offset ([app.js:603](../web/app.js#L603)), so
`roomNow()` is undefined until the first sample returns. With no room time, `songClock` puts the
cursor on the start measure ([score-view.js:594](../web/score-view.js#L594)) while the mode is still
"running", so the view begins to scroll to line 1 and then comes back. The big readout does the
opposite: it falls back to an offset of 0 ([app.js:2226](../web/app.js#L2226)) and shows an elapsed
time that is off by the device's clock error.

**Fix.** Keep the last offset as a display-only estimate until the first fresh sample. Scheduling a
cue (`hostCueServerTime`) must keep requiring a fresh one — that is what the reset is for. Simplest
form: two values, `displayOffsetMs` and `serverOffsetMs`.

**Done when** an e2e test drops and restores the socket during a run and the cursor's bar never
goes down.

### S8. One exception stops the page without a sign

**Read.** The message handler parses and renders with no guard
([app.js:634](../web/app.js#L634)). If `renderState` throws on one unexpected field, the score view
is not updated for that message either (it is called after, [app.js:679](../web/app.js#L679)),
`prevTransportStatus` is not advanced, and the page shows whatever it showed last. There is no
`window` error handler.

**Fix.**

- `try/catch` around each message; call `scoreView.update` whether or not the room render threw.
- A `window` `error` / `unhandledrejection` handler that shows "This page hit a problem – Reload"
  with a button.
- Send the message text once to the coordinator (`clientError`, rate-limited) so the Pi's log has
  it. The coordinator already keeps running after its own errors; nothing reports those either
  (S11).

### S9. Setlist automation runs in the host's browser tab

**Read.** Auto-load and auto-start are a state machine in the host page: `driveSetlistRun`
([app.js:1638](../web/app.js#L1638)) on a 250 ms timer ([app.js:424](../web/app.js#L424)), with
settings in that browser's local storage. A comment says why the clock updates also drive it: a
background tab's timers are cut to one a minute ([app.js:860](../web/app.js#L860)).

What follows from that:

- Host tab closed, host laptop asleep or host tablet locked at the end of a song: nothing advances.
- A page reloaded during a song has forgotten that it was running and does not advance.
- Two host pages (laptop and phone) each run their own copy with their own settings (see S2).
- The 45 s load timeout and the 4.5 s settle run on a throttled timer.

**Fix.** Move the state machine into `RoomController`. It already has every input (setlist, current
song, adapter status, clock sync, timers that are not throttled). The settings and the phase become
room state:

```
automation: { advance, start, allowPartialStart, phase: "idle" | "loading", detail }
```

Host pages render it and send toggles. `setlistLoadDecision`, `startBlockers` and
`shouldAdvanceSetlistOnStop` move to `src/shared` (with their tests); `host-logic.js` keeps the
display text. Stop while loading becomes a message the coordinator handles.

This is the largest item in the plan. S2's small fixes are worth doing first; they stay correct
afterwards.

### S10. Calibration, control mode and Helix settings are not room state

**Read.** The coordinator saves the setlist, the current song and score exports
([room.ts:102](../src/server/room.ts#L102)). Not saved:

| Setting | Where it lives | What goes wrong |
| --- | --- | --- |
| Per-device manual offset | Host browser's local storage, re-sent by the host page when it sees the device ([app.js:1153](../web/app.js#L1153)); coordinator memory for 30 s ([room.ts:81](../src/server/room.ts#L81)) | A device that reconnects while no host page is open, or while the host is on another browser, plays with offset 0. |
| Control mode | Coordinator memory ([room.ts:134](../src/server/room.ts#L134)) | Back to "Host only" after every coordinator restart. |
| Global Helix on/off and offset | Host browser's local storage, baked into the current song the page publishes ([app.js:1885](../web/app.js#L1885)) | A setlist change swaps the bare song back in and the page must re-send ([app.js:1771](../web/app.js#L1771)); a second host browser has its own values, and the last page to publish decides. |
| "Start without devices that are not ready" | Host browser's local storage | Differs per host browser. |

**Fix.** Add them to `PersistedRoomState`. The coordinator applies a saved offset when a device
joins (by the same device-name key), and computes the Helix-adjusted song itself. One-time
migration: a host page whose room has none uploads what its local storage holds.

### S11. Coordinator problems only reach the console

**Read.** These are logged and nowhere else; on a headless Pi nobody reads them:

- the advertised LAN address is gone, so the QR code and links are stale
  ([index.ts:494](../src/server/index.ts#L494));
- an uncaught exception was swallowed ([index.ts:561](../src/server/index.ts#L561)) (audit L8);
- the setlist file could not be written ([room-state-file.ts:45](../src/server/room-state-file.ts#L45));
- a laptop exports with an outdated exporter ([room.ts:719](../src/server/room.ts#L719)).

**Fix.** A `notices` list in the room state, shown in the host page's warning area ("The setlist
could not be saved: disk full", "The coordinator recovered from 2 errors – restart it when
convenient").

For the stale address there is a direct fix as well: a page that was reached over a non-loopback
address knows an address that works — its own `location.origin`. Build the join link from that, and
let `/qr.svg` use the request's `Host` header in the same case. The startup address stays the
fallback for a host page on `127.0.0.1`.

### S12. An open page keeps running old code after an update

**Read.** Pages stay open for weeks (home-screen web app on a stand). After a deploy, the old
script reconnects to the new coordinator. `serverHello` carries no version
([room.ts:213](../src/server/room.ts#L213)); static files are served without cache headers
([index.ts:154](../src/server/index.ts#L154)).

**Fix.** `serverHello` carries the version and a build id (a hash of `web/` taken at start). The
page compares it with the id it was loaded with and shows "BandCue was updated – Reload"; it may
reload by itself when the transport is stopped and no form is being edited. Serve static files with
`cache-control: no-cache` and an `ETag`.

### S13. Smaller items

- **Room traffic (audit L5, M7).** Every clock report rebroadcasts the whole room, setlist included,
  up to 2.5 times a second; the page then serializes the whole state to compare it
  ([app.js:891](../web/app.js#L891)). On an old iPad that work competes with the cursor animation.
  A small `clockState` message removes most of it. Do it together with the audit's move of file
  work off the event loop.
- **Two host pages edit the setlist (read).** Updates replace the whole list, last write wins; a
  page that was offline pushes its copy over the room's on return
  ([app.js:1935](../web/app.js#L1935)). Add a revision number: the coordinator refuses an update
  based on an older revision and the page asks "keep mine / take the room's".
- **Unsent edits are invisible (read).** Edits made while offline are queued (`setlistUnsent`) with
  no sign. Show "Not saved to the room yet" next to the song count.
- **A `null` song drops the whole setlist update silently** — audit L1.
- **An invalid `BANDCUE_ROOM_CODE` is ignored without a word (seen).** `PLAN01` was replaced by a
  random code. Print a line at start.

---

## Part 2 — Usability: host page

Seen in the running page with three songs and two adapters. At 390 px wide the host page is
**5,292 px tall**.

### U1. What the host needs during a song is spread over the page

The loop is: pick a song → Arm → Play → Stop. On a phone the setlist starts about 1,500 px down,
under automation, the Helix panel, the hotkey list and the song form. The reason Play is disabled
is a grey line under the hotkey list, with more of it in the warnings box and in the device cards.

**Change.**

- A transport bar that stays on screen: current song, Arm / Play / Stop, room status.
- The reason Play is blocked sits under the Play button, all blockers listed (today: the first one
  and "+1 more"), with one chip per device: "Drums tablet ✓", "Bass laptop – open a Songsterr tab".
- The setlist directly under the transport bar.
- Control mode, "start without devices", automation and Helix go into one "Room settings" fold.
- The Helix panel shows only when Helix is in use (global switch on *and* a song has Helix sync).
  Today a green "Start from Helix: On" button sits in every host's view.
- The hotkey list hides on touch devices and folds into a "?" on desktop.

### U2. The song form asks for 16 fields

Title, source, URL or score name, three Songsterr URLs, MuseScore score, duration, tempo, start
measure, five Helix fields, notes. Most songs need a title and one link. The form also never closes
after a song is added ([app.js:1448](../web/app.js#L1448) only opens it).

**Change.**

- Two fields by default: title, and one "Songsterr link or MuseScore file" field. The source type
  is derived from what is typed (a `songsterr.com` URL, a `.mscz` name).
- Pasting a Songsterr link into an empty form fills the title from the link
  (`…/radiohead-creep-tab-s97` → "Creep").
- "More" opens the bass and drum links, duration, tempo, start measure and notes. "Helix" is a
  second fold, only shown when Helix is in use.
- Close the form after adding once the setlist has songs.

### U3. Setlist rows are hard to hit

**Measured in the page:** "Make Current" 89×15 px, "Edit" 25×15, "Remove" 47×15, the move arrows
26×26. The usual minimum for touch is 44 px. "Remove" sits directly beside "Edit"; on a phone it
wraps onto a line of its own. Each row prints the full Songsterr URL.

**Change.**

- Tapping the row makes the song current.
- Edit, Import notes and Remove move into a row menu with 44 px targets. Remove keeps its undo.
- A drag handle for reordering; the arrows stay for the keyboard.
- Instead of the URL: short chips — "Songsterr", "MuseScore", "3:45", "90 %", "from bar 17",
  "Notes ready". The link itself shows when the row is opened.
- Import: offer "Replace the setlist" or "Add to the end" (today it always replaces,
  [app.js:2091](../web/app.js#L2091)).

### U4. After a start nobody is told how it went

Each adapter reports when it really fired. The page shows that only as a clause inside a device
card ("… (started +38 ms vs schedule)", [app.js:2300](../web/app.js#L2300)).

**Change.** A "Last start" strip under the transport bar: one chip per device with its deviation,
amber above about 30 ms, red for failed or "started from another measure". That is also where
calibration starts: a "use this as the offset" action beside a device that is steadily late, and
−10 / +10 buttons instead of only a number field with a ±5000 range.

### U5. Devices list reads like a debug view

Every card shows "DESKTOP-ADAPTER", "DISPLAY ONLY" and "12 ms RTT, 3 ms offset, 2 ms jitter". Two
host pages are both called "Host".

**Change.** One plain line per device ("Ready", "Not ready – open a Songsterr tab", "Reading
along"); numbers behind a tap and in the Timing panel, which already has them. Default names say
what the device is ("Host – Chrome on Windows"). A companion that joins without a saved name is
asked once ("Who is this? Drums / Bass / Guitar / …").

### U6. Wording

- "Adapter fallback" → "Address for the extension and the MuseScore helper".
- A refused link says "Open the link or QR code it shows now" — a band member cannot see the
  coordinator's screen. Say "Ask the host for the current QR code".
- "Leader" in the readout is the device that pressed Play; "Started by" says that.

---

## Part 3 — Usability: companion page

### C1. The companion page is the host page with the controls removed

**Seen** at 390 px: the largest text is the room code. Then the song, four tiles (Leader, Elapsed,
Ready adapters, and Current song — the same song again, with its URL), a QR code for a room this
phone has already joined, and the device list with clock numbers. The page is 1,950 px tall.

What a band member needs at a glance: which song, the count-in, what comes next, whether this
device is connected.

**Change.** A "stage view" as the companion's default when the song has no score view:

- song title largest; "next: …" under it;
- the count-in as one large number that flashes on the beat when a tempo is known (the score view
  already does this), else a plain 3-2-1; today it is seconds with two decimals at 60 ms steps;
- the song's **notes field**. The host can type "capo 2" or "drop D" for a song, and no companion
  ever sees it: it is only rendered in the host's setlist row
  ([app.js:2189](../web/app.js#L2189));
- the setlist, read-only and folded (the room state already carries it);
- room code, QR code and devices under "Room details".

### C2. "Everyone can stop" has no Stop button

**Seen.** The control mode offers "Leader can stop" and "Everyone can stop". The coordinator
accepts a Stop from any client in that mode
([transport.ts:329](../src/shared/transport.ts#L329)), but the only Stop button is in the host panel
([index.html:173](../web/index.html#L173)). Either show Stop on the companion page when the mode
allows it, or say in the setting that it applies to the extension only. See
[open decisions](#open-decisions).

### C3. The screen sleeps on a companion without notes

**Read.** Keep-awake is created inside the score view only
([score-view.js:265](../web/score-view.js#L265)). A phone on the stage view sleeps mid-song. Use the
same module there.

---

## Part 4 — Safety nets

### T1. Tests for the failure cases

The e2e suite covers the working path (host smoke, score view). Add, each as its own spec:

- **Dead connection** — the proxy from S1 (about 30 lines: forward both ways, a flag that drops
  data without closing). Assert offline within 8 s and recovery.
- **Coordinator restart mid-song** — the spec starts and kills its own coordinator. Assert the page
  rejoins, the setlist and settings are back, and Stop works (S4, S10).
- **Two host pages** — with auto-load on in both: one advance, one Play, room not armed after (S2).
- **Reconnect during a run with a score** — the cursor's bar never goes down (S7).

### T2. Take the connection out of `app.js`

`app.js` is 2,541 lines with about 30 module-level variables and no unit tests; only
`host-logic.js` has them. S1, S7 and S8 all sit in `connect()`. Move connect, heartbeat, backoff and
clock sync into `web/room-connection.js` with a small interface (`onState`, `onMessage`, `send`,
`roomNow`, `displayNow`) and test it with a fake `WebSocket` and fake timers. Move the
"which setlist wins on join" rule from `syncWithRoom` into `host-logic.js` as a pure function.

### T3. A soak run and a health readout

A script that runs the coordinator with ten fake clients for thirty minutes, with random drops,
score uploads and plays, and records event-loop delay (`perf_hooks.monitorEventLoopDelay`) and map
sizes (audit L2). Expose the same numbers on `GET /api/health`, and raise a notice (S11) when the
delay passes about 50 ms — the event loop is the room clock.

---

## Open decisions

1. **S9: move automation into the coordinator?** It changes the protocol (new room-state fields, two
   new host messages). The extension and helper are not affected. Recommended: yes.
2. **Arming.** Disarm by itself after some minutes? Offer "hold Play to start" in place of
   Arm-then-Play? Recommended: expire after 5 minutes, keep two steps.
3. **Stop for companions (C2).** Recommended: show it when the mode is "Everyone can stop".
4. **Language.** The page is English and blocks browser translation
   ([index.html:6](../web/index.html#L6)). If the band reads German more easily, the companion stage
   view (about 20 strings) is the place to start.
5. **Named setlists** (one per gig, kept on the coordinator) — not planned here; say if it is wanted.

## Suggested order

Each step leaves the product working and can ship on its own.

1. **Small fixes that remove real failure modes:** S1, S2 (small fixes), S3, S4, S8, with the
   dead-connection and two-host tests from T1. Audit H1 (`externalCue`) touches the same handler as
   S2 and fits here.
2. **Score view on bad Wi-Fi:** S5, S6, S7.
3. **The room owns its state:** S10, then S9, then S11 and S12. T2 first makes S9 easier.
4. **Host page:** U1, then U3, U2, U4.
5. **Companion page:** C1, C2, C3.
6. **Load and long runs:** S13 (traffic, with audit L5 and M7), T3.

## Not covered

- Android app (deprecated), the Songsterr extension and the MuseScore helper beyond their effect on
  the page.
- Security: see [Audit-2026-11-13.md](Audit-2026-11-13.md).
- The dark theme and the score view's controls were not looked at in a browser.
- WebKit was not run; the 68 s in S1 is Chromium's. Safari's close timeout may differ, the fix is
  the same.
