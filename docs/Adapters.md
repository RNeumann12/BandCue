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

### Starting from a later measure

When the current song has a `startMeasure`, each adapter seeks there instead of rewinding to the
top. Every adapter does that work **no later than the count-in** (a MuseScore Bridge does it as
soon as the song is known, which is earlier still), so the downbeat stays a single action,
and every adapter reports the measure it actually reached in `lastCommand.startMeasure` so the
host can warn when one device is about to play a different part of the song.

| Adapter | How it reaches the measure | When it can't |
| --- | --- | --- |
| Browser extension | Clicks the staff under Songsterr's own measure number, then verifies the move against Songsterr's play cursor. | Reports the measure it really reached. A measure Songsterr does not draw (inside a repeat) falls back to the top; a measure it draws compressed has no position of its own, so the cursor lands on a neighbour and that is what gets reported. |
| MuseScore helper (keyboard) | `Ctrl+F`, the measure number, `Enter` — MuseScore's Find / Go to — as prefix keys before Play. | Only if MuseScore itself can't be activated, which already fails the command. |
| MuseScore Bridge (plugin attached) | Walks the measure chain and rewinds the cursor to that measure's first segment, then plays from the selection. Done **ahead of the count-in** — when the score opens, the song changes, or the host arms — so the cursor is visibly parked on the right bar before Play. | Reports the measure it really reached: a score that ends before the requested measure lands on its last one, and the host warns. |
| Android app | `MediaController.seekTo()` at the measure's position in time, which needs the song's **BPM and beats per measure**. | Songsterr's Android session usually advertises no seek: it plays from the top and reports measure 1, so the host warns. |

Measure numbering is each player's own. That matters for songs with repeats: MuseScore counts
written measures, while Songsterr's tab numbers the measures it draws. Set the measure by what
the players in your band actually see.

---

## Songsterr — Browser Extension

A Manifest V3 extension that drives Songsterr browser tabs.

**Layout**

| File | Role |
| --- | --- |
| `manifest.json` | MV3 manifest. Permissions: `storage`, `tabs`, `activeTab`; default host access to Songsterr; optional `http://*/*` access requested when joining a local BandCue room. |
| `background.js` | Service worker: holds the WebSocket connection, clock sync, discovery, reconnect, and connection intent. |
| `content-script.js` | Injected into Songsterr pages: resolves the transport control / media element during the count-in, then fires play/stop/reset on the downbeat. |
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
  common LAN subnets. Chrome prompts for local network access when the user connects. On an
  unusual subnet, enter `host:port` (e.g. `192.168.1.23:4173`).
- **QR join** first scans the visible browser tab for the host join QR code. If camera access is
  needed, the popup can open a dedicated extension scanner tab that reads the camera feed and joins
  the room immediately after a successful scan.
- **Auto-open** — when a transport command arrives and no matching Songsterr tab is open, the
  adapter opens the current song's Songsterr URL first. The extension reuses an already-open
  Songsterr tab and pre-opens it at count-in start.
- **Device name** — each member can type a name for this device in the popup; it's persisted in
  `chrome.storage.local` and sent as `clientHello.deviceName`. Left empty, the name is derived
  from the member's instrument and platform (`Bass Songsterr (Windows)`, or `Songsterr (Windows)`
  on **Auto**). Chrome gives an extension no way to read the *computer's* name — the only API
  that does, `chrome.enterprise.deviceAttributes.getDeviceHostname()`, is ChromeOS-and-policy-only,
  and no permission unlocks it elsewhere. This matters beyond cosmetics: the host keys saved
  per-device calibration by device name, and the coordinator caches a recently-seen clock per
  `role + name + apps`, so when every extension reported the same `"Songsterr tab"` one member's
  manual offset was pushed to all of them and a joining device could adopt another member's clock
  estimate. A rename reconnects, since `clientHello` is only read when a connection opens.
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
- **Per-song tempo** is applied through Songsterr's visible playback-speed control while loading
  and verified before Play. Paywalls or changed layouts are reported instead of starting at the
  wrong speed. Changing speed is a **Songsterr Plus** feature, so on a free account the speed panel
  never opens — a song at the default **100%** plays anyway (that is what Songsterr already does),
  while any other tempo is refused, naming Plus as the reason. The current speed is read from the
  speed button's own text, never from its tooltip: the tooltip describes the range Songsterr
  supports ("15%–175%"), and reading that made a tab playing at 100% look like 15%, which used to
  block every Play on free accounts.
