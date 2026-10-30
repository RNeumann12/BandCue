import { createServer } from "node:http";
import { Socket } from "node:net";
import { networkInterfaces } from "node:os";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { timingSafeEqual } from "node:crypto";
import { gunzipSync } from "node:zlib";
import QRCode from "qrcode";
import { WebSocketServer } from "ws";
import { RoomController } from "./room.js";
import { startDiscoveryResponder } from "./discovery.js";
import { startMdnsResponder } from "./mdns.js";
import { loadOrCreateRoomIdentity } from "./room-identity.js";
import { createRoomStateWriter, readRoomStateFile, roomStatePathFor } from "./room-state-file.js";
import { serverNow } from "./server-clock.js";
import { parsePort } from "./config.js";
import {
  DEFAULT_MAX_TOTAL_BYTES,
  ScoreStore,
  ScoreStoreError,
  scoreStoreDirFor
} from "./score-store.js";
import { MAX_IMPORT_BYTES, SONGSTERR_KEY_PATTERN, importIdFor, isGuitarProFile } from "./score-import.js";
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
const IDENTITY_FILE = process.env.BANDCUE_STATE_FILE ?? join(__dirname, "../../.bandcue-room.json");
const { token: ROOM_TOKEN, hostToken: HOST_TOKEN, roomCode: ROOM_CODE } = loadOrCreateRoomIdentity(
  IDENTITY_FILE,
  {
    token: process.env.BANDCUE_TOKEN ?? process.env.PLAYSYNC_TOKEN,
    hostToken: process.env.BANDCUE_HOST_TOKEN,
    roomCode: process.env.BANDCUE_ROOM_CODE
  }
);
const ROOM_STATE_FILE = roomStatePathFor(IDENTITY_FILE);

const lanCandidates = selectLanCandidates(networkInterfaces());
const lanAddress = process.env.PUBLIC_HOST ?? lanCandidates[0] ?? "127.0.0.1";
const baseUrl = `http://${lanAddress}:${PORT}`;
const localBaseUrl = `http://127.0.0.1:${PORT}`;
const companionUrl = `${baseUrl}/?token=${encodeURIComponent(ROOM_TOKEN)}`;
const hostUrl = `${baseUrl}/host?token=${encodeURIComponent(HOST_TOKEN)}`;
const localHostUrl = `${localBaseUrl}/host?token=${encodeURIComponent(HOST_TOKEN)}`;
const localCompanionUrl = `${localBaseUrl}/?token=${encodeURIComponent(ROOM_TOKEN)}`;
// Room time comes from the monotonic serverNow so an OS clock step on this
// machine cannot shift scheduled downbeats mid-rehearsal.
// The room state goes to every device, so it carries the host page's address
// without the host token.
const room = new RoomController(ROOM_CODE, companionUrl, `${baseUrl}/host`, undefined, serverNow);
const restoredSongs = room.restorePersistedState(readRoomStateFile(ROOM_STATE_FILE));
const roomStateWriter = createRoomStateWriter(ROOM_STATE_FILE);
room.onPersistedStateChange((state) => roomStateWriter.schedule(state));
// Score-view exports uploaded by the MuseScore helper (see score-store.ts).
const SCORE_STORE_DIR = process.env.BANDCUE_SCORE_DIR ?? scoreStoreDirFor(IDENTITY_FILE);
const scoreStore = new ScoreStore(SCORE_STORE_DIR, {
  maxTotalBytes: parseMegabytes(process.env.BANDCUE_SCORE_STORE_MB) ?? DEFAULT_MAX_TOTAL_BYTES,
  inUse: () => room.scoresInUse(),
  onEvict: (scoreIds) => room.scoresRemoved(scoreIds)
});
room.setScoreAvailability((scoreId) => scoreStore.has(scoreId));

function parseMegabytes(value: string | undefined): number | undefined {
  const megabytes = Number(value);
  return value && Number.isFinite(megabytes) && megabytes > 0 ? Math.round(megabytes * 1024 * 1024) : undefined;
}

