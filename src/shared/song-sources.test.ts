import { describe, expect, it } from "vitest";
import { hasScoreView, songsterrImportTargets, songsterrSongKey } from "./song-sources.js";

describe("Songsterr import targets", () => {
  it("keys a tab URL by its Songsterr song id, whatever the slug or track", () => {
    expect(songsterrSongKey("https://www.songsterr.com/a/wsa/cranberries-zombie-drum-tab-s27t3")).toBe("s27");
    expect(songsterrSongKey("https://www.songsterr.com/a/wsa/cranberries-zombie-tab-s27")).toBe("s27");
    expect(songsterrSongKey("Zombie.mscz")).toBe("");
    expect(songsterrSongKey(undefined)).toBe("");
  });

  it("lists one target per Songsterr song, with the roles it serves", () => {
    expect(songsterrImportTargets({
      id: "zombie",
      title: "Zombie",
      sourceType: "musescore",
      source: "Zombie.mscz",
      songsterrUrl: "https://www.songsterr.com/a/wsa/cranberries-zombie-tab-s27",
      songsterrBassUrl: "https://www.songsterr.com/a/wsa/cranberries-zombie-bass-tab-s27",
      songsterrDrumUrl: "https://www.songsterr.com/a/wsa/cranberries-zombie-drum-tab-s900"
    })).toEqual([
      { key: "s27", url: "https://www.songsterr.com/a/wsa/cranberries-zombie-tab-s27", roles: ["main", "bass"] },
      { key: "s900", url: "https://www.songsterr.com/a/wsa/cranberries-zombie-drum-tab-s900", roles: ["drums"] }
    ]);
    expect(songsterrImportTargets({ id: "a", title: "A", sourceType: "musescore", source: "A.mscz" })).toEqual([]);
  });

  it("gives a song a score view with a MuseScore score or an import", () => {
    const songsterr = { id: "a", title: "A", sourceType: "songsterr" as const, source: "https://www.songsterr.com/a/wsa/a-tab-s1" };
    expect(hasScoreView(songsterr)).toBe(false);
    expect(hasScoreView({ ...songsterr, scoreImports: [{ key: "s1", importId: "f".repeat(32), importedAt: 1 }] })).toBe(true);
    expect(hasScoreView({ id: "b", title: "B", sourceType: "musescore", source: "B.mscz" })).toBe(true);
  });
});
