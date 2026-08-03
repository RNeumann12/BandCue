# Changelog

## 1.6.1 - 2026-08-03

### Fixed

- **Songsterr playback worked only with a Songsterr Plus account.** Changing playback speed is a
  Plus feature, and the extension refused every Play until a tempo was "applied" — so on a free
  account the room could not start a single song, not even at the default 100%. Two things were
  wrong. The current speed was read from the speed button's *tooltip*, which describes the range
  Songsterr supports ("Tempo ändern … für 15%–175%"), so a tab playing at 100% looked like 15% and
  BandCue tried to change it; on a free account that click opens the Plus upsell rather than a
  speed panel, and the failed tempo then blocked the transport. The speed is now read from the
  button's own text (and the panel's slider when it is open), and a song at the default 100% no
  longer needs a control that a free account does not have. Any other tempo is still refused, now
  naming Plus as the reason, so nothing quietly plays at the wrong speed.

  Verified live against a real Songsterr tab with no account: a room of eight starts (three from
  the top, five at a later measure) all played, and a song asking for 80% was still refused with
  *"Songsterr (Windows) has not applied 80% tempo: … changing speed needs Songsterr Plus (the
  player shows 100%)."*

## 1.6.0 - 2026-08-03

### Added

- **Start a song at a later measure.** A setlist song can carry a **Start at measure**, and Play
  then starts the whole room there instead of at the top — rehearse the second chorus without
  sitting through the intro. The measure travels with the song on the play command every adapter
  already receives, and each one resolves it in its own player:
  - **MuseScore**: `Ctrl+F`, the measure number, `Enter` (its own Find / Go to), sent as prefix
    keys during the count-in, then `play-from-selection` so the jump is what actually plays.
    Configurable with `--goto-measure-key`. Typing into the Find box uses a shorter gap than a
    transport key does — at the full command gap the extra keys overran the dispatch lead and the
    Play key fired ~90 ms late. Unlike every other command it is *typed*, not posted into
    MuseScore's message queue: posted, the digits land in the score view as note durations and
    edit the score (observed on MuseScore 4 — added beams and a system break). Typing needs the
    foreground, so when Windows refuses to bring MuseScore forward the song starts from the top
    instead and reports measure 1 rather than leaving that device silent.
  - **Songsterr in the browser**: clicks the bar under Songsterr's own measure number, then reads
    Songsterr's play cursor back to confirm it landed there. Songsterr sometimes draws repeated or
    empty measures compressed, and such a measure has no position of its own to start from — the
    tab then starts where Songsterr put the cursor (or at the top when the measure isn't drawn at
    all) and reports it, rather than clicking on until the cursor "looks right", which measurably
    bought a start a whole measure late.
  - **Songsterr on Android**: seeks the media session to the measure's position in time, which
    needs the song's BPM and beats per measure and a session that allows seeking (and is stretched
    by the song's tempo percentage, the same way its effective duration is). Where that is missing
    it plays from the top and says so.

  Timing is untouched: every adapter does the seek inside the count-in, never on the downbeat, and
  the extra work is paid for with an earlier hand-off rather than a longer count-in for everyone.
  Measured end to end against a live coordinator: with the real extension on a real Songsterr tab,
  starts with a measure jump landed within 0–2 ms of the scheduled downbeat (mean 0.4 ms over five
  jumps), and with the real MuseScore helper driving MuseScore 4, five jumps landed within 0–2 ms —
  in both cases the same as starts from the top in the same session. MuseScore's own position
  readout confirmed the jumps: measure 8 began playing at 0:00:14, measure 20 at 0:00:38, at
  120 BPM in 4/4.

  Adapters report the measure they really started from, and the host warns by device name when one
  of them differs from what the song asked for — so "one phone is playing the intro" is something
  you read rather than something you hear.

## 1.5.4 - 2026-08-02

### Fixed

- BandCue Bridge now minimizes its own MuseScore plugin window after startup.
  The dialog stays resident and connected but no longer covers the score or
  other rehearsal windows, including after automatic song-change handoffs.

## 1.5.3 - 2026-08-02

### Fixed

- Recovery after an unpacked Songsterr extension reload now reloads the tab and
  retries once. It no longer executes the content script twice in one document,
  which caused `Identifier 'lastControlDetail' has already been declared` and
  left the adapter unable to control tempo or transport.
- MuseScore song changes now start BandCue Bridge automatically in the newly
  opened MuseScore process. MuseScore 4 creates a new process even when its QML
  `readScore(path)` API is used, so keeping the old plugin alive only kept it
  attached to the old score; the helper now performs the process handoff for the
  user instead. Existing bridge dialogs retire before the switch, preventing an
  unsaved old score window from continuing to receive transport commands.

## 1.5.2 - 2026-08-02

### Fixed

- The Songsterr extension now injects and retries automatically when an
  already-open tab has no content script after an unpacked-extension reload.

## 1.5.1 - 2026-08-02

### Fixed

