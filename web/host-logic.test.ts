import { describe, expect, it } from "vitest";

import {
  adjustCurrentIndexAfterRemoval,
  appliesToMuseScore,
  calculateClockSample,
  calculateJitterMs,
  canHostPlay,
  clampManualOffset,
  collectWarnings,
  formatElapsed,
  formatMs,
  formatSignedMs,
  formatSongMeta,
  getCalibrationKey,
  getReadyAdapters,
  getSongsterrUrl,
  getTimingQuality,
  isOpenableSong,
  median,
  nextSongIndex,
  normalizeSong,
  normalizeStoredSong,
  parseDurationInput,
  playBlockedReason,
  previousSongIndex,
  sanitizeDurationMs,
  summarizeClock
} from "./host-logic.js";

const readyAdapter = (overrides: Record<string, unknown> = {}) => ({
  id: "a1",
  deviceName: "MuseScore laptop",
  role: "desktop-adapter",
  status: { ready: true, app: "musescore" },
  ...overrides
});

const armedStoppedState = (clients: unknown[]) => ({
  transport: { status: "stopped" },
  safety: { armed: true },
  clients
});

describe("setlist navigation", () => {
  it("advances and wraps the next index", () => {
    expect(nextSongIndex(-1, 3)).toBe(0); // no selection -> first
    expect(nextSongIndex(0, 3)).toBe(1);
    expect(nextSongIndex(2, 3)).toBe(0); // wraps to the start
  });

  it("steps back and wraps the previous index", () => {
    expect(previousSongIndex(-1, 3)).toBe(2); // no selection -> last
    expect(previousSongIndex(0, 3)).toBe(2); // wraps to the end
    expect(previousSongIndex(2, 3)).toBe(1);
  });

  it("returns -1 for navigation on an empty setlist", () => {
    expect(nextSongIndex(-1, 0)).toBe(-1);
    expect(previousSongIndex(-1, 0)).toBe(-1);
  });

  it("adjusts the current index after a removal", () => {
    expect(adjustCurrentIndexAfterRemoval(1, 1)).toBe(-1); // removed the current song
    expect(adjustCurrentIndexAfterRemoval(3, 1)).toBe(2); // removed before current -> shift down
    expect(adjustCurrentIndexAfterRemoval(1, 3)).toBe(1); // removed after current -> unchanged
  });
});

describe("song normalization", () => {
  it("drops empty optional fields when normalizing for publish", () => {
    const result = normalizeSong({
      id: "s1",
      title: "Song",
      sourceType: "songsterr",
      source: "",
      songsterrUrl: "https://songsterr.com/x",
      museScoreSource: "",
      notes: ""
    });
    expect(result).toMatchObject({
      id: "s1",
      title: "Song",
      songsterrUrl: "https://songsterr.com/x"
    });
    expect(result?.source).toBeUndefined();
    expect(result?.notes).toBeUndefined();
    expect(result?.durationMs).toBeUndefined();
    expect(result?.durationSource).toBeUndefined();
  });

  it("keeps a duration source only when a usable duration is present", () => {
    expect(normalizeSong({ id: "1", title: "A", durationMs: 1000 })).toMatchObject({
      durationMs: 1000,
      durationSource: "manual"
    });
    expect(normalizeSong({ id: "1", title: "A", durationMs: 0 })?.durationSource).toBeUndefined();
  });

  it("rejects stored songs without a usable title", () => {
    expect(normalizeStoredSong({ title: "   " })).toBeUndefined();
    expect(normalizeStoredSong(null)).toBeUndefined();
    expect(normalizeStoredSong({})).toBeUndefined();
  });

  it("trims fields, defaults an unknown source type, and assigns an id", () => {
    const result = normalizeStoredSong({
      title: "  Tune  ",
      sourceType: "bandcamp",
      source: "  ref  ",
      notes: "  hi  "
    });
    expect(result).toMatchObject({ title: "Tune", sourceType: "other", source: "ref", notes: "hi" });
    expect(typeof result?.id).toBe("string");
    expect(result?.id).toBeTruthy();
  });

  it("preserves a valid adapter duration source from storage", () => {
    expect(normalizeStoredSong({ title: "A", durationMs: 2000, durationSource: "adapter" }))
      .toMatchObject({ durationMs: 2000, durationSource: "adapter" });
  });
});

describe("sanitizeDurationMs", () => {
  it("accepts positive in-range durations and rounds them", () => {
    expect(sanitizeDurationMs(1500.4)).toBe(1500);
    expect(sanitizeDurationMs("2000")).toBe(2000);
  });

  it("rejects non-positive, non-finite, and absurdly long values", () => {
    expect(sanitizeDurationMs(0)).toBeUndefined();
    expect(sanitizeDurationMs(-5)).toBeUndefined();
    expect(sanitizeDurationMs("abc")).toBeUndefined();
    expect(sanitizeDurationMs(25 * 60 * 60 * 1000)).toBeUndefined();
  });
});

