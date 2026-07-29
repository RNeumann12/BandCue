import { describe, expect, it } from "vitest";
import type { RoomClientSummary, TransportState } from "./protocol.js";
import {
  DEFAULT_SCHEDULE_DELAY_MS,
  HELIX_MAX_CUE_AGE_MS,
  HELIX_MIN_FLOOR_MS,
  MAX_SCHEDULE_DELAY_MS,
  decideTransportRequest,
  helixCueElapsedMs,
  helixDelayMsForSong,
  helixMinimumDelayMs,
  helixScheduleInfo,
  scheduleDelayForClients
} from "./transport.js";

const stopped: TransportState = { status: "stopped", sequenceId: 0 };

function client(overrides: Partial<RoomClientSummary> = {}): RoomClientSummary {
  return {
    id: "client-a",
    deviceName: "Device A",
    role: "desktop-adapter",
    connectedAt: 0,
    lastSeenAt: 0,
    capabilities: [{ app: "mock", canPlay: true, canStop: true }],
    status: { app: "mock", ready: true },
    ...overrides
  };
}

describe("transport decisions", () => {
  it("schedules play for a ready desktop adapter", () => {
    const decision = decideTransportRequest(stopped, client(), "play", 10_000, 1500);

    expect(decision.accepted).toBe(true);
    expect(decision.nextState).toMatchObject({
      status: "scheduled",
      leaderId: "client-a",
      sequenceId: 1,
      scheduledServerTime: 11_500
    });
  });

  it("rejects play from a non-ready companion", () => {
    const decision = decideTransportRequest(
      stopped,
      client({ role: "companion", status: { app: "mock", ready: false } }),
      "play",
      10_000
    );

    expect(decision.accepted).toBe(false);
  });

  it("ignores stop from a non-leader desktop while running", () => {
    const running: TransportState = {
      status: "running",
      leaderId: "leader",
      sequenceId: 4
    };
    const decision = decideTransportRequest(running, client({ id: "other" }), "stop", 20_000);

    expect(decision.accepted).toBe(false);
  });

  it("accepts stop from host", () => {
    const running: TransportState = {
      status: "running",
      leaderId: "leader",
      sequenceId: 4
    };
    const decision = decideTransportRequest(
      running,
      client({ id: "host", role: "host" }),
      "stop",
      20_000
    );

    expect(decision.accepted).toBe(true);
    expect(decision.nextState?.status).toBe("stopped");
  });

  it("requires arming when safety is enabled", () => {
    const decision = decideTransportRequest(
      stopped,
      client({ role: "host" }),
      "play",
      10_000,
      1500,
      { armed: false, controlMode: "host-only" }
    );

    expect(decision.accepted).toBe(false);
    expect(decision.reason).toContain("not armed");
  });

  it("allows anyone to stop in everyone-can-stop mode", () => {
    const running: TransportState = {
      status: "running",
      leaderId: "leader",
      sequenceId: 4
    };
    const decision = decideTransportRequest(
      running,
      client({ id: "other", role: "companion", capabilities: [] }),
      "stop",
      20_000,
      1500,
      { controlMode: "everyone-can-stop" }
    );

    expect(decision.accepted).toBe(true);
    expect(decision.nextState?.leaderId).toBe("other");
  });
});

