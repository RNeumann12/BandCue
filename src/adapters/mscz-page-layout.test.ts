import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  crc32,
  entryContent,
  forcePageLayout,
  readZipEntries,
  removeNonPageLayout,
  rewriteZipText
} from "./mscz-page-layout.js";

const EXAMPLE = join(import.meta.dirname, "../../examples/score-view/timing-example.mscz");

describe("forcePageLayout", () => {
  it("removes a continuous-view layout mode and keeps page layout", () => {
    expect(removeNonPageLayout("<Score>\n    <layoutMode>line</layoutMode>\n    <Division>480</Division>"))
      .toBe("<Score>\n    <Division>480</Division>");
    expect(removeNonPageLayout("<layoutMode>page</layoutMode>")).toBe("<layoutMode>page</layoutMode>");
  });

  it("leaves a score that already lays out in pages alone", () => {
    expect(forcePageLayout(readFileSync(EXAMPLE))).toBeUndefined();
  });

  it("rewrites only the score file of a continuous-view .mscz, byte for byte elsewhere", () => {
    const original = readFileSync(EXAMPLE);
    const continuous = rewriteZipText(original, (name) => name.endsWith(".mscx"),
      (xml) => xml.replace("<Score>", "<Score>\n    <layoutMode>line</layoutMode>"))!;
    expect(continuous).toBeDefined();

    const paged = forcePageLayout(continuous)!;
    expect(paged).toBeDefined();
    const before = readZipEntries(original);
    const after = readZipEntries(paged);
    expect(after.map((entry) => entry.name)).toEqual(before.map((entry) => entry.name));
    for (const [index, entry] of after.entries()) {
      const content = entryContent(entry);
      // Every entry survives the round trip, and the CRCs a reader checks match.
      expect(content.equals(entryContent(before[index]!))).toBe(true);
      expect(crc32(content)).toBe(entry.crc32);
    }
  });

  it("returns undefined for something that is not a zip", () => {
    expect(forcePageLayout(Buffer.from("not a zip at all"))).toBeUndefined();
  });
});
