import { randomUUID } from "node:crypto";
import type WebSocket from "ws";
import type {
  AdapterStatus,
  CalibrationUpdate,
  ClientHello,
  ClientMessage,
  CurrentSongState,
  CurrentSongUpdate,
  RoomClientSummary,
  RoomState,
  SafetyState,
  SafetyUpdate,
  ServerMessage,
  SetlistSong,
  SetlistState,
  SetlistUpdate,
  TransportCommand,
  TransportRequest,
  TransportState
} from "../shared/protocol.js";
import { DEFAULT_SCHEDULE_DELAY_MS, decideTransportRequest } from "../shared/transport.js";

interface RoomClient extends RoomClientSummary {
  socket?: WebSocket;
}

type ClientClock = NonNullable<RoomClientSummary["clock"]>;

interface RecentClock {
  clock: ClientClock;
  savedAt: number;
}

const RECENT_CLOCK_TTL_MS = 30_000;

export class RoomController {
  private readonly clients = new Map<string, RoomClient>();
  private readonly recentClockByClientKey = new Map<string, RecentClock>();
  private transport: TransportState = {
    status: "stopped",
    sequenceId: 0
  };
  private currentSong?: CurrentSongState;
  private setlist: SetlistState = {
    songs: [],
    updatedAt: 0
  };
  private safety: SafetyState = {
    armed: false,
    controlMode: "host-only",
    updatedAt: 0
  };
  private runningTimer?: NodeJS.Timeout;
  private pendingClockBroadcast?: NodeJS.Timeout;

  constructor(
    private readonly roomCode: string,
    private readonly companionUrl: string,
    private readonly hostUrl: string,
    private readonly scheduleDelayMs = DEFAULT_SCHEDULE_DELAY_MS
  ) {}

  addClient(socket: WebSocket | undefined, hello: ClientHello, now = Date.now()): RoomClient {
    const recentClock = this.getRecentClock(clientKeyFromHello(hello), now);
    const client: RoomClient = {
      id: randomUUID(),
      deviceName: hello.deviceName,
      role: hello.role,
      connectedAt: now,
      lastSeenAt: now,
      capabilities: hello.capabilities,
      clock: recentClock,
      socket
    };

    this.clients.set(client.id, client);
    this.send(client, {
      type: "serverHello",
      clientId: client.id,
      roomCode: this.roomCode,
      serverTime: now,
      defaultScheduleDelayMs: this.scheduleDelayMs
    });
    this.broadcastState();

    return client;
  }

  removeClient(clientId: string): void {
    this.clients.delete(clientId);
    if (this.transport.leaderId === clientId && this.transport.status !== "stopped") {
      const now = Date.now();
      this.transport = {
        status: "stopped",
        leaderId: clientId,
        action: "stop",
        sequenceId: this.transport.sequenceId + 1,
        scheduledServerTime: now
      };
      this.broadcastTransportCommand({
        type: "transportCommand",
        action: "stop",
        leaderId: clientId,
        sequenceId: this.transport.sequenceId,
        scheduledServerTime: now,
        currentSong: this.currentSong
      });
    }
    this.broadcastState();
  }

  handleMessage(clientId: string, message: ClientMessage, now = Date.now()): void {
    const client = this.clients.get(clientId);
    if (!client) {
      return;
    }

    client.lastSeenAt = now;

    if (message.type === "clockSync") {
      this.send(client, {
        type: "clockSyncResult",
        clientSentAt: message.clientSentAt,
        serverReceivedAt: now,
        serverSentAt: Date.now()
      });
      return;
    }

    if (message.type === "clockStatus") {
      this.updateClock(clientId, message.rttMs, message.offsetMs, message.jitterMs);
      return;
    }

    if (message.type === "calibrationUpdate") {
      this.updateCalibration(client, message);
      return;
    }

    if (message.type === "adapterStatus") {
      this.updateAdapterStatus(clientId, message, now);
      return;
    }

    if (message.type === "currentSongUpdate") {
      this.updateCurrentSong(client, message, now);
      return;
    }

    if (message.type === "setlistUpdate") {
      this.updateSetlist(client, message, now);
      return;
    }

    if (message.type === "safetyUpdate") {
      this.updateSafety(client, message, now);
      return;
    }

    if (message.type === "transportRequest") {
      this.handleTransportRequest(client, message, now);
    }
  }