- The Songsterr browser extension now waits for the lazy-loaded speed panel and
  drives Songsterr's custom desktop slider or compact fine-tuning buttons instead
  of looking only for a native range input.
- The MuseScore plugin no longer treats `open-song` as Stop and falsely reports
  `open-song fired`; it delegates opening to the Windows helper's local score
  catalog.

## 1.5.0 - 2026-08-02

### Added

- Per-song playback tempo from 15% to 175%, shared by the Songsterr browser
  extension, the MuseScore desktop bridge, and the Songsterr Android adapter.
- Tempo editing in the setlist UI and preservation through JSON import/export.
- Tempo readiness reporting and Play blocking when an applicable adapter cannot
  confirm the requested non-default tempo.
- Tempo-aware automatic song duration while keeping stored durations normalized
  to 100% speed.

## 1.4.4 - 2026-08-02

### Fixed

- **A Songsterr device's Stop was holding the whole band's downbeat.** Found while verifying the
  iPad audio fix against a real device: after a few songs the iPad was asking the room for a
  2500 ms count-in — the hard cap — and the coordinator raises the floor under *every* Play to
  match (`scheduleDelayForClients`), so one device that stops perfectly well was delaying everyone
  by two and a half seconds.

  The cause is that a Stop is scheduled for *now* (`scheduledServerTime: now`), so it always
  reports reaching its deadline with no lead left — the IPC hop alone guarantees it. That fed the
  self-correcting dispatch lead, which only ever grows, so every Stop ratcheted it upwards until it
  pegged. Only a Play adjusts the lead now: a Stop has no downbeat to hit and nothing to prepare.

  Observed on the device: with the lead pegged at 2500 ms the first Play still landed 630 ms late,
  while the following three landed within 15 ms of the downbeat.

## 1.4.3 - 2026-08-02

### Fixed

- **Orion for iPadOS tells extensions it is Chrome**, and BandCue believed it. The gesture-gated
  audio handling identified WebKit the classic way — `AppleWebKit` present, `Chrome` absent — which
  is precisely backwards for the one browser the feature exists for: Orion hosts *Chrome*
  extensions, so the user agent an extension sees on an iPad claims Chrome. Together with the
  `AudioContext` requirement removed in 1.4.2, that is the second reason nothing ever ran on a real
  iPad. Verified against the device: the extension reported the untouched `Songsterr content script
  ready` and never a word about audio, through three releases.

  The device is now identified by what it *is* rather than what its browser claims to be: an Apple
  platform token plus a touch screen. A desktop OS token (Windows/Android/CrOS/Linux) still stays
  out — those devices have their own adapters and do not gate audio this way.
- The reason a device skips the handling is now reported unconditionally, with the user agent that
  decided it (`gesture-gated audio handling off (apple=0 touch=1 …) ua="…"`). Every wrong guess
  about this device was made from somewhere other than the content script's own world; now it says
  so itself.
- The room was told the count-in had been extended to `556.5126953125 ms`. The self-adjusting lead
  is derived from a fractional clock offset and is now rounded.

## 1.4.2 - 2026-08-02

### Fixed

- **The iPad audio handling had never actually run on an iPad.** Measured against a real device
  (Orion on iPadOS): the extension decided whether a device gates audio behind a user gesture by
  asking, among other things, whether it could construct an `AudioContext` — and Orion's
  *content-script sandbox* presents no such constructor, even though the page it is injected into
  gates audio exactly as assumed. One missing constructor in the wrong world therefore switched off
  the entire feature: no "tap to enable" banner, no arming, and — since 1.4.1 — no priming either,
  on the one platform all of it exists for. It has been inert since it shipped in 1.3.2, which is
  why a member still had to press Play and Stop by hand after every load.

  The gesture-gated decision is now made from the browser alone (WebKit + touch), and the two
  halves are independent: priming Songsterr's own engine is pure DOM and runs everywhere the
  decision holds, while the arming of BandCue's own context switches itself off where no
  `AudioContext` exists. A device in that state reports **"priming only; no Web Audio in this
  context"** and is no longer counted as un-armed forever — an arm that can never be observed must
  not permanently mark a working device as dead.
- A device that skips the gesture-gated handling now says so on its first status when it is a
  WebKit-family browser (`gesture-gated audio handling is off here (touchPoints=…,
  audioContext=…)`). "The feature never ran" and "the feature ran and found nothing to do" used to
  look identical from the host, which is what hid the bug above through two releases.

## 1.4.1 - 2026-08-02

### Fixed

