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

  it("picks the score saved by the newest MuseScore when a song is in several folders", () => {
    const root = mkdtempSync(join(tmpdir(), "bandcue-scores-"));
    mkdirSync(join(root, "MuseScore4"));
    const score = (version: string) => `<?xml version="1.0"?>\n<museScore version="${version}">\n</museScore>\n`;
    writeFileSync(join(root, "Zombie.mscx"), score("3.02"));
    writeFileSync(join(root, "MuseScore4", "Zombie.mscx"), score("4.70"));
    const { entries } = scanMuseScoreCatalog([root]);
    const song = { id: "zombie", title: "Zombie", sourceType: "songsterr" as const,
      source: "https://www.songsterr.com/a/wsa/x-s431", museScoreSource: "Zombie.mscz" };

    const match = matchMuseScoreSong(song, entries);
    expect(match).toMatchObject({ status: "matched", relativePath: "MuseScore4/Zombie.mscx" });
    expect(matchedCatalogEntry(match, entries)?.relativePath).toBe("MuseScore4/Zombie.mscx");

    // No clear winner (same version, or unreadable files): still ambiguous.
    expect(matchMuseScoreSong(song, entries, () => 4.7)).toMatchObject({ status: "ambiguous", count: 2 });
    expect(matchMuseScoreSong(song, entries, () => 0)).toMatchObject({ status: "ambiguous", count: 2 });
  });

  it("matches a Songsterr-primary song via its dedicated museScoreSource", () => {
    const entries: LocalScoreCatalogEntry[] = [
      {
        title: "Creep",
        relativePath: "Radiohead/Creep.mscz",
        absolutePath: "C:/Scores/Radiohead/Creep.mscz"
      }
    ];

    // The song's primary source is a Songsterr URL (for band mates), but it also
    // carries a MuseScore reference so this adapter can still open it.
    const match = matchMuseScoreSong({
      id: "song-3",
      title: "Creep",
      sourceType: "songsterr",
      source: "https://www.songsterr.com/a/wsa/radiohead-creep-tab-s12",
      museScoreSource: "Radiohead/Creep"
    }, entries);

    expect(match.status).toBe("matched");
    expect(matchedCatalogEntry(match, entries)?.relativePath).toBe("Radiohead/Creep.mscz");
  });

  it("is not-applicable when a song has neither a MuseScore type nor reference", () => {
    const match = matchMuseScoreSong({
      id: "song-4",
      title: "Creep",
      sourceType: "songsterr",
      source: "https://www.songsterr.com/a/wsa/radiohead-creep-tab-s12"
    }, []);

    expect(match.status).toBe("not-applicable");
  });
});
