import { deflateRawSync, inflateRawSync } from "node:zlib";

// A MuseScore score saved in continuous view ("line" layout) exports as one
// page several metres wide: unreadable on a tablet, and an image that size can
// exhaust an iPad's memory. The score view wants pages, so the exporter works on
// a copy of the .mscz whose score file asks for page layout. An .mscz is a plain
// zip; this rewrites the one .mscx entry and copies every other entry byte for
// byte, so nothing else about the score changes.

const LOCAL_HEADER_SIGNATURE = 0x04034b50;
const CENTRAL_HEADER_SIGNATURE = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;
const METHOD_STORED = 0;
const METHOD_DEFLATE = 8;
const FLAG_DATA_DESCRIPTOR = 0x0008;

interface ZipEntry {
  name: string;
  nameBytes: Buffer;
  method: number;
  flags: number;
  crc32: number;
  compressedSize: number;
  uncompressedSize: number;
  modTime: number;
  modDate: number;
  versionNeeded: number;
  externalAttributes: number;
  data: Buffer;
}

/**
 * Returns a copy of the score that lays out in pages, or undefined when the
 * score already does (or is not a zip this can read, in which case MuseScore
 * gets the original file and exports whatever layout it was saved in).
 */
export function forcePageLayout(mscz: Buffer): Buffer | undefined {
  return rewriteZipText(mscz, (name) => /\.mscx$/i.test(name) && !name.includes("/"), removeNonPageLayout);
}

/**
 * Rewrites the text entries `select` picks; returns the new archive, or
 * undefined when nothing changed or the archive cannot be read.
 */
export function rewriteZipText(
  zip: Buffer,
  select: (name: string) => boolean,
  transform: (text: string) => string
): Buffer | undefined {
  let entries: ZipEntry[];
  try {
    entries = readZipEntries(zip);
  } catch {
    return undefined;
  }

  let changed = false;
  for (const entry of entries) {
    if (!select(entry.name)) {
      continue;
    }
    const text = entryContent(entry).toString("utf8");
    const next = transform(text);
    if (next === text) {
      continue;
    }
    replaceEntryContent(entry, Buffer.from(next, "utf8"));
    changed = true;
  }

  return changed ? writeZip(entries) : undefined;
}

/** Drops a `<layoutMode>` other than page; MuseScore's default is page layout. */
export function removeNonPageLayout(xml: string): string {
  return xml.replace(/[ \t]*<layoutMode>\s*(?!page\s*<)[^<]*<\/layoutMode>\r?\n?/g, "");
}

export function readZipEntries(zip: Buffer): ZipEntry[] {
  const endOffset = findEndOfCentralDirectory(zip);
  const entryCount = zip.readUInt16LE(endOffset + 10);
  let offset = zip.readUInt32LE(endOffset + 16);
  const entries: ZipEntry[] = [];

  for (let index = 0; index < entryCount; index += 1) {
    if (zip.readUInt32LE(offset) !== CENTRAL_HEADER_SIGNATURE) {
      throw new Error("Corrupt zip central directory");
    }
    const flags = zip.readUInt16LE(offset + 8);
    const method = zip.readUInt16LE(offset + 10);
    const nameLength = zip.readUInt16LE(offset + 28);
    const extraLength = zip.readUInt16LE(offset + 30);
    const commentLength = zip.readUInt16LE(offset + 32);
    const compressedSize = zip.readUInt32LE(offset + 20);
    const localOffset = zip.readUInt32LE(offset + 42);
    if (compressedSize === 0xffffffff || localOffset === 0xffffffff) {
      throw new Error("Zip64 archives are not supported");
    }
    const nameBytes = Buffer.from(zip.subarray(offset + 46, offset + 46 + nameLength));

    if (zip.readUInt32LE(localOffset) !== LOCAL_HEADER_SIGNATURE) {
      throw new Error("Corrupt zip local header");
    }
    const localNameLength = zip.readUInt16LE(localOffset + 26);
    const localExtraLength = zip.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;

    entries.push({
      name: nameBytes.toString("utf8"),
      nameBytes,
      method,
      flags,
      crc32: zip.readUInt32LE(offset + 16),
      compressedSize,
      uncompressedSize: zip.readUInt32LE(offset + 24),
      modTime: zip.readUInt16LE(offset + 12),
      modDate: zip.readUInt16LE(offset + 14),
      versionNeeded: zip.readUInt16LE(offset + 6),
      externalAttributes: zip.readUInt32LE(offset + 38),
      data: Buffer.from(zip.subarray(dataStart, dataStart + compressedSize))
    });
    offset += 46 + nameLength + extraLength + commentLength;
  }

  return entries;
}