  updateClock(clientId: string, rttMs: number, offsetMs: number, jitterMs?: number): void {
    const client = this.clients.get(clientId);
    if (!client) {
      return;
    }

    client.clock = { ...client.clock, rttMs, offsetMs, jitterMs };
    this.rememberClock(client, Date.now());
    this.scheduleClockBroadcast();
  }

  getState(now = Date.now()): RoomState {
    return {
      type: "roomState",
      roomCode: this.roomCode,
      serverTime: now,
      clients: [...this.clients.values()].map(({ socket: _socket, ...client }) => client),
      transport: this.transport,
      currentSong: this.currentSong,
      setlist: this.setlist,
      safety: this.safety,
      companionUrl: this.companionUrl,
      hostUrl: this.hostUrl
    };
  }

  private updateAdapterStatus(clientId: string, status: AdapterStatus, now: number): void {
    const client = this.clients.get(clientId);
    if (!client) {
      return;
    }

    const nextStatus = {
      ...client.status,
      ready: status.ready,
      app: status.app,
      state: status.state ?? (status.ready ? "ready" : "not-ready"),
      playback: status.playback ?? client.status?.playback,
      playbackDetail: status.playbackDetail ?? client.status?.playbackDetail,
      title: status.title ?? client.status?.title,
      detail: status.detail ?? client.status?.detail,
      lastCommand: status.lastCommand ?? client.status?.lastCommand
    };
    const statusChanged = JSON.stringify(client.status ?? null) !== JSON.stringify(nextStatus);
    client.status = nextStatus;
    client.lastSeenAt = now;
    if (statusChanged) {
      this.broadcastState();
    }
  }

  private updateCalibration(client: RoomClientSummary, update: CalibrationUpdate): void {
    if (client.role !== "host") {
      this.send(client, {
        type: "error",
        message: "Only a host can update device calibration."
      });
      return;
    }

    const target = this.clients.get(update.targetClientId);
    if (!target) {
      this.send(client, {
        type: "error",
        message: "Cannot calibrate a device that is no longer connected."
      });
      return;
    }

    target.clock = {
      ...target.clock,
      rttMs: target.clock?.rttMs ?? 0,
      offsetMs: target.clock?.offsetMs ?? 0,
      manualOffsetMs: clampManualOffset(update.manualOffsetMs)
    };
    target.lastSeenAt = Date.now();
    this.rememberClock(target, target.lastSeenAt);
    this.broadcastState();
  }

  private updateCurrentSong(
    client: RoomClientSummary,
    update: CurrentSongUpdate,
    now: number
  ): void {
    if (client.role !== "host") {
      this.send(client, {
        type: "error",
        message: "Only a host can update the current song."
      });
      return;
    }

    this.currentSong = {
      song: update.song,
      index: update.index,
      total: update.total,
      leaderId: client.id,
      updatedAt: update.updatedAt || now
    };
    this.broadcastState();
  }

  private updateSetlist(client: RoomClientSummary, update: SetlistUpdate, now: number): void {
    if (client.role !== "host") {
      this.send(client, {
        type: "error",
        message: "Only a host can update the setlist."
      });
      return;
    }

    const songs = update.songs.map(sanitizeSong).filter((song): song is SetlistSong => Boolean(song));
    this.setlist = {
      songs,
      leaderId: client.id,
      updatedAt: update.updatedAt || now
    };

    if (this.currentSong?.song) {
      const currentIndex = songs.findIndex((song) => song.id === this.currentSong?.song?.id);
      if (currentIndex >= 0) {
        this.currentSong = {
          ...this.currentSong,
          song: songs[currentIndex],
          index: currentIndex + 1,
          total: songs.length,
          updatedAt: now
        };
      } else {
        this.currentSong = undefined;
      }
    }

    this.broadcastState();
  }

  private updateSafety(client: RoomClientSummary, update: SafetyUpdate, now: number): void {
    if (client.role !== "host") {
      this.send(client, {
        type: "error",
        message: "Only a host can update safety controls."
      });
      return;
    }

    this.safety = {
      armed: update.armed ?? this.safety.armed,
      controlMode: update.controlMode ?? this.safety.controlMode,
      leaderId: client.id,
      updatedAt: update.updatedAt || now
    };
    this.broadcastState();
  }