- Songsterr on iPad/iPhone (Orion) stayed silent unless a member pressed Play and Stop by hand
  after every load. 1.3.2 unlocked the extension's *own* AudioContext from a real touch, which is
  necessary but not sufficient: WebKit carries the "must start from a user gesture" restriction on
  each AudioContext, and Songsterr's is a different object from ours. Unlocking ours only proved a
  touch had happened — nothing had reached the engine that actually renders the Synth source, so
  the device could report itself armed and still play nothing. Pressing Play by hand worked because
  that gesture *did* reach Songsterr's engine, which is why the ritual had to be repeated per load
  rather than once per session.

  The extension now performs that ritual itself. On the touch that arms the device it also starts
  Songsterr through the player's own transport and stops it again 140 ms later, synchronously
  inside the gesture — the start runs while the document's user activation is still live, which is
  what lets Songsterr's context begin — then sends the score back to the top. Afterwards our
  synthetic clicks drive a running engine. It costs a blip of sound rather than a silent set.

  The same cycle re-runs by itself ~700 ms after each in-page song switch, so a member who tapped
  once at the start of the night does not have to tap again for every song BandCue loads for them.

  Priming never goes near the downbeat: it is refused while a transport command is pending or a
  BandCue play is running, it is cancelled the instant a command arrives (leaving playback
  stopped), a switch made inside a count-in is told not to prime at all, and a tap on Songsterr's
  own transport is left alone rather than clicked over. Playback that ends by itself — which is
  never followed by a Stop command — is noticed on the status tick, so priming does not stay
  blocked after the first song.
- A play that WebKit swallowed silently used to be reported as a clean start: the click lands and
  Songsterr's button flips to Pause whether or not any sound follows. The device now looks at
  whether the player's position actually moved a second into the song, and when it did not, tells
  the host **"the player never moved (silent start)"** and puts the "tap once" banner back instead
  of leaving the member to discover it by ear. Devices that expose no position are left alone
  rather than guessed at.
- An armed iPad could go quiet again after sitting through a song, because iPadOS reclaims an
  *idle* audio session when the tab is backgrounded or the screen locks. The arming context now
  holds one silent looping source (through a gain of zero) for as long as the page lives, so the
  session is not idle to begin with.
- A Songsterr transport command that threw left the content script believing a command was still
  pending, which blocked audio priming for the rest of the session and closed the reply channel
  with no reason attached. The failure is now reported to the host like any other.

### Changed

