import { createServer } from "node:http";
import { networkInterfaces } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import QRCode from "qrcode";
import { WebSocketServer } from "ws";
import type { ClientHello, ClientMessage } from "../shared/protocol.js";
import { RoomController } from "./room.js";
import { startDiscoveryResponder } from "./discovery.js";

const PORT = Number(process.env.PORT ?? 4173);
const HOST = process.env.HOST ?? "0.0.0.0";
const DISCOVERY_PORT = Number(process.env.BANDCUE_DISCOVERY_PORT ?? PORT);
const ROOM_TOKEN = process.env.BANDCUE_TOKEN ?? process.env.PLAYSYNC_TOKEN ?? randomBytes(9).toString("base64url");
const ROOM_CODE = randomBytes(3).toString("hex").toUpperCase();
const __dirname = dirname(fileURLToPath(import.meta.url));
const publicDir = join(__dirname, "../../web");

function getLanAddress(): string {
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === "IPv4" && !address.internal) {
        return address.address;
      }
    }
  }

  return "127.0.0.1";
}

const lanAddress = process.env.PUBLIC_HOST ?? getLanAddress();
const baseUrl = `http://${lanAddress}:${PORT}`;
const localBaseUrl = `http://127.0.0.1:${PORT}`;
const companionUrl = `${baseUrl}/?token=${encodeURIComponent(ROOM_TOKEN)}`;
const hostUrl = `${baseUrl}/host?token=${encodeURIComponent(ROOM_TOKEN)}`;
const localCompanionUrl = `${localBaseUrl}/?token=${encodeURIComponent(ROOM_TOKEN)}`;
const room = new RoomController(ROOM_CODE, companionUrl, hostUrl);

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
  if (!resolved.startsWith(publicDir)) {
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

const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url ?? "/", baseUrl);
  if (url.pathname !== "/ws" || url.searchParams.get("token") !== ROOM_TOKEN) {
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit("connection", ws);
  });
});

wss.on("connection", (socket) => {
  let clientId: string | undefined;

  socket.once("message", (raw) => {
    const hello = safeParse(raw.toString()) as ClientHello | undefined;
    if (!hello || hello.type !== "clientHello") {
      socket.close(1008, "Expected clientHello");
      return;
    }

    const client = room.addClient(socket, hello);
    clientId = client.id;

    socket.on("message", (messageRaw) => {
      const message = safeParse(messageRaw.toString()) as ClientMessage | undefined;
      if (!message || !clientId) {
        return;
      }
      room.handleMessage(clientId, message);
    });
  });

  socket.on("close", () => {
    if (clientId) {
      room.removeClient(clientId);
    }
  });
});

function safeParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

server.listen(PORT, HOST, () => {
  startDiscoveryResponder({
    roomCode: ROOM_CODE,
    port: PORT,
    discoveryPort: DISCOVERY_PORT
  });
  console.log("BandCue coordinator running");
  console.log(`Host controls:      ${hostUrl}`);
  console.log(`Companion room:     ${companionUrl}`);
  console.log(`Same-machine room:  ${localCompanionUrl}`);
  console.log(`Room code:          ${ROOM_CODE}`);
  console.log(`WebSocket endpoint: ws://${lanAddress}:${PORT}/ws?token=${ROOM_TOKEN}`);
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