describe("scheduleDelayForClients", () => {
  it("keeps the default delay for a healthy room", () => {
    const clients = [
      client({ clock: { rttMs: 20, offsetMs: 5, jitterMs: 3 } }),
      client({ id: "client-b", clock: { rttMs: 60, offsetMs: -10, jitterMs: 8 } })
    ];

    expect(scheduleDelayForClients(clients)).toBe(DEFAULT_SCHEDULE_DELAY_MS);
  });

  it("extends the count-in for a slow, jittery transport client", () => {
    const clients = [
      client({ clock: { rttMs: 20, offsetMs: 5, jitterMs: 3 } }),
      // needed = 600/2 + 80*4 + 1000 = 1620 > default 1500
      client({ id: "client-slow", clock: { rttMs: 600, offsetMs: 0, jitterMs: 80 } })
    ];

    expect(scheduleDelayForClients(clients)).toBe(1620);
  });

  it("ignores companions and clients without clock data", () => {
    const clients = [
      client({
        id: "companion",
        role: "companion",
        capabilities: [],
        clock: { rttMs: 2000, offsetMs: 0, jitterMs: 500 }
      }),
      client({ id: "no-clock", clock: undefined })
    ];

    expect(scheduleDelayForClients(clients)).toBe(DEFAULT_SCHEDULE_DELAY_MS);
  });

  it("caps the count-in for pathological outliers", () => {
    const clients = [
      client({ clock: { rttMs: 30_000, offsetMs: 0, jitterMs: 5000 } })
    ];

    expect(scheduleDelayForClients(clients)).toBe(MAX_SCHEDULE_DELAY_MS);
  });

  it("respects a larger configured default", () => {
    expect(scheduleDelayForClients([], 2500)).toBe(2500);
  });

  it("extends the count-in when an adapter reports a required lead time", () => {
    const clients = [
      // requiredLeadMs + the 1000 ms prep budget (2900) beats the default.
      client({ status: { app: "mock", ready: true, requiredLeadMs: 1900 } })
    ];

    expect(scheduleDelayForClients(clients)).toBe(2900);
  });

  it("caps a reported required lead time at the pathological-outlier ceiling", () => {
    const clients = [
      client({ status: { app: "mock", ready: true, requiredLeadMs: 20_000 } })
    ];

    expect(scheduleDelayForClients(clients)).toBe(MAX_SCHEDULE_DELAY_MS);
  });

  it("ignores a MuseScore adapter's required lead time when the song doesn't use MuseScore", () => {
    const clients = [
      client({
        capabilities: [{ app: "musescore", canPlay: true, canStop: true }],
        status: { app: "musescore", ready: true, requiredLeadMs: 4000 }
      })
    ];
    const helixOnlySong = { sourceType: "other" as const, helixSyncEnabled: true };

    expect(scheduleDelayForClients(clients, DEFAULT_SCHEDULE_DELAY_MS, helixOnlySong))
      .toBe(DEFAULT_SCHEDULE_DELAY_MS);
  });

  it("still honors a MuseScore adapter's required lead time when the song does use MuseScore", () => {
    const clients = [
      client({
        capabilities: [{ app: "musescore", canPlay: true, canStop: true }],
        status: { app: "musescore", ready: true, requiredLeadMs: 1900 }
      })
    ];
    const museScoreSong = { sourceType: "musescore" as const };

    expect(scheduleDelayForClients(clients, DEFAULT_SCHEDULE_DELAY_MS, museScoreSong)).toBe(2900);
  });
});