function contentType(pathname: string): string {
  if (pathname.endsWith(".css")) return "text/css; charset=utf-8";
  if (pathname.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (pathname.endsWith(".svg")) return "image/svg+xml";
  if (pathname.endsWith(".json")) return "application/json; charset=utf-8";
  if (pathname.endsWith(".png")) return "image/png";
  return "text/html; charset=utf-8";
}

// Any throw or rejection escaping this handler would become an unhandled
// rejection and kill the coordinator mid-rehearsal, so the whole body is
// fenced and failures answer 500 instead.
const server = createServer(async (req, res) => {
  try {
    await handleHttpRequest(req, res);
  } catch (error) {
    console.error("HTTP request failed:", error);
    if (!res.headersSent) {
      res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
    }
    res.end("Internal server error");
  }
});

async function handleHttpRequest(
  req: import("node:http").IncomingMessage,
  res: import("node:http").ServerResponse
): Promise<void> {
  const url = new URL(req.url ?? "/", baseUrl);

  if (url.pathname === "/api/room") {
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(room.getState()));
    return;
  }

  if (url.pathname.startsWith("/api/scores/")) {
    await handleScoreRequest(req, res, url);
    return;
  }

  if (url.pathname === "/api/score-imports") {
    await handleScoreImportRequest(req, res, url);
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
}

/**
 * `GET`/`HEAD /api/scores/<scoreId>/<file>` serves a score-view file to anyone
 * in the room; `PUT` stores one, and only for a connected desktop adapter (the
 * MuseScore helper), named by its room client id in `x-bandcue-client-id`.
 * The room or host token comes as `?token=` -- an <img> cannot send headers.
 */
async function handleScoreRequest(
  req: import("node:http").IncomingMessage,
  res: import("node:http").ServerResponse,
  url: URL
): Promise<void> {
  const match = /^\/api\/scores\/([^/]+)\/([^/]+)$/.exec(url.pathname);
  const candidate = url.searchParams.get("token");
  if (!tokenMatches(candidate, ROOM_TOKEN) && !tokenMatches(candidate, HOST_TOKEN)) {
    res.writeHead(401, { "content-type": "text/plain; charset=utf-8" });
    res.end("Unauthorized");
    return;
  }
  if (!match) {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("Not found");
    return;
  }
  const [, scoreId, file] = match as unknown as [string, string, string];

  if (req.method === "PUT") {
    const clientId = req.headers["x-bandcue-client-id"];
    if (!room.isDesktopAdapter(typeof clientId === "string" ? clientId : undefined)) {
      req.resume();
      res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
      res.end("Only a connected desktop adapter may upload scores.");
      return;
    }
    const encoding = String(req.headers["content-encoding"] ?? "identity").toLowerCase();
    if (encoding !== "gzip" && encoding !== "identity") {
      req.resume();
      res.writeHead(415, { "content-type": "text/plain; charset=utf-8" });
      res.end("Use gzip or no content encoding.");
      return;
    }
    const body = await readBody(req, scoreStore.maxUploadBytes);
    if (!body) {
      res.writeHead(413, { "content-type": "text/plain; charset=utf-8", connection: "close" });
      res.end("File too large.");
      return;
    }
    try {
      await scoreStore.put(scoreId, file, body, encoding === "gzip");
    } catch (error) {
      const status = error instanceof ScoreStoreError ? error.statusCode : 500;
      res.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
      res.end(error instanceof Error ? error.message : "Upload failed.");
      return;
    }
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { allow: "GET, HEAD, PUT" });
    res.end();
    return;
  }

  const stored = scoreStore.get(scoreId, file);
  if (!stored) {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("Not found");
    return;
  }
  const headers: Record<string, string | number> = {
    "content-type": stored.contentType,
    // The id is a hash of the score: these bytes never change under it.
    "cache-control": "private, max-age=31536000, immutable",
    vary: "accept-encoding",
    // An SVG opened on its own must not run anything it might contain.
    "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; img-src data:",
    "x-content-type-options": "nosniff"
  };
  const acceptsGzip = /\bgzip\b/i.test(String(req.headers["accept-encoding"] ?? ""));
  if (stored.gzip && !acceptsGzip) {
    const { readFile } = await import("node:fs/promises");
    const body = gunzipSync(await readFile(stored.path));
    res.writeHead(200, { ...headers, "content-length": body.length });
    res.end(req.method === "HEAD" ? undefined : body);
    return;
  }
  if (stored.gzip) {
    headers["content-encoding"] = "gzip";
  }
  res.writeHead(200, { ...headers, "content-length": stored.size });
  if (req.method === "HEAD") {
    res.end();
    return;
  }
  const stream = scoreStore.open(stored);
  stream.on("error", () => res.destroy());
  stream.pipe(res);
}

