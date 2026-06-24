import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "../..");

const extensionSizes = [16, 32, 48, 128];
const androidSizes = [
  ["mipmap-mdpi", 48],
  ["mipmap-hdpi", 72],
  ["mipmap-xhdpi", 96],
  ["mipmap-xxhdpi", 144],
  ["mipmap-xxxhdpi", 192]
] as const;

const sourceSvg = join(root, "assets/brand/bandcue-icon.svg");
readFileSync(sourceSvg, "utf8");

for (const size of extensionSizes) {
  const outDir = join(root, "extension/songsterr/icons");
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, `icon-${size}.png`), renderIconPng(size));
}

for (const [density, size] of androidSizes) {
  const outDir = join(root, "android/app/src/main/res", density);
  mkdirSync(outDir, { recursive: true });
  const png = renderIconPng(size);
  writeFileSync(join(outDir, "ic_launcher.png"), png);
  writeFileSync(join(outDir, "ic_launcher_round.png"), png);
}

console.log(`Generated BandCue icons from ${sourceSvg}`);

function renderIconPng(size: number): Buffer {
  const rgba = Buffer.alloc(size * size * 4);
  const samples = size <= 32 ? 3 : 2;

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;

      for (let sy = 0; sy < samples; sy += 1) {
        for (let sx = 0; sx < samples; sx += 1) {
          const px = (x + (sx + 0.5) / samples) / size;
          const py = (y + (sy + 0.5) / samples) / size;
          const color = colorAt(px * 2 - 1, py * 2 - 1);
          const alpha = color[3] / 255;
          r += color[0] * alpha;
          g += color[1] * alpha;
          b += color[2] * alpha;
          a += alpha;
        }
      }

      const count = samples * samples;
      const offset = (y * size + x) * 4;
      rgba[offset] = clampByte(a ? r / a : 0);
      rgba[offset + 1] = clampByte(a ? g / a : 0);
      rgba[offset + 2] = clampByte(a ? b / a : 0);
      rgba[offset + 3] = clampByte((a / count) * 255);
    }
  }

  return encodePng(size, size, rgba);
}

function colorAt(x: number, y: number): [number, number, number, number] {
  const radius = Math.hypot(x, y);
  if (radius > 0.91) {
    return [0, 0, 0, 0];
  }

  const t = (y + 1) / 2;
  let color: [number, number, number, number] = [
    lerp(16, 20, t),
    lerp(35, 23, t),
    lerp(49, 31, t),
    255
  ];

  const angle = Math.atan2(y, x);
  const cueArc = radius > 0.62 && radius < 0.76 && angle > -2.75 && angle < 0.6 && y < 0.38;
  if (cueArc) {
    color = blend(color, [103, 200, 202, 255]);
  }

  if (circle(x, y, 0.42, -0.48, 0.095) || roundedRect(x, y, 0.50, 0.08, 0.07, 0.25, 0.06) || circle(x, y, 0.50, 0.39, 0.08)) {
    color = blend(color, [255, 209, 102, 255]);
  }

  if (insideTriangle(x, y, [-0.24, -0.42], [-0.24, 0.42], [0.38, 0])) {
    color = blend(color, [246, 248, 241, 255]);
  }

  return color;
}

function circle(x: number, y: number, cx: number, cy: number, r: number): boolean {
  return Math.hypot(x - cx, y - cy) <= r;
}

function roundedRect(x: number, y: number, cx: number, cy: number, hw: number, hh: number, radius: number): boolean {
  const dx = Math.abs(x - cx) - hw + radius;
  const dy = Math.abs(y - cy) - hh + radius;
  return Math.hypot(Math.max(dx, 0), Math.max(dy, 0)) + Math.min(Math.max(dx, dy), 0) <= radius;
}

function insideTriangle(
  x: number,
  y: number,
  a: [number, number],
  b: [number, number],
  c: [number, number]
): boolean {
  const d1 = sign(x, y, a, b);
  const d2 = sign(x, y, b, c);
  const d3 = sign(x, y, c, a);
  return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
}

function sign(x: number, y: number, a: [number, number], b: [number, number]): number {
  return (x - b[0]) * (a[1] - b[1]) - (a[0] - b[0]) * (y - b[1]);
}

function blend(base: [number, number, number, number], over: [number, number, number, number]): [number, number, number, number] {
  const alpha = over[3] / 255;
  return [
    Math.round(over[0] * alpha + base[0] * (1 - alpha)),
    Math.round(over[1] * alpha + base[1] * (1 - alpha)),
    Math.round(over[2] * alpha + base[2] * (1 - alpha)),
    255
  ];
}

function encodePng(width: number, height: number, rgba: Buffer): Buffer {
  const scanlines = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (width * 4 + 1);
    scanlines[rowStart] = 0;
    rgba.copy(scanlines, rowStart + 1, y * width * 4, (y + 1) * width * 4);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", Buffer.concat([
      uint32(width),
      uint32(height),
      Buffer.from([8, 6, 0, 0, 0])
    ])),
    chunk("IDAT", deflateSync(scanlines)),
    chunk("IEND", Buffer.alloc(0))
  ]);
}

function chunk(type: string, data: Buffer): Buffer {
  const typeBuffer = Buffer.from(type, "ascii");
  const crcInput = Buffer.concat([typeBuffer, data]);
  return Buffer.concat([
    uint32(data.length),
    typeBuffer,
    data,
    uint32(crc32(crcInput))
  ]);
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

function uint32(value: number): Buffer {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32BE(value >>> 0, 0);
  return buffer;
}

function clampByte(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)));
}

function lerp(a: number, b: number, t: number): number {
  return Math.round(a + (b - a) * t);
}
