# BandCue Living Improvements Tracker

Last updated: 2026-06-20

This document tracks active reliability and workflow improvements for BandCue. Keep it current as bugs are reproduced, implementation choices change, or work moves from investigation to done.

## Living Tracker

### Status Legend

- `Open`: problem is known, but no implementation work has started.
- `Investigating`: evidence is being gathered or the fix direction is still being validated.
- `Planned`: the implementation direction is clear enough to pick up.
- `In Progress`: code or test changes are underway.
- `Done`: shipped and verified against the acceptance criteria.

### How To Update This Doc

- Keep active problems in this tracker until the acceptance criteria are met.
- Add concrete evidence: affected client, app version when known, layout/window mode, logs, and exact repro steps.
- Update status as soon as the next action changes.
- Move completed items into `Completed MVP Notes` only after the tests or manual checks listed here pass.
- Do not store private local paths in examples. For MuseScore libraries, use folder names, relative paths, or normalized titles.

## Active Items

## 1. Idempotent Stop

Status: `In Progress`

### Problem

For some clients, especially the browser extension and Android Songsterr app, pressing Stop can start playback again if the client has already stopped itself.

### Current Behavior And Evidence

- Browser extension stop currently pauses active media elements, then may fall through to clicking a detected transport button or dispatching a Space shortcut fallback when it cannot prove playback is active.
- Android Songsterr stop uses the Android media session when available and accessibility fallback otherwise. Some Songsterr controls are toggle-like, so tapping the visible transport control after the app has already stopped can restart playback.
- The coordinator marks transport stopped immediately after accepting a Stop request, but clients may already have auto-stopped before the command arrives.
- 2026-06-20 implementation update: browser Stop now no-ops when playback appears stopped and never uses Space fallback for Stop; Android Stop now no-ops when media-session playback is stopped, and accessibility Stop only taps labelled pause/stop controls.

### Suspected Cause

Stop is being treated like a transport command that must always touch the client UI. For toggle-like control paths, a second Stop becomes indistinguishable from Play unless the adapter first confirms playback is active.

### Proposed Direction

- Make Stop state-aware and non-toggle-like in every adapter.
- If playback is already stopped, report a successful no-op instead of touching the player.
- If playback state is unknown and no unambiguous pause/stop control is available, report `failed` or `unknown` rather than using Space or another toggle fallback.
- Browser extension: never use Space fallback for Stop; only pause active media elements or click controls that are confidently labelled pause/stop while playback appears active.
- Android: prefer media-session playback state for Stop decisions. When state is stopped, report no-op success. Use accessibility Stop only when the visible control is confidently a pause/stop action or the media session says playback is active.

### Acceptance Criteria

- Repeated Stop never starts playback again on Songsterr browser extension.
- Repeated Stop never starts playback again on Android Songsterr.
- Browser extension avoids Space fallback for Stop.
- Android reports stopped/no-op when the media session is already stopped.
- Host UI still receives clear adapter status for no-op Stop, failed Stop, and successful Stop.

### Test And Repro Notes

- Unit test browser content-script stop logic with: active media, already-paused media, missing controls, and ambiguous toggle fallback.
- Android JVM tests cover stop decision logic where playback is playing, stopped, unknown with accessibility fallback, and unknown without a safe fallback.
- Real-device check on 2026-06-20 with Samsung SM-F946B in large/foldable landscape layout: patched Android APK connected through ADB reverse to room `47B06D`; with Songsterr foreground but no active media session and accessibility disabled, a BandCue Stop command reported `failed` with `controlPath: none` and did not tap Songsterr.
- Real-device check on 2026-06-20 with Samsung SM-F946B and BandCue Accessibility Fallback enabled: opened Songsterr `Bad Moon Rising` song screen in large/foldable layout, connected patched Android APK to room `FB1FCA`, issued BandCue Play then repeated Stop; Stop reported `failed` with `controlPath: android-accessibility` and detail `Accessibility fallback could not find a visible Songsterr pause control.`, confirming it did not tap unlabeled geometry/toggle controls.
- Manual repro: start a Songsterr song, let Songsterr stop by itself, then press BandCue Stop twice. Playback must remain stopped.

