import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  anchorX,
  choosePart,
  cursorAt,
  findPassIndex,
  instrumentsOf,
  partInNotation,
  followScrollTop,
  partFamily,
  passNumberOf,
  countInBeat,
  countInState,
  familyIndexOf,
  jumpAfter,
  measureAtPoint,
  playOfSong,
  resolvePlayhead,
  resolveScoreSource,
  sectionAt,
  songTimeMs,
  startOffsetMs,
  systemsOf,
  visiblePages
} from "./score-timing.js";
import type { ScoreAvailability, ScoreTiming, TransportState } from "../src/shared/protocol.js";

// The committed example export: pickup, repeat of measures 3-4 (BandCue
// numbering), D.S. al Coda, 120 BPM then 60 BPM from measure 7.
const timing = JSON.parse(
  readFileSync(join(import.meta.dirname, "../examples/score-view/export/score.timing.json"), "utf8")
) as ScoreTiming;

describe("score view timing", () => {
  it("maps room time to song time from the downbeat, start measure and tempo", () => {
    expect(songTimeMs({ roomNowMs: 11_000, downbeatServerTime: 10_000, startOffsetMs: 0 })).toBe(1000);
    expect(songTimeMs({ roomNowMs: 11_000, downbeatServerTime: 10_000, startOffsetMs: 14_500, tempoPercent: 80 })).toBe(15_300);
    expect(songTimeMs({ roomNowMs: 9_000, downbeatServerTime: 10_000, startOffsetMs: 500 })).toBe(-500);
    expect(songTimeMs({ roomNowMs: 11_000, downbeatServerTime: 10_000, startOffsetMs: 0, leadMs: 150 })).toBe(1150);
    expect(songTimeMs({ roomNowMs: 11_000, downbeatServerTime: 10_000, startOffsetMs: 0, tempoPercent: Number.NaN })).toBe(1000);
  });

  it("starts a measure at its first pass, counting the pickup as measure 1 like the bridge plugin", () => {
    expect(startOffsetMs(timing, undefined)).toBe(0);
    expect(startOffsetMs(timing, 1)).toBe(0);
    expect(startOffsetMs(timing, 2)).toBe(500);
    // Measure 3 is repeated (2500 and 6500 ms): MuseScore starts it at its first pass.
    expect(startOffsetMs(timing, 3)).toBe(2500);
    // Measure 5 comes again after the D.S.; still the first pass.
    expect(startOffsetMs(timing, 5)).toBe(10_500);
    // Beyond the end: the last measure, where MuseScore lands too.
    expect(startOffsetMs(timing, 99)).toBe(30_500);
  });

  it("finds the pass playing at a time by binary search", () => {
    expect(findPassIndex(timing.events, -1)).toBe(-1);
    expect(findPassIndex(timing.events, 0)).toBe(0);
    expect(findPassIndex(timing.events, 499)).toBe(0);
    expect(findPassIndex(timing.events, 500)).toBe(1);
    expect(findPassIndex(timing.events, 7000)).toBe(4);
    expect(findPassIndex(timing.events, 1e9)).toBe(timing.events.length - 1);
  });

  it("note by note: stands on each note exactly when it sounds and glides in between", () => {
    const measure2 = timing.events[1]!;
    for (const [time, x] of measure2.b) {
      expect(cursorAt(timing, time, { motion: "notes" })?.x).toBeCloseTo(x, 5);
    }
    const [[t0, x0], [t1, x1]] = measure2.b as [[number, number], [number, number]];
    expect(cursorAt(timing, (t0 + t1) / 2, { motion: "notes" })?.x).toBeCloseTo((x0 + x1) / 2, 5);
    expect(cursorAt(timing, 750, { motion: "notes" })?.measureIndex).toBe(1);
  });

  it("steady by default: one speed across a measure, exact on its first note and its end", () => {
    // A measure whose notes are spaced unevenly, like a 16th run after a half note.
    const uneven: ScoreTiming = {
      ...timing,
      events: [{ m: 1, t: 0, e: 2000, b: [[0, 100], [1000, 150], [1250, 400], [1500, 650], [1750, 900], [2000, 1000]] }],
      durationMs: 2000
    };
    const xs = [0, 250, 500, 1000, 1500, 1750, 2000].map((time) => cursorAt(uneven, time)!.x);
    expect(xs).toEqual([100, 212.5, 325, 550, 775, 887.5, 1000]);
    // Note by note it would sprint through the run instead.
    expect(cursorAt(uneven, 1500, { motion: "notes" })!.x).toBe(650);
    // On every measure of the example, start and end are the same either way.
    for (const event of timing.events) {
      expect(cursorAt(timing, event.t)?.x).toBeCloseTo(event.b[0]![1], 5);
    }
  });

  it("follows repeats and the D.S. jump, and counts the passes", () => {
    expect(cursorAt(timing, 3000)).toMatchObject({ measureIndex: 2, passNumber: 1 });
    expect(cursorAt(timing, 7000)).toMatchObject({ measureIndex: 2, passNumber: 2 });
    expect(cursorAt(timing, 23_000)).toMatchObject({ measureIndex: 4, passNumber: 2 });
    expect(cursorAt(timing, 27_000)).toMatchObject({ measureIndex: 8, passNumber: 1 });
    expect(passNumberOf(timing.events, 0)).toBe(1);
  });

  it("clamps to the start and the end of the song", () => {
    expect(cursorAt(timing, -5000)?.measureIndex).toBe(0);
    const end = cursorAt(timing, 1e9)!;
    expect(end.measureIndex).toBe(9);
    expect(end.x).toBe(timing.events.at(-1)!.b.at(-1)![1]);
    expect(cursorAt({ ...timing, events: [] }, 0)).toBeUndefined();
  });

  it("interpolates anchors", () => {
    expect(anchorX([[0, 10], [100, 20]], 50)).toBe(15);
    expect(anchorX([[0, 10], [100, 20]], -5)).toBe(10);
    expect(anchorX([[0, 10], [100, 20]], 500)).toBe(20);
    expect(anchorX([], 5)).toBe(0);
  });
});

