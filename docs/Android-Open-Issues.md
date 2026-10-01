# Android Adapter — Open Issues (audit 2026-10-01)

Found during the 2026-10-01 sync/reliability audit and deliberately parked: the
non-Android findings from the same audit were fixed right away, these were not.
Paths are relative to `android/app/src/main/java/com/bandcue/songsterr/` unless
noted. Line numbers are as of commit `dc51f3d`.

Status legend: `Open` · `In progress` · `Done`

---

## A1 (High) Play is refused at 100% tempo after a song change

Status: `Open`

`applyCurrentTempo()` (`BandCueAdapterService.kt:712`) runs on every song change,
including songs at 100%. When Songsterr is not the foreground app at that moment,
or the Accessibility fallback is off and Songsterr's media session does not offer
`ACTION_SET_PLAYBACK_SPEED`, it ends in `tempoStatus.state = "failed"`. The Play
preflight in `handleTransportCommand` (`BandCueAdapterService.kt:344`) then rejects
**every** Play with `controlPath = "tempo-preflight"`.

The coordinator's `tempoReadinessError` (`src/server/room.ts`) skips the check at
100%, so the room starts without the phone; the phone only shows a failed command.
A phone that uses Notification Access only is affected as soon as any song is
selected.

**Fix idea.** Mirror the server: a requested 100% needs no preflight. Only
apply/verify tempo when the song asks for something other than 100%, or when the
previous song left Songsterr at a non-100% speed. Re-try a failed apply when
Songsterr comes to the foreground instead of only on the next song change
(`tempoSongKey` currently blocks retries).

## A2 (High) Accessibility path fires ~300 ms+ late on every Play, unreported

Status: `Open`

The room sends `resetBeforePlay = true` with every Play. Songsterr's media session
does not advertise seek, so with Accessibility enabled `executeTransport` routes
Play through `BandCueAccessibilityService.controlSongsterr`, which at the downbeat:

1. walks the accessibility tree to find the play and reset controls,
2. dispatches an 80 ms reset gesture,
3. waits `PLAY_AFTER_RESET_DELAY_MS` (220 ms, `BandCueAccessibilityService.kt:638`),
4. then taps Play.

All of it starts *at* the downbeat, so the phone is systematically 300 ms+ late.
Nothing tells the room:

- the success paths in `executeTransport` (e.g. `BandCueAdapterService.kt:595`) never
  set `firedAtServerTime`, so the host's timing view and the coordinator's
  `[timing]` log are blind to Android;
- the adapter never publishes `requiredLeadMs`, so the count-in never grows for it.

**Fix idea.** Do the reset tap during the count-in (e.g. at `dueLocalAt - 600 ms`,
like the extension's prep phase) and fire only the play tap on the beat, aimed early
by a measured tap cost. Report `firedAtServerTime` on every successful path and
publish a `requiredLeadMs`.

## A3 (High) Catch-up from roomState uses an unsynced clock

Status: `Open`

The coordinator sends a `roomState` right after `serverHello`, before any
`clockSyncResult`. `reconcileTransportFromRoomState`
(`BandCueAdapterService.kt:393`) computes `dueLocalAt` with `serverOffsetMs ?: 0.0`,
so a phone that reconnects during a count-in schedules the catch-up Play against an
offset of 0. On the Raspberry Pi coordinator (no RTC, often no internet at
rehearsal) the real offset can be minutes, so the Play lands far off or never.

The extension and MuseScore helper were fixed for this on 2026-10-01: they skip
reconciliation until the first clock sample has arrived, without consuming the
sequence, so the next roomState (sent within ~400 ms) catches up properly. Port the
same rule (`serverOffsetMs == null` → do nothing) to Android.

## A4 (Medium) Every phone defaults to the same device name

Status: `Open`

`MainActivity.kt:98` / `:165` default the name to `"Android Songsterr"`. Two phones
with the default name share:

- the host's saved per-device calibration (keyed by device name), and
- the coordinator's recently-seen clock cache (keyed by role + name + app).

The extension already fixed the same collision by deriving a default from the
instrument and platform. Use e.g. `"${Build.MODEL} (${instrument})"`.

## A5 (Medium) Opening Songsterr during the count-in deliberately starts late

Status: `Open`

When there is no Songsterr media session at command time, `handleTransportCommand`
opens Songsterr and coerces the delay to at least `SONGSTERR_OPEN_SETTLE_MS`
(1500 ms, `BandCueAdapterService.kt:379-383`). The phone then starts up to seconds
after the band. Either skip the play (and say so), or report the late start
clearly so the host sees it.

## A6 (Medium) Foreground service type `dataSync` on targetSdk 35

Status: `Open`

`AndroidManifest.xml` declares `android:foregroundServiceType="dataSync"` and the app
targets SDK 35. Android 15 limits `dataSync` foreground services to 6 hours per 24
hours and calls `Service.onTimeout(int, int)`; a service that does not stop itself
promptly is treated as an error. `BandCueAdapterService` has no `onTimeout`, and with
auto-connect a phone left connected for a long rehearsal day can hit the limit.

Also `onStartCommand` returns `START_NOT_STICKY`: if the system kills the service it
stays dead until the user reopens the app. Consider `START_STICKY` (re-connecting
from the saved locator when `PREF_AUTO_CONNECT` is set) and a more fitting service
type.

## A7 (Low) No Wi-Fi low-latency lock

Status: `Open`

The service holds no `WifiManager.WifiLock`. Wi-Fi power save (especially with the
screen off) adds 100–300 ms latency spikes; the lowest-RTT clock filter absorbs most
of it, but command delivery and the count-in budget still pay. A
`WIFI_MODE_FULL_LOW_LATENCY` lock (API 29+, `WIFI_MODE_FULL_HIGH_PERF` below) while
connected would make timing steadier.
