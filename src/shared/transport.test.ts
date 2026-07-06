import { describe, expect, it } from "vitest";
import type { RoomClientSummary, TransportState } from "./protocol.js";
import {
  DEFAULT_SCHEDULE_DELAY_MS,
  MAX_SCHEDULE_DELAY_MS,
  decideTransportRequest,
  helixDelayMsForSong,
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
});

describe("Helix sync timing", () => {
  it("converts one 4/4 measure at 120 BPM to 2000 ms", () => {
    expect(helixDelayMsForSong({
      helixSyncEnabled: true,
      helixBpm: 120,
      helixBeatsPerMeasure: 4,
      helixTargetMeasure: 2,
      helixOffsetMs: 0
    })).toBe(2000);
  });

  it("converts one 3/4 measure at 100 BPM to 1800 ms", () => {
    expect(helixDelayMsForSong({
      helixSyncEnabled: true,
      helixBpm: 100,
      helixBeatsPerMeasure: 3,
      helixTargetMeasure: 2,
      helixOffsetMs: 0
    })).toBe(1800);
  });

  it("uses target measure three as two full measures after the trigger", () => {
    expect(helixDelayMsForSong({
      helixSyncEnabled: true,
      helixBpm: 120,
      helixBeatsPerMeasure: 4,
      helixTargetMeasure: 3,
      helixOffsetMs: 0
    })).toBe(4000);
  });

  it("applies signed offsets in both directions and clamps outliers", () => {
    expect(helixDelayMsForSong({
      helixSyncEnabled: true,
      helixBpm: 120,
      helixBeatsPerMeasure: 4,
      helixTargetMeasure: 2,
      helixOffsetMs: -80
    })).toBe(1920);
    expect(helixDelayMsForSong({
      helixSyncEnabled: true,
      helixBpm: 120,
      helixBeatsPerMeasure: 4,
      helixTargetMeasure: 2,
      helixOffsetMs: 6000
    })).toBe(7000);
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
