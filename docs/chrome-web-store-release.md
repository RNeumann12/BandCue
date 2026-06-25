# Chrome Web Store Release Notes

Use this checklist for the first unlisted Chrome Web Store release of the BandCue Songsterr
Adapter.

## Target Release

- Channel: Unlisted Chrome Web Store listing.
- Publishing mode: deferred publishing until manual QA passes.
- Package: `dist/packages/bandcue-songsterr-extension-<version>.zip`.
- Privacy policy URL after GitHub Pages publication:
  `https://rneumann12.github.io/BandCue/chrome-extension-privacy.html`.

## Listing Text

Single purpose:

BandCue Songsterr Adapter connects Songsterr tabs to a local BandCue rehearsal room so playback can
be opened, started, stopped, reset, and kept in sync with other BandCue devices on the same local
network.

Permission justifications:

- `storage`: remembers the room locator, reconnect intent, remembered local hosts, instrument
  preference, and MuseScore-host auto-open preference.
- `tabs`: finds and reuses existing Songsterr tabs instead of opening duplicates.
- `activeTab`: scans the currently visible tab for a BandCue join QR code after the user clicks
  Scan QR.
- `https://www.songsterr.com/*` and `https://songsterr.com/*`: injects the content script only on
  Songsterr pages to control playback and report readiness.
- Optional `http://*/*`: requested only when connecting to a BandCue room, so the extension can
  discover and connect to the user-selected local rehearsal coordinator.

Remote code statement:

The extension executes only JavaScript files packaged in the extension zip. It does not download or
execute remote code.

## Assets

- Icon: `extension/songsterr/icons/icon-128.png`.
- Small promo tile: `assets/chrome-web-store/small-promo-440x280.png`.
- Screenshot: `assets/chrome-web-store/screenshot-1280x800.png`.

Regenerate store assets with:

```powershell
npm run generate:store-assets
```

## Reviewer Instructions

1. Install Node.js 20 or newer.
2. Run `npm install`.
3. Run `npm run dev` from the repository root.
4. Open a Songsterr song tab.
5. Install the packaged extension or load `extension/songsterr` unpacked.
6. Open the extension popup, enter `127.0.0.1:4173`, approve local BandCue network access, and
   press Connect.
7. Use the BandCue host page to send Open Current Song, Play, and Stop commands.

## Final QA

- `npm run check`
- `npm test`
- `npm run package:extension`
- Confirm the zip contains `room-permissions.js` and excludes `*.test.*` files.
- Upload the final zip to the Chrome Developer Dashboard and confirm manifest validation passes.
