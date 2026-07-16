# BandCue Improvement Review — 2026-07-16

A fresh pass over the coordinator, shared code, web client, Songsterr extension,
MuseScore adapter, Android app, tooling, CI, and repository hygiene. Items already
fixed in earlier audits (see `Improvements-2026-07-10.md` and older) are not repeated;
items from those audits that are still open are carried over and marked as such.

Priorities: `P1` = should do, real risk or friction today. `P2` = worth doing soon.
`P3` = nice to have / polish.

Status legend: `Done` = implemented and covered by automated verification on
2026-07-16 (same day). `Open` = not yet started. `Decision needed` = a product or
trust-model choice is required first.

---

## 1. Security & Trust Model

### 1.1 (P1, carried over) Decide the room authorization model

Status: `Decision needed`

Still the biggest open decision. Today the room token is intentionally readable by
anyone on the LAN: `GET /api/room` is unauthenticated and its `companionUrl` /
`hostUrl` fields embed the token (`src/server/index.ts:60`, and
`src/shared/room-locator.ts` extracts the token from exactly this response during
discovery). Any device on the rehearsal Wi-Fi can therefore join — and because the
`host` role is purely client-declared in `clientHello`, any device can also claim
host and control transport, setlist, and calibration.

This is a deliberate "the Wi-Fi is the boundary" design and fine for a trusted
rehearsal room, but it should be an explicit, documented decision. If tightening is
wanted, the smallest useful step is splitting tokens: keep the freely discoverable
member/companion token, but require a separate host token (printed only in the
coordinator console) for `role: "host"` hellos. That closes host escalation without
breaking zero-config joining.

### 1.2 (P2) Don't print the raw WebSocket URL with token at startup

`src/server/index.ts:254` logs `ws://…/ws?token=…`. The host/companion URLs already
carry the token for people who need it; the raw WS line is only useful for debugging
and is the kind of line that ends up in screenshots and pasted terminal output.
Consider printing it only behind a `--verbose`/`BANDCUE_DEBUG` flag.

### 1.3 (P3) Token lives in URL query strings

