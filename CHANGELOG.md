# Changelog

## Unreleased

### Changed

- Helix Stadium starts now use the configured number of complete count-in measures, support
  room-wide and per-song timing shifts up to ±60 seconds, and roll too-early starts forward by
  complete measures instead of rejecting Play.
- The host now has a persistent global Helix master switch and room-wide offset control, while
  keeping per-song timing trims for exceptional songs.

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
