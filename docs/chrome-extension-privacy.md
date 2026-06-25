# BandCue Songsterr Adapter Privacy Policy

Effective date: 2026-06-25

BandCue Songsterr Adapter connects Songsterr tabs in Chrome or Edge to a BandCue rehearsal room
running on your local network. The extension is local-first: it does not create an account, does
not use BandCue cloud servers, does not include analytics, and does not sell or transfer user data.

## Data Stored In The Browser

The extension uses Chrome local storage to remember:

- The last room locator or room URL entered by the user.
- Recently successful local network hosts, so reconnecting to the same rehearsal machine is faster.
- Whether automatic reconnect is enabled.
- The selected instrument preference: auto, guitar, bass, or drums.
- Whether Songsterr auto-open is suppressed on a MuseScore host machine.

This data stays in the browser profile unless the user or browser removes extension storage.

## Songsterr Page Data

On Songsterr pages, the extension reads the page title, page URL, player readiness, and song
duration when available. BandCue uses that information only to match the current rehearsal song,
report readiness to the local coordinator, and run play, stop, reset, and open-song commands.

The extension does not read Songsterr account credentials, payment data, private messages, or other
unrelated page content.

## QR And Camera Use

The extension scans QR codes only after the user clicks Scan QR. It may inspect the currently
visible browser tab image for a BandCue join QR code, or it may request camera access for the
dedicated scanner page. QR images and camera frames are processed locally in the browser and are not
uploaded to BandCue or any third party.

## Local Network Access

The extension connects only to a BandCue coordinator selected by the user through a room URL,
host:port, port, room code, or scanned QR code. Local network access is requested when the user
connects. Room-code and port discovery require broader local network access so the extension can
find the rehearsal computer on Wi-Fi.

BandCue sends extension status and transport messages only to the selected local coordinator.

## Third-Party Services

BandCue Songsterr Adapter does not use remote analytics, advertising networks, crash reporting
services, or cloud storage. It includes a local copy of the open-source jsQR decoder for QR
scanning.

## Contact

Project source and issue tracking are available at:

https://github.com/RNeumann12/BandCue
