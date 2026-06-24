# Changelog

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