  private handleTransportRequest(
    client: RoomClientSummary,
    request: TransportRequest,
    now: number
  ): void {
    const decision = decideTransportRequest(
      this.transport,
      client,
      request.action,
      now,
      this.scheduleDelayMs,
      this.safety
    );

    if (!decision.accepted || !decision.nextState) {
      this.send(client, {
        type: "error",
        message: decision.reason ?? "Transport request rejected."
      });
      return;
    }

    this.transport = decision.nextState;
    const command: Omit<TransportCommand, "manualOffsetMs"> = {
      type: "transportCommand",
      action: request.action,
      leaderId: this.transport.leaderId ?? client.id,
      sequenceId: this.transport.sequenceId,
      scheduledServerTime: this.transport.scheduledServerTime ?? now,
      currentSong: this.currentSong
    };

    this.safety = {
      ...this.safety,
      armed: false,
      leaderId: client.id,
      updatedAt: now
    };
    this.broadcastTransportCommand(command);
    this.broadcastState();

    if (request.action === "play") {
      this.markRunningAt(command.scheduledServerTime);
    }
  }

  private markRunningAt(scheduledServerTime: number): void {
    if (this.runningTimer) {
      clearTimeout(this.runningTimer);
    }

    const delayMs = Math.max(0, scheduledServerTime - Date.now());
    this.runningTimer = setTimeout(() => {
      if (this.transport.status !== "scheduled") {
        return;
      }

      this.transport = {
        ...this.transport,
        status: "running",
        startedServerTime: scheduledServerTime
      };
      this.broadcastState();
    }, delayMs);
  }

  private broadcastState(): void {
    if (this.pendingClockBroadcast) {
      clearTimeout(this.pendingClockBroadcast);
      this.pendingClockBroadcast = undefined;
    }
    this.broadcast(this.getState());
  }

  private scheduleClockBroadcast(): void {
    if (this.pendingClockBroadcast) {
      return;
    }

    this.pendingClockBroadcast = setTimeout(() => {
      this.pendingClockBroadcast = undefined;
      this.broadcast(this.getState());
    }, 400);
  }

  private broadcast(message: ServerMessage): void {
    for (const client of this.clients.values()) {
      this.send(client, message);
    }
  }

  private broadcastTransportCommand(command: Omit<TransportCommand, "manualOffsetMs">): void {
    for (const client of this.clients.values()) {
      this.send(client, {
        ...command,
        manualOffsetMs: client.clock?.manualOffsetMs
      });
    }
  }

  private send(client: RoomClient, message: ServerMessage): void {
    if (!client.socket || client.socket.readyState !== client.socket.OPEN) {
      return;
    }

    client.socket.send(JSON.stringify(message));
  }

  private rememberClock(client: RoomClientSummary, now: number): void {
    if (!client.clock) {
      return;
    }

    this.recentClockByClientKey.set(clientKeyFromSummary(client), {
      clock: client.clock,
      savedAt: now
    });
  }

  private getRecentClock(key: string, now: number): ClientClock | undefined {
    const cached = this.recentClockByClientKey.get(key);
    if (!cached) {
      return undefined;
    }

    if (now - cached.savedAt > RECENT_CLOCK_TTL_MS) {
      this.recentClockByClientKey.delete(key);
      return undefined;
    }

    return cached.clock;
  }
}

function clampManualOffset(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }

  return Math.max(-1000, Math.min(1000, Math.round(value)));
}

function sanitizeSong(song: SetlistSong): SetlistSong | undefined {
  const title = trimText(song.title, 140);
  if (!title) {
    return undefined;
  }

  const sourceType = ["songsterr", "musescore", "other"].includes(song.sourceType)
    ? song.sourceType
    : "other";

  return {
    id: trimText(song.id, 80) || randomUUID(),
    title,
    sourceType,
    source: trimText(song.source ?? "", 500) || undefined,
    notes: trimText(song.notes ?? "", 500) || undefined
  };
}

function trimText(value: string, maxLength: number): string {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function clientKeyFromHello(hello: ClientHello): string {
  return [
    hello.role,
    normalizeKey(hello.deviceName),
    hello.capabilities.map((capability) => capability.app).sort().join(",")
  ].join(":");
}

function clientKeyFromSummary(client: RoomClientSummary): string {
  return [
    client.role,
    normalizeKey(client.deviceName),
    client.capabilities.map((capability) => capability.app).sort().join(",")
  ].join(":");
}

function normalizeKey(value: string): string {
  return value.trim().toLowerCase();
}
