import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  anchorX,
  choosePart,
  cursorAt,
  findPassIndex,
  followScrollTop,
  partFamily,
  passNumberOf,
  resolvePlayhead,
  songTimeMs,
  startOffsetMs,
  systemsOf,
  visiblePages
} from "./score-timing.js";
import type { ScoreTiming, TransportState } from "../src/shared/protocol.js";

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

  it("puts the cursor on each note exactly when it sounds and glides in between", () => {
    const measure2 = timing.events[1]!;
    for (const [time, x] of measure2.b) {
      expect(cursorAt(timing, time)?.x).toBeCloseTo(x, 5);
    }
    const [[t0, x0], [t1, x1]] = measure2.b as [[number, number], [number, number]];
    expect(cursorAt(timing, (t0 + t1) / 2)?.x).toBeCloseTo((x0 + x1) / 2, 5);
    expect(cursorAt(timing, 750)?.measureIndex).toBe(1);
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
    expect(resolvePlayhead(scheduled, undefined, 9_000)).toEqual({ mode: "countdown", downbeatServerTime: 10_000, remainingMs: 1000 });
    // The room may not have flipped to running yet; the downbeat still counts.
    expect(resolvePlayhead(scheduled, undefined, 10_050)).toEqual({ mode: "running", downbeatServerTime: 10_000 });
    expect(resolvePlayhead({ ...scheduled, status: "running", startedServerTime: 10_000 }, undefined, 12_000))
      .toEqual({ mode: "running", downbeatServerTime: 10_000 });
  });

  it("freezes where a stop caught the song", () => {
    const stopped: TransportState = { status: "stopped", action: "stop", sequenceId: 4, scheduledServerTime: 15_000, stopReason: "manual" };
    expect(resolvePlayhead(stopped, { sequenceId: 3, downbeatServerTime: 10_000 }, 20_000))
      .toEqual({ mode: "stopped", downbeatServerTime: 10_000, stoppedAtServerTime: 15_000 });
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
