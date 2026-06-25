# BandCue Audit Improvements - 2026-06-25

## Scope

This audit reviewed the current BandCue repository across:

- Node coordinator and room controller (`src/server/`)
- Shared protocol/discovery/timing logic (`src/shared/`)
- Browser host/companion UI (`web/`)
- Songsterr browser extension (`extension/songsterr/`)
- Android Songsterr companion app (`android/`)
- Existing documentation and improvement tracker (`docs/`)

Automated checks run during the audit:

- `npm test` - passed: 10 test files, 129 tests
- `npm run check` - passed
- `npm run test:android` - passed

The codebase is in solid shape for a local-first rehearsal tool: protocol rules are covered by focused unit tests, the adapter lifecycle has explicit disconnect behavior, and the existing improvement tracker captures many of the high-risk playback edge cases. The items below are the improvements still worth prioritizing.

## Priority 1: Stop Exposing The Room Token Through Discovery

### Finding

`GET /api/room` returns the full `RoomState`, including `companionUrl` and `hostUrl`. Both URLs contain the room token. Room-code and LAN discovery clients then extract that token from `companionUrl` and use it to build the WebSocket URL.

This conflicts with the documented security model: the docs say the room code is not secret and the token gates WebSocket access. In the current implementation, any LAN client that can reach `/api/room` can obtain the token without already knowing it.

### Why It Matters

This is acceptable only if BandCue treats "reachable on the rehearsal LAN" as full trust. The docs currently promise a stronger model than that. On shared Wi-Fi, venue Wi-Fi, school networks, or any network with curious clients, discovery effectively downgrades the token from a secret to public room metadata.

### Recommended Direction

- Split discovery metadata from authenticated room state.
- Make unauthenticated `/api/room` return only non-secret data needed for discovery, such as:
  - `type`
  - `roomCode`
  - `port`
  - optional display name/version
- Add a tokenless discovery result only when the user already entered a full room URL or token-bearing QR URL.
- Require `?token=` for any endpoint that returns `hostUrl`, `companionUrl`, clients, setlist, safety, or transport state.
- Update extension, Android, and MuseScore locator flows so room-code discovery locates the host but does not mint credentials.
- If convenience is more important than secrecy for v1, update `docs/Networking.md` to state plainly that LAN discovery can reveal the join token and that BandCue assumes a trusted rehearsal LAN.

### Acceptance Criteria

- Fetching `/api/room` without a token does not reveal `companionUrl`, `hostUrl`, or any token.
- Room-code discovery can still identify the correct host and provide a useful fallback message.
- Joining a room still requires either a token-bearing URL/QR or an explicitly accepted trusted-LAN discovery mode.
- Documentation matches the actual trust model.

## Priority 2: Sanitize Current-Song Updates The Same Way As Setlist Updates

### Finding

`RoomController.updateSetlist()` sanitizes every incoming `SetlistSong`, but `RoomController.updateCurrentSong()` stores `update.song` directly. That bypasses the length caps, source normalization, duration bounds, and field cleanup used for setlist updates.

### Why It Matters

The host role is self-declared after a client has the room token. Once connected as a host, a client can publish oversized or malformed current-song payloads into room state. The browser renders most values safely with `textContent`, but the server still stores and broadcasts the unsanitized object.

### Recommended Direction

- Reuse `sanitizeSong()` in `updateCurrentSong()`.
- Clamp or drop invalid `index` and `total` values.
- Consider deriving `index` and `total` from the current server-side setlist when the song id exists there.
- Add tests for malformed current-song updates:
  - blank title is rejected or clears current song
  - excessive text is capped
  - invalid duration is dropped
  - invalid source type becomes `other`
  - invalid index/total does not propagate

### Acceptance Criteria

- `currentSong.song` is always sanitized to the same contract as `setlist.songs[]`.
- Current-song updates cannot broadcast unbounded text fields.
- Existing host setlist flow still publishes and displays the selected song normally.

## Priority 3: Add Connection Schema And Size Guardrails

### Finding

The coordinator accepts parsed JSON messages without a transport-level size cap or full schema validation. Individual handlers sanitize some fields after routing, but `clientHello`, capabilities, and some message shapes can still be very large or malformed.

### Why It Matters

BandCue is LAN-local, but the coordinator binds to `0.0.0.0` by default. A malformed client can consume memory and CPU by sending large messages, large capability arrays, or frequent messages. The current tests focus on domain behavior, not hostile or accidental malformed input.

### Recommended Direction

- Add a max WebSocket payload size to `WebSocketServer`.
- Validate `clientHello` before `addClient()`:
  - cap device name length
  - restrict role to known values
  - cap capability count
  - restrict app names and boolean capability flags
