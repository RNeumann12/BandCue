import { createServer } from "node:http";
import { Socket } from "node:net";
import { networkInterfaces } from "node:os";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { timingSafeEqual } from "node:crypto";
import QRCode from "qrcode";
import { WebSocketServer } from "ws";
import { RoomController } from "./room.js";
import { startDiscoveryResponder } from "./discovery.js";
import { startMdnsResponder } from "./mdns.js";
import { loadOrCreateRoomIdentity } from "./room-identity.js";
import { serverNow } from "./server-clock.js";
import { parsePort } from "./config.js";
import { selectLanCandidates } from "../shared/lan-address.js";
import {
  MAX_WS_MESSAGE_BYTES,
  parseClientHelloPayload,
  parseClientMessagePayload
} from "./message-guards.js";

const PORT = parsePort(process.env.PORT, "PORT");
const HOST = process.env.HOST ?? "0.0.0.0";
const DISCOVERY_PORT = parsePort(process.env.BANDCUE_DISCOVERY_PORT, "BANDCUE_DISCOVERY_PORT", PORT);
const __dirname = dirname(fileURLToPath(import.meta.url));
const publicDir = join(__dirname, "../../web");
// Reuse the token and room code across restarts so a coordinator restart
// mid-rehearsal doesn't invalidate every saved URL and QR code. Delete the
// state file (or set BANDCUE_TOKEN / BANDCUE_ROOM_CODE) to rotate them.
const { token: ROOM_TOKEN, roomCode: ROOM_CODE } = loadOrCreateRoomIdentity(
  process.env.BANDCUE_STATE_FILE ?? join(__dirname, "../../.bandcue-room.json"),
  {
    token: process.env.BANDCUE_TOKEN ?? process.env.PLAYSYNC_TOKEN,
    roomCode: process.env.BANDCUE_ROOM_CODE
  }
);

const lanCandidates = selectLanCandidates(networkInterfaces());
const lanAddress = process.env.PUBLIC_HOST ?? lanCandidates[0] ?? "127.0.0.1";
const baseUrl = `http://${lanAddress}:${PORT}`;
const localBaseUrl = `http://127.0.0.1:${PORT}`;
const companionUrl = `${baseUrl}/?token=${encodeURIComponent(ROOM_TOKEN)}`;
const hostUrl = `${baseUrl}/host?token=${encodeURIComponent(ROOM_TOKEN)}`;
const localCompanionUrl = `${localBaseUrl}/?token=${encodeURIComponent(ROOM_TOKEN)}`;
// Room time comes from the monotonic serverNow so an OS clock step on this
// machine cannot shift scheduled downbeats mid-rehearsal.
const room = new RoomController(ROOM_CODE, companionUrl, hostUrl, undefined, serverNow);

function contentType(pathname: string): string {
  if (pathname.endsWith(".css")) return "text/css; charset=utf-8";
  if (pathname.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (pathname.endsWith(".svg")) return "image/svg+xml";
  if (pathname.endsWith(".json")) return "application/json; charset=utf-8";
  return "text/html; charset=utf-8";
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", baseUrl);

  if (url.pathname === "/api/room") {
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(room.getState()));
    return;
  }

  if (url.pathname === "/qr.svg") {
    const svg = await QRCode.toString(companionUrl, {
      type: "svg",
      margin: 1,
      color: {
        dark: "#12110f",
        light: "#f7f3ea"
      }
    });
    res.writeHead(200, { "content-type": "image/svg+xml" });
    res.end(svg);
    return;
  }

  const file = url.pathname === "/" || url.pathname === "/host"
    ? "index.html"
    : url.pathname.replace(/^\//, "");

  const resolved = join(publicDir, file);
  // Compare against the directory plus separator: a bare prefix check would let
  // a normalized path escape into a sibling directory whose name starts with
  // the same characters (e.g. `web-private` next to `web`).
  if (!resolved.startsWith(publicDir + sep) && resolved !== publicDir) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  try {
    const { readFile } = await import("node:fs/promises");
    const body = await readFile(resolved);
    res.writeHead(200, { "content-type": contentType(resolved) });
    res.end(body);
  } catch {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("Not found");
  }
});

const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_WS_MESSAGE_BYTES });

function tokenMatches(candidate: string | null): boolean {
  if (typeof candidate !== "string") {
    return false;
  }
  const expected = Buffer.from(ROOM_TOKEN);
  const provided = Buffer.from(candidate);
  return expected.length === provided.length && timingSafeEqual(expected, provided);
}

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url ?? "/", baseUrl);
  if (url.pathname !== "/ws" || !tokenMatches(url.searchParams.get("token"))) {
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    socket.destroy();
    return;
  }

  // Defense-in-depth alongside the app-level liveness sweep: let the OS probe
  // and tear down peers that vanish without a FIN.
  if (socket instanceof Socket) {
    socket.setKeepAlive(true, 30_000);
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit("connection", ws);
  });
});

// A freshly upgraded socket that never sends clientHello would otherwise linger
// forever holding a slot. Close it if the handshake does not arrive in time.
const HELLO_TIMEOUT_MS = 10_000;

