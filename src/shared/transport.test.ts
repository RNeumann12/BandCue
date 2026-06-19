import { describe, expect, it } from "vitest";
import type { RoomClientSummary, TransportState } from "./protocol.js";
import { decideTransportRequest } from "./transport.js";

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