- Add lightweight message validators per message type before calling room handlers.
- Add rate limits or debounce protections for high-frequency mutating messages such as setlist/current-song updates.
- Close policy-violating sockets with a clear WebSocket close code and reason.

### Acceptance Criteria

- Oversized WebSocket messages are rejected before room handling.
- Invalid `clientHello` cannot add a client to room state.
- Invalid capabilities cannot appear in `clients[]`.
- Unit tests cover invalid hello, oversized-like payload handling at the parser boundary, and malformed mutating messages.

## Priority 4: Fix Web UI Reconnect Timer Lifecycle

### Finding

`web/app.js` starts a new `setInterval()` for clock sync inside the WebSocket `open` handler, but it does not keep the interval id or clear it when the socket closes. Every reconnect can leave another interval running. The extension background script already handles this correctly with `clockTimer`.

### Why It Matters

During unstable rehearsal Wi-Fi or host restarts, a browser tab can reconnect multiple times. Stale intervals keep firing, which adds needless client work and repeated attempted sends. It also makes future timing bugs harder to reason about because multiple clock loops may be active.

### Recommended Direction

- Add a `clockTimer` variable in `web/app.js`.
- Clear it before starting a new clock interval.
- Clear it in the WebSocket `close` handler.
- Avoid scheduling multiple reconnect timers if the socket closes repeatedly.
- Reset `transportRequestPending` on `error` responses as well as on `roomState`.

### Acceptance Criteria

- A host/companion browser tab has at most one clock-sync interval after repeated reconnects.
- Rejected transport requests do not leave the host controls permanently pending.
- Unit-test the reconnect state machine if the socket wiring is extracted, or add a small browser-level manual test checklist.

## Priority 5: Clarify Host Authorization Semantics

### Finding

Any client with the room token can connect with `role: "host"` and mutate setlist, safety, calibration, current song, and open-song state. This may be intentional for a local-first rehearsal tool, but the docs currently emphasize host-only controls without making clear that "host" is a client-declared role protected only by the shared room token.

### Why It Matters

This is fine for a trusted band LAN, but it is not the same as owner/admin authorization. Once the token is shared for companion display, that same token can be used by a custom client to claim host privileges.

### Recommended Direction

Pick one explicit model:

- Trusted-room model: document that anyone with the token can technically claim host role, and BandCue assumes trusted room participants.
- Owner-host model: generate a separate host token and companion/adapter token, or claim the first host connection as owner and require an owner secret for host mutations.

### Acceptance Criteria

- Documentation states the chosen trust model plainly.
- If separate host authorization is implemented, non-host tokens cannot perform host mutations even if they send `role: "host"`.
- Existing QR/companion flow remains simple enough for rehearsal use.

## Priority 6: Keep Platform-Copied Discovery Logic From Drifting

### Finding

Discovery constants and logic exist in TypeScript, the browser extension, and Android. Comments warn that subnet lists and mDNS naming must stay in sync, and tests cover some of that, but the implementations are still manually copied.

### Why It Matters

The project has already invested in reliability around discovery. Manual copies are easy to miss when defaults, timeout behavior, or diagnostics change. Drift will show up as "works on extension but not Android" bugs.

### Recommended Direction

- Add a small generated JSON fixture for shared discovery constants:
  - default port
  - mDNS stem
  - subnet list
  - host range
- Have TypeScript tests assert the fixture matches `src/shared/room-locator.ts`.
- Have Android tests assert `RoomLocator.kt` matches the same fixture.
- Add an extension test that imports or evaluates the copied constants against the fixture.
- Consider generating the Android and extension constants from the TypeScript source if the project accepts a build step.

### Acceptance Criteria

- A subnet or mDNS naming change fails tests unless all platform copies are updated.
- Discovery error messages remain aligned across Node/MuseScore, extension, and Android.

## Suggested Implementation Order

1. Decide and document the actual room trust model.
2. Fix `/api/room` token exposure or document trusted-LAN discovery explicitly.
3. Sanitize `currentSongUpdate` and add focused tests.
4. Add WebSocket hello/message guardrails.
5. Fix web reconnect timers and pending-request reset.
6. Add cross-platform discovery drift tests.

## Notes On Existing Tracker

`docs/Improvements.md` already tracks playback-specific reliability work such as idempotent Stop, Android reset-to-start, discovery robustness, auto-stop, MuseScore catalog/open-song support, extension disconnect behavior, and Android disconnect behavior. Those items remain useful. This audit adds cross-cutting security, validation, and lifecycle issues that are not fully represented there.