/**
 * `POST /api/score-imports?songId=&key=&revision=` stores a Guitar Pro file a
 * Songsterr extension fetched from one of the song's Songsterr pages and
 * records it on the song. Like score uploads, only a connected desktop adapter
 * may send one.
 */
async function handleScoreImportRequest(
  req: import("node:http").IncomingMessage,
  res: import("node:http").ServerResponse,
  url: URL
): Promise<void> {
  const reply = (status: number, body: Record<string, unknown>) => {
    res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(body));
  };
  const candidate = url.searchParams.get("token");
  if (!tokenMatches(candidate, ROOM_TOKEN) && !tokenMatches(candidate, HOST_TOKEN)) {
    req.resume();
    reply(401, { error: "Unauthorized" });
    return;
  }
  if (req.method !== "POST") {
    req.resume();
    res.writeHead(405, { allow: "POST" });
    res.end();
    return;
  }
  const clientId = req.headers["x-bandcue-client-id"];
  if (!room.isDesktopAdapter(typeof clientId === "string" ? clientId : undefined)) {
    req.resume();
    reply(403, { error: "Only a connected desktop adapter may import scores." });
    return;
  }
  const songId = url.searchParams.get("songId") ?? "";
  const key = url.searchParams.get("key") ?? "";
  if (!songId || !SONGSTERR_KEY_PATTERN.test(key)) {
    req.resume();
    reply(400, { error: "songId and a Songsterr key (s<digits>) are required." });
    return;
  }
  const body = await readBody(req, MAX_IMPORT_BYTES);
  if (!body) {
    res.writeHead(413, { "content-type": "application/json; charset=utf-8", connection: "close" });
    res.end(JSON.stringify({ error: "File too large." }));
    return;
  }
  if (!isGuitarProFile(body)) {
    reply(400, { error: "That is not a Guitar Pro file." });
    return;
  }
  const importId = importIdFor(body);
  try {
    await scoreStore.put(importId, "source.gp", body, false);
  } catch (error) {
    reply(error instanceof ScoreStoreError ? error.statusCode : 500, {
      error: error instanceof Error ? error.message : "Storing the import failed."
    });
    return;
  }
  const result = room.recordScoreImport(songId, key, importId, url.searchParams.get("revision") ?? undefined);
  if (!result.ok) {
    reply(409, { error: result.message });
    return;
  }
  reply(200, { importId, roles: result.roles });
}

function readBody(req: import("node:http").IncomingMessage, limit: number): Promise<Buffer | undefined> {
  return new Promise((resolvePromise, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        tooLarge = true;
        chunks.length = 0;
        return;
      }
      if (!tooLarge) {
        chunks.push(chunk);
      }
    });
    req.on("end", () => resolvePromise(tooLarge ? undefined : Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_WS_MESSAGE_BYTES });

function tokenMatches(candidate: string | null, token: string): boolean {
  if (typeof candidate !== "string") {
    return false;
  }
  const expected = Buffer.from(token);
  const provided = Buffer.from(candidate);
  return expected.length === provided.length && timingSafeEqual(expected, provided);
}