### Open Questions

- Should unknown playback state plus a visible pause icon count as safe enough to tap on Android, or should it fail closed until state is known?

## 2. More Reliable Auto Discovery

Status: `In Progress`

### Problem

Some clients have problems connecting by room code or port. Auto discovery needs to be more solid across MuseScore helper, browser extension, and Android.

### Current Behavior And Evidence

- MuseScore helper checks local candidates and then uses UDP LAN discovery.
- Browser extension cannot use raw UDP discovery, so it checks local candidates and scans a fixed set of common LAN subnets.
- Android builds local candidates plus a fixed LAN scan list.
- Different clients have different discovery behavior, timeout windows, diagnostics, and subnet coverage.
- 2026-06-20 implementation update: MuseScore now falls back from UDP discovery to the same common HTTP subnet scan style used by browser/Android clients; browser, Android, and shared TypeScript helpers use the same documented default subnet list; failure messages now name local/UDP/scan attempts and recommend host:port or full room URL fallback.
- The host join panel now shows a copyable `host:port` adapter fallback next to the room QR/full URL.

### Suspected Cause

Discovery is split across platform-specific implementations with different network capabilities. Fixed subnet scanning misses some rehearsal networks, while UDP broadcast may be blocked by Wi-Fi isolation, firewall rules, VPNs, or OS permissions.

### Proposed Direction

- Consolidate discovery expectations and terminology across all clients.
- Keep the raw room URL and explicit `host:port` path as the reliable fallback.
- Make room-code discovery report what it tried: local addresses, UDP broadcast availability, scanned subnets, target port, and timeout.
- Prefer reusable candidate-building logic where possible, and keep browser/Android subnet defaults aligned.
- Consider deriving scan targets from the client's actual network interfaces where platform APIs allow it.
- Add clearer user-facing diagnostics in extension popup, Android app, and MuseScore terminal output.

### Acceptance Criteria

- Room code works across common rehearsal Wi-Fi setups for MuseScore helper, browser extension, and Android.
- Failure messages say which port and network ranges were tried.
- Failure messages clearly recommend `host:port` or full room URL when discovery is blocked.
- Browser extension and Android scan the same documented default subnet set unless platform constraints require otherwise.

### Test And Repro Notes

- Unit test shared candidate generation and room-code matching.
- Add tests for timeout/error message composition.
- 2026-06-20 automated checks: TypeScript room-locator tests cover LAN scan candidate generation and fallback diagnostics; Android RoomLocator tests cover documented LAN scan ranges and fallback message composition.
- Manual test on at least: same machine, typical home Wi-Fi, phone hotspot, and Wi-Fi network with client isolation or blocked broadcast if available.
- Record whether VPN, firewall, or multiple NICs were present for each failed repro.

### Open Questions

- Should the coordinator expose a small copyable `host:port` value in the host UI next to the room code for faster manual fallback?

## 3. Android Songsterr Reset-To-Start

Status: `In Progress`

### Problem

The Android Songsterr `scroll back to start` / reset-to-start action does not always work. In larger Android windows or alternate layouts, the reset button appears to be positioned somewhere else.

### Current Behavior And Evidence

- Accessibility fallback finds the play control, then locates reset-to-start mostly by geometry relative to the play button and screen height.
- Current reset detection assumes a toolbar row above the play button and filters controls using fixed lower-screen thresholds.
- Larger windows, tablets, split-screen mode, or orientation changes can move the toolbar enough that these assumptions break.
- 2026-06-20 implementation update: Android reset detection now uses a tested layout-aware scorer that groups visible toolbar controls above play, considers speed/sound-mode anchors, reports missing versus low-confidence reset separately, and caches recently successful reset geometry for the same layout signature.

### Suspected Cause

The reset button is unlabeled in Songsterr's accessibility tree, so the implementation relies too heavily on static geometry. Layout changes move the relevant row and make the "rightmost control above play" heuristic unreliable.