describe("resolvePlayhead", () => {
  const scheduled: TransportState = { status: "scheduled", action: "play", sequenceId: 3, scheduledServerTime: 10_000 };

  it("waits on the start measure during the count-in, then runs from the downbeat", () => {
    expect(resolvePlayhead(scheduled, undefined, 9_000))
      .toMatchObject({ mode: "countdown", downbeatServerTime: 10_000, remainingMs: 1000 });
    // The room may not have flipped to running yet; the downbeat still counts.
    expect(resolvePlayhead(scheduled, undefined, 10_050)).toMatchObject({ mode: "running", downbeatServerTime: 10_000 });
    expect(resolvePlayhead({ ...scheduled, status: "running", startedServerTime: 10_000 }, undefined, 12_000))
      .toMatchObject({ mode: "running", downbeatServerTime: 10_000 });
  });

  it("freezes where a stop caught the song", () => {
    const stopped: TransportState = { status: "stopped", action: "stop", sequenceId: 4, scheduledServerTime: 15_000, stopReason: "manual" };
    expect(resolvePlayhead(stopped, { sequenceId: 3, downbeatServerTime: 10_000 }, 20_000))
      .toMatchObject({ mode: "stopped", downbeatServerTime: 10_000, stoppedAtServerTime: 15_000 });
  });

  it("does not run this song's cursor from another song's downbeat", () => {
    const running: TransportState = {
      status: "running", action: "play", sequenceId: 3, scheduledServerTime: 10_000, startedServerTime: 10_000,
      song: { id: "song-a", startMeasure: 5, tempoPercent: 80 }
    };
    // The host moved on to song B while A plays.
    expect(resolvePlayhead(running, undefined, 12_000, "song-b")).toEqual({ mode: "elsewhere" });
    expect(playOfSong(running, "song-b")).toBeUndefined();
    // Back on A, A's run (with the start and tempo it began with) still counts.
    expect(resolvePlayhead(running, undefined, 12_000, "song-a")).toMatchObject({
      mode: "running", downbeatServerTime: 10_000, play: { startMeasure: 5, tempoPercent: 80 }
    });
    // A coordinator that does not say which song plays: the current one.
    const legacy: TransportState = { ...running, song: undefined };
    expect(resolvePlayhead(legacy, undefined, 12_000, "song-b")).toMatchObject({ mode: "running" });
    expect("startMeasure" in (playOfSong(legacy, "song-b") ?? {})).toBe(false);
  });

  it("knows nothing of a play it never saw", () => {
    const stopped: TransportState = { status: "stopped", action: "stop", sequenceId: 4, scheduledServerTime: 15_000 };
    expect(resolvePlayhead(stopped, undefined, 20_000)).toEqual({ mode: "idle" });
    expect(resolvePlayhead(stopped, { sequenceId: 4, downbeatServerTime: 10_000 }, 20_000)).toEqual({ mode: "idle" });
    expect(resolvePlayhead(undefined, undefined, 0)).toEqual({ mode: "idle" });
  });
});

