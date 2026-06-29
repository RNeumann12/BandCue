# Changelog

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