describe("parseDurationInput", () => {
  it("parses mm:ss and h:mm:ss notation", () => {
    expect(parseDurationInput("3:45")).toBe(225_000);
    expect(parseDurationInput("0:30")).toBe(30_000);
    expect(parseDurationInput("1:02:03")).toBe(3_723_000);
  });

  it("parses a bare number as seconds", () => {
    expect(parseDurationInput("90")).toBe(90_000);
    expect(parseDurationInput(" 90 ")).toBe(90_000);
  });

  it("returns undefined for blank input", () => {
    expect(parseDurationInput("")).toBeUndefined();
    expect(parseDurationInput("   ")).toBeUndefined();
    expect(parseDurationInput(undefined)).toBeUndefined();
  });

  it("rejects malformed, out-of-range, and overflowing values", () => {
    expect(parseDurationInput("3:60")).toBeUndefined();
    expect(parseDurationInput("3:75")).toBeUndefined();
    expect(parseDurationInput("1:2:3:4")).toBeUndefined();
    expect(parseDurationInput("abc")).toBeUndefined();
    expect(parseDurationInput("3:4a")).toBeUndefined();
    expect(parseDurationInput("0:00")).toBeUndefined();
  });
});

describe("song source resolution", () => {
  it("prefers the dedicated Songsterr URL and validates the protocol", () => {
    expect(getSongsterrUrl({ songsterrUrl: "https://songsterr.com/a/wsa/x-s1" }))
      .toBe("https://songsterr.com/a/wsa/x-s1");
    expect(getSongsterrUrl({ sourceType: "songsterr", source: "javascript:alert(1)" })).toBe("");
    expect(getSongsterrUrl({ sourceType: "musescore", source: "https://songsterr.com/x" })).toBe("");
  });

  it("detects MuseScore applicability", () => {
    expect(appliesToMuseScore({ sourceType: "musescore" })).toBe(true);
    expect(appliesToMuseScore({ museScoreSource: "CCR/Bad Moon" })).toBe(true);
    expect(appliesToMuseScore({ sourceType: "songsterr" })).toBe(false);
    expect(appliesToMuseScore(undefined)).toBe(false);
  });

  it("treats a song as openable when any adapter can resolve it", () => {
    expect(isOpenableSong({ songsterrUrl: "https://songsterr.com/x" })).toBe(true);
    expect(isOpenableSong({ museScoreSource: "x" })).toBe(true);
    expect(isOpenableSong({ sourceType: "other", source: "notes" })).toBe(false);
    expect(isOpenableSong(undefined)).toBe(false);
  });
});

describe("clock math", () => {
  it("computes a non-negative rtt and the midpoint offset", () => {
    // client sent 0, got reply at 100; server received at 1050, sent at 1060.
    const sample = calculateClockSample(0, 100, 1050, 1060);
    expect(sample.rttMs).toBe(90); // 100 - 0 - (1060 - 1050)
    expect(sample.offsetMs).toBe(1005); // ((1050 - 0) + (1060 - 100)) / 2
  });

  it("clamps a negative rtt to zero", () => {
    expect(calculateClockSample(0, 0, 100, 200).rttMs).toBe(0);
  });

  it("summarizes using the lowest-rtt samples", () => {
    const samples = [
      { rttMs: 200, offsetMs: 50 },
      { rttMs: 10, offsetMs: 5 },
      { rttMs: 12, offsetMs: 7 }
    ];
    const summary = summarizeClock(samples);
    expect(summary.rttMs).toBe(12); // median of [10, 12, 200]
    expect(summary.offsetMs).toBe(7);
  });

  it("reports zero jitter with fewer than two samples", () => {
    expect(calculateJitterMs([{ rttMs: 10, offsetMs: 5 }])).toBe(0);
  });

  it("computes jitter as the median absolute deviation of offsets", () => {
    expect(calculateJitterMs([
      { rttMs: 10, offsetMs: 0 },
      { rttMs: 10, offsetMs: 10 },
      { rttMs: 10, offsetMs: 20 }
    ])).toBe(10);
  });

  it("returns the median for odd and even length lists", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(median([])).toBe(0);
  });
});