describe("score layout helpers", () => {
  it("groups measures into lines", () => {
    const { systems, systemOfMeasure } = systemsOf(timing);
    expect(systems).toHaveLength(2);
    expect(systemOfMeasure.slice(0, 6)).toEqual([0, 0, 0, 0, 0, 0]);
    expect(systemOfMeasure.slice(6)).toEqual([1, 1, 1, 1]);
    expect(systems[1]!.top).toBeGreaterThan(systems[0]!.bottom);
  });

  it("keeps a player's part from song to song by name or instrument family", () => {
    const parts = [
      { id: "score", name: "Full score" },
      { id: "part-1", name: "E-Gitarre (Tabulatur)" },
      { id: "part-2", name: "Bassgitarre (Tabulatur)" },
      { id: "part-3", name: "Schlagzeug" }
    ];
    expect(choosePart(parts, "")).toBe("score");
    expect(choosePart(parts, "schlagzeug")).toBe("part-3");
    expect(choosePart(parts, "Drums")).toBe("part-3");
    expect(choosePart(parts, "Bass")).toBe("part-2");
    expect(choosePart(parts, "Electric Guitar")).toBe("part-1");
    expect(choosePart(parts, "Vocals")).toBe("score");
    expect(choosePart([], "Drums")).toBeUndefined();
    expect(partFamily("Bass Drum")).toBe("drums");
  });

  it("offers guitar and bass as notes or tab, and keeps the player's choice", () => {
    const parts = [
      { id: "score", name: "Full score", instrument: "score" },
      { id: "part-1", name: "Vocals", instrument: "part-1" },
      { id: "part-2-notes", name: "Lead Guitar", instrument: "part-2", notation: "notes" as const },
      { id: "part-2-tab", name: "Lead Guitar", instrument: "part-2", notation: "tab" as const },
      { id: "part-3", name: "Drums", instrument: "part-3" }
    ];
    expect(instrumentsOf(parts)).toEqual([
      { key: "score", name: "Full score", notations: [] },
      { key: "part-1", name: "Vocals", notations: [] },
      { key: "part-2", name: "Lead Guitar", notations: ["notes", "tab"] },
      { key: "part-3", name: "Drums", notations: [] }
    ]);
    expect(choosePart(parts, "Lead Guitar")).toBe("part-2-tab");
    expect(choosePart(parts, "Lead Guitar", "notes")).toBe("part-2-notes");
    expect(choosePart(parts, "Rhythm Guitar", "notes")).toBe("part-2-notes");
    expect(choosePart(parts, "Drums", "notes")).toBe("part-3");
    expect(partInNotation(parts, "part-2", "tab")).toBe("part-2-tab");
    expect(partInNotation(parts, "part-3", "tab")).toBe("part-3");
    expect(partInNotation(parts, "nope", "tab")).toBeUndefined();
  });

  it("shows the next page beside the current one, turning the left page first", () => {
    expect(visiblePages(0, 5, 2)).toEqual([0, 1]);
    expect(visiblePages(1, 5, 2)).toEqual([2, 1]);
    expect(visiblePages(2, 5, 2)).toEqual([2, 3]);
    expect(visiblePages(4, 5, 2)).toEqual([4, 3]);
    expect(visiblePages(3, 5, 1)).toEqual([3]);
    expect(visiblePages(0, 1, 2)).toEqual([0]);
    expect(visiblePages(0, 0, 2)).toEqual([]);
  });

  it("scrolls the current line to the reading line and keeps the next line in view", () => {
    expect(followScrollTop({ lineTop: 1000, lineBottom: 1200, nextBottom: 1500, viewportHeight: 1000, readingLine: 0.2 })).toBe(800);
    // A huge zoom: the next line would fall off, so the current line moves up.
    const tight = followScrollTop({ lineTop: 1000, lineBottom: 1500, nextBottom: 2000, viewportHeight: 1000, readingLine: 0.2 });
    expect(tight).toBeGreaterThan(800);
    expect(tight).toBeLessThanOrEqual(1000);
    expect(followScrollTop({ lineTop: 50, lineBottom: 100, viewportHeight: 1000, readingLine: 0.2 })).toBe(0);
  });
});