### Proposed Direction

- Track the transport/control row from visible accessibility nodes over time instead of relying on fixed screen-height bands.
- Use relative anchors: speed control, sound mode control, play/pause control, and recent successful reset geometry.
- Store recent successful button geometry per layout signature, such as screen bounds, orientation, and root/window dimensions.
- When reset cannot be identified confidently, report that reset was skipped or missing before playing, rather than presenting it as a successful reset.
- Add richer status detail so the host can show whether reset was clicked, skipped, or failed.

### Acceptance Criteria

- Reset-before-play works in standard phone portrait layout.
- Reset-before-play works in larger Android windows, including tablet or split-screen layouts where feasible.
- Failure reports distinguish: reset button missing, reset tap rejected, and reset skipped due to low confidence.
- Play still works when reset is unavailable, but status clearly says playback may have started from the current position.

### Test And Repro Notes

- Add Android JVM tests for reset candidate scoring with multiple synthetic geometries.
- Include layouts where the toolbar is lower, wider, shifted horizontally, or split into a different row grouping.
- 2026-06-20 automated checks: Android JVM tests cover phone portrait reset selection, larger-window toolbar placement, cached geometry for sparse shifted layouts, missing reset controls, and low-confidence skip reporting.
- Manual repro: open Songsterr Android in normal phone layout and in a larger/freeform or split-screen window; issue BandCue Play with reset-before-play enabled.

### Open Questions

- Which Android devices/window modes have reproduced this most often? Add device model, Android version, Songsterr version, orientation, and window mode when known.

## 4. Setlist Duration And Host Auto-Stop

Status: `In Progress`

### Problem

The setlist is a good start, but BandCue has no way to track how long songs are. The host control UI keeps running after a song ends even though clients may stop playback automatically.

### Current Behavior And Evidence

- `SetlistSong` currently stores title, source type, source, and notes.
- Host UI displays elapsed time while transport is running.
- Clients can report playback status, but no duration is currently part of the protocol.
- The coordinator only returns to stopped state when a Stop request is accepted or a leader disconnect triggers Stop.
- 2026-06-20 implementation update: protocol now accepts optional adapter-reported `durationMs`; the Songsterr browser extension reports finite media duration and current tab URL when available; the coordinator associates matching adapter duration with the current setlist song and auto-stops BandCue room state after the known duration without broadcasting Stop.

### Suspected Cause

BandCue has transport state but no song-length model. The coordinator cannot know when to mark the UI stopped unless the user presses Stop or clients publish enough metadata.

### Proposed Direction

- Use adapter-first duration reporting as the first implementation path.
- Extend adapter status or current-song reporting with optional `durationMs` when a client can determine the current song length.
- Associate reported duration with the current setlist song when the report matches the current song identity.
- Have the coordinator or host mark BandCue transport stopped after the known duration elapses.
- Important behavior: host auto-stop updates BandCue transport/UI state only. It should not broadcast a Stop command by default, because Stop can be fragile on clients that have already auto-stopped.
- Add optional manual duration override later if adapter duration is unavailable or unreliable.

### Acceptance Criteria

- When the current song has known duration, the host UI reaches the end and returns to stopped automatically.
- Auto-stop does not broadcast a Stop command by default.
- Unknown-duration songs keep the current manual Stop behavior.
- Duration source is visible enough for debugging, for example adapter-reported versus manual override in a later phase.

### Test And Repro Notes

- Protocol/server tests for duration-driven auto-stop without broadcasting a Stop command.
- UI tests or manual checks for elapsed display, end-of-song transition, and unknown-duration behavior.
- Adapter tests for publishing duration only when it belongs to the current song.
- 2026-06-20 automated checks: TypeScript room tests cover matching adapter-reported duration into current song/setlist metadata and duration-driven room auto-stop without broadcasting a Stop command.

### Open Questions

- Which client is most likely to report reliable duration first: Songsterr browser extension, Android media session, or MuseScore Bridge?

