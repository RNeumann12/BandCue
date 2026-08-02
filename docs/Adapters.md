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
  wrong speed.
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
- MuseScore 4 opens each score in a **new instance**, and keystroke control gets unreliable when
  several instances are running. After an auto-open, the helper waits for the new window to
  appear (up to 15 s), starts BandCue Bridge from its Plug-Ins menu, then closes the previous
  MuseScore instances gracefully (WM_CLOSE — an unsaved-changes prompt keeps the old instance
  alive and is reported instead of force-killed). Before switching, attached bridge dialogs are
  retired so a lingering old instance cannot receive play/stop. Disable closing old windows with
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
inside MuseScore, where the cursor API is available:

```js
var cursor = curScore.newCursor();
cursor.rewind(0);                       // start of the score
curScore.selection.select(cursor.element);  // the first real chord or rest
cmd("play-from-selection");
```

That selects a **note**, not a frame, so playback starts at bar 1 every time.

**Install.** Copy the folder into MuseScore's Plugins directory (Preferences → Folders shows the
path; usually `%USERPROFILE%\Documents\MuseScore4\Plugins`), enable **BandCue Bridge** under
Home → Plugins, and leave its window open while playing — `pluginType: "dialog"` is what keeps the
plugin resident, since a plain plugin exits after `onRun` and could never wait for a cue. BandCue
minimizes that dialog automatically after startup; restoring it is optional and only shows status.

**Transport.** The plugin talks to the adapter's `--bridge-port` over a WebSocket on the same port
as the HTTP API. MuseScore's plugin sandbox has no HTTP client, but it does expose
`api.websocket.open(port, callback)` — note that it takes a *port*, not a URL, which is why the
adapter accepts the upgrade on any path. Commands are **pushed** rather than polled, so no poll
interval sits between the count-in and the plugin.

| Direction | Message | Meaning |
| --- | --- | --- |
| → plugin | `hello` | `{ fallbackMs, currentSong }` on connect |
| → plugin | `command` | `{ sequenceId, action, dueLocalAt, resetBeforePlay, currentSong }` |
| → plugin | `song` | the current song changed |
| → plugin | `retire` | disconnect before the helper opens a score in a new MuseScore process |
| → adapter | `claim` | stops the keyboard fallback from also firing |
| → adapter | `result` | `{ sequenceId, status, playback, detail }` |
| → adapter | `status` | `{ ready, title, playback }`; also the keep-alive, every 2 s |

These route through the same handlers as the HTTP endpoints, so the two transports cannot drift
apart. While a bridge is attached the adapter reports **`requiredLeadMs: 0`** — there is no window
to foreground and no shell to launch — and if the plugin claims a command but reports no result
within `--bridge-fallback-ms`, keyboard control still runs.

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

**Fallback timing.** If a bridge helper claimed a command but no result arrives within
`--bridge-fallback-ms` (default **900 ms**) after the scheduled time, the Windows keyboard path
runs. A command still unclaimed at the downbeat falls back immediately. Without an active bridge
helper, Windows activation/reset begins during the count-in and only the final Play key waits for
`dueLocalAt` (`--dispatch-lead-ms`, default **1000 ms**). `open-song` is process-aware instead of
using the transport queue: the Windows helper opens the single matched local score, retires old
bridge dialogs, and launches BandCue Bridge in the new MuseScore process.

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

Because focus no longer matters, [`--cue-hotkey`](Configuration.md#external-cue-helix-and-other-pedals)
is now optional rather than required — it remains useful when you want to *use* MuseScore's window
yourself, or keep the host page on a phone, without the cue going missing.

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
