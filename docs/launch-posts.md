# BandCue — launch posts (ready to paste)

Drafts for sharing BandCue. Each is framed as a real person who built a thing for their
own band — that tone outperforms a feature dump everywhere, especially on Reddit and HN.

**Before posting, do these:**
1. Record a 30–60s demo (phones + a laptop all hitting play in sync). Drop the link into the posts marked `[DEMO LINK]`.
2. ✅ ~~Add a LICENSE file~~ — done (MIT, in the repo root).
3. Make sure the GitHub repo is public and the Releases page has the v1.0.2 download.

Repo: https://github.com/RNeumann12/BandCue

---

## 1. Hacker News — "Show HN"

**Title:**
`Show HN: BandCue – local-first playback sync so a whole band starts on the same beat`

**Body (post as the first comment):**

> When my band rehearses, everyone has the tab or score open on their own phone or laptop, and hitting "play" by hand never lines up — one screen is a beat ahead, another a beat behind. So I built BandCue.
>
> One machine runs a coordinator on the rehearsal Wi-Fi. Instead of sending "play now", it schedules "play at time T", and every device counts down to the same instant using an NTP-style clock sync (offset/RTT/jitter measurement), so they all start together. There's per-device calibration for screens that are consistently early or late, and a setlist mode that auto-loads/arms/plays/advances through a whole rehearsal hands-free.
>
> It drives real players rather than reinventing them: Songsterr in Chrome/Edge (MV3 extension), Songsterr on Android (native Kotlin adapter using media sessions), and MuseScore on Windows (a helper that sends transport via keyboard or a local bridge API). Phones/tablets can also join as read-only companion displays.
>
> It's local-first by design — no cloud, no account, nothing leaves the rehearsal LAN. Coordinator's in Node, web UI is static HTML/CSS/JS, discovery is mDNS + UDP broadcast + LAN scan with a QR-code join.
>
> Demo: [DEMO LINK]
> Code: https://github.com/RNeumann12/BandCue
>
> Happy to talk about the clock-sync math, the discovery fallbacks, or how the MuseScore bridge works.

*(HN tip: post mid-week, US morning. Engage with every comment in the first 2 hours — that's what moves it up.)*

---

## 2. r/musescore

**Title:** `I built a free tool that makes MuseScore (and Songsterr) start playback in sync across a whole band`

**Body:**

> My band rehearses with scores on multiple screens and we could never hit "play" together. So I made **BandCue** — one machine on the rehearsal Wi-Fi schedules a synchronized start, and every device begins on the same beat.
>
> For MuseScore: a small Windows helper opens the score and drives play/stop. It can auto-open the right local score from a folder you point it at (it only shares the title + folder-relative path, never your full paths). It also works alongside Songsterr if some band mates use that instead.
>
> It's free, open source, and runs entirely on your local network — no cloud, no account.
>
> Demo: [DEMO LINK]
> GitHub: https://github.com/RNeumann12/BandCue
>
> Would love feedback from anyone who rehearses off scores — what would make this actually useful for your group?

---

## 3. r/Songsterr

**Title:** `Made a free tool to sync Songsterr playback across every device in your band`

**Body:**

> If your band plays from Songsterr on separate phones/laptops, you know the pain of trying to start together. **BandCue** schedules a synchronized start so every device begins on the exact same beat.
>
> It works through a Chrome/Edge extension (and a native Android app, plus iPad/iPhone via the Orion browser). It also resets each player to the top before play, so you stay together even after someone scrolled around. Per-device timing calibration is built in for screens that drift early or late.
>
> Free, open source, runs entirely on your rehearsal Wi-Fi — no cloud, no account.
>
> Demo: [DEMO LINK]
> GitHub: https://github.com/RNeumann12/BandCue

---

## 4. r/WeAreTheMusicMakers / r/musicians / r/Band

**Title:** `I got tired of my band never starting the song together, so I built a free sync tool`

**Body:**

> Quick share of a side project. When we rehearse with tabs/scores on everyone's own device, pressing play by hand is always slightly off. **BandCue** puts a little coordinator on the rehearsal Wi-Fi that schedules a synchronized start — everyone's screen counts down and starts on the same beat.
>
> It drives Songsterr (Chrome/Edge extension + Android app) and MuseScore (Windows), with a setlist mode that runs the whole rehearsal hands-free, and companion screens for phones/tablets that just want to follow along.
>
> It's free and open source, and 100% local — nothing leaves the room, no account needed.
>
> Demo: [DEMO LINK] · Code: https://github.com/RNeumann12/BandCue
>
> Built it to scratch my own itch — curious whether other bands hit the same problem.

---

## 5. Worship / church band communities (Facebook groups, Discord, r/worshipleaders)

*Strong fit — these groups are multi-screen, click-track-driven, and tech-comfortable.*

**Title/Opener:** `Free tool to start everyone's chart/tab on the same beat (local network, no cloud)`

**Body:**

> Sharing a free tool for teams that run charts or tabs on multiple devices. **BandCue** runs on your rehearsal/stage Wi-Fi and schedules a synchronized start so every screen begins together — no more counting in and hoping. Works with Songsterr (browser + Android) and MuseScore, with a hands-free setlist mode and follow-along displays for phones/tablets.
>
> Everything stays on your local network — no cloud, no account, nothing leaves the room.
>
> Demo: [DEMO LINK] · https://github.com/RNeumann12/BandCue

---

## Short social caption (TikTok / Reels / YouTube Shorts / X)

> One tap. Whole band starts on the same beat. 🎸🥁
> BandCue syncs Songsterr & MuseScore across every phone, tablet, and laptop on your rehearsal Wi-Fi. Free & open source, no cloud.
> 👉 github.com/RNeumann12/BandCue
> #bandpractice #musictech #guitar #bass #drums #worshipband #musescore #songsterr

---

## ✅ License — done

The repo now ships an **MIT License** (`LICENSE` in the root, `"license": "MIT"` in
`package.json`, and a License section in the README). The copyright holder is set to
"R. Neumann" — edit that one line if you'd prefer a different name.

Heads-up: BandCue drives Songsterr and MuseScore. That's fine for a tool you run locally,
but double-check you're comfortable with their terms before promoting it widely, and don't
redistribute their trademarks/assets as your own. (The README License section already adds a
short "not affiliated with" disclaimer.)
