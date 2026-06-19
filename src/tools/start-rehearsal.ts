import { spawn, type ChildProcess } from "node:child_process";

const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const museScoreName =
  process.env.BANDCUE_MUSESCORE_NAME || process.env.PLAYSYNC_MUSESCORE_NAME || "MuseScore laptop";
const extraMuseScoreArgs = splitArgs(
  process.env.BANDCUE_MUSESCORE_ARGS || process.env.PLAYSYNC_MUSESCORE_ARGS || ""
);
const coordinatorPort = process.env.BANDCUE_PORT || process.env.PORT || "4173";

let coordinator: ChildProcess | undefined;
let museScore: ChildProcess | undefined;

coordinator = spawn(npmCommand, ["run", "dev"], {
  stdio: ["inherit", "pipe", "pipe"],
  shell: false
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
  console.log("Starting MuseScore helper for this machine...");
  museScore = spawn(npmCommand, [
    "run",
    "dev:musescore",
    "--",
    "--port",
    coordinatorPort,
    "--name",
    museScoreName,
    ...extraMuseScoreArgs
  ], {
    stdio: "inherit",
    shell: false
  });
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
