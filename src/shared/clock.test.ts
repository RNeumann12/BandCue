import { describe, expect, it } from "vitest";
import {
  blendOffset,
  calculateClockSample,
  calculateJitterMs,
  CLOCK_OFFSET_JUMP_MS,
  delayUntilServerTime,
  isClockConverged,
  summarizeClock
} from "./clock.js";

describe("clock sync", () => {
  it("calculates offset and round trip time from NTP-style timestamps", () => {
    const sample = calculateClockSample(1000, 1100, 1055, 1060);

    expect(sample.rttMs).toBe(95);
    expect(sample.offsetMs).toBe(7.5);
  });

  it("takes the offset from the single lowest-rtt sample", () => {
    const summary = summarizeClock([
      { rttMs: 100, offsetMs: 30 },
      { rttMs: 20, offsetMs: 10 },
      { rttMs: 25, offsetMs: 12 },
      { rttMs: 500, offsetMs: 200 }
    ]);

    // RTT is still the median of the best samples for the quality gauge...
    expect(summary.rttMs).toBe(62.5);
    // ...but the offset is the cleanest round trip (rtt 20 -> offset 10).
    expect(summary.offsetMs).toBe(10);
  });

  it("returns a zeroed summary for no samples", () => {
    expect(summarizeClock([])).toEqual({ rttMs: 0, offsetMs: 0 });
  });

  it("converts scheduled server time to a local timeout delay", () => {
    expect(delayUntilServerTime(10_000, 8_000, 1_000)).toBe(1_000);
    expect(delayUntilServerTime(10_000, 12_000, 0)).toBe(0);
  });

  it("calculates jitter from offset variation", () => {
    expect(calculateJitterMs([
      { rttMs: 20, offsetMs: 10 },
      { rttMs: 21, offsetMs: 12 },
      { rttMs: 19, offsetMs: 15 }
    ])).toBe(2);
  });

  describe("blendOffset", () => {
    it("adopts the first measurement outright", () => {
      expect(blendOffset(undefined, 2000)).toBe(2000);
    });

    it("eases small changes in to damp jitter", () => {
      // 100 -> 120 with 0.3 smoothing lands at 106, not the full 120.
      expect(blendOffset(100, 120, 0.3)).toBeCloseTo(106);
    });

    it("adopts a large jump immediately (real clock step)", () => {
      const next = 100 + CLOCK_OFFSET_JUMP_MS + 50;
      expect(blendOffset(100, next)).toBe(next);
    });
  });

  describe("isClockConverged", () => {
    it("requires enough samples and acceptable jitter", () => {
      expect(isClockConverged(5, 10)).toBe(true);
      expect(isClockConverged(2, 10)).toBe(false);
      expect(isClockConverged(10, 40)).toBe(false);
    });
  });
});
