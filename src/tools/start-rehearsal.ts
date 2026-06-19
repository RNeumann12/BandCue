import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";

const DEFAULT_BRIDGE_PORT = "4731";

const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const museScoreName =
  process.env.BANDCUE_MUSESCORE_NAME || process.env.PLAYSYNC_MUSESCORE_NAME || "MuseScore laptop";
const extraMuseScoreArgs = splitArgs(
  process.env.BANDCUE_MUSESCORE_ARGS || process.env.PLAYSYNC_MUSESCORE_ARGS || ""
);
const coordinatorPort = process.env.BANDCUE_PORT || process.env.PORT || "4173";

// Bridge mode: run this host on the MuseScore bridge API instead of acting as a
// Songsterr player. Enable with `npm run dev:all -- --musescore-bridge [port]`
// or the BANDCUE_MUSESCORE_BRIDGE env var. When enabled, the MuseScore helper
// starts with `--bridge-port`, and we remind the user to keep the Songsterr
// extension from auto-opening tabs on this machine.
const bridgePort = resolveBridgePort(process.argv.slice(2));

let coordinator: ChildProcess | undefined;
let museScore: ChildProcess | undefined;

coordinator = spawnNpm(["run", "dev"], {
  stdio: ["inherit", "pipe", "pipe"]
});

startMuseScore();

coordinator.stdout?.on("data", (chunk) => {
  process.stdout.write(chunk.toString());
});

coordinator.stderr?.on("data", (chunk) => process.stderr.write(chunk));
coordinator.on("exit", (code) => {
  if (museScore && !museScore.killed) {
    museScore.kill();
  }
  process.exitCode = code ?? 0;
});

process.on("SIGINT", stopAll);
process.on("SIGTERM", stopAll);

function startMuseScore(): void {
  console.log("");
  if (bridgePort) {
    console.log(`Starting MuseScore helper in bridge mode on http://127.0.0.1:${bridgePort} ...`);
    console.log("This host will control MuseScore through the bridge API rather than Songsterr.");
    console.log("Keep the Songsterr extension disconnected (or its auto-open toggle off) on this");
    console.log("machine so it does not pop open Songsterr tabs while you play from MuseScore.");
  } else {
    console.log("Starting MuseScore helper for this machine...");
  }

  const bridgeArgs = bridgePort ? ["--bridge-port", bridgePort] : [];
  museScore = spawnNpm([
    "run",
    "dev:musescore",
    "--",
    "--port",
    coordinatorPort,
    "--name",
    museScoreName,
    ...bridgeArgs,
    ...extraMuseScoreArgs
  ], {
    stdio: "inherit"
  });
}

// Spawns npm in a cross-platform safe way. On Windows, npm is `npm.cmd`, and
// since Node 18.20/20.12/22 (CVE-2024-27980) spawning a `.cmd` file requires a
// shell — otherwise `spawn` throws EINVAL. When running through a shell we must
// also quote arguments ourselves, since args containing spaces (e.g. the
// MuseScore name) would otherwise be split into separate tokens.
function spawnNpm(args: string[], options: { stdio: SpawnOptions["stdio"] }): ChildProcess {
  const useShell = process.platform === "win32";
  const finalArgs = useShell ? args.map(quoteArg) : args;
  return spawn(npmCommand, finalArgs, {
    stdio: options.stdio,
    shell: useShell
  });
}

function quoteArg(arg: string): string {
  return /[\s"]/.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg;
}

// Returns the bridge port to use, or "" when bridge mode is off. Accepts
// `--musescore-bridge` (default port), `--musescore-bridge 4731`,
// `--musescore-bridge=4731`, or the BANDCUE_MUSESCORE_BRIDGE env var (a port
// number, or a truthy value such as "1"/"true" for the default port).
function resolveBridgePort(argv: string[]): string {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--musescore-bridge") {
      return normalizeBridgePort(argv[index + 1]) || DEFAULT_BRIDGE_PORT;
    }
    if (arg?.startsWith("--musescore-bridge=")) {
      return normalizeBridgePort(arg.slice("--musescore-bridge=".length)) || DEFAULT_BRIDGE_PORT;
    }
  }

  const fromEnv = process.env.BANDCUE_MUSESCORE_BRIDGE?.trim();
  if (!fromEnv) {
    return "";
  }
  if (/^(0|false|no|off)$/i.test(fromEnv)) {
    return "";
  }
  return normalizeBridgePort(fromEnv) || DEFAULT_BRIDGE_PORT;
}

function normalizeBridgePort(value: string | undefined): string {
  if (!value) {
    return "";
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 && parsed <= 65535 ? String(parsed) : "";
}

function stopAll(): void {
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
