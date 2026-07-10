# BandCue Improvement Plan — 2026-07-10

This audit reviews the coordinator, shared protocol and timing code, static web client,
Songsterr extension, Android adapter, release tooling, documentation, and automated tests.

Baseline on 2026-07-10:

- `npm test`: 14 files and 185 tests passed before changes.
- `npm run check`: passed before changes.
- The repository had no GitHub Actions workflow.
- Existing untracked `.claude/` content was left untouched.

## Status legend

- `Done`: implemented and covered by automated verification in this pass.
- `Planned`: direction is clear but not yet implemented.
- `Decision needed`: product or trust-model choice is required first.

## 1. Bound data that is rebroadcast to every client

Status: `Done`

### Finding

The one-megabyte WebSocket payload ceiling limits an individual message, but a host could still
publish hundreds or thousands of setlist entries. Adapter status fields such as title, detail,
playback detail, and command detail also reached `RoomState` without the text caps used for songs.
That state is rebroadcast to every connected device, including over rehearsal Wi-Fi.

### Implemented

- Reject setlists above 500 songs and retain the previous valid setlist.
- Cap adapter title at 140 characters, descriptive fields at 500, and control-path labels at 80.
- Normalize adapter command timestamps before storing them.
- Add regression tests for both limits.

### Acceptance criteria

- Oversized setlists receive a clear error and cannot replace valid room state.
- A single adapter cannot make recurring room-state broadcasts grow through unbounded text.

## 2. Validate coordinator ports at startup

Status: `Done`

### Finding

`PORT` and `BANDCUE_DISCOVERY_PORT` were converted with `Number()`. Blank, fractional, negative,
out-of-range, or non-numeric values reached the networking layer and failed with indirect Node
errors, or were interpreted unexpectedly.

### Implemented

- Parse both ports as strict integers in the TCP/UDP range 1–65535.
- Name the invalid environment variable in the startup error.
- Add boundary and malformed-input tests.

## 3. Add repeatable quality gates

Status: `Done`

### Finding

Type checking and tests existed, but there was no single verification command, no CI workflow,
and release packaging did not automatically run the checks first.

### Implemented

- Add `npm run verify` for strict type checking plus the full Vitest suite.
- Run verification automatically before `npm run package:release`.
- Declare the documented Node.js 20 minimum in `package.json`.
- Add GitHub Actions verification on Node.js 20, 22, and 24.

## 4. Detect copied platform metadata drift

Status: `Done`

### Finding

The package, extension, and Android versions are maintained in three files. Discovery port and
subnet defaults are also copied across TypeScript, extension JavaScript, and Android Kotlin.
Comments asked maintainers to keep them aligned, but normal tests did not enforce that contract.

### Implemented

- Add a repository-consistency test for all three release versions.
- Add a consistency test for the default discovery port and ordered LAN subnet list.

## 5. Keep documented runtime limits aligned

Status: `Done`

The architecture, configuration, and protocol docs still stated the old ±1000 ms manual
calibration limit. Update all three to the implemented ±5000 ms limit so troubleshooting and
rehearsal setup use the actual contract.

## 6. Decide the room authorization model

Status: `Decision needed`

### Finding

Unauthenticated `GET /api/room` returns URLs containing the shared room token so room-code
discovery can join automatically. Anyone with that shared token can also self-declare the host
role. This is convenient on a trusted rehearsal LAN, but it is not host/companion separation.

### Options

1. Keep the trusted-room model and document clearly that discovery reveals join credentials and
   any token holder can technically claim host controls.
2. Introduce separate host and participant credentials. This provides real authorization but
   changes saved URLs, QR codes, discovery, and every adapter's join flow.

Do not implement this implicitly: it changes the product's connection experience and backward
compatibility.

## 7. Add graceful coordinator shutdown

Status: `Planned`

Retain the UDP and mDNS responder handles, stop room timers, close WebSockets, and close the HTTP
server on `SIGINT`/`SIGTERM`. Add a bounded forced-exit fallback. This will make launcher restarts
and future service hosting more predictable.

## 8. Add browser-level host workflow tests

Status: `Planned`

Pure host logic is well tested, but DOM wiring, reconnect behavior, local-storage migration,
setlist import/export, hotkeys, and Helix form validation are not exercised in a real browser.
Add a small Playwright smoke suite covering connect, arm/play/stop, edit/import a setlist, and a
forced coordinator reconnect.

## 9. Split the largest runtime modules

Status: `Planned`

`web/app.js`, `extension/songsterr/background.js`, `src/adapters/musescore-windows.ts`, and
`src/server/room.ts` each combine multiple responsibilities. Extract state machines and pure
platform-independent decisions first; avoid a mechanical split that only moves line counts.

Suggested order:

1. WebSocket/reconnect lifecycle from the web app.
2. Setlist runner and persistence from the web app.
3. Discovery and transport scheduling from the extension background worker.
4. MuseScore bridge HTTP API and Windows control backend from the helper.
5. Room sanitization and playback-end tracking from the coordinator.

## 10. Add Android checks to hosted CI

Status: `Planned`

The local Android JVM tests exist but are not part of the new Node matrix. Add a separate CI job
with Java 17 and the Android SDK, then run the Gradle unit-test task. Keep it separate so Node
feedback remains fast when Android dependency setup is slow.
