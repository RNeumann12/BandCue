import { mkdirSync, writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "../..");
const outDir = join(root, "assets/chrome-web-store");

mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, "small-promo-440x280.png"), renderSmallPromo());
writeFileSync(join(outDir, "screenshot-1280x800.png"), renderScreenshot());

console.log(`Generated Chrome Web Store assets in ${outDir}`);

function renderSmallPromo(): Buffer {
  const canvas = createCanvas(440, 280, [14, 19, 17, 255]);
  gradient(canvas, [18, 26, 22, 255], [38, 47, 42, 255]);
  circle(canvas, 118, 140, 70, [80, 232, 138, 255]);
  circle(canvas, 118, 140, 61, [16, 35, 49, 255]);
  triangle(canvas, [96, 98], [96, 182], [158, 140], [246, 248, 241, 255]);
  roundedRect(canvas, 238, 70, 134, 118, 10, [237, 245, 235, 255]);
  roundedRect(canvas, 253, 92, 94, 12, 5, [80, 232, 138, 255]);
  roundedRect(canvas, 253, 121, 100, 10, 5, [43, 57, 49, 255]);
  roundedRect(canvas, 253, 145, 72, 10, 5, [43, 57, 49, 255]);
  roundedRect(canvas, 253, 168, 42, 14, 6, [255, 209, 102, 255]);
  roundedRect(canvas, 305, 168, 42, 14, 6, [80, 232, 138, 255]);
  return encodePng(canvas);
}

function renderScreenshot(): Buffer {
  const canvas = createCanvas(1280, 800, [12, 18, 16, 255]);
  gradient(canvas, [14, 20, 17, 255], [31, 43, 36, 255]);

  roundedRect(canvas, 92, 74, 796, 552, 18, [231, 236, 228, 255]);
  rect(canvas, 92, 74, 796, 48, [32, 42, 37, 255]);
  circle(canvas, 122, 98, 7, [255, 95, 87, 255]);
  circle(canvas, 146, 98, 7, [255, 209, 102, 255]);
  circle(canvas, 170, 98, 7, [80, 232, 138, 255]);
  roundedRect(canvas, 212, 88, 520, 20, 6, [15, 20, 17, 255]);
  roundedRect(canvas, 128, 154, 312, 34, 8, [80, 232, 138, 255]);
  roundedRect(canvas, 128, 212, 592, 24, 8, [48, 62, 54, 255]);
  roundedRect(canvas, 128, 266, 690, 84, 10, [210, 219, 207, 255]);
  roundedRect(canvas, 156, 294, 230, 18, 7, [33, 44, 38, 255]);
  roundedRect(canvas, 156, 324, 420, 10, 5, [95, 108, 96, 255]);
  roundedRect(canvas, 128, 384, 690, 84, 10, [210, 219, 207, 255]);
  roundedRect(canvas, 156, 412, 280, 18, 7, [33, 44, 38, 255]);
  roundedRect(canvas, 156, 442, 360, 10, 5, [95, 108, 96, 255]);
  roundedRect(canvas, 128, 502, 304, 64, 10, [80, 232, 138, 255]);
  roundedRect(canvas, 462, 502, 304, 64, 10, [255, 209, 102, 255]);

  roundedRect(canvas, 826, 132, 330, 528, 16, [16, 20, 17, 255]);
  roundedRect(canvas, 858, 166, 118, 13, 6, [145, 163, 146, 255]);
  roundedRect(canvas, 858, 194, 142, 30, 8, [246, 255, 242, 255]);
  roundedRect(canvas, 858, 250, 238, 62, 8, [23, 30, 26, 255]);
  circle(canvas, 1068, 281, 9, [80, 232, 138, 255]);
  roundedRect(canvas, 858, 338, 238, 40, 7, [11, 15, 13, 255]);
  roundedRect(canvas, 858, 404, 74, 40, 7, [80, 232, 138, 255]);
  roundedRect(canvas, 940, 404, 74, 40, 7, [32, 42, 36, 255]);
  roundedRect(canvas, 1022, 404, 74, 40, 7, [32, 42, 36, 255]);
  roundedRect(canvas, 858, 472, 114, 40, 7, [21, 27, 24, 255]);
  roundedRect(canvas, 982, 472, 114, 40, 7, [21, 27, 24, 255]);
  roundedRect(canvas, 858, 540, 238, 46, 7, [11, 15, 13, 255]);
  roundedRect(canvas, 858, 612, 198, 12, 6, [174, 188, 175, 255]);
  roundedRect(canvas, 858, 636, 148, 9, 5, [99, 114, 101, 255]);

  return encodePng(canvas);
}

type Canvas = { width: number; height: number; rgba: Buffer };
type Color = [number, number, number, number];
type Point = [number, number];

function createCanvas(width: number, height: number, color: Color): Canvas {
  const canvas = { width, height, rgba: Buffer.alloc(width * height * 4) };
  rect(canvas, 0, 0, width, height, color);
  return canvas;
}

