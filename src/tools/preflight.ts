import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "../..");

let failed = false;

check("Node.js 20+", () => {
  const major = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10);
  return major >= 20 ? `found ${process.version}` : `found ${process.version}`;
}, () => Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10) >= 20);

check("Dependencies installed", () => "node_modules present", () => existsSync(join(root, "node_modules")));
check("Songsterr extension manifest", () => "extension/songsterr/manifest.json present", () =>
  existsSync(join(root, "extension/songsterr/manifest.json"))
);
check("Web host files", () => "web/index.html present", () => existsSync(join(root, "web/index.html")));

const museScore = spawnSync("powershell.exe", [
  "-NoProfile",
  "-Command",
  "Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.ProcessName -match 'MuseScore|mscore' } | Select-Object -First 1 | ForEach-Object ProcessName"
], { encoding: "utf8", windowsHide: true });

if (museScore.status === 0 && museScore.stdout.trim()) {
  pass("MuseScore window", `found ${museScore.stdout.trim()}`);
} else {
  warn("MuseScore window", "not found; start MuseScore before using the desktop helper");
}

if (failed) {
  process.exitCode = 1;
}

function check(name: string, message: () => string, ok: () => boolean): void {
  if (ok()) {
    pass(name, message());
  } else {
    fail(name, message());
  }
}

function pass(name: string, message: string): void {
  console.log(`[ok] ${name}: ${message}`);
}

function warn(name: string, message: string): void {
  console.warn(`[warn] ${name}: ${message}`);
}

function fail(name: string, message: string): void {
  failed = true;
  console.error(`[fail] ${name}: ${message}`);
}
