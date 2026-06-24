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

// Package every top-level item (recursing into any subfolders) except test
// files, which live beside the source but must not ship in the extension.
const command = [
  `$staging = Join-Path "${outDir}" "songsterr-extension-staging";`,
  `if (Test-Path $staging) { Remove-Item -LiteralPath $staging -Recurse -Force; }`,
  `New-Item -ItemType Directory -Path $staging | Out-Null;`,
  `Get-ChildItem -Path "${extensionDir}" -Force -Exclude "*.test.*" | Copy-Item -Destination $staging -Recurse -Force;`,
  `Compress-Archive -Path "$staging\\*" -DestinationPath "${outFile}" -Force;`,
  `Remove-Item -LiteralPath $staging -Recurse -Force;`
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
