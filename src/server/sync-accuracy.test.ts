import { describe, expect, it } from "vitest";
import { RoomController } from "./room.js";
import {
  CLOCK_SAMPLE_WINDOW,
  CLOCK_WARMUP_SAMPLES,
  blendOffset,
  calculateClockSample,
  delayUntilServerTime,
  summarizeClock,
  type ClockSample
} from "../shared/clock.js";
import type { ServerMessage, TransportCommand } from "../shared/protocol.js";

/**
 * End-to-end sync-accuracy harness: the thing BandCue exists for is that all
 * devices start within a tight window of each other. This drives the real
 * RoomController and the real shared clock-estimator pipeline
 * (calculateClockSample / summarizeClock / blendOffset / delayUntilServerTime)
 * with simulated clients behind jittery, spiky network paths and skewed device
 * clocks, then asserts the achieved start spread stays inside the budget.
 *
 * All randomness is seeded, so failures reproduce deterministically. If a
 * change to the clock or scheduling code breaks these budgets, it made real
 * rehearsal sync worse -- fix the change, not the budget.
 */

// Budgets (ms). The estimator picks the lowest-RTT sample, so with symmetric
// base latency the residual error is a few ms of jitter asymmetry per client.
const MAX_START_SPREAD_MS = 30;
const MAX_ABSOLUTE_DEVIATION_MS = 20;

function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

interface SimClient {
  id: string;
  name: string;
  /** True device-clock offset: serverTime = clientTime + trueOffsetMs. */
  trueOffsetMs: number;
  estOffsetMs: number | undefined;
  samples: ClockSample[];
  messages: ServerMessage[];
  /** One-way network latency draw for this client's path. */
  latency: () => number;
}

function makeSocket(messages: ServerMessage[]): never {
  return {
    readyState: 1,
    OPEN: 1,
    send: (data: string) => {
      messages.push(JSON.parse(data) as ServerMessage);
    }
  } as never;
}

// One-way latency: small symmetric base, uniform jitter, occasional queuing
// spike -- a fair cartoon of rehearsal Wi-Fi.
function makeLatency(rand: () => number, baseMs: number, jitterMs: number, spikeChance: number): () => number {
  return () => {
    let latency = baseMs + rand() * jitterMs;
    if (rand() < spikeChance) {
      latency += 40 + rand() * 80;
    }
    return latency;
  };
}

interface Simulation {
  room: RoomController;
  clients: SimClient[];
  hostId: string;
  hostMessages: ServerMessage[];
  now: () => number;
  advance: (ms: number) => void;
  syncRound: (client: SimClient) => void;
}

function createSimulation(seed: number, clientSpecs: Array<{ name: string; trueOffsetMs: number }>): Simulation {
  let simTime = 1_000_000;
  const now = () => Math.round(simTime);
  const room = new RoomController("SIM123", "http://room", "http://host", 1500, now);
  const rand = lcg(seed);

  const hostMessages: ServerMessage[] = [];
  const host = room.addClient(makeSocket(hostMessages), {
    type: "clientHello",
    deviceName: "Host",
    role: "host",
    capabilities: []
  });

  const clients: SimClient[] = clientSpecs.map((spec, index) => {
    const messages: ServerMessage[] = [];
    const added = room.addClient(makeSocket(messages), {
      type: "clientHello",
      deviceName: spec.name,
      role: "desktop-adapter",
      capabilities: [{ app: "mock", canPlay: true, canStop: true }]
    });
    return {
      id: added.id,
      name: spec.name,
      trueOffsetMs: spec.trueOffsetMs,
      estOffsetMs: undefined,
      samples: [],
      messages,
      latency: makeLatency(rand, 5 + index * 2, 25, 0.15)
    };
  });

  // One full clock-sync round trip for one client, mirroring the real client
  // pipeline: send clockSync, receive clockSyncResult, fold the sample in.
  const syncRound = (client: SimClient) => {
    const sentLocal = now() - client.trueOffsetMs;
    simTime += client.latency();
    room.handleMessage(client.id, { type: "clockSync", clientSentAt: sentLocal }, now());
    const reply = [...client.messages].reverse().find(
      (message) => message.type === "clockSyncResult"
    );
    if (!reply || reply.type !== "clockSyncResult") {
      throw new Error("clockSyncResult was not delivered");
    }
    simTime += client.latency();
    const receivedLocal = now() - client.trueOffsetMs;
    const sample = calculateClockSample(
      sentLocal,
      receivedLocal,
      reply.serverReceivedAt,
      reply.serverSentAt
    );
    client.samples.push(sample);
    client.samples = client.samples.slice(-CLOCK_SAMPLE_WINDOW);
    client.estOffsetMs = blendOffset(client.estOffsetMs, summarizeClock(client.samples).offsetMs);
  };

  return {
    room,
    clients,
    hostId: host.id,
    hostMessages,
    now,
    advance: (ms: number) => {
      simTime += ms;
    },
    syncRound
  };
}