export function entryContent(entry: Pick<ZipEntry, "method" | "data">): Buffer {
  if (entry.method === METHOD_STORED) {
    return entry.data;
  }
  if (entry.method === METHOD_DEFLATE) {
    return inflateRawSync(entry.data);
  }
  throw new Error(`Unsupported zip compression method ${entry.method}`);
}

function replaceEntryContent(entry: ZipEntry, content: Buffer): void {
  entry.method = METHOD_DEFLATE;
  entry.data = deflateRawSync(content);
  entry.crc32 = crc32(content);
  entry.compressedSize = entry.data.length;
  entry.uncompressedSize = content.length;
  entry.versionNeeded = Math.max(entry.versionNeeded, 20);
}

function writeZip(entries: ZipEntry[]): Buffer {
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    // Sizes and CRC are written up front, so a data descriptor never follows.
    const flags = entry.flags & ~FLAG_DATA_DESCRIPTOR;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL_HEADER_SIGNATURE, 0);
    local.writeUInt16LE(entry.versionNeeded, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(entry.method, 8);
    local.writeUInt16LE(entry.modTime, 10);
    local.writeUInt16LE(entry.modDate, 12);
    local.writeUInt32LE(entry.crc32 >>> 0, 14);
    local.writeUInt32LE(entry.compressedSize, 18);
    local.writeUInt32LE(entry.uncompressedSize, 22);
    local.writeUInt16LE(entry.nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, entry.nameBytes, entry.data);

    const header = Buffer.alloc(46);
    header.writeUInt32LE(CENTRAL_HEADER_SIGNATURE, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(entry.versionNeeded, 6);
    header.writeUInt16LE(flags, 8);
    header.writeUInt16LE(entry.method, 10);
    header.writeUInt16LE(entry.modTime, 12);
    header.writeUInt16LE(entry.modDate, 14);
    header.writeUInt32LE(entry.crc32 >>> 0, 16);
    header.writeUInt32LE(entry.compressedSize, 20);
    header.writeUInt32LE(entry.uncompressedSize, 24);
    header.writeUInt16LE(entry.nameBytes.length, 28);
    header.writeUInt32LE(entry.externalAttributes >>> 0, 38);
    header.writeUInt32LE(offset, 42);
    central.push(header, entry.nameBytes);

    offset += local.length + entry.nameBytes.length + entry.data.length;
  }

  const centralDirectory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(END_OF_CENTRAL_DIRECTORY_SIGNATURE, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, centralDirectory, end]);
}

function findEndOfCentralDirectory(zip: Buffer): number {
  // The record sits at the very end, after an optional comment of up to 64 KiB.
  const earliest = Math.max(0, zip.length - 22 - 0xffff);
  for (let offset = zip.length - 22; offset >= earliest; offset -= 1) {
    if (zip.readUInt32LE(offset) === END_OF_CENTRAL_DIRECTORY_SIGNATURE) {
      return offset;
    }
  }
  throw new Error("Not a zip archive");
}

let crcTable: Uint32Array | undefined;

export function crc32(data: Buffer): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) {
        c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      }
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (const byte of data) {
    crc = crcTable[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
