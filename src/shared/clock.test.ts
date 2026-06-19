import { describe, expect, it } from "vitest";
import {
  calculateClockSample,
  calculateJitterMs,
  delayUntilServerTime,
  summarizeClock
} from "./clock.js";

describe("clock sync", () => {
  it("calculates offset and round trip time from NTP-style timestamps", () => {
    const sample = calculateClockSample(1000, 1100, 1055, 1060);

    expect(sample.rttMs).toBe(95);
    expect(sample.offsetMs).toBe(7.5);
  });

  it("uses the lowest-rtt samples for the summary", () => {
    const summary = summarizeClock([
      { rttMs: 100, offsetMs: 30 },
      { rttMs: 20, offsetMs: 10 },
      { rttMs: 25, offsetMs: 12 },
      { rttMs: 500, offsetMs: 200 }
    ]);

    expect(summary.rttMs).toBe(62.5);
    expect(summary.offsetMs).toBe(21);
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
});
