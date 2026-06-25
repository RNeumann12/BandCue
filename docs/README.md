# BandCue Documentation

Detailed documentation for BandCue, local-first playback sync for band rehearsals. Start with the
[project README](../README.md) for setup and day-to-day use, then dive into these for depth.

| Doc | Read it when you want to… |
| --- | --- |
| [Architecture.md](Architecture.md) | Understand the components, data flow, timing model, room state, and safety rules. |
| [Protocol.md](Protocol.md) | Look up the exact WebSocket message types between clients and the coordinator. |
| [Adapters.md](Adapters.md) | Work on (or integrate with) the browser, Android, or MuseScore adapters, or the bridge API. |
| [Networking.md](Networking.md) | Debug discovery, understand mDNS/UDP/scan, or learn the token/auth model. |
| [Configuration.md](Configuration.md) | Find a CLI flag, environment variable, default, or constant. |
| [Development.md](Development.md) | Build, test, and contribute — including the Android build and release signing. |
| [chrome-extension-privacy.md](chrome-extension-privacy.md) | Review the Chrome Web Store privacy policy for the Songsterr adapter. |
| [chrome-web-store-release.md](chrome-web-store-release.md) | Prepare Chrome Web Store listing text, assets, and reviewer notes. |
| [Improvements.md](Improvements.md) | See the living tracker of active reliability and workflow work. |

## Quick map

```
Coordinator (src/server)  ── serves ──►  Web host + companion (web/)
        ▲                                         
        │  WebSocket /ws?token=                    
        ├──────────────  Browser extension (extension/songsterr)  → Songsterr tabs
        ├──────────────  Android app (android/)                   → Songsterr Android
        └──────────────  MuseScore helper (src/adapters)          → MuseScore Studio

Shared rules (src/shared): protocol · clock sync · transport/safety · discovery
```
</content>