/** Arm and play from the host; return each client's achieved start (server time). */
function playAndMeasure(sim: Simulation): { scheduledServerTime: number; startsByName: Map<string, number> } {
  sim.room.handleMessage(sim.hostId, {
    type: "safetyUpdate",
    armed: true,
    updatedAt: sim.now()
  }, sim.now());
  sim.room.handleMessage(sim.hostId, {
    type: "transportRequest",
    action: "play",
    requestedAt: sim.now()
  }, sim.now());

  const startsByName = new Map<string, number>();
  let scheduledServerTime = 0;
  for (const client of sim.clients) {
    const command = [...client.messages].reverse().find(
      (message): message is TransportCommand => message.type === "transportCommand"
    );
    expect(command, `${client.name} should receive the play command`).toBeDefined();
    if (!command) {
      continue;
    }
    scheduledServerTime = command.scheduledServerTime;

    // The client receives the command after its downlink latency, then waits
    // out the remaining delay against its *estimated* offset; its clock error
    // is what moves the achieved start off the scheduled instant.
    const receivedAtServer = sim.now() + client.latency();
    const localNow = receivedAtServer - client.trueOffsetMs;
    const waitMs = delayUntilServerTime(
      command.scheduledServerTime + (command.manualOffsetMs ?? 0),
      localNow,
      client.estOffsetMs ?? 0
    );
    startsByName.set(client.name, localNow + waitMs + client.trueOffsetMs);
  }
  return { scheduledServerTime, startsByName };
}

function expectWithinBudget(
  scheduledServerTime: number,
  startsByName: Map<string, number>
): void {
  const starts = [...startsByName.values()];
  const spread = Math.max(...starts) - Math.min(...starts);
  expect(spread, `start spread across devices (starts: ${JSON.stringify([...startsByName])})`)
    .toBeLessThanOrEqual(MAX_START_SPREAD_MS);
  for (const [name, start] of startsByName) {
    expect(
      Math.abs(start - scheduledServerTime),
      `${name} deviation from the scheduled downbeat`
    ).toBeLessThanOrEqual(MAX_ABSOLUTE_DEVIATION_MS);
  }
}

describe("sync accuracy (simulated rehearsal)", () => {
  it("starts a mixed room together after the warm-up burst", () => {
    const sim = createSimulation(0xbadc0de, [
      { name: "Laptop", trueOffsetMs: 12 },
      { name: "Phone A", trueOffsetMs: -180 },
      { name: "Phone B", trueOffsetMs: 95 },
      { name: "Tablet", trueOffsetMs: -40 }
    ]);

    // The real clients play as soon as the warm-up burst has converged.
    for (let round = 0; round < CLOCK_WARMUP_SAMPLES; round += 1) {
      for (const client of sim.clients) {
        sim.syncRound(client);
      }
      sim.advance(250);
    }

    const { scheduledServerTime, startsByName } = playAndMeasure(sim);
    expectWithinBudget(scheduledServerTime, startsByName);
  });

  it("stays inside budget after steady-state syncing with a badly skewed clock", () => {
    const sim = createSimulation(0x5eed, [
      { name: "Laptop", trueOffsetMs: 0 },
      // A device whose clock is 90 s off (no NTP, manual clock) must still
      // land on the beat -- and must not be dragged toward zero (regression
      // guard for the offset-reset bias fixed in A2).
      { name: "Unsynced phone", trueOffsetMs: 90_000 },
      { name: "Tablet", trueOffsetMs: -350 }
    ]);

    for (let round = 0; round < 30; round += 1) {
      for (const client of sim.clients) {
        sim.syncRound(client);
      }
      sim.advance(round < CLOCK_WARMUP_SAMPLES ? 250 : 1000);
    }

    const { scheduledServerTime, startsByName } = playAndMeasure(sim);
    expectWithinBudget(scheduledServerTime, startsByName);
  });

  it("re-converges quickly after a reconnect (fresh estimator state)", () => {
    const sim = createSimulation(0xfeed5, [
      { name: "Laptop", trueOffsetMs: 25 },
      { name: "Phone", trueOffsetMs: 140 }
    ]);

    // Steady state, then one client "reconnects": samples and estimate reset,
    // exactly like the real clients do on a socket open.
    for (let round = 0; round < 15; round += 1) {
      for (const client of sim.clients) {
        sim.syncRound(client);
      }
      sim.advance(500);
    }
    const phone = sim.clients[1]!;
    phone.samples = [];
    phone.estOffsetMs = undefined;
    for (let round = 0; round < CLOCK_WARMUP_SAMPLES; round += 1) {
      sim.syncRound(phone);
      sim.advance(250);
    }

    const { scheduledServerTime, startsByName } = playAndMeasure(sim);
    expectWithinBudget(scheduledServerTime, startsByName);
  });
});
