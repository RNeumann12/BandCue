import { describe, expect, it } from "vitest";

import {
  adjustCurrentIndexAfterRemoval,
  appliesToMuseScore,
  appliesToSongsterr,
  calculateClockSample,
  calculateJitterMs,
  canHostPlay,
  clampHelixOffsetMs,
  clampManualOffset,
  collectWarnings,
  DEFAULT_HOST_HOTKEYS,
  applyGlobalHelixSettings,
  formatElapsed,
  formatMs,
  formatSignedMs,
  formatSongMeta,
  getCalibrationKey,
  getReadyAdapters,
  getSongsterrUrl,
  getTimingQuality,
  helixDelayMsForSong,
  helixLeadReadiness,
  helixMinimumDelayMs,
  hostCueServerTime,
  HELIX_MIN_FLOOR_MS,
  HOTKEY_CUE_MAX_AGE_MS,
  hostHotkeyActionForEvent,
  isOpenableSong,
  median,
  nextSongIndex,
  normalizeSong,
  normalizeStoredSong,
  parseDurationInput,
  playBlockedReason,
  previousSongIndex,
  sanitizeDurationMs,
  sanitizeTempoPercent,
  effectiveDurationMs,
  sanitizeHelixBpm,
  setlistLoadDecision,
  shouldAdvanceSetlistOnStop,
  normalizeAutoRunSettings,
  describeAutoRun,
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
  it("defaults and constrains per-song tempo", () => {
    expect(sanitizeTempoPercent(undefined)).toBe(100);
    expect(sanitizeTempoPercent(92.4)).toBe(92);
    expect(sanitizeTempoPercent(5)).toBe(15);
    expect(sanitizeTempoPercent(300)).toBe(175);
    expect(normalizeStoredSong({ title: "Zombie", sourceType: "songsterr" })?.tempoPercent).toBe(100);
  });

  it("scales a base duration by tempo", () => {
    expect(effectiveDurationMs(240_000, 80)).toBe(300_000);
    expect(effectiveDurationMs(240_000, 120)).toBe(200_000);
  });
  it("drops empty optional fields when normalizing for publish", () => {
    const result = normalizeSong({
      id: "s1",
      title: "Song",
      sourceType: "songsterr",
      source: "",
      songsterrUrl: "https://songsterr.com/x",
      songsterrBassUrl: "https://songsterr.com/bass",
      songsterrDrumUrl: "",
      museScoreSource: "",
      notes: ""
    });
    expect(result).toMatchObject({
      id: "s1",
      title: "Song",
      songsterrUrl: "https://songsterr.com/x",
      songsterrBassUrl: "https://songsterr.com/bass"
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

  it("preserves Helix sync metadata from storage", () => {
    expect(normalizeStoredSong({
      title: "A",
      helixSyncEnabled: true,
      helixBpm: 123.456,
      helixBeatsPerMeasure: 3,
      helixTargetMeasure: 2,
      helixOffsetMs: -80
    })).toMatchObject({
      helixSyncEnabled: true,
      helixBpm: 123.46,
      helixBeatsPerMeasure: 3,
      helixTargetMeasure: 2,
      helixOffsetMs: -80
    });
  });

  it("defaults old stored songs to Helix sync disabled", () => {
    expect(normalizeStoredSong({ title: "Old song" })).toMatchObject({
      helixSyncEnabled: false,
      helixBeatsPerMeasure: 4,
      helixTargetMeasure: 2,
      helixOffsetMs: 0
    });
  });

  it("keeps a start measure from storage and treats the top of the song as none", () => {
    expect(normalizeStoredSong({ title: "A", startMeasure: 8 })).toMatchObject({ startMeasure: 8 });
    expect(normalizeStoredSong({ title: "A", startMeasure: 1 })?.startMeasure).toBeUndefined();
    expect(normalizeStoredSong({ title: "A", startMeasure: 0 })?.startMeasure).toBeUndefined();
    expect(normalizeStoredSong({ title: "A", startMeasure: 5000 })?.startMeasure).toBeUndefined();
    expect(normalizeStoredSong({ title: "A" })?.startMeasure).toBeUndefined();
    expect(normalizeSong({ id: "1", title: "A", startMeasure: 8.4 })).toMatchObject({ startMeasure: 8 });
  });

  it("trims alternate Songsterr URLs from storage", () => {
    expect(normalizeStoredSong({
      title: "A",
      songsterrBassUrl: " https://songsterr.com/bass ",
      songsterrDrumUrl: " https://songsterr.com/drums "
    })).toMatchObject({
      songsterrBassUrl: "https://songsterr.com/bass",
      songsterrDrumUrl: "https://songsterr.com/drums"
    });
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

  it("detects Songsterr applicability from alternate instrument URLs", () => {
    expect(appliesToSongsterr({ sourceType: "other", songsterrDrumUrl: "https://songsterr.com/drums" })).toBe(true);
    expect(appliesToSongsterr({ sourceType: "other" })).toBe(false);
  });

  it("treats a song as openable when any adapter can resolve it", () => {
    expect(isOpenableSong({ songsterrUrl: "https://songsterr.com/x" })).toBe(true);
    expect(isOpenableSong({ sourceType: "other", songsterrDrumUrl: "https://songsterr.com/drums" })).toBe(true);
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
    expect(summary.offsetMs).toBe(5); // offset of the single lowest-rtt sample (rtt 10)
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
    expect(clampManualOffset(6000)).toBe(5000);
    expect(clampManualOffset(-6000)).toBe(-5000);
    expect(clampManualOffset(1500)).toBe(1500);
    expect(clampManualOffset(12.6)).toBe(13);
    expect(clampManualOffset(Number.NaN)).toBe(0);
  });

  it("keys calibration by normalized device name", () => {
    expect(getCalibrationKey({ deviceName: "  MuseScore Laptop  " })).toBe("musescore laptop");
    expect(getCalibrationKey({})).toBe("");
  });

  it("grades timing quality from rtt and jitter", () => {
    expect(getTimingQuality(undefined).label).toBe("pending");
    // Below the sample threshold the offset isn't trustworthy yet.
    expect(getTimingQuality({ rttMs: 50, jitterMs: 5, sampleCount: 1 }).label).toBe("syncing…");
    // Once enough samples are in, grade purely on rtt/jitter.
    expect(getTimingQuality({ rttMs: 50, jitterMs: 5, sampleCount: 10 }).label).toBe("tight");
    expect(getTimingQuality({ rttMs: 120, jitterMs: 5, sampleCount: 10 }).label).toBe("watch");
    expect(getTimingQuality({ rttMs: 50, jitterMs: 40, sampleCount: 10 }).label).toBe("unstable");
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

describe("Helix sync timing", () => {
  it("sanitizes BPM with the supported range and precision", () => {
    expect(sanitizeHelixBpm(123.456)).toBe(123.46);
    expect(sanitizeHelixBpm(19.9)).toBeUndefined();
    expect(sanitizeHelixBpm(401)).toBeUndefined();
    expect(sanitizeHelixBpm("abc")).toBeUndefined();
  });

  it("converts complete count-in measures to milliseconds and applies signed offset", () => {
    expect(helixDelayMsForSong({
      helixSyncEnabled: true,
      helixBpm: 120,
      helixBeatsPerMeasure: 4,
      helixTargetMeasure: 2,
      helixOffsetMs: 0
    })).toBe(4000);
    expect(helixDelayMsForSong({
      helixSyncEnabled: true,
      helixBpm: 100,
      helixBeatsPerMeasure: 3,
      helixTargetMeasure: 2,
      helixOffsetMs: 0
    })).toBe(3600);
    expect(helixDelayMsForSong({
      helixSyncEnabled: true,
      helixBpm: 120,
      helixBeatsPerMeasure: 4,
      helixTargetMeasure: 3,
      helixOffsetMs: -80
    })).toBe(5920);
  });

  it("holds a too-early offset to exactly the room's floor, never a whole extra measure", () => {
    expect(helixDelayMsForSong({
      helixSyncEnabled: true,
      helixBpm: 200,
      helixBeatsPerMeasure: 4,
      helixTargetMeasure: 1,
      helixOffsetMs: -1000
    }, 1500)).toBe(1500);
  });

  it("supports large Helix shifts independently of device calibration", () => {
    expect(clampHelixOffsetMs(45_000)).toBe(45_000);
    expect(clampHelixOffsetMs(90_000)).toBe(60_000);
    expect(clampHelixOffsetMs(-90_000)).toBe(-60_000);
  });

  it("combines the global Helix master and offset with song timing", () => {
    const song = {
      id: "song-1",
      title: "Global timing",
      sourceType: "other",
      helixSyncEnabled: true,
      helixOffsetMs: -250
    };
    expect(applyGlobalHelixSettings(song, { enabled: true, offsetMs: 1000 })).toMatchObject({
      helixSyncEnabled: true,
      helixOffsetMs: 750
    });
    expect(applyGlobalHelixSettings(song, { enabled: false, offsetMs: 1000 })).toMatchObject({
      helixSyncEnabled: false,
      helixOffsetMs: 750
    });
  });

  it("returns undefined when Helix sync is disabled or incomplete", () => {
    expect(helixDelayMsForSong({ helixSyncEnabled: false })).toBeUndefined();
    expect(helixDelayMsForSong({
      helixSyncEnabled: true,
      helixBeatsPerMeasure: 4,
      helixTargetMeasure: 2
    })).toBeUndefined();
  });
});

describe("Helix lead requirement", () => {
  const helixSong = (overrides: Record<string, unknown> = {}) => ({
    id: "song-1",
    title: "Helix Song",
    sourceType: "songsterr",
    source: "https://songsterr.test/song",
    helixSyncEnabled: true,
    helixBpm: 120,
    helixBeatsPerMeasure: 4,
    helixTargetMeasure: 1,
    helixOffsetMs: 0,
    ...overrides
  });

  const roomWith = (status: Record<string, unknown>, clock = { rttMs: 20, jitterMs: 4 }) => ({
    clients: [{
      id: "a1",
      role: "desktop-adapter",
      capabilities: [{ app: "songsterr", canPlay: true, canStop: true }],
      status,
      clock
    }]
  });

  it("mirrors the coordinator's floor: device need, not the default count-in", () => {
    expect(helixMinimumDelayMs({ clients: [] })).toBe(HELIX_MIN_FLOOR_MS);
    expect(helixMinimumDelayMs(roomWith({ ready: true, requiredLeadMs: 400 }))).toBe(1400);
    expect(helixMinimumDelayMs(roomWith({ ready: true, requiredLeadMs: 2500 }))).toBe(3500);
  });

  it("ignores an adapter the song never uses", () => {
    const museScoreRoom = {
      clients: [{
        id: "a1",
        role: "desktop-adapter",
        capabilities: [{ app: "musescore", canPlay: true, canStop: true }],
        status: { ready: true, requiredLeadMs: 4000 },
        clock: { rttMs: 20, jitterMs: 4 }
      }]
    };
    // Skipped entirely -- an idle MuseScore adapter has nothing to prep for a
    // Songsterr song, so neither its lead nor its link quality bounds the start.
    expect(helixMinimumDelayMs(museScoreRoom, helixSong())).toBe(HELIX_MIN_FLOOR_MS);
  });

  it("reports spare lead time when the count-in clears the room's floor", () => {
    // One 4/4 measure at 120 BPM is 2000 ms; the room needs 1400 ms.
    expect(helixLeadReadiness(roomWith({ ready: true, requiredLeadMs: 400 }), helixSong()))
      .toMatchObject({
        countInMs: 2000,
        minimumDelayMs: 1400,
        spareMs: 600,
        measuresNeeded: 1,
        ok: true
      });
  });

  it("says how many count-in measures a too-short count-in needs", () => {
    // The room needs 3500 ms, so one 2000 ms measure is 1500 ms short and two
    // measures are the smallest count-in that lands on the Helix downbeat.
    expect(helixLeadReadiness(roomWith({ ready: true, requiredLeadMs: 2500 }), helixSong()))
      .toMatchObject({
        countInMs: 2000,
        minimumDelayMs: 3500,
        spareMs: -1500,
        measuresNeeded: 2,
        ok: false
      });
  });

  it("counts a negative song trim against the available count-in", () => {
    expect(helixLeadReadiness(
      roomWith({ ready: true, requiredLeadMs: 400 }),
      helixSong({ helixTargetMeasure: 2, helixOffsetMs: -2500 })
    )).toMatchObject({
      countInMs: 1500,
      minimumDelayMs: 1400,
      measuresNeeded: 2,
      ok: true
    });
  });

  it("returns undefined without Helix sync or without the numbers to judge", () => {
    expect(helixLeadReadiness(roomWith({ ready: true }), undefined)).toBeUndefined();
    expect(helixLeadReadiness(roomWith({ ready: true }), helixSong({ helixSyncEnabled: false })))
      .toBeUndefined();
    expect(helixLeadReadiness(roomWith({ ready: true }), helixSong({ helixBpm: undefined })))
      .toBeUndefined();
  });
});

describe("hostCueServerTime", () => {
  it("stamps the keystroke instant in room time", () => {
    expect(hostCueServerTime({
      eventTimeStampMs: 5_000,
      timeOriginMs: 1_000_000,
      localNowMs: 1_005_030,
      serverOffsetMs: 250
    })).toBe(1_005_250);
  });

  it("falls back to now for a stamp that is synthetic, future, or too old", () => {
    const base = {
      timeOriginMs: 1_000_000,
      localNowMs: 1_005_030,
      serverOffsetMs: 250
    };
    expect(hostCueServerTime({ ...base, eventTimeStampMs: undefined })).toBe(1_005_280);
    expect(hostCueServerTime({ ...base, eventTimeStampMs: 6_000 })).toBe(1_005_280);
    expect(hostCueServerTime({
      ...base,
      eventTimeStampMs: 5_030 - HOTKEY_CUE_MAX_AGE_MS - 1
    })).toBe(1_005_280);
  });

  it("sends no stamp at all until the clock offset is trustworthy", () => {
    expect(hostCueServerTime({
      eventTimeStampMs: 5_000,
      timeOriginMs: 1_000_000,
      localNowMs: 1_005_030,
      serverOffsetMs: undefined
    })).toBeUndefined();
  });
});

describe("host hotkeys", () => {
  const eventFor = (key: string, overrides: Record<string, unknown> = {}) => ({
    key,
    ctrlKey: true,
    altKey: true,
    shiftKey: false,
    metaKey: false,
    repeat: false,
    ...overrides
  });

  it("maps every default host hotkey action", () => {
    for (const hotkey of DEFAULT_HOST_HOTKEYS) {
      expect(hostHotkeyActionForEvent(eventFor(hotkey.key.toUpperCase()))).toBe(hotkey.action);
    }
  });

  it("requires the exact modifier combination", () => {
    expect(hostHotkeyActionForEvent(eventFor("p", { ctrlKey: false }))).toBeUndefined();
    expect(hostHotkeyActionForEvent(eventFor("p", { altKey: false }))).toBeUndefined();
    expect(hostHotkeyActionForEvent(eventFor("p", { shiftKey: true }))).toBeUndefined();
    expect(hostHotkeyActionForEvent(eventFor("p", { metaKey: true }))).toBeUndefined();
  });

  it("ignores repeated keydown events and common conflicting shortcuts", () => {
    expect(hostHotkeyActionForEvent(eventFor("p", { repeat: true }))).toBeUndefined();
    expect(hostHotkeyActionForEvent(eventFor("s", { altKey: false, shiftKey: true }))).toBeUndefined();
  });

  it("ignores editable targets", () => {
    expect(hostHotkeyActionForEvent(eventFor("p", { target: { tagName: "INPUT" } }))).toBeUndefined();
    expect(hostHotkeyActionForEvent(eventFor("p", { target: { tagName: "select" } }))).toBeUndefined();
    expect(hostHotkeyActionForEvent(eventFor("p", { target: { tagName: "textarea" } }))).toBeUndefined();
    expect(hostHotkeyActionForEvent(eventFor("p", { target: { isContentEditable: true } }))).toBeUndefined();
    expect(hostHotkeyActionForEvent(eventFor("p", {
      target: {
        tagName: "SPAN",
        closest: (selector: string) => selector.includes("contenteditable")
      }
    }))).toBeUndefined();
  });

  it("returns undefined for non-hotkey events", () => {
    expect(hostHotkeyActionForEvent(undefined)).toBeUndefined();
    expect(hostHotkeyActionForEvent(eventFor("x"))).toBeUndefined();
  });
});

describe("setlistLoadDecision", () => {
  const options = { needsAdapter: true, elapsedMs: 0, settleMs: 4500, timeoutMs: 20000 };
  const readyState = { transport: { status: "stopped" }, clients: [readyAdapter()] };

  it("waits while the transport is still active", () => {
    expect(setlistLoadDecision({ transport: { status: "running" }, clients: [readyAdapter()] }, { ...options, elapsedMs: 9999 }))
      .toBe("wait");
  });

  it("plays immediately when the song needs no adapter", () => {
    expect(setlistLoadDecision({ transport: { status: "stopped" }, clients: [] }, { ...options, needsAdapter: false }))
      .toBe("play");
  });

  it("waits, then times out, when no adapter becomes ready", () => {
    const noAdapters = { transport: { status: "stopped" }, clients: [] };
    expect(setlistLoadDecision(noAdapters, { ...options, elapsedMs: 5000 })).toBe("wait");
    expect(setlistLoadDecision(noAdapters, { ...options, elapsedMs: 20000 })).toBe("timeout");
  });

  it("waits for the settle window once an adapter is ready, then plays", () => {
    expect(setlistLoadDecision(readyState, { ...options, elapsedMs: 1000 })).toBe("wait");
    expect(setlistLoadDecision(readyState, { ...options, elapsedMs: 4500 })).toBe("play");
  });
});

describe("shouldAdvanceSetlistOnStop", () => {
  it("advances only for automatic end-of-song stop reasons", () => {
    expect(shouldAdvanceSetlistOnStop({
      transport: { status: "stopped", stopReason: "auto-duration" }
    }, "running")).toBe(true);
    expect(shouldAdvanceSetlistOnStop({
      transport: { status: "stopped", stopReason: "auto-playback-ended" }
    }, "running")).toBe(true);
    expect(shouldAdvanceSetlistOnStop({
      transport: { status: "stopped", stopReason: "manual" }
    }, "running")).toBe(false);
    expect(shouldAdvanceSetlistOnStop({
      transport: { status: "stopped", stopReason: "leader-disconnect" }
    }, "running")).toBe(false);
    expect(shouldAdvanceSetlistOnStop({
      transport: { status: "stopped", stopReason: "auto-duration" }
    }, "scheduled")).toBe(false);
  });
});

describe("normalizeAutoRunSettings", () => {
  it("defaults to manual advancing with auto-start pre-armed", () => {
    expect(normalizeAutoRunSettings(undefined)).toEqual({ advance: false, start: true });
    expect(normalizeAutoRunSettings({})).toEqual({ advance: false, start: true });
  });

  it("keeps the two switches independent so auto-start survives an auto-load toggle", () => {
    expect(normalizeAutoRunSettings({ advance: true, start: false })).toEqual({ advance: true, start: false });
    expect(normalizeAutoRunSettings({ advance: false, start: false })).toEqual({ advance: false, start: false });
  });

  it("coerces junk from storage", () => {
    expect(normalizeAutoRunSettings({ advance: "yes", start: 0 })).toEqual({ advance: true, start: true });
  });
});

describe("describeAutoRun", () => {
  it("describes each combination", () => {
    expect(describeAutoRun({ advance: false, start: true })).toContain("Manual");
    expect(describeAutoRun({ advance: true, start: true })).toContain("start it");
    expect(describeAutoRun({ advance: true, start: false })).toContain("wait for Play");
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

describe("start-measure warnings", () => {
  const state = (startMeasure: number | undefined, sequenceId = 4) => ({
    currentSong: { song: { title: "A", sourceType: "songsterr", startMeasure } },
    transport: { sequenceId }
  });
  const adapter = (startMeasure: number | undefined, sequenceId = 4) => readyAdapter({
    status: {
      ready: true,
      lastCommand: { action: "play", status: "succeeded", sequenceId, startMeasure }
    }
  });

  it("warns when a device started somewhere else than the song asked for", () => {
    expect(collectWarnings(state(8), [adapter(1)], [adapter(1)])).toContain(
      "MuseScore laptop: started from measure 1, not 8 - this device is playing a different part of the song."
    );
  });

  it("stays quiet when the device reached the requested measure", () => {
    expect(collectWarnings(state(8), [adapter(8)], [adapter(8)])).not.toContain(
      "MuseScore laptop: started from measure 1, not 8 - this device is playing a different part of the song."
    );
  });

  it("ignores a report from an earlier play and songs without a start measure", () => {
    expect(collectWarnings(state(8), [adapter(1, 3)], [adapter(1, 3)]).join()).not.toContain("different part");
    expect(collectWarnings(state(undefined), [adapter(1)], [adapter(1)]).join()).not.toContain("different part");
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
      .toBe("1 / 3 - Songsterr - 100% tempo - ref");
    expect(formatSongMeta({ sourceType: "musescore", durationMs: 65_000, durationSource: "adapter" }, 2, 4))
      .toBe("2 / 4 - MuseScore - 100% tempo - 01:05 (adapter)");
    expect(formatSongMeta({ sourceType: "other" }, 0, 0)).toBe("setlist - Other - 100% tempo");
  });

  it("says which measure a song starts from", () => {
    expect(formatSongMeta({ sourceType: "songsterr", startMeasure: 8 }, 1, 2))
      .toBe("1 / 2 - Songsterr - 100% tempo - from measure 8");
    expect(formatSongMeta({ sourceType: "songsterr", startMeasure: 1 }, 1, 2))
      .toBe("1 / 2 - Songsterr - 100% tempo");
  });

  it("includes Helix sync timing in song meta", () => {
    expect(formatSongMeta({
      sourceType: "other",
      helixSyncEnabled: true,
      helixBpm: 120,
      helixBeatsPerMeasure: 4,
      helixTargetMeasure: 2,
      helixOffsetMs: -80
    }, 1, 1)).toBe("1 / 1 - Other - 100% tempo - Helix: 120 BPM, 4/4, 2-measure count-in, -80 ms");
  });
});