describe("Helix sync timing", () => {
  it("uses the configured number of complete 4/4 count-in measures", () => {
    expect(helixDelayMsForSong({
      helixSyncEnabled: true,
      helixBpm: 120,
      helixBeatsPerMeasure: 4,
      helixTargetMeasure: 2,
      helixOffsetMs: 0
    })).toBe(4000);
  });

  it("uses the configured number of complete 3/4 count-in measures", () => {
    expect(helixDelayMsForSong({
      helixSyncEnabled: true,
      helixBpm: 100,
      helixBeatsPerMeasure: 3,
      helixTargetMeasure: 2,
      helixOffsetMs: 0
    })).toBe(3600);
  });

  it("uses three full measures when the count-in is three", () => {
    expect(helixDelayMsForSong({
      helixSyncEnabled: true,
      helixBpm: 120,
      helixBeatsPerMeasure: 4,
      helixTargetMeasure: 3,
      helixOffsetMs: 0
    })).toBe(6000);
  });

  it("applies signed offsets in both directions and clamps outliers", () => {
    expect(helixDelayMsForSong({
      helixSyncEnabled: true,
      helixBpm: 120,
      helixBeatsPerMeasure: 4,
      helixTargetMeasure: 2,
      helixOffsetMs: -80
    })).toBe(3920);
    expect(helixDelayMsForSong({
      helixSyncEnabled: true,
      helixBpm: 120,
      helixBeatsPerMeasure: 4,
      helixTargetMeasure: 2,
      helixOffsetMs: 90_000
    })).toBe(64_000);
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

  it("subtracts the cue's travel time so the downbeat stays anchored to the cue", () => {
    // 2 measures at 120 BPM is 4000 ms after the *cue*; 60 ms of that is already
    // gone by the time the request is scheduled, so only 3940 ms are left.
    expect(helixDelayMsForSong({
      helixSyncEnabled: true,
      helixBpm: 120,
      helixBeatsPerMeasure: 4,
      helixTargetMeasure: 2,
      helixOffsetMs: 0
    }, 0, 60)).toBe(3940);
  });

  it("returns undefined for disabled or invalid Helix sync metadata", () => {
    expect(helixDelayMsForSong({ helixSyncEnabled: false })).toBeUndefined();
    expect(helixDelayMsForSong({
      helixSyncEnabled: true,
      helixBpm: 0,
      helixBeatsPerMeasure: 4,
      helixTargetMeasure: 2
    })).toBeUndefined();
    expect(helixDelayMsForSong({
      helixSyncEnabled: true,
      helixBpm: 120,
      helixBeatsPerMeasure: 0,
      helixTargetMeasure: 2
    })).toBeUndefined();
  });
});

describe("helixScheduleInfo", () => {
  it("reports zero extension when the requested delay already clears the floor", () => {
    expect(helixScheduleInfo({
      helixSyncEnabled: true,
      helixBpm: 120,
      helixBeatsPerMeasure: 4,
      helixTargetMeasure: 2,
      helixOffsetMs: -80
    }, 1500)).toMatchObject({
      requestedDelayMs: 3920,
      minimumDelayMs: 1500,
      appliedDelayMs: 3920,
      extendedMs: 0
    });
  });

  it("reports how far a too-early request got held to the floor, without adding a whole measure", () => {
    expect(helixScheduleInfo({
      helixSyncEnabled: true,
      helixBpm: 200,
      helixBeatsPerMeasure: 4,
      helixTargetMeasure: 1,
      helixOffsetMs: -1000
    }, 1500)).toMatchObject({
      requestedDelayMs: 200,
      minimumDelayMs: 1500,
      appliedDelayMs: 1500,
      extendedMs: 1300
    });
  });

  it("reports the cue latency it took off the count-in", () => {
    expect(helixScheduleInfo({
      helixSyncEnabled: true,
      helixBpm: 120,
      helixBeatsPerMeasure: 4,
      helixTargetMeasure: 1,
      helixOffsetMs: 0
    }, 1400, 45)).toMatchObject({
      countInMs: 2000,
      cueLatencyMs: 45,
      requestedDelayMs: 1955,
      minimumDelayMs: 1400,
      appliedDelayMs: 1955,
      extendedMs: 0
    });
  });

  it("returns undefined for disabled or invalid Helix sync metadata", () => {
    expect(helixScheduleInfo({ helixSyncEnabled: false })).toBeUndefined();
  });
});

describe("helixCueElapsedMs", () => {
  it("reports how long the cue spent reaching the coordinator", () => {
    expect(helixCueElapsedMs(10_000, 10_042)).toBe(42);
  });

  it("ignores a missing, future, or implausibly old stamp", () => {
    // No stamp, or a clock estimate that puts the cue ahead of now: fall back to
    // timing the count-in from now, which is what the room did before.
    expect(helixCueElapsedMs(undefined, 10_000)).toBe(0);
    expect(helixCueElapsedMs(Number.NaN, 10_000)).toBe(0);
    expect(helixCueElapsedMs(10_050, 10_000)).toBe(0);
    // A stale page or a clock step would otherwise "reclaim" seconds and start
    // the whole room far too early.
    expect(helixCueElapsedMs(0, 60_000)).toBe(HELIX_MAX_CUE_AGE_MS);
  });
});

describe("helixMinimumDelayMs", () => {
  it("does not round a Helix start up to the comfortable default count-in", () => {
    // Nothing in the room reports a need, so the Helix's own count-in decides.
    expect(helixMinimumDelayMs([client({ status: undefined, clock: undefined })]))
      .toBe(HELIX_MIN_FLOOR_MS);
    expect(HELIX_MIN_FLOOR_MS).toBeLessThan(DEFAULT_SCHEDULE_DELAY_MS);
  });

  it("still covers a device's own measured lead requirement", () => {
    expect(helixMinimumDelayMs([
      client({ status: { app: "mock", ready: true, requiredLeadMs: 1800 }, clock: undefined })
    ])).toBe(2800);
  });
});