describe("resolveScoreSource", () => {
  const score: ScoreAvailability = {
    songId: "zombie",
    status: "ready",
    scoreId: "local",
    imports: [
      { key: "s27", roles: ["main", "bass"], status: "ready", scoreId: "main-import", importedAt: 1, revision: "2026-10-24" },
      { key: "s900", roles: ["drums"], status: "ready", scoreId: "drum-import", importedAt: 1 }
    ]
  };

  it("keeps the MuseScore score unless the device asks for Songsterr", () => {
    expect(resolveScoreSource(score, "Drums", "musescore")).toEqual({ scoreId: "local", origin: "musescore" });
    expect(resolveScoreSource(undefined, "Drums", "songsterr")).toBeUndefined();
  });

  it("reads the import of the Songsterr page that serves this player's instrument", () => {
    expect(resolveScoreSource(score, "Feargal Lawler (Drums)", "songsterr")).toMatchObject({ scoreId: "drum-import", origin: "songsterr" });
    expect(resolveScoreSource(score, "Bass", "songsterr")).toMatchObject({ scoreId: "main-import", revision: "2026-10-24" });
    expect(resolveScoreSource(score, "Lead Guitar", "songsterr")?.scoreId).toBe("main-import");
  });

  it("falls back to whatever is ready", () => {
    const onlyDrums: ScoreAvailability = { ...score, imports: [score.imports![1]!] };
    expect(resolveScoreSource(onlyDrums, "Guitar", "songsterr")?.scoreId).toBe("drum-import");
    const converting: ScoreAvailability = { ...score, imports: [{ ...score.imports![1]!, status: "exporting", scoreId: undefined }] };
    expect(resolveScoreSource(converting, "Drums", "songsterr")?.scoreId).toBe("local");
    const noLocal: ScoreAvailability = { songId: "creep", status: "missing", imports: [score.imports![0]!] };
    expect(resolveScoreSource(noLocal, "Drums", "musescore")?.scoreId).toBe("main-import");
  });
});

