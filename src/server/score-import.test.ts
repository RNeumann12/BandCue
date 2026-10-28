import { describe, expect, it } from "vitest";
import { importIdFor, isGuitarProFile } from "./score-import.js";

function padded(head: Buffer): Buffer {
  return Buffer.concat([head, Buffer.alloc(64)]);
}

describe("Songsterr import files", () => {
  it("accepts the Guitar Pro formats and nothing else", () => {
    expect(isGuitarProFile(padded(Buffer.from([0x50, 0x4b, 0x03, 0x04])))).toBe(true);
    expect(isGuitarProFile(padded(Buffer.from("BCFZ", "latin1")))).toBe(true);
    expect(isGuitarProFile(padded(Buffer.from("\x18FICHIER GUITAR PRO v5.10", "latin1")))).toBe(true);
    expect(isGuitarProFile(padded(Buffer.from("<svg xmlns=", "latin1")))).toBe(false);
    expect(isGuitarProFile(Buffer.from([0x50, 0x4b, 0x03, 0x04]))).toBe(false);
  });

  it("names a file by its content", () => {
    const file = padded(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
    expect(importIdFor(file)).toMatch(/^[a-f0-9]{32}$/);
    expect(importIdFor(file)).toBe(importIdFor(Buffer.from(file)));
    expect(importIdFor(file)).not.toBe(importIdFor(padded(Buffer.from("BCFZ", "latin1"))));
  });
});