- The host now distinguishes the two halves of the iPad audio state: *not armed* (no touch yet),
  *engine is not started* (touched, but Songsterr's own audio has not run), and armed **and**
  primed. Previously both dead states read the same, and the second was invisible.

## 1.4.0 - 2026-07-30

### Changed

- Setlist mode is gone as a mode. It was a third place to start and stop playback — turning the
  toggle on loaded, armed and played the current song, turning it off stopped the room, and a
  manual Stop silently switched it back off — so it never sat still next to the Arm/Play/Stop the
  host actually uses. Its behaviour is now two switches inside the host's transport panel, both
  simply on or off and remembered across reloads:
  - **Auto-load next song** (`Ctrl+Alt+R`): when a song ends by itself, make the next entry
    current and ask every adapter to load it.
  - **Auto-start it** (`Ctrl+Alt+T`): once that song has loaded, arm and play it too. Off, the
    next song sits loaded and waiting for the host's Play — which is the split the old single
    toggle could not express. Only meaningful for auto-loaded songs, so it greys out with
    auto-load off.

  Play and Stop keep their plain meaning: nothing is auto-started unless a song ended on its own,
  a manual Stop never advances the list, and Stop pressed while the next song is still loading
  calls off its auto-start.

### Changed

- **The Windows MuseScore adapter no longer needs MuseScore in the foreground.** Keystrokes are
  posted straight into its window's message queue (`WM_KEYDOWN`/`WM_KEYUP`) instead of typed into
  whatever window has the keyboard focus. `SendKeys` had made a foreground MuseScore a hard
  requirement, and that requirement could not be met: Windows only permits a foreground change when
  the caller is already the foreground process, was started by it, or received the last input event,
  and an adapter launched from an unfocused console meets none of them — the activation is simply
  refused, silently. It failed exactly when it mattered, too, since on a Helix rig the host page
  needs that same focus to receive the cue. Verified against a real MuseScore 4 window while another
  application held the focus. Keys whose SendKeys spelling cannot be expressed as a single
  keystroke keep the old path, per sequence rather than per key. The lead the adapter asks of the
  room is now **550 ms**, and the Play key landed 1–21 ms off the downbeat.

### Added

- **A MuseScore Studio plugin** (`extension/musescore/bandcue.qml`) that runs BandCue's play/stop
  from inside MuseScore, and with it the only reliable way to start a song from bar 1. Keystrokes
  cannot do it, and that is MuseScore's own doing rather than a delivery problem: `Ctrl+Home`
  (`first-element`) moves the cursor and the view but not the playback position, `rewind` does
  nothing while playback is stopped and ships unbound anyway, and `play-from-selection` starts at
  the cursor — which `Ctrl+Home` leaves on the score's first *element*, usually a title frame
  rather than a note. So a reset looked like it almost worked: the score scrolled back to the top
  while playback carried on from wherever it was last clicked. Inside a plugin the cursor API can
  select the first real chord or rest (`cursor.rewind(0)` → `selection.select(cursor.element)`),
  which is exactly what keystrokes could not express.

  The plugin reaches the adapter's `--bridge-port` over a WebSocket on the same port as the HTTP
  API, because MuseScore's plugin sandbox has no HTTP client but does expose
  `api.websocket.open(port, callback)`. Commands are pushed rather than polled, so no poll interval
  sits between the count-in and the downbeat, and `claim`/`result`/`status` route through the same
  handlers as the HTTP endpoints so the two transports cannot drift apart. While the plugin is
  attached the adapter asks the room for **no extra count-in at all** (`requiredLeadMs: 0`): there
  is no window to foreground and no shell to launch. If it claims a command and then reports
  nothing within `--bridge-fallback-ms`, keyboard control still runs.
- **`--cue-hotkey` on the Windows MuseScore adapter**, which claims the cue combination (e.g.
  `ctrl+alt+p`) system-wide and turns it into a Play request stamped with the instant Windows
  generated the input. It exists to resolve a standoff that had no solution inside BandCue: the
  host page can only see a pedal's keystroke while the browser holds the keyboard focus, and
  MuseScore can only be driven by keystrokes while *it* holds the focus. On a machine doing both —
  the normal Helix setup — one of them always lost, and a background adapter is usually refused
  the foreground outright, so every Play fell back to the slow path and landed several hundred
  milliseconds late. With the cue claimed system-wide, MuseScore keeps the foreground all night,
  activation becomes a no-op, and the host page can live on a phone. Use it on one machine per
  room; the room must still be armed. Also exposed as `-CueHotkey` on the adapter launcher and
  `BANDCUE_CUE_HOTKEY`, and as a double-clickable
  **`BandCue MuseScore Bridge - Helix Cue.cmd`** for the machine the pedal is plugged into.

  A captured cue is sent as a new `externalCue` message, **not** as a play request: the coordinator
  relays it to the host, which then makes its own ordinary Play. Who may start playback is a room
  policy — in host-only mode nobody but the host may — and owning a hotkey must not promote an
  adapter into an authority it did not have. So the pedal behaves exactly like the host pressing
  its own Play hotkey, host-only keeps meaning what it says, and a cue with a stamp in the future,
  older than 3 s, or with no host connected is refused with a reason.

### Fixed

- The MuseScore adapter could report that it needed only a few hundred milliseconds of count-in
  while every command was in fact falling back to the slow shell-per-command path, which needs
  seconds. The room sized its count-in for the fast path, the fallback could not make it, and
  starts landed late with nothing in the logs to say why. A fallback now says so on the console
  and immediately reports the lead time it really needs.
- A Helix-synced room started about a beat behind the backing track, and no count-in or offset
  setting would move it. The Windows MuseScore adapter did all of its work *inside* the count-in —
  launch `powershell.exe`, load the SendKeys/AppActivate assemblies, scan every process, foreground
  the window, send the reset key — which measured ~2.3 s on a real machine. It asked the room for
  that much lead time, the coordinator raised the floor under every start to match, and since one
  4/4 measure at 128 BPM is only 1875 ms, every Helix start was held ~1.1 s past the Helix's
  downbeat. Because the floor swallowed the whole count-in, the global Helix offset and the
  count-in measures had no effect at all — the symptom that made this look like a scheduling bug
  rather than a slow adapter. (Before the adapter had grown its lead, the room *was* scheduled on
  the downbeat and MuseScore simply fired 1162 ms late instead; the lateness moved, it never left.)

  The adapter now keeps one PowerShell resident for the session and moves everything it can off
  the count-in:
  - the shell launch and assembly load (~1.8 s together) happen once, at adapter startup;
  - the MuseScore window is looked up when the room **arms**, without touching the foreground —
    the cue is a keystroke, so taking focus early would send it into MuseScore instead of the
    host page and no Play would ever be requested;
  - the count-in only has to cover taking the window and sending the reset.

  Measured on a real window: startup 1.0 s (once), arm-time lookup ~16 ms, and setup using
  248–294 ms of its lead with the Play key landing on the downbeat. The lead the adapter asks of
  the room drops from 2298 ms to 600 ms, so a single count-in measure now clears the floor and the
  Helix offset does what it says again. A trigger that dies, times out, or cannot take the window
  falls back to the old shell-per-command path, and the room hears the higher lead requirement
  immediately.
- Helix-triggered starts landed a Wi-Fi hop late, every time. The Helix's count-in was timed from
  the moment its Play request reached the coordinator, so everything the cue spent on its way there
  — input handling on the host page, the browser's event loop, the LAN hop, the coordinator's own
  queue — was added on top of the configured count-in instead of counted as part of it. The room
  stayed perfectly in sync with itself and consistently behind the backing track, and the variance
  of that path came through as start-to-start wobble against the Helix. The host page now stamps
  the cue keystroke in room time (from the browser's own event timestamp, so a busy page cannot
  shift it) and the coordinator schedules the downbeat one count-in after *that*, ignoring stamps
  that are missing, in the future, or more than 3 s old. Measured against a live coordinator: a cue
  152 ms in transit now lands the downbeat 2000 ms after the Helix beat at 120 BPM, where it
  previously landed at 2151 ms.
- A Helix start could be pushed off the downbeat by the room's *default* count-in rather than by
  any real device need. The floor a Helix start had to clear started at the 1500 ms default —
  a comfort setting for button presses, where nothing external is waiting. It is now only what the
  connected devices actually report needing, so a short count-in is honoured whenever the room can
  in fact make it (e.g. a single 1200 ms measure at 200 BPM in a Songsterr-only room now starts on
  the beat instead of 300 ms late).
- The host's Helix panel now says up front whether the current song's count-in covers what this
  room needs, and how many count-in measures it would take if not, instead of only reporting the
  shortfall after a start had already landed late. The post-start line now also shows the cue's
  travel time and whether the start landed on the Helix downbeat.
- MuseScore only sometimes jumped back to the start of the score before playing. The reset key
  (Ctrl+Home) was read back out of the bridge command queue, but `queueBridgeCommand` drops the
  command entirely when no bridge server is listening — which is every session started with
  `Start-BandCueMuseScoreAdapter.ps1` / *BandCue MuseScore Bridge - Connect.cmd*, since that
  launcher passes no `--bridge-port`. The reset therefore resolved to `false` and only Esc was
  sent, so playback resumed from MuseScore's own start position: correct whenever that already was
  bar 1, wrong as soon as playback had last been started anywhere else. The requested reset now
  travels with the scheduled command instead of via the bridge queue.

## 1.3.5 - 2026-07-29

### Fixed

- Songsterr is now identified by its song id rather than its URL slug. Songsterr canonicalizes the
  address after loading — it rewrites the *whole* slug from the id (a request for
  `.../metallica-nothing-else-matters-tab-s437` lands on
  `.../limp-bizkit-rollin-air-raid-vehicle-tab-s437`) and appends a per-track `t<n>`. The setlist's
  stored URL therefore almost never matches the player's own address literally, so BandCue decided
  the member was on the wrong song and re-routed the player — re-rendering the whole score just as
  playback should have started, which reads as a reload and leaves the song dead. The `-s<id>` is
  the only stable part of a Songsterr address, and is what both sides now compare.
- The content script now echoes the request id on its in-page navigation answer. 1.3.4 changed the
  background to match answers by request id but did not update the sender, so every answer on that
  channel was dropped and each switch fell back to a full reload after the timeout. The background
  test fakes the content script and so could not see it; a content-script test now covers the seam.

## 1.3.4 - 2026-07-29

### Fixed

- A Songsterr tab already showing the right song could still be reloaded on the downbeat, which
  reset the song and left playback dead — on iPad it also discarded the armed audio. Two callers
  open a song at once (the host's `openSongCommand`, and the eager pre-open at the start of the
  count-in), and the in-page switch introduced in 1.3.2 tracked its pending answer per *tab*. The
  second caller overwrote the first's resolver, so one call could never complete and the other was
  answered by the first's timeout with a spurious "the router refused" — which triggered exactly
  the full reload the switch exists to avoid.

  Pending switches are now tracked per request, and concurrent opens of the same song share one
  operation instead of racing two switches down the same tab.

## 1.3.3 - 2026-07-29

### Fixed

- The in-page song switch added in 1.3.2 no longer silently falls back to reloading the tab on
  iPad. The content script's answer was only carried on the `sendMessage` reply channel, and
  Safari-derived browsers — Orion on iPadOS, the one platform the whole path exists for — do not
  reliably hold that channel open for the second or so Songsterr's router takes. A lost answer
  looks exactly like a refusal, so every switch fell back to the full reload it was meant to
  avoid. The answer is now also sent over the `runtime.sendMessage` channel that status reports
  already use successfully from those devices, and whichever arrives first wins.

### Changed

- The host now says *how* a song was reached: `switched in place, no reload`, `reloaded the tab —
  the in-page switch was not confirmed`, `tab was already on the song`, or `opened a new tab`.
  A member who sees their tab reload can tell whether the in-page switch was tried and refused or
  never attempted, instead of the host reporting only that the song opened.

**Note on 1.3.2:** its published extension zip was replaced in place about 35 minutes after
release, and the two builds share a filename and version. If Songsterr still reloads on every song
change, an install taken from the earlier zip is the likely cause — this release carries a distinct
version number so the installed build can be identified.

## 1.3.2 - 2026-07-29

### Changed

- Switching songs no longer reloads the Songsterr tab. Songsterr is a single-page app, so the
  extension now asks its router for the next song inside the same document instead of navigating
  the tab. This is the other half of the iPad fix below: arming the audio is worth little on its
  own, because every song change would tear the document down and throw the unlocked session away
  again, leaving the member to tap the screen before each song. The arm now survives a song change.

  The result is verified before it is trusted — the switch counts as successful only once the
  player has actually loaded the new song — and anything else falls back to the full tab
  navigation used before, so a change to Songsterr's router can only cost the optimization, not
  correctness. An in-page switch is also faster than a page load, so the tab is ready for the
  downbeat sooner.

### Fixed

- A Songsterr tab that is already in front is no longer re-activated when a song is selected.
  iPadOS purges background tabs under memory pressure and reloads them when they are activated,
  which could undo the in-page switch above.

- Songsterr on iPad/iPhone (Orion) no longer goes silent after switching songs. WebKit only lets
  Web Audio start from inside a *trusted* user gesture and re-imposes that rule on every new
  document, so once BandCue navigated the tab to the next song, the synthetic click still reached
  Songsterr — the button flipped to Pause — while its audio context stayed suspended: no sound, and
  the play cursor never moved. The extension now rides along on any real touch on the Songsterr
  page to unlock the document's audio session, shows a "Tap to enable BandCue audio" banner while
  that touch is still missing, and reports the unarmed state to the host so a dark iPad is visible
  before the count-in instead of after. Chromium and desktop Safari are unaffected — they grant a
  page sticky activation after one interaction, so none of this runs there.

  Arming happens on the player's tap and never on the downbeat: the scheduled transport path is
  unchanged, and the control action still reads only a boolean, so start timing is untouched.

## 1.3.1 - 2026-07-29

### Changed

- Songsterr devices can now be told apart in the room. Each member can name their device in the
  extension popup; left empty, the name is derived from their instrument and platform
  (`Bass Songsterr (Windows)`, or `Songsterr (Windows)` on Auto) instead of every device reporting
  the identical `"Songsterr tab"`. Chrome gives an extension no way to read the computer's own
  name — the only API that does is ChromeOS-and-policy-only, and no permission unlocks it
  elsewhere — so the name is the member's to set, as it already was in the Android app and the
  MuseScore adapter.

### Fixed

- Per-device timing calibration now applies to the device it was set for. The host keys saved
  manual offsets by device name, so while every extension reported `"Songsterr tab"` they shared a
  single entry and one member's offset was pushed to every Songsterr device in the room.
- A joining Songsterr device no longer adopts another member's clock estimate. The coordinator
  caches a recently-seen clock per `role + name + apps` to survive reconnects; identical names made
  every Songsterr device share one cache entry, including its manual offset.

**Upgrading:** saved calibrations are keyed by device name, so offsets stored under the old shared
`"Songsterr tab"` name stop matching once devices are renamed and need setting once more. They were
being cross-applied to every Songsterr device before this release, so this is a reset rather than a
loss.

## 1.3.0 - 2026-07-29

Start-timing release. Every adapter now does its setup during the count-in and only
triggers playback on the downbeat, and the host gains room-wide Helix controls.

### Changed

- Songsterr starts are now noticeably tighter between devices. The extension used to
  resolve *which* control to press only after the scheduled instant had already passed:
  two document-wide button scans, each forcing a layout, measured at ~5 ms apiece on a
  real Songsterr page and scaling with DOM size and CPU — a per-device head start that
  clock sync cannot compensate for. Forcing the Synth source, resetting to the song
  start, and picking the control now all happen during the count-in, so the downbeat is
  a single click. The final wait also aims early by a measured, capped estimate of how
  long that click takes, so playback *starts* on the beat instead of just being asked to.
- The Songsterr extension now finds the player's transport button on non-English
  Songsterr UIs. It previously matched English labels only ("Play" / "Resume"), so on a
  German player ("Abspielen") it matched nothing and silently fell back to a blind
  Space-key toggle after paying for both scans. The button is now also matched by its
  language-independent CSS-module class, and only used when toggling actually moves
  playback the way the command intends.
- The Songsterr extension reports how far its start landed from the scheduled downbeat,
  grows its own dispatch lead when a command runs out of count-in (reporting it as
  `requiredLeadMs` so the room's count-in grows to match), and warns when a command fired
  from a background tab — Chrome clamps timers in hidden tabs to ≥ 1 s, which no in-page
  scheduling can undo. Keep the Songsterr tab visible while playing.
- A MuseScore adapter no longer stretches the count-in for songs that don't use MuseScore. Its
  setup lead is only added when the current song actually has a MuseScore source, so a
  Songsterr-only or Helix-only song keeps its short count-in.
- Helix Stadium starts now use the configured number of complete count-in measures and support
  room-wide and per-song timing shifts up to ±60 seconds. If a negative offset leaves too little
  device-prep lead time, BandCue holds the start to exactly the lead time needed instead of
  rolling it forward a whole extra measure -- the Helix cue fires once and keeps its own timeline
  regardless of BandCue, so an extra measure of BandCue-side delay would desync it from a Helix
  count-in that cannot be made any longer. A host status line reports whether the last
  Helix-triggered Play was honored as requested or held back (and by how much) to meet that floor.
- The host now has a persistent global Helix master switch and room-wide offset control, while
  keeping per-song timing trims for exceptional songs.
- Fixed a race where the room could auto-stop playback seconds after Play if one adapter (e.g.
  Songsterr) started and briefly re-reported "stopped" before a slower adapter (e.g. MuseScore,
  mid multi-step Windows automation) had reported "playing" for the first time -- the slower
  adapter's still-stale "stopped" status from before Play was mistaken for "already finished".
  Auto-stop now requires every ready, transport-capable adapter to have actually started this run
  before treating it as finished.
- MuseScore keyboard playback now activates the window and performs stop/reset during the
  count-in, then sends the final Play key at the scheduled instant. Unclaimed bridge commands no
  longer incur the 900 ms post-downbeat fallback wait, stale bridge activity expires, and the
  adapter reports its measured key-fire deviation in the host timing view.

## 1.2.2 - 2026-07-16

Reliability and project-quality release; no new user-facing features. The
Android app is unchanged apart from the version bump.

### Changed

- Coordinator: Ctrl+C / SIGTERM now shuts down gracefully — every connected device
  receives a WebSocket close frame ("Coordinator shutting down") immediately instead
  of discovering the dead server via its heartbeat timeout.
- Coordinator: an unexpected error while answering an HTTP request (e.g. QR
  rendering) now returns a 500 response instead of crashing the whole process
  mid-rehearsal.
- The web client and the entire Songsterr extension are now statically type-checked
  (`checkJs` via `tsconfig.web.json` and per-context configs in
  `extension/songsterr/`), wired into `npm run check`, `verify`, and CI. This fixed
  two latent type mismatches in the host setlist form (numeric Helix values assigned
  to text inputs).
- CI now also runs the Android JVM unit tests (Gradle 8.10.2, no emulator) and a
  Playwright browser smoke test that boots the real coordinator, drives the host
  page, joins a fake adapter, and schedules/stops a play (`npm run test:e2e`).

### Fixed

- The packaged Chrome extension zip no longer risks picking up development-only
  files; tests, type-check configs, and type declarations are excluded explicitly.

### Docs

- README: removed the dead placeholder demo link; the setlist Export/Import section
  now links to a documented example file (`examples/setlist.example.json`).
- A committed personal setlist export was removed from the repository and
  `bandcue-setlist-*.json` is now gitignored.

## 1.2.1 - 2026-07-04

### Fixed

- Songsterr extension: room joins are more tolerant of weak rehearsal Wi-Fi. Direct host, full URL, mDNS, and LAN-scan discovery now get a slower fallback pass, remembered room hosts are tried before broad scans, and reconnects keep trying the last known WebSocket endpoint when rediscovery is flaky.

## 1.2.0 - 2026-07-02

### Changed

- Browser devices now hit the downbeat, not shortly after it: the extension forwards transport commands to the Songsterr tab ~400 ms ahead of the scheduled start, runs the pre-play work (Synth source, reset-to-start) during the count-in, and waits out the final stretch inside the page so the play action itself lands on the beat. Multiple Songsterr tabs are dispatched in parallel.
- Coordinator restarts no longer kick everyone out of the room: the room token and code persist in a local `.bandcue-room.json` (delete it to rotate them; `BANDCUE_TOKEN`/`BANDCUE_ROOM_CODE` still override), so saved URLs and QR codes keep working and every client reconnects on its own.
- Devices that were briefly offline now catch up from room state: a play scheduled while they were disconnected still starts on the beat (when enough count-in remains), and a manual Stop they missed is applied on reconnect. Automatic end-of-song stops are deliberately not replayed.
- Clock offset estimates no longer start biased toward zero after a (re)connect; the first fresh sample is adopted as-is, removing a residual timing error of up to tens of milliseconds after Wi-Fi blips.
- Room time on the coordinator is now derived from a monotonic clock, so an OS/NTP clock step mid-rehearsal can no longer shift scheduled starts or auto-stop timers.
- The count-in now adapts to the room: a playing device on a slow or jittery connection extends the scheduled delay (up to 5 s) so its command still arrives and preps in time; companion displays never extend it.
- Each device now reports when its play/stop actually executed, in room time: the host device list shows "started ±N ms vs schedule" per device, and the coordinator logs one `[timing]` line per executed command — sync issues become diagnosable (and calibratable) instead of guesswork.
- Room-state broadcasts no longer carry MuseScore catalog entries (up to 500 titles/paths went to every phone on every update); only the counts and match status are shared. The server also pings every client every 4 s to catch dead connections faster, and warns when the machine's LAN address changes mid-session and the QR/URLs go stale.
- New automated sync-accuracy harness: a simulated rehearsal with jittery Wi-Fi, latency spikes, and badly skewed device clocks asserts that all devices start within 30 ms of each other — regressions to timing code now fail CI instead of surfacing at rehearsal.

### Fixed

- Songsterr extension: when the browser blocks autoplay because the tab was never interacted with, the host now sees "Browser blocked autoplay — click once inside the Songsterr tab" instead of a generic failure.
- Android: fragmented WebSocket messages are now reassembled instead of silently dropped (latent — the current server never fragments).
- Coordinator: a client spamming messages (over 80 per 2 s) is disconnected instead of consuming the room's CPU.
- Android: WebSocket frame writes are now synchronized, closing a race where a keepalive pong from the read thread could corrupt the stream and drop the connection mid-rehearsal.
- Android: the WebSocket handshake gets its own 5 s read timeout, so a peer that accepts TCP but never answers the upgrade can no longer stall reconnecting forever.
- Coordinator: static-file path guard could be bypassed into a sibling directory whose name shares the `web` prefix; the room token is now compared in constant time; room-state broadcasts are serialized once instead of once per client.

## 1.1.0 - 2026-07-01

### Changed

- Hardened connection stability against half-open sockets (Wi-Fi drops, laptop sleep, Android Doze, killed apps) that never send a TCP close:
  - The coordinator now runs a liveness sweep that evicts clients it hasn't heard from within ~12 s (every client sends clockSync at ~1 Hz), so ghost devices no longer linger in the room and a vanished transport leader still triggers the leader-disconnect Stop promptly. New sockets that never send `clientHello` are also closed after a timeout.
  - The web and Songsterr-extension clients add a heartbeat watchdog that forces a reconnect when the server goes silent, instead of talking to a dead socket until the browser eventually tears it down.
  - The Android client enables TCP keepalive and a read timeout so a half-open connection fails and reconnects instead of blocking forever.
  - All clients now reconnect with exponential backoff + jitter (instead of a fixed delay) and reuse the last resolved endpoint between retries, so a coordinator restart isn't hammered by a LAN-scan storm. The extension adds a `chrome.alarms` backstop so a reconnect still happens after the MV3 service worker is evicted.
  - Every client now clears its clock samples and offset on (re)connect, so timing re-converges cleanly from the warm-up burst instead of blending in stale samples from before a sleep/resume (when the device clock may have just stepped).
  - The coordinator enables TCP keepalive on WebSocket connections so the OS also helps detect peers that vanish without a TCP close.

## 1.0.4 - 2026-06-29

### Changed

- The Songsterr extension now forces the player's "Synth" playback source instead of "Original" (YouTube) on page load and before every synced play, so sync stays reliable on weak connections where the original video stalls or drifts.

## 1.0.3 - 2026-06-29

### Changed

- Improved automatic clock sync so device timing converges in ~2 s instead of ~10 s: a warm-up burst of rapid samples on connect, a lowest-RTT (NTP-style) offset estimator with a wider sample window, and EMA smoothing that still adopts real clock steps immediately. Adds a "syncing…" readiness badge and a pre-Play warning when an adapter's clock hasn't settled.
- Raised the manual offset cap to ±5000 ms to cover genuine output/Bluetooth latency.

## 1.0.2 - 2026-06-25

### Added

- Added Chrome Web Store privacy, listing, reviewer, and asset-generation materials for the Songsterr extension.
- Added generated Chrome Web Store screenshot and small promo tile assets.

### Changed

- Changed the Songsterr extension's broad local-network HTTP permission to an optional host permission requested when the user connects to a BandCue room.

## 1.0.1 - 2026-06-24

### Fixed

- Fixed the public-beta host launcher preflight so release bundles accept the packaged Songsterr extension zip instead of requiring unpacked extension source files.

## 1.0.0 - 2026-06-24

### Added

- Added BandCue public-beta branding with generated browser-extension and Android launcher icons.
- Added double-click Windows host launchers for the standard coordinator and MuseScore bridge mode.
- Added a v1.0 release packaging script that builds icons, packages the extension, collects the Android APK, writes checksums, and creates a public-beta zip.

### Changed

- Bumped the Node package, Songsterr extension, and Android adapter to version 1.0.0.
- Android now declares launcher and round launcher icons.
- Extension packaging now emits both stable and versioned zip filenames.

## 0.6.0 - 2026-06-24

### Added

- Added setlist mode so the host can auto-load, arm, play, and advance through the rehearsal list until the final song finishes.
- Added manual song duration entry and adapter-reported duration binding so setlist playback can stop and advance at the right time.
- Added per-member Songsterr instrument support, including host-entered bass/drum override URLs and member-side instrument selection in the extension.
- Added QR code scanning to the Songsterr extension popup for faster room joining from BandCue room URLs.
- Added Android protocol support for bass/drum Songsterr URLs and instrument-specific URL resolution.
- Added an example exported setlist for June 24, 2026.

### Changed

- Songsterr tabs now reuse/open each member's own instrument part from a single host Songsterr URL when possible.
- Automatic setlist stops now record why playback stopped, so the host only advances when a song ended automatically rather than after a manual stop.
- The MuseScore helper pins `dev:all` sessions to the local coordinator by default.
- Extension packaging now stages the whole extension tree, including vendor scanner files, while still excluding tests.
- Documentation now covers iPad/iPhone usage through Orion browser and the new setlist, Songsterr, Android, MuseScore, and protocol behavior.

### Fixed

- Fixed scanned full room URLs by verifying that they point to an active BandCue room before connecting.
- Fixed automatic setlist end handling when adapters report that playback naturally stopped.