## 5. MuseScore Bridge Local Song Publishing And Auto-Open

Status: `Open`

### Problem

MuseScore songs still need to be opened manually. BandCue needs a system where MuseScore Bridge clients publish which songs they have locally and can automatically open the correct song.

### Current Behavior And Evidence

- MuseScore setlist items can store a score name or human-readable title.
- MuseScore helper can warn when the active score title does not match the current setlist item.
- The bridge can receive transport commands and report status/title/playback, but it does not publish a local song catalog or open scores yet.

### Suspected Cause

The bridge knows the current active score but does not know the user's local score library. Without a published catalog, the coordinator cannot match a setlist item to a local `.mscz` or `.mscx` file.

### Proposed Direction

- Each MuseScore Bridge client defines one or more configured local score folders.
- The bridge scans those folders for supported MuseScore files and publishes a catalog to BandCue.
- Catalog entries should include normalized title and relative path from the configured folder. Full absolute local paths should stay private by default.
- BandCue matches the current MuseScore setlist item against bridge-published catalog entries.
- Add MuseScore open-song support through the bridge command lifecycle.
- Host UI should show clear states for no match, ambiguous match, matched client, and open result.

### Acceptance Criteria

- A MuseScore Bridge client can publish locally available songs from configured folders.
- Selecting a MuseScore setlist song can automatically open the matching local score on a capable bridge client.
- Ambiguous or missing matches are visible in the host UI.
- Full absolute local paths are not broadcast to other clients by default.

### Test And Repro Notes

- MuseScore bridge tests for folder catalog normalization and supported file filtering.
- Matching tests for title, relative path, extensionless names, and ambiguous duplicates.
- Open-song command lifecycle tests for queued, claimed, succeeded, failed, and timeout/fallback cases.
- Manual test with two bridge clients where only one has the selected song.

### Open Questions

- Should the bridge catalog scan recursively by default, or should recursion be configurable per folder?

## 6. Browser Extension UI And Explicit Connection Control

Status: `Open`

### Problem

The browser extension UI is hard to use and does not make connection state or user intent clear enough. It should only connect when the user wants it to, and it needs a clear Disconnect button that stops all future auto-connecting.

### Current Behavior And Evidence

- The extension popup is functional but not polished enough for rehearsal use.
- The background script stores the previous room input and auto-configures the connection when the extension loads.
- When the socket closes, the background script retries after a delay as long as a WebSocket URL is still configured.
- There is no clear user-facing Disconnect action that means "stay disconnected until I explicitly connect again."

### Suspected Cause

The extension currently treats stored room configuration as permission to reconnect automatically. It does not distinguish between "temporarily disconnected, retry" and "the user intentionally disconnected."

### Proposed Direction

- Improve the popup UI so connection state, current room, adapter readiness, and actions are obvious at a glance.
- Add a prominent Disconnect button.
- Introduce an explicit user intent flag, such as `autoConnectEnabled` or `connectMode`, stored in extension local storage.
- Connect only after the user presses Connect or when stored user intent says auto-connect is enabled.
- Pressing Disconnect should close the socket, clear pending reconnect timers, stop clock sync, stop status polling that depends on the connection, and persist the "do not auto-connect" intent.
- Keep room input saved for convenience, but do not reconnect from saved room input alone.

### Acceptance Criteria

- The extension never reconnects after Disconnect until the user presses Connect again.
- Reloading the extension, browser, or Songsterr tab does not reconnect after an intentional Disconnect.
- The popup clearly shows connected, connecting, disconnected-by-user, and error states.
- Connect and Disconnect actions are visually obvious and cannot be confused with transport controls.
- Saved room input remains available after Disconnect.

### Test And Repro Notes

- Extension tests or manual checks for: fresh install, Connect, socket drop retry, Disconnect, extension reload, browser restart, and Songsterr tab reload.
- Verify background reconnect timers and clock sync timers are cleared on Disconnect.
- Manual repro: connect extension, press Disconnect, stop and restart the coordinator, then confirm the extension stays disconnected until Connect is pressed.

