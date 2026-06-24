# BandCue Development Guide

How to build, test, and work on BandCue. For configuration details see
[Configuration.md](Configuration.md); for the architecture see [Architecture.md](Architecture.md).

## Prerequisites

- **Node.js 20+** (the coordinator and all Node tooling). `npm run preflight` checks this.
- **Chrome or Edge** for the browser extension.
- **Windows + MuseScore Studio** for the MuseScore helper (it uses Windows window activation and
  keyboard shortcuts).
- **Android SDK** (+ Android Studio JBR or a JDK) for the Android adapter. Android Studio itself
  is *not* required to build — the build script bootstraps Gradle.

## First-Time Setup

```powershell
npm install
npm run preflight   # verify Node version, deps, and required files
npm run dev         # start the coordinator
```

On Windows, v1.0 also includes double-click launchers in the repo/release root:

```text
BandCue Host.cmd
BandCue Host - MuseScore Bridge.cmd
```

They require Node.js 20+, install dependencies on first run when needed, run preflight, start the
appropriate host command, and open the host URL when the coordinator prints it.

## TypeScript Workflow

The server, shared library, adapters, and tools are TypeScript, run directly with `tsx` (no build
step needed for development).

```powershell
npm run check    # type-check only (tsc --noEmit) — fast feedback
npm test         # run the vitest unit suite once
npm run build    # emit compiled JS (tsc -p tsconfig.json)
```

Run a single test file with vitest directly:

```powershell
npx vitest run src/server/room.test.ts
```

### Test coverage map

Unit tests live next to the code they cover (`*.test.ts`):

| Area | Tests |
| --- | --- |
| Room state, scheduling, auto-stop, duration binding | `src/server/room.test.ts` |
| Transport/safety decision rules | `src/shared/transport.test.ts` |
| Clock sample math | `src/shared/clock.test.ts` |
| Discovery: locators, candidates, mDNS, fallback messaging | `src/shared/room-locator.test.ts`, `src/shared/lan-discovery.test.ts`, `src/shared/lan-address.test.ts` |
| MuseScore catalog scanning/matching | `src/adapters/musescore-catalog.test.ts` |
| Browser extension background logic | `extension/songsterr/background.test.ts` |

The browser extension test is TypeScript run by vitest even though the shipped extension is plain
JS. Keep the three copies of `LAN_SCAN_SUBNETS` (shared / extension / Android) in sync — see
[Networking.md](Networking.md#4-lan-subnet-scan).

## Web Client

The host/companion UI in `web/` is static HTML/CSS/JS served directly by the coordinator. There's
no bundler — edit `web/index.html`, `web/app.js`, `web/styles.css` and reload the page. Use
`/host` for the control panel and `/` for the companion view.

## Browser Extension

Load `extension/songsterr/` unpacked (see [Adapters.md](Adapters.md#songsterr--browser-extension))
and reload it from `chrome://extensions` after edits. The shipped files are plain JS so they load
without a build. Package for distribution:

```powershell
npm run package:extension
```

The package script writes both `dist/packages/bandcue-songsterr-extension.zip` and a versioned
`dist/packages/bandcue-songsterr-extension-<version>.zip`.

## Android Adapter

```powershell
npm run build:android            # debug APK
npm run build:android:release    # signed release APK
npm run test:android             # JVM unit tests
```

`build:android` bootstraps Gradle into `android/.gradle-bootstrap/`, resolves the Android SDK
(`ANDROID_SDK_ROOT` / `ANDROID_HOME` / `%LOCALAPPDATA%\Android\Sdk`) and Java (Android Studio JBR
or `JAVA_HOME`), and writes:

```
android/app/build/outputs/apk/debug/app-debug.apk
```

Install on a device with USB debugging:

```powershell
adb install -r android/app/build/outputs/apk/debug/app-debug.apk
```

### Release signing

Signed release APKs (`app-release.apk`) are produced by `npm run build:android:release`. Signing
is wired in [`android/app/build.gradle.kts`](../android/app/build.gradle.kts), which reads
`android/keystore.properties` (storeFile / storePassword / keyAlias / keyPassword) for a `release`
signingConfig and falls back to debug signing when that file is absent.

> **Both `android/release.keystore` and `android/keystore.properties` are gitignored** and exist
> only on the build machine. The keystore is self-signed and is not stored anywhere else — **back
> it up**. Losing it means future releases can't be signed with the same key.

## Project Layout

```
src/
  server/
    index.ts        Coordinator entry: HTTP + WS, routes, QR, discovery startup
    room.ts         RoomController — authoritative state, scheduling, sanitization
    discovery.ts    UDP discovery responder
    mdns.ts         mDNS responder
  shared/
    protocol.ts     Wire types (source of truth)
    clock.ts        NTP-style clock math
    transport.ts    decideTransportRequest (safety/permission rules)
    room-locator.ts Locator parsing, discovery candidates, subnet list
    lan-discovery.ts UDP broadcast client + parsing
    lan-address.ts  LAN IP selection
    song-sources.ts Songsterr/MuseScore reference resolution
  adapters/
    musescore-windows.ts   MuseScore helper (keyboard + bridge API)
    musescore-catalog.ts   Local .mscz/.mscx scanning + matching
  tools/
    preflight.ts           Pre-rehearsal checks
    start-rehearsal.ts     dev:all orchestration
    package-extension.ts   Extension zip packaging
    package-release.ts     Public beta release bundle packaging
    generate-icons.ts      Browser/Android icon generation
web/                Host + companion UI (static)
extension/songsterr/  Chrome/Edge MV3 adapter
android/            Native Kotlin adapter (+ its own README)
scripts/build-android.ps1   Gradle-bootstrapping Android build
scripts/Start-BandCueHost.ps1  Windows public-beta host launcher
docs/               This documentation set
```

## Public Beta Release Bundle

Build the v1.0-style release folder and zip with:

```powershell
npm run package:release
```

The script regenerates icons, packages the extension, builds the Android release APK, and writes
`dist/release/bandcue-v<version>/` plus `dist/release/bandcue-v<version>.zip`. Use
`npm run package:release -- --skip-android` only for dry runs when the Android toolchain is not
available.

## Coding Conventions

- Match the surrounding code: 2-space indent, double quotes, explicit `.js` import suffixes in
  TS (the project is ESM, `"type": "module"`).
- Treat all client input as untrusted — every field the server stores from a client message is
  sanitized in `room.ts`. Follow that pattern for new fields.
- Keep platform clients (extension, Android) behaviorally aligned with the shared TypeScript logic
  and with each other; they intentionally mirror the same discovery, clock, and protocol rules.

## Living Improvements

Active reliability and workflow work is tracked in [Improvements.md](Improvements.md) with status,
evidence, acceptance criteria, and repro notes. Update it as items move from investigation to
done.
</content>