// Which connections carried the host token: only they may join as the host.
const hostSockets = new WeakSet<object>();

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url ?? "/", baseUrl);
  const candidate = url.searchParams.get("token");
  const isHostToken = tokenMatches(candidate, HOST_TOKEN);
  if (url.pathname !== "/ws" || !(isHostToken || tokenMatches(candidate, ROOM_TOKEN))) {
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
    if (isHostToken) {
      hostSockets.add(ws);
    }
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

  // ws emits 'error' for protocol violations (oversized payload, invalid UTF-8,
  // bad opcode). With no listener, Node turns that into an uncaught exception
  // and one malformed frame from any device would take the whole room down
  // mid-song. ws already closes the socket itself; the 'close' handler below
  // removes the client.
  socket.on("error", (error) => {
    console.warn(`WebSocket error from ${clientId ?? "unidentified client"}: ${error.message}`);
  });

  // Browsers answer server pings from the network stack even when the page's
  // timers are throttled (a backgrounded or fully covered host window is cut to
  // one timer wake-up a minute), so a pong is proof of life the idle sweep must
  // honor -- otherwise it evicts a perfectly connected host.
  socket.on("pong", () => {
    if (clientId) {
      room.markAlive(clientId);
    }
  });

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

    const client = room.addClient(socket, hello, undefined, { canHost: hostSockets.has(socket) });
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

let discoverySocket: ReturnType<typeof startDiscoveryResponder> | undefined;
let mdnsResponder: ReturnType<typeof startMdnsResponder> | undefined;

// Coordinator restarts happen mid-rehearsal (new Wi-Fi, config change). Close
// every client with a WebSocket close frame so devices show "coordinator shut
// down" immediately instead of waiting out their heartbeat timeout.
let shuttingDown = false;
function shutdown(signal: string): void {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  console.log(`Received ${signal}, shutting down...`);

  for (const client of wss.clients) {
    try {
      client.close(1001, "Coordinator shutting down");
    } catch {
      // Best effort; the process is exiting either way.
    }
  }
  room.stopLivenessSweep();
  roomStateWriter.flush();
  clearInterval(wsPingTimer);
  clearInterval(lanWatchTimer);
  try {
    discoverySocket?.close();
  } catch {
    // Socket may not be bound yet.
  }
  mdnsResponder?.destroy();
  wss.close();
  server.close(() => {
    process.exit(0);
  });
  // Close frames are queued synchronously above; don't let a stuck TCP peer
  // keep the process alive past this point.
  setTimeout(() => process.exit(0), 2_000).unref?.();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

// Last line of defense. Every client message is already fenced in its own
// try/catch, so anything reaching here comes from a timer or an I/O callback.
// Exiting would drop every device mid-song and lose the room's in-memory state;
// the room's state changes are small and self-contained, so logging and staying
// up is the better failure mode during a rehearsal.
process.on("uncaughtException", (error) => {
  console.error("Uncaught exception (coordinator keeps running):", error);
});
process.on("unhandledRejection", (reason) => {
  console.error("Unhandled promise rejection (coordinator keeps running):", reason);
});

// A listen failure (port already taken) is the one error that must end the
// process, with a message instead of a stack trace.
server.on("error", (error: NodeJS.ErrnoException) => {
  if (error.code === "EADDRINUSE") {
    console.error(`Port ${PORT} is already in use. Is another BandCue coordinator running? Set PORT to use a different one.`);
  } else {
    console.error("Coordinator HTTP server failed:", error);
  }
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  discoverySocket = startDiscoveryResponder({
    roomCode: ROOM_CODE,
    port: PORT,
    discoveryPort: DISCOVERY_PORT
  });
  mdnsResponder = startMdnsResponder({
    roomCode: ROOM_CODE,
    port: PORT,
    address: lanAddress
  });
  room.startLivenessSweep();
  console.log("BandCue coordinator running");
  console.log(`Host controls:      ${hostUrl}`);
  console.log(`Host on this machine: ${localHostUrl}`);
  console.log("  Keep the host link to yourself: it controls the room. Share the companion link or QR code.");
  console.log(`Companion room:     ${companionUrl}`);
  console.log(`Same-machine room:  ${localCompanionUrl}`);
  console.log(`Room code:          ${ROOM_CODE}`);
  console.log(restoredSongs
    ? `Setlist:            ${restoredSongs} song${restoredSongs === 1 ? "" : "s"} restored from ${ROOM_STATE_FILE}`
    : `Setlist:            saved to ${ROOM_STATE_FILE}`);
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
  console.log("MuseScore on this machine (BandCue Bridge plugin on port 4731):");
  console.log(`npm run dev:musescore -- --port ${PORT} --name "MuseScore laptop"`);
  console.log("Keyboard-only MuseScore control, without the plugin:");
  console.log(`npm run dev:musescore -- --port ${PORT} --name "MuseScore laptop" --no-bridge`);
});