- **Start timing** — everything a Play needs is worked out during the count-in, so the downbeat
  itself is a single click or key dispatch:
  - The background forwards the command `adaptiveDispatchLeadMs` (400 ms by default) ahead of the
    downbeat. The content script then forces the Synth source, resets to the song start, **and
    resolves which control it will touch**, before waiting out the remainder.
  - Resolving the control used to happen *after* the wait: two document-wide button scans, each
    forcing a layout. Measured on a real Songsterr page that was ~5 ms of work that varied with
    DOM size and CPU — a per-device head start that clock sync cannot compensate for.
  - The final wait sleeps in self-correcting chunks (so one overlong wake-up can still be caught
    up) and spins the last 25 ms. It aims early by a measured, capped estimate of how long the
    control action takes, so the action *completes* on the beat rather than starting there.
  - If prep ever runs out of lead time, the extension grows its own lead and reports it as
    `requiredLeadMs`, so the coordinator's count-in grows to cover it (same self-correction as the
    MuseScore adapter).
  - `lastCommand.firedAtServerTime` is stamped after the control actually ran, so the host's
    deviation view reflects the real start.
- **Localized players** — Songsterr translates every control label, so matching only English words
  ("Play" / "Resume") found nothing on e.g. a German UI ("Abspielen") and silently pushed those
  devices onto the slower, blind Space-key toggle. The transport button is now also matched by its
  CSS-module class (local name `play`, e.g. `_8e144G_play`), which is language-independent. The
  class identifies the toggle but not its direction, so it is used only when toggling actually
  moves playback the way the command wants.
- **Background tabs** — Chrome clamps timers in a hidden tab to ≥ 1 s, which no in-page scheduling
  can undo. When a command fires from a hidden tab the extension says so in its status detail;
  keep the Songsterr tab visible while playing.
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
- **Start at measure N** → after the reset, `^f` (`--goto-measure-key`), `^a`, the measure number
  one digit at a time, `{ENTER}`: MuseScore's Find / Go to box takes a bare number as a measure,
  and the play key that follows is `play-from-selection`, so the jump is what actually plays. These
  are prefix keys, so they run during the count-in; the helper also starts its setup that much
  earlier (one command gap per extra key, plus a cushion) so the jump never delays the Play key.

  **A measure jump needs MuseScore in the foreground.** Every other command is *posted* into
  MuseScore's message queue and needs no focus, but text typed into a dialog only reaches it
  through the real keyboard focus — posted to the main window the digits are taken as note
  durations and edit the score. So a measure jump is typed, and when Windows refuses to bring
  MuseScore forward the helper starts the song **from the top** instead (posted, as usual) and
  reports measure 1, which the host shows as a mismatch. Keep MuseScore in front on the machine
  that plays from it, or expect that fallback.

The host page shows the active MuseScore window title, whether playback is inferred playing or
stopped from the last successful command, and a visible failure if Windows could not activate the
MuseScore window.

The resident MuseScore Bridge also applies the current song's playback multiplier without editing
score tempo markings. Non-100% songs are blocked when only the keyboard fallback is active.

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
- **With BandCue Bridge attached, a song change stays in the running MuseScore.** The plugin closes
  the current score and opens the next one in the same window (`closeScore()` / `readScore()`),
  which measured 0.8–0.9 s against a real MuseScore 4.7 — no new process, no plugin restart. If the
  current score has unsaved changes, MuseScore asks as usual; keeping it open is reported instead
  of opening the next score in another window. If MuseScore hands the score to *another* MuseScore
  window that already had it open, the helper closes the now-empty window and moves the plugin to
  the one showing the score.