// Per-socket message budget. A live client peaks at a handful of messages per
// second (clock warm-up burst + status reports), so this only trips for a
// misbehaving or hostile client spamming mutating messages.
const RATE_WINDOW_MS = 2_000;
const RATE_MAX_MESSAGES = 80;

// Server-initiated WebSocket pings: detects half-open peers faster than the
// 12 s idle sweep alone and keeps NAT/AP state warm between clockSync messages.
// Browsers answer automatically; the Android client answers in its read loop.
const WS_PING_INTERVAL_MS = 4_000;
const wsPingTimer = setInterval(() => {
  for (const client of wss.clients) {
    if (client.readyState === client.OPEN) {
      client.ping();
    }
  }
}, WS_PING_INTERVAL_MS);
wsPingTimer.unref?.();

wss.on("connection", (socket) => {
  let clientId: string | undefined;
  let rateWindowStart = 0;
  let rateCount = 0;

  const overMessageRateLimit = (): boolean => {
    const now = Date.now();
    if (now - rateWindowStart > RATE_WINDOW_MS) {
      rateWindowStart = now;
      rateCount = 0;
    }
    rateCount += 1;
    return rateCount > RATE_MAX_MESSAGES;
  };

  const helloTimer = setTimeout(() => {
    socket.close(1008, "clientHello timeout");
  }, HELLO_TIMEOUT_MS);
  helloTimer.unref?.();

  socket.once("message", (raw) => {
    clearTimeout(helloTimer);
    const hello = parseClientHelloPayload(raw.toString());
    if (!hello) {
      socket.close(1008, "Expected clientHello");
      return;
    }

    const client = room.addClient(socket, hello);
    clientId = client.id;

    socket.on("message", (messageRaw) => {
      if (overMessageRateLimit()) {
        socket.close(1008, "Message rate limit exceeded");
        return;
      }
      const message = parseClientMessagePayload(messageRaw.toString());
      if (!message || !clientId) {
        return;
      }
      try {
        room.handleMessage(clientId, message);
      } catch (error) {
        console.error(`Failed to handle message from ${clientId}:`, error);
      }
    });
  });

  socket.on("close", () => {
    clearTimeout(helloTimer);
    if (clientId) {
      room.removeClient(clientId);
    }
  });
});

// The advertised LAN IP (URLs, QR code, mDNS answer) is chosen once at startup.
// If DHCP hands the machine a new address or the Wi-Fi changes mid-session,
// everything printed and advertised goes stale — warn loudly so the host knows
// to restart or pin PUBLIC_HOST, instead of silently serving unreachable URLs.
const LAN_ADDRESS_CHECK_INTERVAL_MS = 30_000;
let lastLanWarning = "";
const lanWatchTimer = setInterval(() => {
  const candidates = selectLanCandidates(networkInterfaces());
  if (candidates.includes(lanAddress) || process.env.PUBLIC_HOST) {
    lastLanWarning = "";
    return;
  }
  const warning = candidates.length
    ? `Advertised LAN address ${lanAddress} is no longer on this machine (now: ${candidates.join(", ")}). ` +
      "Saved URLs and the QR code are stale — restart the coordinator or set PUBLIC_HOST."
    : `Advertised LAN address ${lanAddress} is no longer on this machine and no LAN address was found. Is Wi-Fi down?`;
  if (warning !== lastLanWarning) {
    lastLanWarning = warning;
    console.warn(warning);
  }
}, LAN_ADDRESS_CHECK_INTERVAL_MS);
lanWatchTimer.unref?.();

server.listen(PORT, HOST, () => {
  startDiscoveryResponder({
    roomCode: ROOM_CODE,
    port: PORT,
    discoveryPort: DISCOVERY_PORT
  });
  startMdnsResponder({
    roomCode: ROOM_CODE,
    port: PORT,
    address: lanAddress
  });
  room.startLivenessSweep();
  console.log("BandCue coordinator running");
  console.log(`Host controls:      ${hostUrl}`);
  console.log(`Companion room:     ${companionUrl}`);
  console.log(`Same-machine room:  ${localCompanionUrl}`);
  console.log(`Room code:          ${ROOM_CODE}`);
  console.log(`WebSocket endpoint: ws://${lanAddress}:${PORT}/ws?token=${ROOM_TOKEN}`);
  const otherLans = lanCandidates.filter((address) => address !== lanAddress);
  if (otherLans.length) {
    console.log(`Other LAN IPs:      ${otherLans.join(", ")}`);
    console.log(`  If clients can't reach ${lanAddress}, set PUBLIC_HOST=<ip> to one of these.`);
  }
  console.log(`Adapter locator:    ${ROOM_CODE} or ${PORT}`);
  console.log("");
  console.log("Startup checks:");
  console.log("npm run preflight");
  console.log("");
  console.log("One-command local rehearsal:");
  console.log("npm run dev:all");
  console.log("");
  console.log("MuseScore on this machine:");
  console.log(`npm run dev:musescore -- --port ${PORT} --name "MuseScore laptop"`);
  console.log("Optional MuseScore bridge API:");
  console.log(`npm run dev:musescore -- --port ${PORT} --name "MuseScore laptop" --bridge-port 4731`);
});