describe("calibration", () => {
  it("clamps manual offset to the supported range and rounds", () => {
    expect(clampManualOffset(1500)).toBe(1000);
    expect(clampManualOffset(-1500)).toBe(-1000);
    expect(clampManualOffset(12.6)).toBe(13);
    expect(clampManualOffset(Number.NaN)).toBe(0);
  });

  it("keys calibration by normalized device name", () => {
    expect(getCalibrationKey({ deviceName: "  MuseScore Laptop  " })).toBe("musescore laptop");
    expect(getCalibrationKey({})).toBe("");
  });

  it("grades timing quality from rtt and jitter", () => {
    expect(getTimingQuality(undefined).label).toBe("pending");
    expect(getTimingQuality({ rttMs: 50, jitterMs: 5 }).label).toBe("tight");
    expect(getTimingQuality({ rttMs: 120, jitterMs: 5 }).label).toBe("watch");
    expect(getTimingQuality({ rttMs: 50, jitterMs: 40 }).label).toBe("unstable");
  });
});

describe("transport and safety decisions", () => {
  it("lists only ready desktop adapters", () => {
    const state = {
      clients: [
        readyAdapter(),
        readyAdapter({ id: "a2", status: { ready: false } }),
        { id: "h", role: "host", status: { ready: true } }
      ]
    };
    expect(getReadyAdapters(state).map((d) => d.id)).toEqual(["a1"]);
    expect(getReadyAdapters(undefined)).toEqual([]);
  });

  it("allows play only when armed, stopped, and a ready adapter exists", () => {
    expect(canHostPlay(armedStoppedState([readyAdapter()]))).toBe(true);
    expect(canHostPlay(armedStoppedState([]))).toBe(false); // no ready adapter
    expect(canHostPlay({ ...armedStoppedState([readyAdapter()]), safety: { armed: false } })).toBe(false);
    expect(canHostPlay({ ...armedStoppedState([readyAdapter()]), transport: { status: "running" } })).toBe(false);
    expect(canHostPlay(undefined)).toBe(false);
  });

  it("explains why play is blocked, most-specific first", () => {
    expect(playBlockedReason(undefined)).toMatch(/not ready/);
    expect(playBlockedReason({ transport: { status: "running" }, safety: { armed: true }, clients: [] }))
      .toMatch(/already active/);
    expect(playBlockedReason(armedStoppedState([]))).toMatch(/No ready desktop adapter/);
    expect(playBlockedReason({ ...armedStoppedState([readyAdapter()]), safety: { armed: false } }))
      .toMatch(/Arm playback/);
  });
});

describe("collectWarnings", () => {
  it("warns when no desktop adapters are connected", () => {
    expect(collectWarnings({ clients: [] }, [], [])).toEqual([
      "No desktop adapters connected. Play will not control MuseScore or Songsterr yet."
    ]);
  });

  it("warns when adapters are connected but none are ready", () => {
    const adapter = readyAdapter({ status: { ready: false, detail: "starting up" } });
    const warnings = collectWarnings({}, [], [adapter]);
    expect(warnings).toContain("Desktop adapters are connected, but none are ready.");
    expect(warnings).toContain("MuseScore laptop: starting up");
  });

  it("flags high rtt, high jitter, and failed commands, de-duplicated", () => {
    const adapter = readyAdapter({
      clock: { rttMs: 200, jitterMs: 40 },
      status: { ready: true, lastCommand: { status: "failed", detail: "no window" } }
    });
    const warnings = collectWarnings({}, [adapter], [adapter]);
    expect(warnings).toContain("MuseScore laptop: high clock round trip (200 ms)");
    expect(warnings).toContain("MuseScore laptop: high clock jitter (40 ms)");
    expect(warnings).toContain("MuseScore laptop: no window");
    expect(new Set(warnings).size).toBe(warnings.length);
  });
});

describe("formatting", () => {
  it("formats elapsed milliseconds as mm:ss", () => {
    expect(formatElapsed(0)).toBe("00:00");
    expect(formatElapsed(65_000)).toBe("01:05");
    expect(formatElapsed(3_600_000)).toBe("60:00");
  });

  it("formats raw and signed millisecond readouts", () => {
    expect(formatMs(undefined)).toBe("--");
    expect(formatMs(12.4)).toBe("12 ms");
    expect(formatSignedMs(undefined)).toBe("--");
    expect(formatSignedMs(5)).toBe("+5 ms");
    expect(formatSignedMs(-5)).toBe("-5 ms");
    expect(formatSignedMs(0)).toBe("0 ms");
  });

  it("builds song meta with position, source, duration, and references", () => {
    expect(formatSongMeta({ sourceType: "songsterr", source: "ref" }, 1, 3))
      .toBe("1 / 3 - Songsterr - ref");
    expect(formatSongMeta({ sourceType: "musescore", durationMs: 65_000, durationSource: "adapter" }, 2, 4))
      .toBe("2 / 4 - MuseScore - 01:05 (adapter)");
    expect(formatSongMeta({ sourceType: "other" }, 0, 0)).toBe("setlist - Other");
  });
});