Browser clients pass the token as `?token=` (web app and extension). On a LAN-only
plain-HTTP deployment this is mostly cosmetic (it lands in browser history and the
coordinator's own logs), but if the auth model from 1.1 is ever tightened, move WS
auth into the first message (`clientHello`) or a `Sec-WebSocket-Protocol` value so
the token stops appearing in URLs at all.

---

## 2. Coordinator Robustness

### 2.1 (P1, carried over) Graceful shutdown is still missing

Status: `Done`

Implemented in `src/server/index.ts`: SIGINT/SIGTERM now close every WebSocket
client with code 1001 ("Coordinator shutting down"), stop the liveness sweep and
the ping/LAN-watch timers, close the discovery and mDNS responders, and close the
HTTP server, with a 2 s hard-exit fallback for stuck TCP peers. The POSIX signal
path is exercised on CI when Playwright's webServer tears the coordinator down
(SIGTERM); on Windows, Ctrl+C in the console takes the same path.

### 2.2 (P2) Unhandled async errors in the HTTP handler can crash the process

Status: `Done`

The `createServer` callback body now runs through a top-level try/catch
(`handleHttpRequest` in `src/server/index.ts`) that logs and answers 500 instead of
letting a rejection (e.g. from `QRCode.toString`) become a process-killing unhandled
rejection.

### 2.3 (P2) Surface the stale-LAN-address warning in the UI, not just the console

`src/server/index.ts:218-235` detects when the advertised IP is no longer on the
machine but only `console.warn`s. The host machine's terminal is often minimized or
headless during rehearsal. The room already broadcasts state constantly — add a
`serverWarning` field to `RoomState` so the web host UI (which already has a
warnings area) can show "QR code / saved URLs are stale, restart the coordinator".

### 2.4 (P3) Static file serving polish

- No cache headers: every page load refetches `app.js` / `styles.css` / the 10k-line
  vendored `jsQR.js` equivalent. `Cache-Control: no-cache` plus an ETag (or just
  `max-age=60`) is enough for a LAN app.
- `contentType()` falls back to `text/html` for unknown extensions — a `.png` or
  `.ico` added to `web/` later would be served with the wrong type. Add the common
  image types or a `application/octet-stream` fallback.
- `url.pathname` is never `decodeURIComponent`ed, so any file with an encoded
  character in its name 404s. Harmless today, surprising later.

### 2.5 (P3) No cap on concurrent connections

There's a per-socket message rate limit and a hello timeout, but nothing bounds the
number of simultaneous WebSocket clients. A misbehaving LAN device reconnect-looping
with valid hellos can grow the client map and the broadcast fan-out without limit.
A generous cap (say 64 clients) with a clear close reason would bound the blast
radius at near-zero cost.

---

## 3. Code Health

### 3.1 (P1) `web/` and `extension/` JavaScript is outside every type check

Status: `Done` (option 1; option 2 remains the long-term direction, see 3.2)

All plain-JS runtime files are now type-checked with `allowJs` + `checkJs` as part
of `npm run check` (and therefore `verify` and CI): `tsconfig.web.json` covers
`web/*.js`, and four per-execution-context configs under `extension/songsterr/`
(`tsconfig.background/popup/scanner/content.json`, sharing `tsconfig.base.json`)
cover the extension. Contexts are checked separately because the extension's files
are classic scripts — one combined tsc program would merge their global scopes and
report false redeclaration clashes between the service worker and the popup.
The ~100 findings were fixed via JSDoc casts (typed `$`/`$$` query helpers in
`app.js`, a `queryMediaElements()` helper in `content-script.js`), two real
`.value = number` type mismatches, renaming popup globals that shadowed
`window.stop`/`window.status`, and an ambient `globals.d.ts` for `jsQR`,
`importScripts`, and `BarcodeDetector`. `package-extension.ts` excludes the new
dev-only files from the store zip. Checks are deliberately not `strict` —
strictNullChecks against hand-written DOM code would drown the real findings.

### 3.2 (P2) Hand-maintained mirrors of shared logic

Because the web app and MV3 extension have no build step, shared logic exists in
parallel copies: `web/host-logic.js` re-implements pieces of `src/shared/*`, and
`background.js:12-18` mirrors the clock constants from `src/shared/clock.ts` with a
"keep in sync" comment. `project-consistency.test.ts` guards ports and subnet lists
but **not** the clock constants or any mirrored logic. Either extend that test to
cover the clock constants (cheap), or introduce the bundling step from 3.1 so there
is one source of truth (right).

### 3.3 (P2, carried over) Split the four oversized modules

Still open from the 07-10 audit: `src/server/room.ts` (1157 lines),
`src/adapters/musescore-windows.ts` (1519), `web/app.js` (1656),
`extension/songsterr/background.js` (1780). Natural seams that already exist in the
code: room.ts → transport state machine / adapter-status sanitizers / clock cache;
musescore-windows.ts → CLI+args / bridge HTTP server / window automation;
background.js → discovery+connection / transport dispatch / tab+status tracking.

### 3.4 (P3) No linter or formatter

CI runs only `tsc --noEmit` + vitest. There is no ESLint/Biome/Prettier config, so
style and bug-class rules (unused vars in the plain-JS files, accidental `==`,
floating promises) are unenforced. Biome would be the lowest-friction single tool
for a mixed TS/JS repo this size.

---

## 4. Testing & CI

### 4.1 (P2, carried over) Android is not covered by CI

Status: `Done` (pending first hosted run)

`ci.yml` now has an `android` job: temurin JDK 17 + `gradle/actions/setup-gradle`
pinned to the same Gradle 8.10.2 that `scripts/build-android.ps1` bootstraps
locally, running `gradle testDebugUnitTest` in `android/` (no emulator needed; the
build falls back to debug signing when the gitignored keystore is absent). Gradle
cannot run on this development machine, so the job is verified on the next push.

### 4.2 (P2, carried over) No browser-level end-to-end test

Status: `Done`

`e2e/host-smoke.spec.ts` (Playwright, `npm run test:e2e`, CI job `e2e`) boots the
real coordinator via `playwright.config.ts`'s webServer, opens `/host?token=…`,
asserts the room code renders, adds a setlist song, joins a fake ready
desktop-adapter over a raw WebSocket, arms, plays, asserts `/api/room` reaches
`scheduled`/`running`, and stops. Passes locally in ~4 s.

### 4.3 (P3) Release packaging is never exercised in CI

`npm run package:release` and `package:extension` only run on a maintainer machine.
A CI job (or a job on tag push) that runs them and uploads the artifacts would catch
packaging regressions and double as the release pipeline.

### 4.4 (P3) No coverage reporting

Vitest supports `--coverage` out of the box. Not worth gating on a threshold, but a
coverage report in CI would show whether the big untyped JS files (3.1) are actually
exercised by their extracted-logic tests.

---

## 5. Repository & Docs Hygiene

### 5.1 (P2) Personal setlist data is committed at the repo root

Status: `Done`

`bandcue-setlist-2026-06-24.json` is untracked from git (the local file is kept on
disk) and `bandcue-setlist-*.json` is gitignored so future exports can't be
committed by accident. A scrubbed `examples/setlist.example.json` documents the
import format (Songsterr, MuseScore, and Helix-sync variants) and is linked from
the README's Export/Import section.

### 5.2 (P2) README still contains launch placeholders

Status: `Done`

The dead "Watch the 60-second demo" link and the "_Replace the demo link_" note are
removed. Re-add a demo link when a real video/GIF exists.

### 5.3 (P3) Consolidate the four improvement docs

`docs/Improvements.md`, `Audit-Improvements-2026-06-25.md`,
`Improvements-2026-07-02.md`, `Improvements-2026-07-10.md` (and now this file)
overlap in scope, and each carries its own status legend. Fold everything still open
into one living `Improvements.md` tracker and mark the dated audits as historical
records at the top, so there is exactly one place to look for "what's still open".

### 5.4 (P3) Root-level launcher scripts

`BandCue Host.cmd` and `BandCue Host - MuseScore Bridge.cmd` sit in the repo root
(with spaces in their names). Moving them to `scripts/` — or generating them into
the release zip only via `package-release.ts` — would keep the root to
project-standard files. If they're documented as double-click entry points in the
release layout, keep them there but note it in `docs/Development.md`.

---

## 6. Product / UX Ideas (no commitment implied)

- **(P2) Host UI warning for stale LAN address** — see 2.3; the plumbing is the
  server-side work, the UI already has a warnings list.
- **(P3) Rate-limit close vs. reconnect loop** — a client closed for exceeding the
  message rate limit (`index.ts:191`) will auto-reconnect and can loop. Include a
  machine-readable close code the clients treat as "back off much longer".
- **(P3) mDNS re-announce on address change** — the mDNS responder binds the
  startup address; when the LAN watcher (2.3) detects a new address it could
  re-announce instead of only warning.
- **(P3) Setlist sharing between host devices** — the setlist lives in the host
  browser's localStorage; a second host device starts empty. Persisting the last
  setlist server-side (it's already sanitized and size-capped) would make "host from
  my phone tonight" seamless.

---

## Suggested Order

1. **1.1** — make the auth-model decision (everything security-adjacent hangs on it). `Decision needed`
2. ~~**2.1 + 2.2** — shutdown handling and crash-proofing the HTTP handler.~~ `Done 2026-07-16`
3. ~~**3.1** — bring web/extension JS under type checking.~~ `Done 2026-07-16`
4. ~~**4.1 + 4.2** — Android unit tests in CI, one Playwright smoke test.~~ `Done 2026-07-16`
5. ~~**5.1 + 5.2** — repo hygiene.~~ `Done 2026-07-16`
6. Everything else opportunistically, ideally alongside the module splits (3.3).

Still open after the 2026-07-16 implementation pass: 1.1 (decision), 1.2, 1.3,
2.3–2.5, 3.2–3.4, 4.3, 4.4, 5.3, 5.4, and the section 6 ideas.
