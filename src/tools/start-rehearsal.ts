import { bridgePortFromSetting, DEFAULT_BRIDGE_PORT } from "../adapters/musescore-bridge-setting.js";
import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";


const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const museScoreName =
  process.env.BANDCUE_MUSESCORE_NAME || process.env.PLAYSYNC_MUSESCORE_NAME || "MuseScore laptop";
const extraMuseScoreArgs = splitArgs(
  process.env.BANDCUE_MUSESCORE_ARGS || process.env.PLAYSYNC_MUSESCORE_ARGS || ""
);
const coordinatorPort = process.env.BANDCUE_PORT || process.env.PORT || "4173";
// Pin the locally-launched MuseScore helper to this machine's coordinator. The
// helper starts before the coordinator's HTTP is listening, so a bare port
// locator's 127.0.0.1 probe fails and discovery falls through to the LAN scan --
// which can attach the helper to a *different* BandCue room running on another
// device. A host:port locator keeps it on localhost (and simply retries until
// the coordinator is up) instead of roaming the network. Override with
// BANDCUE_MUSESCORE_ROOM when you really want it to join a remote room.
const museScoreRoom =
  process.env.BANDCUE_MUSESCORE_ROOM || process.env.PLAYSYNC_MUSESCORE_ROOM || `127.0.0.1:${coordinatorPort}`;

// Bridge mode (the default): the MuseScore helper drives MuseScore through the
// BandCue Bridge plugin. `--no-musescore-bridge` / BANDCUE_MUSESCORE_BRIDGE=0
// falls back to keystrokes. When enabled, the MuseScore helper
// starts with `--bridge-port`, and we remind the user to keep the Songsterr
// extension from auto-opening tabs on this machine.
const bridgePort = resolveBridgePort(process.argv.slice(2));

// Pin the LAN IP advertised in the room URL/QR from one place. Use this when
// auto-detection picks the wrong interface (multiple physical LANs, or a virtual
// adapter that slips through): `npm run dev:all -- --public-host 192.168.178.38`,
// `--public-host=192.168.178.38`, or the BANDCUE_PUBLIC_HOST env var. It flows
// to the coordinator as PUBLIC_HOST, which src/server/index.ts honors.
const publicHost = resolvePublicHost(process.argv.slice(2));

let coordinator: ChildProcess | undefined;
let museScore: ChildProcess | undefined;

if (publicHost) {
  console.log(`Pinning advertised LAN address to ${publicHost} (PUBLIC_HOST).`);
}

// Set once the user asks BandCue to stop; after that an exiting child is the
// shutdown, not a crash, and is never restarted.
let stopping = false;

// A crashed child is restarted after a short pause: a coordinator or helper
// that dies mid-rehearsal must not end the rehearsal. Every device reconnects
// by itself and the host page republishes the setlist. A child that keeps
// dying right away (bad arguments, port taken) is given up on instead of being
// restarted forever.
const RESTART_DELAY_MS = 2000;
const CRASH_WINDOW_MS = 60_000;
const MAX_CRASHES_PER_WINDOW = 5;

function restartPolicy(label: string, start: () => void): (code: number | null) => void {
  const crashes: number[] = [];
  return (code) => {
    if (stopping) {
      return;
    }
    const now = Date.now();
    crashes.push(now);
    while (crashes.length && now - crashes[0]! > CRASH_WINDOW_MS) {
      crashes.shift();
    }
    if (crashes.length > MAX_CRASHES_PER_WINDOW) {
      console.error(`${label} exited ${crashes.length} times within a minute; not restarting it again.`);
      if (label === "Coordinator") {
        stopAll();
        process.exitCode = code ?? 1;
      }
      return;
    }
    console.error(`${label} exited unexpectedly (code ${code ?? "none"}); restarting in ${RESTART_DELAY_MS / 1000}s...`);
    setTimeout(() => {
      if (!stopping) {
        start();
      }
    }, RESTART_DELAY_MS);
  };
}

const onCoordinatorExit = restartPolicy("Coordinator", startCoordinator);
const onMuseScoreExit = restartPolicy("MuseScore helper", startMuseScore);

startCoordinator();
startMuseScore();

process.on("SIGINT", stopAll);
process.on("SIGTERM", stopAll);

