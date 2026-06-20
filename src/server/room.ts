import { randomUUID } from "node:crypto";
import type WebSocket from "ws";
import type {
  AdapterStatus,
  CalibrationUpdate,
  ClientHello,
  ClientMessage,
  CurrentSongState,
  CurrentSongUpdate,
  OpenSongCommand,
  OpenSongRequest,
  RoomClientSummary,
  RoomState,
  SafetyState,
  SafetyUpdate,
  ServerMessage,
  SetlistSong,
  SongDurationSource,
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
  private openSongSequence = 0;
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
  private autoStopTimer?: NodeJS.Timeout;
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
        resetBeforePlay: false,
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

    if (message.type === "openSongRequest") {
      this.handleOpenSongRequest(client, message, now);
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
      source: trimText(status.source ?? client.status?.source ?? "", 500) || undefined,
      durationMs: sanitizeDurationMs(status.durationMs) ?? client.status?.durationMs,
      durationSource: sanitizeDurationSource(status.durationSource) ?? client.status?.durationSource,
      detail: status.detail ?? client.status?.detail,
      lastCommand: status.lastCommand ?? client.status?.lastCommand
    };
    const songDurationChanged = this.applyAdapterDurationToCurrentSong(client, nextStatus, now);
    const statusChanged = JSON.stringify(client.status ?? null) !== JSON.stringify(nextStatus);
    client.status = nextStatus;
    client.lastSeenAt = now;
    if (songDurationChanged) {
      this.scheduleAutoStopForCurrentSong();
    }
    if (statusChanged || songDurationChanged) {
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
    this.scheduleAutoStopForCurrentSong();
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
      this.scheduleAutoStopForCurrentSong();
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
    if (request.action === "stop") {
      this.clearAutoStopTimer();
    }
    const command: Omit<TransportCommand, "manualOffsetMs"> = {
      type: "transportCommand",
      action: request.action,
      leaderId: this.transport.leaderId ?? client.id,
      sequenceId: this.transport.sequenceId,
      scheduledServerTime: this.transport.scheduledServerTime ?? now,
      // Rehearsal sync: hitting play should start every device from the top of
      // the song so the band stays together. Each adapter performs the reset
      // through its platform's official seek API on a best-effort basis and
      // must never let a failed reset block playback.
      resetBeforePlay: request.action === "play",
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

  private handleOpenSongRequest(
    client: RoomClientSummary,
    request: OpenSongRequest,
    now: number
  ): void {
    if (client.role !== "host") {
      this.send(client, {
        type: "error",
        message: "Only a host can ask adapters to open the current Songsterr song."
      });
      return;
    }

    if (
      !this.currentSong?.song ||
      this.currentSong.song.sourceType !== "songsterr" ||
      !this.currentSong.song.source
    ) {
      this.send(client, {
        type: "error",
        message: "Select a current setlist song with a Songsterr URL before opening it."
      });
      return;
    }

    this.openSongSequence += 1;
    const command: OpenSongCommand = {
      type: "openSongCommand",
      leaderId: client.id,
      sequenceId: this.openSongSequence,
      requestedAt: request.requestedAt || now,
      currentSong: this.currentSong
    };
    this.broadcast(command);
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
      this.scheduleAutoStopForCurrentSong();
      this.broadcastState();
    }, delayMs);
  }

  private scheduleAutoStopForCurrentSong(): void {
    this.clearAutoStopTimer();

    const durationMs = this.currentSong?.song?.durationMs;
    const startedServerTime = this.transport.startedServerTime;
    if (
      this.transport.status !== "running" ||
      this.transport.action !== "play" ||
      !startedServerTime ||
      !durationMs
    ) {
      return;
    }

    const sequenceId = this.transport.sequenceId;
    const leaderId = this.transport.leaderId;
    const delayMs = Math.max(0, startedServerTime + durationMs - Date.now());
    this.autoStopTimer = setTimeout(() => {
      if (
        this.transport.status !== "running" ||
        this.transport.action !== "play" ||
        this.transport.sequenceId !== sequenceId
      ) {
        return;
      }

      const now = Date.now();
      this.transport = {
        status: "stopped",
        leaderId,
        action: "stop",
        sequenceId: this.transport.sequenceId + 1,
        scheduledServerTime: now
      };
      this.broadcastState();
    }, delayMs);
  }

  private clearAutoStopTimer(): void {
    if (!this.autoStopTimer) {
      return;
    }

    clearTimeout(this.autoStopTimer);
    this.autoStopTimer = undefined;
  }

  private applyAdapterDurationToCurrentSong(
    client: RoomClientSummary,
    status: Omit<AdapterStatus, "type">,
    now: number
  ): boolean {
    const durationMs = sanitizeDurationMs(status.durationMs);
    const currentSong = this.currentSong?.song;
    if (!durationMs || !currentSong || !adapterStatusMatchesSong(status, currentSong)) {
      return false;
    }

    if (
      currentSong.durationMs === durationMs &&
      currentSong.durationSource === "adapter"
    ) {
      return false;
    }

    const nextSong: SetlistSong = {
      ...currentSong,
      durationMs,
      durationSource: "adapter"
    };
    this.currentSong = {
      ...this.currentSong,
      song: nextSong,
      leaderId: this.currentSong?.leaderId ?? client.id,
      updatedAt: now
    };

    const setlistIndex = this.setlist.songs.findIndex((song) => song.id === nextSong.id);
    if (setlistIndex >= 0) {
      this.setlist = {
        ...this.setlist,
        songs: this.setlist.songs.map((song, index) => index === setlistIndex ? nextSong : song),
        updatedAt: now
      };
    }

    return true;
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
    durationMs: sanitizeDurationMs(song.durationMs),
    durationSource: sanitizeDurationSource(song.durationSource),
    notes: trimText(song.notes ?? "", 500) || undefined
  };
}

function sanitizeDurationMs(value: number | undefined): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }

  const rounded = Math.round(value);
  return rounded > 0 && rounded <= 24 * 60 * 60 * 1000 ? rounded : undefined;
}

function sanitizeDurationSource(value: SongDurationSource | undefined): SongDurationSource | undefined {
  return value === "adapter" || value === "manual" ? value : undefined;
}

function adapterStatusMatchesSong(
  status: Omit<AdapterStatus, "type">,
  song: SetlistSong
): boolean {
  if (status.app !== song.sourceType) {
    return false;
  }

  if (song.source && status.source && sameNormalizedSource(status.source, song.source)) {
    return true;
  }

  const statusTitle = normalizeSongIdentity(status.title ?? "");
  const songTitle = normalizeSongIdentity(song.title);
  return Boolean(
    statusTitle &&
      songTitle &&
      (statusTitle.includes(songTitle) || songTitle.includes(statusTitle))
  );
}

function sameNormalizedSource(left: string, right: string): boolean {
  try {
    const leftUrl = new URL(left);
    const rightUrl = new URL(right);
    return (
      leftUrl.hostname.toLowerCase() === rightUrl.hostname.toLowerCase() &&
      normalizeSourcePath(leftUrl.pathname) === normalizeSourcePath(rightUrl.pathname)
    );
  } catch {
    return normalizeSongIdentity(left) === normalizeSongIdentity(right);
  }
}

function normalizeSourcePath(pathname: string): string {
  return pathname.replace(/\/+$/, "").toLowerCase();
}

function normalizeSongIdentity(value: string): string {
  return value
    .replace(/\.(mscz|mscx)$/i, "")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
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