- **Without a plugin**, the helper opens the score the Windows way. MuseScore 4 turns that into a
  **new instance**, so the helper waits for the new window (up to 15 s), closes the previous
  instances gracefully (their startup dialogs first, then WM_CLOSE — an unsaved-changes prompt
  keeps an old instance alive and is reported instead of force-killed), and starts BandCue Bridge
  in the new one, so the next change is an in-place one. Attached plugins are retired first so a
  lingering old instance cannot receive play/stop. Disable closing old windows with
  `--close-old-instances 0`.

### MuseScore plugin (bridge) — the only way to reset the playhead

Keystrokes cannot make MuseScore start from the top of a score, and this is a property of
MuseScore rather than of how the keys are delivered:

| Action | Shortcut | Why it doesn't reset playback |
| --- | --- | --- |
| `first-element` | `Ctrl+Home` | moves the cursor and the view; the **playback position** stays put |
| `rewind` | unbound by default | does nothing at all while playback is stopped |
| `play-from-selection` | `Shift+Space` | starts at the cursor — but only helps if the cursor is on a note, and `Ctrl+Home` lands on the score's first *element*, typically a title frame |

The plugin at [`extension/musescore/bandcue.qml`](../extension/musescore/bandcue.qml) solves it from
inside MuseScore. It moves the **playback position** itself, through MuseScore's playback toolbar
model, which is the same thing as typing into the toolbar's measure box: first to the top
(`playPosition = 0`), then to the start measure (`measureNumber`), then to its first beat. MuseScore
seeks asynchronously and those setters read the current position back, so the plugin takes one
step at a time and reads each result back before the next. On the downbeat it sends a plain `play`.

It used to select the first note and send `play-from-selection` instead. Measured on MuseScore
4.7.2, that silently did nothing whenever the score had been opened by MuseScore at launch, and on
repeat plays, because a plugin's selection does not reliably reach MuseScore's playback. A plain
`play` from a position set this way started every time. The plugin still selects the starting
note, but only so the band can see on screen where the song will start.