describe("reading aids", () => {
  const marked: ScoreTiming = {
    ...timing,
    sections: [{ m: 1, label: "Intro" }, { m: 2, label: "Verse" }, { m: 5, label: "Chorus" }],
    meters: [{ m: 0, n: 4, d: 4 }]
  };

  it("names the section a measure is in", () => {
    expect(sectionAt(marked, 0)).toBeUndefined();
    expect(sectionAt(marked, 2)).toBe("Verse");
    expect(sectionAt(marked, 4)).toBe("Verse");
    expect(sectionAt(marked, 9)).toBe("Chorus");
    expect(sectionAt(timing, 3)).toBeUndefined();
  });

  it("warns before a repeat or a jump", () => {
    const events = timing.events;
    const kinds = events.map((_, index) => jumpAfter(events, index)).filter(Boolean);
    // The example repeats measures 3-4 and jumps D.S. al Coda.
    expect(kinds).toContainEqual({ kind: "repeat", toMeasureIndex: 2 });
    expect(kinds.length).toBeGreaterThanOrEqual(2);
    expect(jumpAfter(events, events.length - 1)).toBeUndefined();
    expect(jumpAfter([{ m: 0, t: 0, e: 1, b: [] }, { m: 1, t: 1, e: 2, b: [] }], 0)).toBeUndefined();
  });

  it("counts the count-in in the start measure's beats, at the song's tempo", () => {
    // 120 BPM in 4/4: a 2 s measure, 500 ms beats; the pickup is skipped.
    expect(countInBeat(marked, 1, 100)).toEqual({ beatMs: 500, beatsPerMeasure: 4 });
    expect(countInBeat(marked, 3, 50)).toEqual({ beatMs: 1000, beatsPerMeasure: 4 });
    expect(countInBeat(timing, 3, 100)).toBeUndefined();
    const beat = { beatMs: 500, beatsPerMeasure: 4 };
    expect(countInState(1_999, beat)).toMatchObject({ beatsLeft: 4 });
    expect(countInState(1_500, beat)).toMatchObject({ beatsLeft: 3, phase: 0 });
    expect(countInState(1_450, beat)?.phase).toBeCloseTo(0.1);
    expect(countInState(10, beat)).toMatchObject({ beatsLeft: 1 });
    // More than two measures away: seconds, not beats.
    expect(countInState(4_500, beat)).toBeUndefined();
    expect(countInState(0, beat)).toBeUndefined();
  });

  it("finds the measure under a tap", () => {
    const measure = timing.measures[3]!;
    expect(measureAtPoint(timing, measure.page, measure.x + measure.w / 2, measure.y + measure.h / 2)).toBe(3);
    // Just above the staff (a chord symbol) still picks it.
    expect(measureAtPoint(timing, measure.page, measure.x + 5, measure.y - 100)).toBe(3);
    expect(measureAtPoint(timing, measure.page + 1, measure.x + 5, measure.y)).toBeUndefined();
    expect(measureAtPoint(timing, measure.page, -50, measure.y)).toBeUndefined();
  });
});

describe("part memory", () => {
  const parts = [
    { id: "score", name: "Full score", instrument: "score" },
    { id: "part-1-notes", name: "Lead Guitar", instrument: "part-1", notation: "notes" as const },
    { id: "part-1-tab", name: "Lead Guitar", instrument: "part-1", notation: "tab" as const },
    { id: "part-2-notes", name: "Rhythm Guitar", instrument: "part-2", notation: "notes" as const },
    { id: "part-2-tab", name: "Rhythm Guitar", instrument: "part-2", notation: "tab" as const },
    { id: "part-3", name: "Drums", instrument: "part-3" }
  ];

  it("gives the second guitarist the second guitar part in a song that names them differently", () => {
    expect(familyIndexOf(parts, "part-2-tab")).toBe(1);
    expect(familyIndexOf(parts, "part-1-notes")).toBe(0);
    expect(familyIndexOf(parts, "part-3")).toBe(0);
    const other = [
      { id: "score", name: "Full score" },
      { id: "part-1", name: "Guitar 1" },
      { id: "part-2", name: "Guitar 2" }
    ];
    expect(choosePart(other, "Rhythm Guitar", "tab", 1)).toBe("part-2");
    expect(choosePart(other, "Rhythm Guitar", "tab", 0)).toBe("part-1");
    // Fewer guitars than that: the last one there is.
    expect(choosePart(other, "Guitar 3", "tab", 4)).toBe("part-2");
    // An exact name beats the position.
    expect(choosePart(parts, "Rhythm Guitar", "notes", 0)).toBe("part-2-notes");
  });
});

describe("page turns", () => {
  it("can turn whole pages in book order", () => {
    expect(visiblePages(0, 5, 2, "whole")).toEqual([0, 1]);
    expect(visiblePages(1, 5, 2, "whole")).toEqual([0, 1]);
    expect(visiblePages(3, 5, 2, "whole")).toEqual([2, 3]);
    expect(visiblePages(4, 5, 2, "whole")).toEqual([4]);
    expect(visiblePages(3, 5, 1, "whole")).toEqual([3]);
  });
});
