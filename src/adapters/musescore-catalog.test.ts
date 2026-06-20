import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  matchMuseScoreSong,
  matchedCatalogEntry,
  publicCatalogEntries,
  scanMuseScoreCatalog,
  type LocalScoreCatalogEntry
} from "./musescore-catalog.js";

describe("MuseScore catalog", () => {
  it("scans supported score files recursively and publishes relative paths only", () => {
    const root = mkdtempSync(join(tmpdir(), "bandcue-scores-"));
    mkdirSync(join(root, "CCR"));
    writeFileSync(join(root, "CCR", "Bad Moon Rising.mscz"), "");
    writeFileSync(join(root, "notes.txt"), "");

    const catalog = scanMuseScoreCatalog([root]);
    const publicEntries = publicCatalogEntries(catalog.entries);

    expect(publicEntries).toEqual([{
      title: "Bad Moon Rising",
      relativePath: "CCR/Bad Moon Rising.mscz",
      sourceId: "ccr/bad moon rising"
    }]);
    expect(JSON.stringify(publicEntries)).not.toContain(root);
  });

  it("matches by source path, extensionless title, and reports ambiguous duplicates", () => {
    const entries: LocalScoreCatalogEntry[] = [
      {
        title: "Bad Moon Rising",
        relativePath: "CCR/Bad Moon Rising.mscz",
        absolutePath: "C:/Scores/CCR/Bad Moon Rising.mscz"
      },
      {
        title: "Bad Moon Rising",
        relativePath: "Covers/Bad Moon Rising.mscx",
        absolutePath: "C:/Scores/Covers/Bad Moon Rising.mscx"
      }
    ];

    const exact = matchMuseScoreSong({
      id: "song-1",
      title: "Bad Moon Rising",
      sourceType: "musescore",
      source: "CCR/Bad Moon Rising"
    }, entries);
    expect(exact.status).toBe("matched");
    expect(matchedCatalogEntry(exact, entries)?.relativePath).toBe("CCR/Bad Moon Rising.mscz");

    const ambiguous = matchMuseScoreSong({
      id: "song-2",
      title: "Bad Moon Rising",
      sourceType: "musescore"
    }, entries);
    expect(ambiguous).toMatchObject({
      status: "ambiguous",
      count: 2
    });
  });
});