### Open Questions

- Should the extension offer a separate "Connect automatically next time" setting, or should pressing Connect always enable auto-connect until Disconnect is pressed?

## 7. Android App Disconnect Should Stop All Activity

Status: `Open`

### Problem

The Android app is hard to kill. Pressing Disconnect should stop all further activity, including reconnect attempts and background work.

### Current Behavior And Evidence

- The Android adapter service schedules reconnect attempts after socket close or errors.
- The service runs clock sync and status publishing while connected.
- Disconnect currently needs to be audited so it reliably stops reconnect scheduling, active sockets, timers, foreground/background work, and any user-visible running state.

### Suspected Cause

The Android service is designed to keep the adapter alive during rehearsal, but it needs a stronger distinction between transient connection loss and intentional user disconnect.

### Proposed Direction

- Add explicit user disconnect intent to the Android app/service state.
- Pressing Disconnect should set that intent, close the socket, cancel reconnect tasks, stop clock sync, stop adapter status publishing, and stop the service or foreground notification if one is active.
- Reconnect scheduling should only run when the user has requested an active connection.
- App UI should clearly show that BandCue is disconnected and inactive.
- Starting a new connection should clear the disconnect intent and restart only the necessary work.

### Acceptance Criteria

- After pressing Disconnect, Android does not reconnect automatically.
- After pressing Disconnect, Android stops background network activity and scheduled reconnect tasks.
- Closing and reopening the Android app after Disconnect does not auto-connect unless the user presses Connect.
- The app remains easy to start again for a rehearsal without force-stopping it from Android settings.
- The UI clearly distinguishes intentional Disconnect from network error/retrying.

### Test And Repro Notes

- Android tests or manual checks for: Connect, network drop retry, Disconnect, app close/reopen, service restart, device sleep/wake, and coordinator restart.
- Verify no reconnect task fires after Disconnect.
- Verify socket, clock sync, and status update jobs stop after Disconnect.

### Open Questions

- Should Disconnect also clear the persistent room value, or should it keep the last room ready for the next manual Connect?

## Public Interfaces To Plan

- Extend adapter status/protocol with optional duration/catalog capability:
  - Current song duration reporting, likely `durationMs`.
  - Bridge song catalog summary, likely `{ title, relativePath, sourceId? }`.
  - Open-song support for MuseScore Bridge clients.
- Extend `SetlistSong` with optional duration metadata once adapter reports are persisted or merged.
- Keep full local absolute MuseScore paths private by default; publish relative path plus display title from configured folders.

## Cross-Cutting Test Plan

- Unit tests for Stop behavior: stopped clients produce no-op success and never invoke toggle fallback.
- Discovery tests for candidate generation, room-code matching, timeout messaging, and platform-specific fallback behavior.
- Android JVM tests for reset candidate scoring with multiple screen/window geometries.
- Protocol/server tests for duration-driven auto-stop without broadcasting a Stop command.
- MuseScore bridge tests for folder catalog normalization, matching, and open-song command lifecycle.
- Extension UI and background tests for explicit Connect/Disconnect intent and disabled auto-reconnect.
- Android service tests for intentional Disconnect cancelling reconnect, socket, clock sync, and status work.

## Completed MVP Notes

- Adapter status, command feedback, host transport controls, and warnings are implemented.
- A simple setlist flow is implemented: the host stores songs locally, selects the current song, and the coordinator broadcasts current-song state to companions.
- Latency and jitter calibration is implemented: the host can view timing quality and set per-device manual offsets, persisted locally by device name.
- Safety controls are implemented: host arming is required before Play, Play disarms after acceptance, and the host can choose stop-control mode.
- Install/run polish is implemented for the current repo shape: preflight checks, one-command local rehearsal startup, and Songsterr extension zip packaging.
- MuseScore integration has a bridge command lifecycle, bridge-reported playback/title status, current-song title mismatch warnings, and Windows keyboard control as the fallback.
- MuseScore songs remain manual until the local song publishing and auto-open work in this tracker is completed.