function startCoordinator(): void {
  const child = spawnNpm(["run", "dev"], {
    stdio: ["inherit", "pipe", "pipe"],
    env: publicHost ? { ...process.env, PUBLIC_HOST: publicHost } : process.env
  });
  coordinator = child;
  child.stdout?.on("data", (chunk) => {
    process.stdout.write(chunk.toString());
  });
  child.stderr?.on("data", (chunk) => process.stderr.write(chunk));
  child.on("exit", (code) => {
    if (stopping) {
      if (museScore && !museScore.killed) {
        museScore.kill();
      }
      process.exitCode = code ?? 0;
      return;
    }
    onCoordinatorExit(code);
  });
}

function startMuseScore(): void {
  console.log("");
  if (bridgePort) {
    console.log(`Starting MuseScore helper for this machine (BandCue Bridge on 127.0.0.1:${bridgePort})...`);
  } else {
    console.log("Starting MuseScore helper for this machine (keyboard control, no BandCue Bridge)...");
  }
  console.log("If this machine plays from MuseScore, tick \"Don't auto-open Songsterr tabs\" in the");
  console.log("Songsterr extension here so it does not open Songsterr tabs during songs.");

  // The helper runs the bridge by default too, so "off" has to be said.
  const bridgeArgs = bridgePort ? ["--bridge-port", bridgePort] : ["--no-bridge"];
  museScore = spawnNpm([
    "run",
    "dev:musescore",
    "--",
    "--room",
    museScoreRoom,
    "--port",
    coordinatorPort,
    "--name",
    museScoreName,
    ...bridgeArgs,
    ...extraMuseScoreArgs
  ], {
    stdio: "inherit"
  });
  museScore.on("exit", (code) => onMuseScoreExit(code));
}

// Spawns npm in a cross-platform safe way. On Windows, npm is `npm.cmd`, and
// since Node 18.20/20.12/22 (CVE-2024-27980) spawning a `.cmd` file requires a
// shell — otherwise `spawn` throws EINVAL. When running through a shell we must
// also quote arguments ourselves, since args containing spaces (e.g. the
// MuseScore name) would otherwise be split into separate tokens.
function spawnNpm(
  args: string[],
  options: { stdio: SpawnOptions["stdio"]; env?: SpawnOptions["env"] }
): ChildProcess {
  const useShell = process.platform === "win32";
  const finalArgs = useShell ? args.map(quoteArg) : args;
  return spawn(npmCommand, finalArgs, {
    stdio: options.stdio,
    env: options.env,
    shell: useShell
  });
}

function quoteArg(arg: string): string {
  return /[\s"]/.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg;
}

// Returns the bridge port to use, or "" when bridge mode is off. Bridge mode
// is the default (port 4731). `--musescore-bridge 5050` / `=5050` picks another
// port, `--no-musescore-bridge` or BANDCUE_MUSESCORE_BRIDGE=0 switches to
// keyboard-only control.
function resolveBridgePort(argv: string[]): string {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--no-musescore-bridge") {
      return "";
    }
    if (arg === "--musescore-bridge") {
      return normalizeBridgePort(argv[index + 1]) || String(DEFAULT_BRIDGE_PORT);
    }
    if (arg?.startsWith("--musescore-bridge=")) {
      const value = arg.slice("--musescore-bridge=".length);
      return value ? String(bridgePortFromSetting(value) ?? "") : String(DEFAULT_BRIDGE_PORT);
    }
  }

  return String(bridgePortFromSetting(process.env.BANDCUE_MUSESCORE_BRIDGE) ?? "");
}

// Resolves the LAN IP/host to advertise, or "" when unset. Accepts
// `--public-host 192.168.178.38`, `--public-host=192.168.178.38`, or the
// BANDCUE_PUBLIC_HOST env var.
function resolvePublicHost(argv: string[]): string {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--public-host") {
      return (argv[index + 1] ?? "").trim();
    }
    if (arg?.startsWith("--public-host=")) {
      return arg.slice("--public-host=".length).trim();
    }
  }

  return process.env.BANDCUE_PUBLIC_HOST?.trim() ?? "";
}

function normalizeBridgePort(value: string | undefined): string {
  if (!value) {
    return "";
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 && parsed <= 65535 ? String(parsed) : "";
}

function stopAll(): void {
  stopping = true;
  if (museScore && !museScore.killed) {
    museScore.kill();
  }
  if (coordinator && !coordinator.killed) {
    coordinator.kill();
  }
}

function splitArgs(value: string): string[] {
  return value.match(/"[^"]+"|'[^']+'|\S+/g)?.map((part) =>
    part.replace(/^["']|["']$/g, "")
  ) ?? [];
}