**The plugin checks that MuseScore really plays.** After a Play it watches the playback position.
If the position has not moved within 2 s, it sends `playbackCheck { started: false }`, and the
helper turns the command into a failure the host shows. A play that only *looked* successful can
no longer go unnoticed. The plugin also reports `playReady` (MuseScore's `isPlayAllowed`). Until
it is true, the helper reports MuseScore as not ready, and an `open` only finishes once the new
score's sounds have loaded: measured 0.7–1.1 s after the score opened.

**Downbeats are timed by the wall clock.** A QML `Timer` runs on Qt Quick's animation clock, and
inside MuseScore that clock ran up to twice as fast as real time: a Play due in 1.5 s fired after
0.6 s. The plugin's timer now only decides when to look at `Date.now()`, and it waits out the last
30 ms exactly. Measured: every Play fired 0–1 ms from the scheduled downbeat. Each result carries
`receivedAt`/`firedAt`, and the helper logs a `[timing]` line and reports `firedAtServerTime` to the
room.

**The plugin has no window, on purpose.** MuseScore runs a `pluginType: "dialog"` plugin as a
window and closes every dialog whenever a score closes, so a dialog bridge could never survive a
song change — which is why earlier versions launched a whole new MuseScore per song and then
restarted the plugin through the Plug-Ins menu. A plugin without `pluginType` stays loaded for the
life of the MuseScore process: it keeps its timers and its socket after `onRun`, survives score
changes, and needs starting only once per MuseScore session. Its status shows on the host page.

**Install and start — automatic.** With `--bridge-port`, the helper sets everything up at startup
(turn it off with `--plugin-setup 0`):

- copies the current `bandcue.qml` into MuseScore's Plugins folder, taken from **Preferences →
  Folders** if set there, otherwise from Windows' *Documents* folder — which OneDrive commonly
  redirects to `%USERPROFILE%\OneDrive\Dokumente`, so the literal `%USERPROFILE%\Documents\
  MuseScore4\Plugins` is never assumed;
- enables BandCue Bridge in `%LOCALAPPDATA%\MuseScore\MuseScore4\extensions\config.json`;
- binds it to **Ctrl+Alt+Shift+B** in `%LOCALAPPDATA%\MuseScore\MuseScore4\shortcuts.xml` (MuseScore
  merges that file with its defaults, so one added entry is safe).

MuseScore reads all of that when it starts, so after the first setup **restart MuseScore once**;
the host shows that request until it is done. From then on, whenever MuseScore is running without
the plugin and nothing is playing or armed, the helper starts it by pressing that shortcut in
MuseScore's window. It asks Windows for the foreground once; a background helper is usually
refused, so it then waits until MuseScore is in front — a MuseScore the helper just opened comes to
the front by itself (measured: 1.1 s, plugin attached 3.3 s after the score opened), and a running
one when someone clicks it (the host then says *"Click into MuseScore once…"*). It closes
MuseScore's startup dialogs first with Esc — the update notice and the welcome tour are modal and
swallow any shortcut — and hands the foreground back if it took it.

**It never types into anything but MuseScore.** Keys are sent only after checking that the
foreground window belongs to MuseScore, and the foreground is never forced with input tricks (an
Alt tap, attaching to the foreground thread): while Windows keeps another app in front, anything
typed lands in *that* app — an Esc into a terminal or chat window interrupts whatever it is doing.
If the shortcut goes in and no plugin attaches three times, the helper stops and asks on the host
for a MuseScore restart. Turn the automatic start off with `--plugin-autostart 0` and use
**Plug-Ins → BandCue Bridge** yourself.

Why a shortcut: MuseScore 4.7's own "run automatically after a score opens" setting fails for every
plugin (it looks plugins up under an `action://` URI they are not registered under, and logs an
assertion), MuseScore ignores shortcuts *posted* to a background window, and the old route —
`Alt+P`, `Down`, `Enter` — depended on the menu's order and landed in whatever dialog was open.
Running the plugin a second time is harmless: the helper retires every copy but the first.

**Verifying the bridge is really attached.** `GET http://127.0.0.1:<bridge-port>/status` returns
`{"status":{…}}` filled in from the plugin's own 2 s keep-alive. An empty `"status":{}` means no
plugin is connected — the adapter is running keyboard-only, and every non-100 % song will be
refused with *"MuseScore Bridge must be connected to set N% tempo"* rather than played at the wrong
speed. The adapter's `tempo.detail` in the room state says the same thing: *"100% tempo uses normal
MuseScore playback"* is the **no-bridge** wording, while an attached plugin reports *"applied
through MuseScore Bridge"*.

**Transport.** The plugin talks to the adapter's `--bridge-port` over a WebSocket on the same port
as the HTTP API. MuseScore's plugin sandbox has no HTTP client, but it does expose
`api.websocket.open(port, callback)` — note that it takes a *port*, not a URL, which is why the
adapter accepts the upgrade on any path. Commands are **pushed** rather than polled, so no poll
interval sits between the count-in and the plugin.

That socket API reports nothing when a connection drops, so the helper **pings** every attached
plugin once a second and the plugin reconnects after 4 s without hearing from it — restarting the
helper no longer means restarting the plugin (measured: re-attached 0.34 s after the helper came
back). The helper in turn drops a plugin silent for 6 s. Only the first plugin to attach takes
commands; any later copy is sent `retire` at once, so two copies can never both start playback.
(The plugin could listen instead, but MuseScore's plugin WebSocket *server* binds every network
interface, which would put score control on the LAN.)

| Direction | Message | Meaning |
| --- | --- | --- |
| → plugin | `hello` | `{ fallbackMs, startMeasure, currentSong }` on connect |
| → plugin | `ping` | once a second; what the plugin's reconnect watches |
| → plugin | `command` | `{ sequenceId, action, dueLocalAt, resetBeforePlay, startMeasure, currentSong }` |
| → plugin | `open` | `{ sequenceId, path, scoreName, startMeasure, currentSong }` — change songs in this window |
| → plugin | `song` | the current song changed: `{ startMeasure, currentSong }` |
| → plugin | `prepare` | `{ startMeasure, reason, currentSong }` — park the cursor there now, no downbeat involved |
| → plugin | `retire` | stop for good: another copy is attached, or the helper is replacing this MuseScore |
| → adapter | `claim` | stops the keyboard fallback (or, for `open`, the new-MuseScore fallback) from also running |
| → adapter | `result` | `{ sequenceId, status, playback, detail, startMeasure, reason, receivedAt, firedAt }` |
| → adapter | `playbackCheck` | `{ sequenceId, started, afterMs, detail }`: whether a Play really started |
| → adapter | `status` | `{ ready, playReady, title, playback, version, canOpenScores }`; also the keep-alive, every 2 s |

**Start measures belong to the plugin while it is attached.** A claim suppresses the keyboard path,
including the Find / Go to typing that jumps to a measure, so the plugin does the jump itself. It
seeks the playback position to the measure (see above), and `selectStartPoint()` additionally walks
the measure chain from `curScore.firstMeasure` to put the visible selection on that measure's first
note, falling back across tracks when voice 1 of the top staff rests there. The measure playback
actually starts from comes back in the `result`, so a score too short for the song shows up as a
host warning instead of quietly playing the intro.

A command due immediately (a Stop has no count-in) waits up to 300 ms for an attached plugin's
claim before the keyboard path takes over. Without that wait the round trip of the claim lost the
race and Stops went out as keystrokes.

The `prepare` message keeps that walk off the critical path. The adapter sends it whenever the
room's intent is already known and nothing is waiting on a beat — the bridge connected, the score
opened, the current song changed, the host armed, playback stopped — so by the time a Play arrives
the cursor is normally already on the right bar, visibly, and the downbeat only has to start
playback. The adapter never sends it while the transport is running: the plugin sees playback start
but never sees a song end on its own, so only the adapter can tell a quiet moment from a song in
progress. The Play re-selects anyway, so a `prepare` that never arrived costs correctness nothing —
and a click in the score between arming and Play cannot move where the song starts.

These route through the same handlers as the HTTP endpoints, so the two transports cannot drift
apart. While a bridge is attached the adapter reports **`requiredLeadMs: 0`** — there is no window
to foreground and no shell to launch. A command the attached plugin has claimed never falls back to
keyboard control, even when its result is late: the plugin may already have started or stopped
playback, and the keyboard path is a Space *toggle* that would undo it.

### MuseScore Bridge API

When started with `--bridge-port` (e.g. `4731`), the helper exposes a small HTTP API on
`127.0.0.1` so a MuseScore plugin or external script can take over playback with real playback
state instead of relying on simulated keystrokes.

| Method & path | Purpose |
| --- | --- |
| `GET /status` | Current bridge status, current song, and `{ fallbackMs, lastSeenAt }`. |
| `GET /catalog` | The privacy-safe local score catalog (title + relative path). |
| `GET /commands` | Queued/claimed BandCue commands, soonest first. Each carries `sequenceId`, `action`, `dueLocalAt`, `scheduledServerTime`, `resetBeforePlay`, `startMeasure` (absent means "from the top"), and the current MuseScore song. |
| `POST /commands/{sequenceId}/claim` | Claim a command (body `{ "controlPath": "musescore-plugin" }`). |
| `POST /commands/{sequenceId}/result` | Report the outcome (`{ "status": "succeeded", "playback": "playing", "title": "…", "controlPath": "…", "startMeasure": 8 }`). Report `startMeasure` for a play so the host knows the jump was honored; without it the helper reports measure 1 and the host warns. |
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

**Fallback timing.** A command still unclaimed at the downbeat falls back to the Windows keyboard
path immediately. A claimed command gets `--bridge-fallback-ms` (default **900 ms**) after the
scheduled time to report its result. If the plugin that claimed it is still attached, a late result
does *not* trigger keyboard control — the plugin may already have acted, and the keyboard path is a
Space toggle that would undo it — so the adapter reports the command as pending and waits up to 5 s
more for the plugin's word before declaring it failed. Only a claimed command whose plugin has
disconnected (or one claimed over the HTTP API) falls back to the keyboard. Without an active bridge
helper, Windows activation/reset begins during the count-in and only the final Play key waits for
`dueLocalAt` (`--dispatch-lead-ms`, default **1000 ms**). `open-song` does not use the transport
queue: an attached plugin gets an `open` and has 2 s to claim it, else the helper opens the score in
a new MuseScore itself (see *Local score catalog & auto-open*). A claimed `open` is never followed by
that fallback, because the plugin may already have closed the previous score.

Only helpers that can take a command count as an active bridge: polling `GET /commands`, claiming,
or reporting. Reading `GET /status` or `GET /catalog` does not, so a status check can no longer drop
the keyboard path's count-in to zero.

**Resident trigger (the normal path).** Spawning `powershell.exe` and loading the
`System.Windows.Forms`/`Microsoft.VisualBasic` assemblies costs ~1.8 s, and doing that per command
puts the cost inside the count-in — which a room synced to an external timeline cannot absorb
(one 4/4 measure at 128 BPM is 1875 ms). The helper therefore keeps **one** PowerShell resident
for the session ([`musescore-trigger.ts`](../src/adapters/musescore-trigger.ts)) and splits the
work around the cue:

| When | Work | Measured |
| --- | --- | --- |
| Adapter startup | Launch the shell, load the assemblies | 1.0–3.4 s, once |
| Room **arms** (`resolve`) | Scan for the MuseScore window and cache it | 16–100 ms |
| Lead time (`fire`) | Post the stop/reset prefix into MuseScore's queue | 248–436 ms of a 550 ms lead |
| Downbeat | Post the Play key | 1–21 ms off the downbeat |

Requests are newline-delimited JSON over the process's stdin/stdout, correlated by id. The lead
this path asks of the room (`requiredLeadMs`) is therefore **550 ms**, not the ~2.3 s the
shell-per-command path needs.

**Keys are posted, not typed — and this is why.** `SendKeys` types into whatever window holds the
keyboard focus, so using it means MuseScore must be foregrounded first. That turns out not to be
something an adapter can rely on: Windows only permits `SetForegroundWindow` under narrow
conditions — the caller is already the foreground process, *was started by* it, or received the
last input event — and a helper launched from an unfocused console meets none of them. The
activation is then refused outright, with no error beyond the window not changing.

Worse, it is refused precisely when it matters. On a Helix rig the host page needs the keyboard
focus to receive the cue, so MuseScore cannot have it, so activation fails, so every command falls
back to the slow shell path and fires hundreds of milliseconds late.

The resident trigger therefore delivers keystrokes with `PostMessage` straight into MuseScore's own
message queue (`WM_KEYDOWN`/`WM_KEYUP`, modifiers posted around the key and released in reverse).
Qt reads them from the queue like any other input, so **no foreground window is required at all** —
verified against a real MuseScore 4 window while another application held the focus. Keys are
translated from their SendKeys spelling by `parseSendKeysToken`, and if any key in a sequence cannot
be expressed that way the whole sequence falls back to `SendKeys` rather than being half-posted.

Because focus no longer matters, the [system-wide hotkey options](Configuration.md#external-cue-helix-and-other-pedals)
are optional rather than required. They remain useful when you want to *use* MuseScore's window
yourself, or keep the host page on a phone. The listener can claim Arm, Play, Stop, Next, Previous,
Open, and the two setlist-automation toggles in one resident process.

When a command does fall back, the adapter says so on its console and immediately reports the
fallback's much larger `requiredLeadMs` to the room, so a degraded path can never quietly sit
behind a count-in that was sized for the fast one.

A trigger that exits, times out, or cannot take the window falls back to the shell-per-command
path below, and the adapter immediately reports the higher `requiredLeadMs` so the room's count-in
grows to match.

**Keeping the fallback path's timing consistent.** When commands do fall back to a shell each, a
cold DLL load or a busy scheduler can push the setup past the lead time, and the final Play key
then fires immediately (late) instead of on the downbeat. Three things keep this in check:

- **Background priming.** Every ~45 s the helper spawns a throwaway PowerShell that only loads
  those assemblies and exits (skipped while the resident trigger is up, which holds them already).
  Windows keeps recently used DLL pages in its standby cache, so the real trigger spawn later in
  the same session usually loads them from RAM instead of disk.
- **Self-adjusting lead time.** Each Play command reports how long its setup (spawn, activation,
  prefix keys) actually took. If it overran `--dispatch-lead-ms` and the key fired late, the helper
  grows its effective lead time (by the overrun plus a small cushion, capped at 4 s), logs a
  warning, and reports the new requirement to the room in its next `adapterStatus` as
  `requiredLeadMs`. The coordinator folds that into the room's count-in the same way it already
  does for a client's measured clock RTT/jitter (`scheduleDelayForClients` in
  `shared/transport.ts`), so the *next* Play gets a longer count-in too — a locally-grown lead time
  is otherwise capped at whatever count-in the room already scheduled and can't help on its own.
  This only stretches the count-in for songs the MuseScore adapter actually applies to
  (`sourceType: "musescore"` or a `museScoreSource`) — a connected-but-idle adapter's setup lead
  never bleeds into a Songsterr-only or Helix-only song's schedule, since it has nothing to
  spawn/activate for that song.
  Verified live end-to-end (real coordinator, real MuseScore 4, real keyboard control path): after
  one adaptive correction, 17 further Play commands landed within 0–21 ms of the scheduled downbeat,
  down from up to ~900 ms of erratic lateness beforehand.
- **Tighter final wait.** The trigger script raises its own process priority and shrinks the OS
  timer tick (`timeBeginPeriod(1)`) for the duration of the precise wait loop, so `Start-Sleep`
  tracks `dueLocalAt` more tightly than the default ~15.6 ms system tick allows.

If Play keeps firing late even after the lead time grows toward the 4 s cap, the resident trigger
is not being used and the bottleneck is outside BandCue's control — most commonly antivirus
real-time scanning of every new `powershell.exe` launch. Excluding `powershell.exe` (or the
specific `System.Windows.Forms`/`Microsoft.VisualBasic` assemblies) from real-time scanning, or
switching to bridge mode (which does not re-spawn a shell per command), removes that variable
entirely. A room whose count-in requirement sits in the seconds is always worth investigating
rather than covering with extra count-in measures.

**Several MuseScore windows open.** Both paths pick the *newest* window matching `--process-match`
/ `--title-match`. Leaving old instances open makes the window scan slower and the choice
ambiguous, so let `--close-old-instances` do its job (on by default) or close them yourself.

For driving the host entirely from MuseScore while the band stays on Songsterr, see
[Running the Host on MuseScore (Bridge Mode)](../README.md#running-the-host-on-musescore-bridge-mode).
</content>
