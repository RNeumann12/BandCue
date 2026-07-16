import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "../..");
const extensionDir = join(root, "extension/songsterr");
const outDir = join(root, "dist/packages");
const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version as string;
const outFile = join(outDir, "bandcue-songsterr-extension.zip");
const versionedOutFile = join(outDir, `bandcue-songsterr-extension-${version}.zip`);

if (!existsSync(extensionDir)) {
  throw new Error(`Extension directory not found: ${extensionDir}`);
}

mkdirSync(outDir, { recursive: true });
rmIfExists(outFile);
rmIfExists(versionedOutFile);

// Exclude dev-only files: tests, the per-context type-check configs, and
// ambient type declarations. None of them are referenced by the manifest.
const files = walkFiles(extensionDir)
  .filter((file) => !/\.test\.|tsconfig[^\\/]*\.json$|\.d\.ts$/.test(file))
  .map((file) => ({
    absolutePath: file,
    zipPath: relative(extensionDir, file).replace(/\\/g, "/"),
    contents: readFileSync(file)
  }));

const zip = createZip(files);
writeFileSync(outFile, zip);
writeFileSync(versionedOutFile, zip);

console.log(`Packaged Songsterr extension: ${outFile}`);
console.log(`Versioned Songsterr extension: ${versionedOutFile}`);

function rmIfExists(path: string): void {
  if (existsSync(path)) {
    rmSync(path, { force: true });
  }
}

function walkFiles(dir: string): string[] {
  return readdirSync(dir)
    .flatMap((name) => {
      const fullPath = join(dir, name);
      return statSync(fullPath).isDirectory() ? walkFiles(fullPath) : [fullPath];
    })
    .sort((a, b) => a.localeCompare(b));
}

function createZip(files: Array<{ zipPath: string; contents: Buffer }>): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;
  const now = new Date();
  const dos = toDosDateTime(now);

  for (const file of files) {
    const name = Buffer.from(file.zipPath, "utf8");
    const crc = crc32(file.contents);
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0, 6);
    localHeader.writeUInt16LE(0, 8);
    localHeader.writeUInt16LE(dos.time, 10);
    localHeader.writeUInt16LE(dos.date, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(file.contents.length, 18);
    localHeader.writeUInt32LE(file.contents.length, 22);
    localHeader.writeUInt16LE(name.length, 26);
    localHeader.writeUInt16LE(0, 28);

    localParts.push(localHeader, name, file.contents);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0, 8);
    centralHeader.writeUInt16LE(0, 10);
    centralHeader.writeUInt16LE(dos.time, 12);
    centralHeader.writeUInt16LE(dos.date, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(file.contents.length, 20);
    centralHeader.writeUInt32LE(file.contents.length, 24);
    centralHeader.writeUInt16LE(name.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset, 42);
    centralParts.push(centralHeader, name);

    offset += localHeader.length + name.length + file.contents.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, centralDirectory, end]);
}

function toDosDateTime(date: Date): { date: number; time: number } {
  const year = Math.max(1980, date.getFullYear());
  return {
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2)
  };
}

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let index = 0; index < 8; index += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}
