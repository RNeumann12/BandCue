// Smoke test for the *built* coordinator (dist/server/index.js), runnable on the
// oldest Node the project is deployed on (the Raspberry Pi runs Node 18).
//
//   npm run build && node scripts/smoke-coordinator.mjs
//
// Checks, against a throwaway room on a spare port:
//   1. HTTP answers /api/room with the room state;
//   2. a client can join over WebSocket and gets clock-sync replies;
//   3. a malformed (oversized) frame from one client does not take the
//      coordinator down -- the next client can still join.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const port = Number(process.env.SMOKE_PORT || 4799);
const token = "smoketoken";
const stateDir = mkdtempSync(join(tmpdir(), "bandcue-smoke-"));

const coordinator = spawn(process.execPath, ["dist/server/index.js"], {
  cwd: repoRoot,
  env: {
    ...process.env,
    PORT: String(port),
    BANDCUE_DISCOVERY_PORT: String(port + 1),
    BANDCUE_TOKEN: token,
    BANDCUE_ROOM_CODE: "5A0CE1",
    BANDCUE_STATE_FILE: join(stateDir, "room.json"),
    PUBLIC_HOST: "127.0.0.1"
  },
  stdio: ["ignore", "pipe", "pipe"]
});
let output = "";
coordinator.stdout.on("data", (chunk) => { output += chunk; });
coordinator.stderr.on("data", (chunk) => { output += chunk; });
let exited = false;
coordinator.on("exit", () => { exited = true; });

function fail(message) {
  console.error(`SMOKE FAILED: ${message}`);
  console.error("--- coordinator output ---");
  console.error(output);
  finish(1);
}

function finish(code) {
  if (!exited) {
    coordinator.kill();
  }
  rmSync(stateDir, { recursive: true, force: true });
  process.exit(code);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForHttp() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (exited) fail("coordinator exited during startup");
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/room`);
      if (response.ok) {
        const state = await response.json();
        if (state.type !== "roomState" || state.roomCode !== "5A0CE1") {
          fail(`unexpected /api/room payload: ${JSON.stringify(state).slice(0, 200)}`);
        }
        return;
      }
    } catch {
      // Not listening yet.
    }
    await sleep(250);
  }
  fail("coordinator never answered /api/room");
}

function joinRoom(deviceName) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${token}`);
    const timer = setTimeout(() => reject(new Error(`${deviceName}: no clockSyncResult within 5 s`)), 5000);
    socket.on("error", () => {});
    socket.on("open", () => {
      socket.send(JSON.stringify({ type: "clientHello", deviceName, role: "companion", capabilities: [] }));
      socket.send(JSON.stringify({ type: "clockSync", clientSentAt: Date.now() }));
    });
    socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.type === "clockSyncResult") {
        clearTimeout(timer);
        resolve(socket);
      }
    });
  });
}

try {
  await waitForHttp();
  console.log("ok: /api/room answers");

  const first = await joinRoom("Smoke A");
  console.log("ok: WebSocket join and clock sync");

  // 2 MB is over the coordinator's 1 MB frame limit: ws rejects it as a
  // protocol error. That used to be an unhandled 'error' event -- a crash.
  first.send("x".repeat(2 * 1024 * 1024));
  await sleep(1000);
  if (exited) fail("an oversized frame from one client crashed the coordinator");

  const second = await joinRoom("Smoke B");
  console.log("ok: coordinator survives a malformed frame and still accepts clients");
  second.close();
  finish(0);
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
