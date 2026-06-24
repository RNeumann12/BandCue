import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "../..");
const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string };
const version = packageJson.version;
const releaseRoot = join(root, "dist/release");
const bundleDir = join(releaseRoot, `bandcue-v${version}`);
const packageDir = join(bundleDir, "packages");
const releaseZip = join(releaseRoot, `bandcue-v${version}.zip`);
const skipAndroid = process.argv.includes("--skip-android");

run("npm", ["run", "generate:icons"]);
run("npm", ["run", "package:extension"]);
if (!skipAndroid) {
  run("npm", ["run", "build:android:release"]);
}

rmIfExists(bundleDir);
rmIfExists(releaseZip);
mkdirSync(packageDir, { recursive: true });

copyFiles([
  "BandCue Host.cmd",
  "BandCue Host - MuseScore Bridge.cmd",
  "CHANGELOG.md",
  "README.md",
  "package-lock.json",
  "package.json",
  "tsconfig.json",
  "vitest.config.ts"
]);
copyDirs(["assets", "docs", "scripts", "src", "web"]);

const extensionZip = join(root, "dist/packages", `bandcue-songsterr-extension-${version}.zip`);
if (!existsSync(extensionZip)) {
  throw new Error(`Extension package not found: ${extensionZip}`);
}
copyFileSync(extensionZip, join(packageDir, `bandcue-songsterr-extension-${version}.zip`));

const androidApk = join(root, "android/app/build/outputs/apk/release/app-release.apk");
if (existsSync(androidApk)) {
  copyFileSync(androidApk, join(packageDir, `bandcue-songsterr-${version}.apk`));
} else if (skipAndroid) {
  writeFileSync(
    join(packageDir, "ANDROID-APK-SKIPPED.txt"),
    "Android release APK was skipped for this package run. Run npm run build:android:release, then npm run package:release.\n",
    "utf8"
  );
} else {
  throw new Error(`Android release APK not found: ${androidApk}`);
}

writeFileSync(join(bundleDir, "PUBLIC-BETA-README.md"), releaseReadme(), "utf8");
writeFileSync(join(bundleDir, "SHA256SUMS.txt"), checksums(bundleDir), "utf8");
compressBundle();

console.log("");
console.log(`BandCue v${version} release folder: ${bundleDir}`);
console.log(`BandCue v${version} release zip:    ${releaseZip}`);
console.log(`Extension package:                  ${join(packageDir, `bandcue-songsterr-extension-${version}.zip`)}`);
console.log(`Android package:                    ${join(packageDir, `bandcue-songsterr-${version}.apk`)}`);

function run(command: string, args: string[]): void {
  const result = process.platform === "win32" && command === "npm"
    ? spawnSync(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", ["npm.cmd", ...args].map(quoteArg).join(" ")], {
      cwd: root,
      stdio: "inherit"
    })
    : spawnSync(command, args, {
      cwd: root,
      stdio: "inherit"
    });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with exit code ${result.status}`);
  }
}

function quoteArg(arg: string): string {
  return /[\s"]/u.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg;
}

function copyFiles(files: string[]): void {
  for (const file of files) {
    const source = join(root, file);
    const target = join(bundleDir, file);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(source, target);
  }
}

function copyDirs(dirs: string[]): void {
  for (const dir of dirs) {
    cpSync(join(root, dir), join(bundleDir, dir), {
      recursive: true,
      filter: (source) => !shouldSkipCopy(source)
    });
  }
}

function shouldSkipCopy(source: string): boolean {
  const normalized = source.replace(/\\/g, "/");
  return normalized.includes("/.gradle")
    || normalized.includes("/build/")
    || normalized.endsWith(".log");
}

function rmIfExists(path: string): void {
  if (existsSync(path)) {
    rmSync(path, { recursive: true, force: true });
  }
}

function checksums(baseDir: string): string {
  return walkFiles(baseDir)
    .filter((file) => !file.endsWith("SHA256SUMS.txt"))
    .map((file) => {
      const hash = createHash("sha256").update(readFileSync(file)).digest("hex");
      return `${hash}  ${relative(baseDir, file).replace(/\\/g, "/")}`;
    })
    .join("\n") + "\n";
}

function walkFiles(dir: string): string[] {
  return readdirSync(dir)
    .flatMap((name) => {
      const fullPath = join(dir, name);
      return statSync(fullPath).isDirectory() ? walkFiles(fullPath) : [fullPath];
    })
    .sort((a, b) => a.localeCompare(b));
}

function compressBundle(): void {
  const command = [
    `$ErrorActionPreference = "Stop";`,
    `Compress-Archive -Path "${bundleDir}\\*" -DestinationPath "${releaseZip}" -Force;`
  ].join(" ");
  const result = spawnSync("powershell.exe", ["-NoProfile", "-Command", command], {
    cwd: root,
    stdio: "inherit",
    windowsHide: true
  });
  if (result.status !== 0) {
    throw new Error(`Compress-Archive failed with exit code ${result.status}`);
  }
}

function releaseReadme(): string {
  return `# BandCue ${version} Public Beta

BandCue keeps browser, Android, and MuseScore players in sync on the same rehearsal Wi-Fi.
This public-beta package is local-first: no account and no cloud service are required.

## Host Setup

1. Install Node.js 20 or newer from https://nodejs.org/.
2. Double-click \`BandCue Host.cmd\`.
3. Keep the terminal window open while rehearsing.
4. The launcher opens the host controls in your browser when BandCue is ready.

For a MuseScore host, double-click \`BandCue Host - MuseScore Bridge.cmd\` instead.

## Band Member Setup

- Chrome or Edge Songsterr users install \`packages/bandcue-songsterr-extension-${version}.zip\` through the browser's extensions page.
- Android Songsterr users install \`packages/bandcue-songsterr-${version}.apk\` and enable notification access when prompted.
- Band members can join with the QR code, full room URL, room code, or host:port shown by the host.

## Troubleshooting

- If the launcher says Node.js is missing or too old, install Node.js 20+ and run it again.
- If dependencies are missing, the launcher runs \`npm install\` on first startup.
- If room-code discovery fails on a rehearsal network, use the host:port value from the host page.
- If Windows Firewall prompts for Node.js, allow private-network access for rehearsal Wi-Fi.
`;
}
