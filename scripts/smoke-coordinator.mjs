// Smoke test for the *built* coordinator (dist/server/index.js), runnable on the
// oldest Node the project is deployed on (the Raspberry Pi runs Node 18).
//
//   npm run build && node scripts/smoke-coordinator.mjs
//
// Checks, against a throwaway room on a spare port:
//   1. HTTP answers /api/room with the room state;
//   2. a client can join over WebSocket and gets clock-sync replies;
//   3. a malformed (oversized) frame from one client does not take the
//      coordinator down -- the next client can still join;
//   4. only the host token can host: the join token joins as a companion;
//   5. the setlist and current song survive the coordinator being killed
//      (no clean shutdown, like a Pi losing power) and started again.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const port = Number(process.env.SMOKE_PORT || 4799);
const token = "smoketoken";
const hostToken = "smokehosttoken";
const stateDir = mkdtempSync(join(tmpdir(), "bandcue-smoke-"));

let coordinator;
let output = "";
let exited = false;

function startCoordinator() {
  exited = false;
  coordinator = spawn(process.execPath, ["dist/server/index.js"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PORT: String(port),
      BANDCUE_DISCOVERY_PORT: String(port + 1),
      BANDCUE_TOKEN: token,
      BANDCUE_HOST_TOKEN: hostToken,
      BANDCUE_ROOM_CODE: "5A0CE1",
      BANDCUE_STATE_FILE: join(stateDir, "room.json"),
      PUBLIC_HOST: "127.0.0.1"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  coordinator.stdout.on("data", (chunk) => { output += chunk; });
  coordinator.stderr.on("data", (chunk) => { output += chunk; });
  coordinator.on("exit", () => { exited = true; });
}

async function killCoordinator() {
  // On Windows this is TerminateProcess: no signal handler, no flush -- the
  // same as pulling the plug.
  coordinator.kill("SIGKILL");
  for (let attempt = 0; attempt < 40 && !exited; attempt += 1) {
    await sleep(100);
  }
}

class SmokeFailure extends Error {}

function fail(message) {
  throw new SmokeFailure(message);
}

// Ends the run by cleaning up rather than with process.exit(): exiting while
// Node is still closing fetch's keep-alive sockets aborts the process on
// Windows (a libuv assertion), which would turn a pass into a crash.
async function finish(code) {
  if (coordinator && !exited) {
    coordinator.kill();
    for (let attempt = 0; attempt < 40 && !exited; attempt += 1) {
      await sleep(100);
    }
  }
  rmSync(stateDir, { recursive: true, force: true });
  process.exitCode = code;
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

function joinRoom(deviceName, { role = "companion", withToken = token, onHello } = {}) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${withToken}`);
    const timer = setTimeout(() => reject(new Error(`${deviceName}: no clockSyncResult within 5 s`)), 5000);
    socket.on("error", () => {});
    socket.on("open", () => {
      socket.send(JSON.stringify({ type: "clientHello", deviceName, role, capabilities: [] }));
      socket.send(JSON.stringify({ type: "clockSync", clientSentAt: Date.now() }));
    });
    socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.type === "serverHello") {
        onHello?.(message);
      }
      if (message.type === "clockSyncResult") {
        clearTimeout(timer);
        resolve(socket);
      }
    });
  });
}

async function roomState() {
  return (await fetch(`http://127.0.0.1:${port}/api/room`)).json();
}

try {
  startCoordinator();
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

  let grantedRole;
  const pretender = await joinRoom("Smoke pretender", { role: "host", onHello: (hello) => { grantedRole = hello.role; } });
  if (grantedRole !== "companion") fail(`the join token was allowed to host (role ${grantedRole})`);
  pretender.close();
  const host = await joinRoom("Smoke host", { role: "host", withToken: hostToken, onHello: (hello) => { grantedRole = hello.role; } });
  if (grantedRole !== "host") fail(`the host token was not allowed to host (role ${grantedRole})`);
  console.log("ok: only the host token can host");

  const songs = [
    { id: "s1", title: "Smoke One", sourceType: "other" },
    { id: "s2", title: "Smoke Two", sourceType: "musescore", museScoreSource: "Two.mscz", tempoPercent: 90 }
  ];
  host.send(JSON.stringify({ type: "setlistUpdate", songs, updatedAt: Date.now() }));
  host.send(JSON.stringify({ type: "currentSongUpdate", song: songs[1], index: 2, total: 2, updatedAt: Date.now() }));
  await sleep(1200);
  host.close();
  await killCoordinator();
  if (!exited) fail("the coordinator did not stop");

  startCoordinator();
  await waitForHttp();
  const restored = await roomState();
  const titles = restored.setlist?.songs?.map((song) => song.title).join(", ");
  if (titles !== "Smoke One, Smoke Two") fail(`setlist after a restart: ${titles || "empty"}`);
  if (restored.currentSong?.song?.title !== "Smoke Two" || restored.currentSong?.song?.tempoPercent !== 90) {
    fail(`current song after a restart: ${JSON.stringify(restored.currentSong)}`);
  }
  console.log("ok: the setlist and current song survive the coordinator being killed");
  await finish(0);
} catch (error) {
  console.error(`SMOKE FAILED: ${error instanceof Error ? error.message : String(error)}`);
  console.error("--- coordinator output ---");
  console.error(output);
  await finish(1);
}
