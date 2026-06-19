import { existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "../..");
const extensionDir = join(root, "extension/songsterr");
const outDir = join(root, "dist/packages");
const outFile = join(outDir, "bandcue-songsterr-extension.zip");

if (!existsSync(extensionDir)) {
  throw new Error(`Extension directory not found: ${extensionDir}`);
}

mkdirSync(outDir, { recursive: true });
if (existsSync(outFile)) {
  rmSync(outFile);
}

const command = [
  "Compress-Archive",
  "-Path",
  `"${extensionDir}\\*"`,
  "-DestinationPath",
  `"${outFile}"`,
  "-Force"
].join(" ");

const result = spawnSync("powershell.exe", ["-NoProfile", "-Command", command], {
  encoding: "utf8",
  windowsHide: true
});

if (result.status !== 0) {
  console.error(result.stderr || result.stdout);
  process.exit(result.status ?? 1);
}

console.log(`Packaged Songsterr extension: ${outFile}`);
