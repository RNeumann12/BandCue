# BandCue Configuration Reference

Every command-line flag and environment variable that BandCue understands. Defaults are shown in
**bold**. Many env vars accept a legacy `PLAYSYNC_*` alias from the project's former name.

## npm Scripts

| Script | What it runs |
| --- | --- |
| `npm run dev` | The coordinator ([`src/server/index.ts`](../src/server/index.ts)). |
| `npm run dev:all` | Coordinator **+** local MuseScore helper ([`start-rehearsal.ts`](../src/tools/start-rehearsal.ts)). |
| `npm run dev:all:bridge` | `dev:all` with MuseScore in bridge mode (`--musescore-bridge`). |
| `npm run dev:musescore` | The MuseScore Windows helper ([`musescore-windows.ts`](../src/adapters/musescore-windows.ts)). |
| `npm run preflight` | Pre-rehearsal environment checks. |
| `npm run generate:icons` | Generate extension and Android launcher PNGs from the BandCue icon source. |
| `npm run generate:store-assets` | Generate Chrome Web Store promo and screenshot PNGs. |
| `npm run package:extension` | Zip the Chrome/Edge extension. |
| `npm run package:release` | Build the public-beta release folder and zip. |
| `npm run build:android` | Build the debug APK (bootstraps Gradle). |
| `npm run build:android:release` | Build a signed release APK (`assembleRelease`). |
| `npm run test:android` | Android JVM tests. |
| `npm run build` | `tsc -p tsconfig.json`. |
| `npm run check` | `tsc --noEmit` type-check. |
| `npm test` | `vitest run` unit tests. |

Pass flags through an npm script with `--`, e.g.
`npm run dev:musescore -- --name "MuseScore laptop"`.

Windows public-beta launchers:

| Launcher | What it runs |
| --- | --- |
| `BandCue Host.cmd` | Checks Node/deps, runs preflight, starts `npm run dev`, and opens the host URL. |
| `BandCue Host - MuseScore Bridge.cmd` | Same startup flow, but starts `npm run dev:all:bridge`. |
| `BandCue MuseScore Bridge - Connect.cmd` | Joins a room as this machine's MuseScore adapter. Extra arguments pass through to [`Start-BandCueMuseScoreAdapter.ps1`](../scripts/Start-BandCueMuseScoreAdapter.ps1) (`-Room`, `-Name`, `-CueHotkey`, `-BridgePort`). |
| `BandCue MuseScore Bridge - Helix Cue.cmd` | The full Helix setup for the machine the pedal is plugged into: the same, plus `-CueHotkey "ctrl+alt+p"` and `-BridgePort 4731`. Enable the **BandCue Bridge** plugin in MuseScore and leave its window open. See [External cue](#external-cue-helix-and-other-pedals) and [Adapters.md](Adapters.md#musescore-plugin-bridge--the-only-way-to-reset-the-playhead). |

## Coordinator (`npm run dev`)

The coordinator is configured entirely through environment variables.

| Env var | Default | Purpose |
| --- | --- | --- |
| `PORT` | **4173** | HTTP + WebSocket port. |
| `HOST` | **0.0.0.0** | Bind address. |
| `BANDCUE_DISCOVERY_PORT` | = `PORT` | UDP discovery responder port. |
| `BANDCUE_TOKEN` (or `PLAYSYNC_TOKEN`) | random `base64url` | The room token. Set it to keep a stable URL across restarts. |
| `PUBLIC_HOST` | auto-detected LAN IP | The IP/host advertised in the room URL and QR code. |

The room **code** is always randomly generated (6 hex chars) and can't be pinned.

## One-Command Rehearsal (`npm run dev:all`)

Spawns the coordinator and the MuseScore helper together. Flags are parsed by
[`start-rehearsal.ts`](../src/tools/start-rehearsal.ts); the rest are inherited from the
coordinator and helper.

| Flag / Env var | Default | Purpose |
| --- | --- | --- |
| `--musescore-bridge [port]` / `BANDCUE_MUSESCORE_BRIDGE` | off | Run the helper in bridge mode. Bare flag or `=1`/`true` uses **4731**; pass a port to override. `0`/`false`/`no`/`off` disables. |
| `--public-host <ip>` / `BANDCUE_PUBLIC_HOST` | unset | Pin the advertised LAN IP (flows to the coordinator as `PUBLIC_HOST`). |
| `BANDCUE_PORT` (or `PORT`) | **4173** | Coordinator port the helper targets. |
| `BANDCUE_MUSESCORE_NAME` (or `PLAYSYNC_MUSESCORE_NAME`) | **"MuseScore laptop"** | The helper's device name. |
| `BANDCUE_MUSESCORE_ARGS` (or `PLAYSYNC_MUSESCORE_ARGS`) | unset | Extra args appended to the helper command (quoted-string aware). |

`--musescore-bridge` accepts `--musescore-bridge`, `--musescore-bridge 5050`, or
`--musescore-bridge=5050`.

## MuseScore Helper Flags (`npm run dev:musescore`)

Parsed by `parseArgs` in [`musescore-windows.ts`](../src/adapters/musescore-windows.ts).

### Connection

| Flag | Default | Purpose |
| --- | --- | --- |
| `--room <value>` | unset | Room code, port, `host:port`, or full room URL. (Placeholders `HOST`/`TOKEN` are rejected.) |
| `--port <n>` | **4173** (or `BANDCUE_PORT`/`PORT`) | Coordinator HTTP port for discovery. |
| `--discovery-port <n>` | = `--port` (or `BANDCUE_DISCOVERY_PORT`) | UDP discovery port. |
| `--name <text>` | **`<hostname> MuseScore`** | Device name shown in the room. |

### Playback control

| Flag | Default | Purpose |
| --- | --- | --- |
| `--play-key <keys>` | **`" "`** (Space) | Keystroke(s) sent to play. |
| `--reset-key <keys>` | **`^{HOME}`** (Ctrl+Home) | Keystroke(s) to seek to the start before play. |
| `--stop-key <keys>` | **`{ESC}`** | Keystroke(s) sent to stop. |
| `--play-mode <mode>` | **`stop-then-play`** | `stop-then-play` (ESC, wait, Space — safer) or `single-key` (legacy toggle). |
| `--process-match <regex>` | **`MuseScore\|mscore`** | Regex matching the MuseScore process name. |
| `--title-match <regex>` | unset | Optional stricter window-title match. |

### Timing & activation

| Flag | Default | Purpose |
| --- | --- | --- |
| `--activation-retries <n>` | **5** | Retries to bring the MuseScore window to the foreground. |
| `--activation-delay-ms <n>` | **90** | Delay between activation retries. |
| `--command-gap-ms <n>` | **120** | Gap between chained keystrokes. |
| `--dispatch-lead-ms <n>` | **1000** | Lead time for the *fallback* path only (one shell per command), used when the resident trigger cannot run a command. The final Play key still waits for the downbeat. Use `0` to disable. This is only the starting value: if setup (spawn + activate + prefix keys) ever overruns it and the Play key fires late, the helper grows its effective lead time for the rest of the session (capped at 4000 ms) and logs a warning — see [Adapters.md](Adapters.md#musescore-on-windows). The resident trigger's own lead starts at **600 ms** and is capped at 1000 ms. |

### External cue (Helix and other pedals)

| Flag / Env var | Default | Purpose |
| --- | --- | --- |
| `--cue-hotkey <combo>` / `BANDCUE_CUE_HOTKEY` | unset (off) | Claim this combination system-wide on this machine and turn it into a Play request stamped with the instant the input happened, e.g. `ctrl+alt+p`. Needs at least one modifier (`ctrl`/`alt`/`shift`/`win`) plus a letter, digit, or `f1`–`f24`. |

Use this on the one machine the pedal is plugged into. Without it, the cue only reaches BandCue
while the **host page** holds the keyboard focus — and on a machine that also drives MuseScore,
that is the same focus MuseScore needs to receive its keystrokes, so one of the two always loses.
Registering the cue system-wide lets MuseScore keep the foreground all night while the cue still
arrives. The room must still be armed; the coordinator rejects the Play otherwise, and rejects it
from an adapter entirely when the control mode is host-only.

### Bridge mode

| Flag | Default | Purpose |
| --- | --- | --- |
| `--bridge-port <n>` | unset (off) | Expose the localhost bridge API on this port (e.g. `4731`). |
| `--bridge-fallback-ms <n>` | **900** | Grace after the scheduled time for an already-claimed bridge command. Unclaimed commands fall back immediately. |

### Local score catalog

| Flag / Env var | Default | Purpose |
| --- | --- | --- |
| `--score-folder <path>` (repeatable) / `BANDCUE_MUSESCORE_FOLDERS` (`;`-separated) | none | Folders to scan for `.mscz`/`.mscx`. Enables publishing + auto-open. |
| `--score-recursive <bool>` / `BANDCUE_MUSESCORE_RECURSIVE` | **on** (`0` disables) | Scan folders recursively. |
| `--close-old-instances <bool>` / `BANDCUE_MUSESCORE_CLOSE_OLD` | **on** (`0` disables) | After auto-open confirms the new MuseScore window, close the previous instances gracefully (WM_CLOSE, never force-killed). |

### Examples

```powershell
# Default local connection, custom device name
npm run dev:musescore -- --name "MuseScore laptop"

# Target a coordinator on a non-default port
npm run dev:musescore -- --port 5000 --name "MuseScore laptop"

# Custom shortcuts and a stricter window match
npm run dev:musescore -- --name "MuseScore laptop" `
  --stop-key "{ESC}" --play-key " " --process-match "MuseScore|mscore" --title-match "Song Title"

# Publish a local library and expose the bridge API
npm run dev:musescore -- --name "MuseScore laptop" `
  --score-folder "C:\Users\you\Documents\MuseScore4\Scores" --bridge-port 4731
```

## Android Build (`scripts/build-android.ps1`)

| Parameter | Default | Purpose |
| --- | --- | --- |
| `-Task <name>` | **`assembleDebug`** | One of `assembleDebug`, `assembleRelease`, `test`, `clean`. |
| `-GradleVersion <ver>` | **`8.10.2`** | Gradle version to bootstrap. |

The script resolves the Android SDK from `ANDROID_SDK_ROOT`, `ANDROID_HOME`, or
`%LOCALAPPDATA%\Android\Sdk`, and Java from the Android Studio JBR or `JAVA_HOME`. Release signing
uses a gitignored keystore — see the notes in [Development.md](Development.md).

## Constants Worth Knowing

| Constant | Value | Where |
| --- | --- | --- |
| `DEFAULT_SCHEDULE_DELAY_MS` | 1500 ms | Count-in delay before a scheduled start ([`transport.ts`](../src/shared/transport.ts)). |
| `DEFAULT_ROOM_PORT` | 4173 | Default HTTP/discovery port ([`room-locator.ts`](../src/shared/room-locator.ts)). |
| `RECENT_CLOCK_TTL_MS` | 30 s | How long a client's clock is cached across reconnects ([`room.ts`](../src/server/room.ts)). |
| Manual offset clamp | ±5000 ms | Range for per-device calibration. |
</content>