function gradient(canvas: Canvas, top: Color, bottom: Color): void {
  for (let y = 0; y < canvas.height; y += 1) {
    const t = y / Math.max(1, canvas.height - 1);
    rect(canvas, 0, y, canvas.width, 1, [
      lerp(top[0], bottom[0], t),
      lerp(top[1], bottom[1], t),
      lerp(top[2], bottom[2], t),
      255
    ]);
  }
}

function rect(canvas: Canvas, x: number, y: number, width: number, height: number, color: Color): void {
  const x0 = Math.max(0, Math.floor(x));
  const y0 = Math.max(0, Math.floor(y));
  const x1 = Math.min(canvas.width, Math.ceil(x + width));
  const y1 = Math.min(canvas.height, Math.ceil(y + height));
  for (let py = y0; py < y1; py += 1) {
    for (let px = x0; px < x1; px += 1) {
      setPixel(canvas, px, py, color);
    }
  }
}

function roundedRect(canvas: Canvas, x: number, y: number, width: number, height: number, radius: number, color: Color): void {
  const x0 = Math.max(0, Math.floor(x));
  const y0 = Math.max(0, Math.floor(y));
  const x1 = Math.min(canvas.width, Math.ceil(x + width));
  const y1 = Math.min(canvas.height, Math.ceil(y + height));
  for (let py = y0; py < y1; py += 1) {
    for (let px = x0; px < x1; px += 1) {
      const dx = Math.max(x + radius - px, 0, px - (x + width - radius));
      const dy = Math.max(y + radius - py, 0, py - (y + height - radius));
      if (dx * dx + dy * dy <= radius * radius) {
        setPixel(canvas, px, py, color);
      }
    }
  }
}

function circle(canvas: Canvas, cx: number, cy: number, radius: number, color: Color): void {
  const r2 = radius * radius;
  for (let y = Math.floor(cy - radius); y <= Math.ceil(cy + radius); y += 1) {
    for (let x = Math.floor(cx - radius); x <= Math.ceil(cx + radius); x += 1) {
      const dx = x - cx;
      const dy = y - cy;
      if (dx * dx + dy * dy <= r2) {
        setPixel(canvas, x, y, color);
      }
    }
  }
}

function triangle(canvas: Canvas, a: Point, b: Point, c: Point, color: Color): void {
  const x0 = Math.floor(Math.min(a[0], b[0], c[0]));
  const y0 = Math.floor(Math.min(a[1], b[1], c[1]));
  const x1 = Math.ceil(Math.max(a[0], b[0], c[0]));
  const y1 = Math.ceil(Math.max(a[1], b[1], c[1]));
  for (let y = y0; y <= y1; y += 1) {
    for (let x = x0; x <= x1; x += 1) {
      if (insideTriangle(x, y, a, b, c)) {
        setPixel(canvas, x, y, color);
      }
    }
  }
}

function insideTriangle(x: number, y: number, a: Point, b: Point, c: Point): boolean {
  const d1 = sign(x, y, a, b);
  const d2 = sign(x, y, b, c);
  const d3 = sign(x, y, c, a);
  return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
}

function sign(x: number, y: number, a: Point, b: Point): number {
  return (x - b[0]) * (a[1] - b[1]) - (a[0] - b[0]) * (y - b[1]);
}

function setPixel(canvas: Canvas, x: number, y: number, color: Color): void {
  if (x < 0 || y < 0 || x >= canvas.width || y >= canvas.height) {
    return;
  }
  const offset = (y * canvas.width + x) * 4;
  canvas.rgba[offset] = color[0];
  canvas.rgba[offset + 1] = color[1];
  canvas.rgba[offset + 2] = color[2];
  canvas.rgba[offset + 3] = color[3];
}

function encodePng(canvas: Canvas): Buffer {
  const scanlines = Buffer.alloc((canvas.width * 4 + 1) * canvas.height);
  for (let y = 0; y < canvas.height; y += 1) {
    const rowStart = y * (canvas.width * 4 + 1);
    scanlines[rowStart] = 0;
    canvas.rgba.copy(scanlines, rowStart + 1, y * canvas.width * 4, (y + 1) * canvas.width * 4);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", Buffer.concat([
      uint32(canvas.width),
      uint32(canvas.height),
      Buffer.from([8, 6, 0, 0, 0])
    ])),
    chunk("IDAT", deflateSync(scanlines)),
    chunk("IEND", Buffer.alloc(0))
  ]);
}

function chunk(type: string, data: Buffer): Buffer {
  const typeBuffer = Buffer.from(type, "ascii");
  return Buffer.concat([
    uint32(data.length),
    typeBuffer,
    data,
    uint32(crc32(Buffer.concat([typeBuffer, data])))
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

function lerp(a: number, b: number, t: number): number {
  return Math.round(a + (b - a) * t);
}
