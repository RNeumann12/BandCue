import { describe, expect, it } from "vitest";
import { decideTransportReconciliation, MIN_RECONCILE_LEAD_MS } from "./transport-reconcile.js";

const scheduledPlay = { status: "scheduled" as const, action: "play" as const, sequenceId: 5, scheduledServerTime: 10_000 };

describe("decideTransportReconciliation", () => {
  it("resets tracking when the coordinator restarted and the sequence went backwards", () => {
    expect(decideTransportReconciliation({
      transport: { status: "stopped", sequenceId: 0 },
      lastSequenceId: 9
    })).toEqual({ kind: "reset-tracking" });
  });

  it("does nothing for a sequence already handled", () => {
    expect(decideTransportReconciliation({ transport: scheduledPlay, lastSequenceId: 5, playLeadMs: 1000 }))
      .toEqual({ kind: "none" });
  });

  it("waits for a clock sample before judging a missed play", () => {
    expect(decideTransportReconciliation({ transport: scheduledPlay, lastSequenceId: 4 }))
      .toEqual({ kind: "wait-for-clock" });
  });

  it("joins a missed play with enough count-in left", () => {
    expect(decideTransportReconciliation({
      transport: scheduledPlay,
      lastSequenceId: 4,
      playLeadMs: MIN_RECONCILE_LEAD_MS
    })).toEqual({ kind: "schedule-play" });
  });

  it("skips a missed play that is too close to its downbeat", () => {
    expect(decideTransportReconciliation({
      transport: scheduledPlay,
      lastSequenceId: 4,
      playLeadMs: MIN_RECONCILE_LEAD_MS - 1
    })).toEqual({ kind: "adopt-sequence" });
  });

  it("executes a missed manual stop only when this adapter was playing", () => {
    const stopped = { status: "stopped" as const, action: "stop" as const, sequenceId: 6, stopReason: "manual" as const };
    expect(decideTransportReconciliation({ transport: stopped, lastSequenceId: 5, lastAction: "play" }))
      .toEqual({ kind: "execute-stop" });
    expect(decideTransportReconciliation({ transport: stopped, lastSequenceId: 5, lastAction: "stop" }))
      .toEqual({ kind: "adopt-sequence" });
  });

  it("never replays an automatic stop", () => {
    expect(decideTransportReconciliation({
      transport: { status: "stopped", action: "stop", sequenceId: 6, stopReason: "auto-duration" },
      lastSequenceId: 5,
      lastAction: "play"
    })).toEqual({ kind: "adopt-sequence" });
  });

  it("adopts a running song it cannot join cleanly", () => {
    expect(decideTransportReconciliation({
      transport: { status: "running", action: "play", sequenceId: 6, scheduledServerTime: 1 },
      lastSequenceId: 5,
      playLeadMs: -5000
    })).toEqual({ kind: "adopt-sequence" });
  });
});
