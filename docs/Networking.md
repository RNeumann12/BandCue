# BandCue Networking & Discovery

BandCue is local-first: the coordinator, the web UI, and all discovery live on the rehearsal LAN.
This document covers how clients find a room, the four discovery mechanisms, and the token model
that secures a connection.

## Room Locators

A client joins a room from one of four user-entered **locators**, resolved by
[`room-locator.ts`](../src/shared/room-locator.ts). In order of reliability:

| Locator | Example | Notes |
| --- | --- | --- |
| **Full room URL** | `http://192.168.1.10:4173/?token=abc…` | Always works. Contains the token. Copy from the host page or terminal. |
| **`host:port`** | `192.168.1.23:4173` | Reliable when discovery is blocked. No scan needed. |
| **Room code** | `47B06D` | 6 hex chars. Triggers discovery to find the host, then verifies the code. |
| **Port only** | `4173` | Triggers discovery on that port; first room found wins. |

A room code or port produces *candidates* that are probed via `GET /api/room`. The
`expectedRoomCode` on each candidate guards against connecting to the wrong room on a shared LAN.

## The Four Discovery Mechanisms

When a locator is a room code or port, clients try these paths (a native helper uses all four; a
browser can't do raw UDP):

### 1. Local candidates
Always tried first: `127.0.0.1` and `localhost` on the target port. Instant win when the adapter
runs on the coordinator machine.

### 2. mDNS (multicast DNS)
The coordinator advertises hostnames over multicast DNS ([`mdns.ts`](../src/server/mdns.ts)):

- `bandcue.local` — the generic name (covers the common single-room case and port-only locators).
- `bandcue-<roomcode>.local` — disambiguates multiple rooms on one LAN.

Any client with an OS mDNS resolver (Windows 10 1703+, macOS, Linux + Avahi) can resolve these to
the server's LAN IP and reach the room with a plain HTTP request — **no brute-force scan**. This
is the browser-friendly counterpart to UDP discovery. Clients without a resolver, or on a
multicast-blocked network, fall back to the scan.

### 3. UDP broadcast *(native clients only)*
The coordinator runs a UDP responder ([`discovery.ts`](../src/server/discovery.ts)) on the
discovery port (defaults to the HTTP port). A native client broadcasts a
`bandcue.discovery.request` datagram ([`lan-discovery.ts`](../src/shared/lan-discovery.ts)) to
`255.255.255.255` and each interface's computed broadcast address. The server replies with the
room code + HTTP port, and the client verifies the room through `/api/room` before connecting.
Browsers can't open raw UDP sockets, so they skip this step.

### 4. LAN subnet scan
The last resort: probe `GET /api/room` across a documented list of common rehearsal subnets,
hosts `.1`–`.254`. The canonical list lives in `DEFAULT_LAN_SCAN_SUBNETS`:

```
192.168.0   192.168.1   192.168.178   192.168.2   192.168.4   192.168.86
10.0.0      10.0.1      10.0.2        172.16.0    172.20.10
```

Ordered most-likely-first (common router defaults and the Fritz!Box `192.168.178` default), so a
scan that finds the room early avoids probing hundreds of dead hosts. Clients prioritize their
**own** subnet first when the platform exposes the local IP (`prioritizeScanSubnets`).

> **Keep these in sync.** Three copies of the subnet list exist:
> [`src/shared/room-locator.ts`](../src/shared/room-locator.ts) (canonical),
> `extension/songsterr/background.js` (`LAN_SCAN_SUBNETS`), and
> `android/.../RoomLocator.kt` (`LAN_SCAN_SUBNETS`). Update all three together.

## When Discovery Fails

Discovery can be blocked by Wi-Fi client isolation, a firewall, a VPN, or an uncommon subnet.
Every client's failure message names what it tried (local / UDP / scanned subnets / port) and
recommends the reliable fallback: enter the **`host:port`** shown on the host page (e.g.
`192.168.1.12:4173`) or paste the **full room URL**. The host join panel also shows a copyable
`host:port` next to the QR/full URL for exactly this case.

## Choosing the Advertised LAN IP

The coordinator auto-detects a LAN IP to put in the room URL and QR code
([`lan-address.ts`](../src/shared/lan-address.ts), `selectLanCandidates`). On machines with
multiple physical LANs or a virtual adapter, auto-detection can pick the wrong interface. Pin it:

```powershell
npm run dev:all -- --public-host 192.168.178.38
# or set the env var the coordinator honors directly:
$env:PUBLIC_HOST = "192.168.178.38"; npm run dev
```

Other detected LAN IPs are printed at startup so you know the alternatives.

## The Token & Security Model

- The **room token** (`ROOM_TOKEN`) is the secret. It's a random `base64url` string generated at
  startup (or set via `BANDCUE_TOKEN`). A WebSocket upgrade to `/ws` is **rejected with HTTP 401**
  unless `?token=` matches. Anyone with the token can join and (subject to safety rules) control
  transport.
- The **room code** (`ROOM_CODE`) is **not** secret — it's a 6-hex-char locator that only helps
  find the host. Discovery responders return the code freely. Knowing the code does not grant
  access; the token still gates the WebSocket.
- The full room URL embeds the token, so treat the URL and QR code like a shared password for the
  rehearsal.
- BandCue assumes a trusted rehearsal LAN. There is no per-user auth, TLS, or rate limiting — it
  is not designed to be exposed to the public internet. Keep it on the local network.

## Default Ports

| Port | Default | Purpose | Override |
| --- | --- | --- | --- |
| HTTP + WebSocket | `4173` | Web UI, `/api/room`, `/ws` | `PORT` |
| UDP discovery | = HTTP port | Datagram discovery responder | `BANDCUE_DISCOVERY_PORT` |
| MuseScore bridge | `4731` | Localhost bridge API | `--bridge-port` / `BANDCUE_MUSESCORE_BRIDGE` |

See [Configuration.md](Configuration.md) for the full list of environment variables and flags.
</content>
