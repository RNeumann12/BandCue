import { randomUUID } from "node:crypto";
import type WebSocket from "ws";
import type {
  AdapterStatus,
  AdapterCommandStatus,
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
  StopReason,
  SetlistState,
  SetlistUpdate,
  TransportCommand,
  TransportRequest,
  TransportState
} from "../shared/protocol.js";
import type { HelixScheduleInfo } from "../shared/transport.js";
import {
  DEFAULT_SCHEDULE_DELAY_MS,
  MANUAL_OFFSET_LIMIT_MS,
  clampHelixOffsetMs,
  decideTransportRequest,
  hasReadyTransportCapability,
  helixScheduleInfo,
  sanitizeHelixBeatsPerMeasure,
  sanitizeHelixBpm,
  sanitizeHelixTargetMeasure,
  scheduleDelayForClients
} from "../shared/transport.js";
import {
  appliesToMuseScore,
  appliesToSongsterr,
  museScoreReference,
  songsterrReferences
} from "../shared/song-sources.js";

interface RoomClient extends RoomClientSummary {
  socket?: WebSocket;
}

type ClientClock = NonNullable<RoomClientSummary["clock"]>;

interface RecentClock {
  clock: ClientClock;
  savedAt: number;
}

const RECENT_CLOCK_TTL_MS = 30_000;
const PLAYBACK_END_SETTLE_MS = 750;
// A connected client sends clockSync at ~1 Hz (faster during warm-up), so silence
// for longer than this means the socket is half-open (Wi-Fi drop, laptop sleep,
// Android Doze, killed app) even though no TCP FIN ever arrived. The periodic
// sweep evicts such clients so the room list stays truthful and a vanished
// transport leader still triggers the leader-disconnect Stop promptly.
const CLIENT_IDLE_TIMEOUT_MS = 12_000;
const LIVENESS_SWEEP_INTERVAL_MS = 4_000;
export const MAX_SETLIST_SONGS = 500;

export class RoomController {
  private readonly clients = new Map<string, RoomClient>();
  private readonly recentClockByClientKey = new Map<string, RecentClock>();
  private transport: TransportState = {
    status: "stopped",
    sequenceId: 0
  };
  private openSongSequence = 0;
  private currentSong?: CurrentSongState;
  private lastHelixScheduleInfo?: HelixScheduleInfo;
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
  private playbackEndTimer?: NodeJS.Timeout;
  private playbackEndTracking?: {
    sequenceId: number;
    requiredClientIds: Set<string>;
    playingClientIds: Set<string>;
  };
  private pendingClockBroadcast?: NodeJS.Timeout;
  private livenessSweepTimer?: NodeJS.Timeout;
  // Last logged "<sequence>:<firedAt>" per client, to keep the per-play timing
  // log to one line per executed command.
  private readonly lastTimingLogByClientId = new Map<string, string>();

  constructor(
    private readonly roomCode: string,
    private readonly companionUrl: string,
    private readonly hostUrl: string,
    private readonly scheduleDelayMs = DEFAULT_SCHEDULE_DELAY_MS,
    // Time source for everything the room schedules or stamps. Production
    // passes the monotonic serverNow (src/server/server-clock.ts) so an OS
    // clock step cannot shift room time; tests keep the Date.now default.
    private readonly now: () => number = () => Date.now()
  ) {}

  addClient(socket: WebSocket | undefined, hello: ClientHello, now = this.now()): RoomClient {
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
      const now = this.now();
      this.transport = {
        status: "stopped",
        leaderId: clientId,
        action: "stop",
        sequenceId: this.transport.sequenceId + 1,
        scheduledServerTime: now,
        stopReason: "leader-disconnect"
      };
      this.clearAutoStopTimer();
      this.clearPlaybackEndTracking();
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

  /**
   * Evict clients we have not heard from within CLIENT_IDLE_TIMEOUT_MS. A live
   * client sends clockSync every second, so prolonged silence means a half-open
   * socket that never produced a `close` event. We terminate the socket (best
   * effort) and drop the client via removeClient, which also fires the
   * leader-disconnect Stop when the vanished client held transport.
   */
  sweepIdleClients(now = this.now()): void {
    const staleIds: string[] = [];
    for (const [id, client] of this.clients) {
      if (now - client.lastSeenAt > CLIENT_IDLE_TIMEOUT_MS) {
        staleIds.push(id);
      }
    }

    for (const id of staleIds) {
      const socket = this.clients.get(id)?.socket as
        | (WebSocket & { terminate?: () => void })
        | undefined;
      if (socket && typeof socket.terminate === "function") {
        try {
          socket.terminate();
        } catch {
          // Best effort; removeClient below still drops it from the room.
        }
      }
      this.removeClient(id);
    }
  }

  /** Start the periodic liveness sweep. Returns a function that stops it. */
  startLivenessSweep(intervalMs = LIVENESS_SWEEP_INTERVAL_MS): () => void {
    this.stopLivenessSweep();
    this.livenessSweepTimer = setInterval(() => this.sweepIdleClients(), intervalMs);
    // The sweep alone should never keep the Node process alive.
    this.livenessSweepTimer.unref?.();
    return () => this.stopLivenessSweep();
  }

  stopLivenessSweep(): void {
    if (this.livenessSweepTimer) {
      clearInterval(this.livenessSweepTimer);
      this.livenessSweepTimer = undefined;
    }
  }

  handleMessage(clientId: string, message: ClientMessage, now = this.now()): void {
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
        serverSentAt: this.now()
      });
      return;
    }

    if (message.type === "clockStatus") {
      this.updateClock(clientId, message.rttMs, message.offsetMs, message.jitterMs, message.sampleCount);
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

  updateClock(
    clientId: string,
    rttMs: number,
    offsetMs: number,
    jitterMs?: number,
    sampleCount?: number
  ): void {
    const client = this.clients.get(clientId);
    if (!client) {
      return;
    }

    client.clock = { ...client.clock, rttMs, offsetMs, jitterMs, sampleCount };
    this.rememberClock(client, this.now());
    this.scheduleClockBroadcast();
  }

  getState(now = this.now()): RoomState {
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
      playbackDetail: sanitizeStatusText(status.playbackDetail, client.status?.playbackDetail, 500),
      title: sanitizeStatusText(status.title, client.status?.title, 140),
      source: trimText(status.source ?? client.status?.source ?? "", 500) || undefined,
      durationMs: sanitizeDurationMs(status.durationMs) ?? client.status?.durationMs,
      durationSource: sanitizeDurationSource(status.durationSource) ?? client.status?.durationSource,
      catalog: sanitizeCatalog(status.catalog) ?? client.status?.catalog,
      songMatch: sanitizeSongMatch(status.songMatch) ?? client.status?.songMatch,
      detail: sanitizeStatusText(status.detail, client.status?.detail, 500),
      lastCommand: status.lastCommand
        ? sanitizeLastCommand(status.lastCommand)
        : client.status?.lastCommand
    };
    const songDurationChanged = this.applyAdapterDurationToCurrentSong(client, nextStatus, now);
    const statusChanged = JSON.stringify(client.status ?? null) !== JSON.stringify(nextStatus);
    this.logCommandTiming(client, nextStatus.lastCommand);
    client.status = nextStatus;
    client.lastSeenAt = now;
    if (songDurationChanged) {
      this.scheduleAutoStopForCurrentSong();
    }
    const playbackEnded = this.applyAdapterPlaybackToTransport(clientId, now);
    if (statusChanged || songDurationChanged || playbackEnded) {
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
    target.lastSeenAt = this.now();
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
      song: update.song ? sanitizeSong(update.song) : undefined,
      index: sanitizeOptionalInteger(update.index, 1, 10_000),
      total: sanitizeOptionalInteger(update.total, 0, 10_000),
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

    if (update.songs.length > MAX_SETLIST_SONGS) {
      this.send(client, {
        type: "error",
        message: `A setlist can contain at most ${MAX_SETLIST_SONGS} songs.`
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
    // A play's count-in adapts to the room: a transport-capable client on a
    // slow or jittery path gets a longer lead so its command still lands and
    // preps before the downbeat.
    const requiredLeadMs = request.action === "play"
      ? scheduleDelayForClients(this.clients.values(), this.scheduleDelayMs)
      : this.scheduleDelayMs;
    const delayMs = request.action === "play"
      ? this.delayForPlayRequest(requiredLeadMs, client)
      : this.scheduleDelayMs;
    if (delayMs === undefined) {
      return;
    }
    const decision = decideTransportRequest(
      this.transport,
      client,
      request.action,
      now,
      delayMs,
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
      this.clearPlaybackEndTracking();
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
      if (this.lastHelixScheduleInfo) {
        this.broadcast({
          type: "helixScheduleUpdate",
          ...this.lastHelixScheduleInfo
        });
      }
    }
  }

  private delayForPlayRequest(requiredLeadMs: number, client: RoomClientSummary): number | undefined {
    this.lastHelixScheduleInfo = undefined;
    const song = this.currentSong?.song;
    if (!song?.helixSyncEnabled) {
      return requiredLeadMs;
    }

    const info = helixScheduleInfo(song, requiredLeadMs);
    if (info === undefined) {
      this.send(client, {
        type: "error",
        message: "Helix sync is enabled for this song, but it needs a valid BPM, beats per measure, and target measure."
      });
      return undefined;
    }

    this.lastHelixScheduleInfo = info;
    return info.appliedDelayMs;
  }

  private handleOpenSongRequest(
    client: RoomClientSummary,
    request: OpenSongRequest,
    now: number
  ): void {
    if (client.role !== "host") {
      this.send(client, {
        type: "error",
        message: "Only a host can ask adapters to open the current song."
      });
      return;
    }

    const currentSong = this.currentSong;
    const song = currentSong?.song;
    if (!currentSong || !song || (!appliesToSongsterr(song) && !appliesToMuseScore(song))) {
      this.send(client, {
        type: "error",
        message: "Select a current Songsterr or MuseScore setlist song before opening it."
      });
      return;
    }

    this.openSongSequence += 1;
    const command: OpenSongCommand = {
      type: "openSongCommand",
      leaderId: client.id,
      sequenceId: this.openSongSequence,
      requestedAt: request.requestedAt || now,
      currentSong
    };
    this.broadcast(command);
  }

  private markRunningAt(scheduledServerTime: number): void {
    if (this.runningTimer) {
      clearTimeout(this.runningTimer);
    }

    const delayMs = Math.max(0, scheduledServerTime - this.now());
    this.runningTimer = setTimeout(() => {
      if (this.transport.status !== "scheduled") {
        return;
      }

      this.transport = {
        ...this.transport,
        status: "running",
        startedServerTime: scheduledServerTime
      };
      this.startPlaybackEndTracking(this.transport.sequenceId);
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
    const delayMs = Math.max(0, startedServerTime + durationMs - this.now());
    this.autoStopTimer = setTimeout(() => {
      if (
        this.transport.status !== "running" ||
        this.transport.action !== "play" ||
        this.transport.sequenceId !== sequenceId
      ) {
        return;
      }

      const now = this.now();
      if (this.stopRoomAutomatically("auto-duration", leaderId, now)) {
        this.broadcastState();
      }
    }, delayMs);
  }

  private clearAutoStopTimer(): void {
    if (!this.autoStopTimer) {
      return;
    }

    clearTimeout(this.autoStopTimer);
    this.autoStopTimer = undefined;
  }

  private startPlaybackEndTracking(sequenceId: number): void {
    this.clearPlaybackEndTimer();
    this.playbackEndTracking = {
      sequenceId,
      // Snapshot the adapters that were ready for this run. A device joining
      // later must not block auto-stop for a song it never participated in.
      requiredClientIds: new Set(
        [...this.clients.values()]
          // Status can lag the downbeat: include every adapter that was
          // connected and transport-capable when the run began, then let
          // shouldStopFromPlaybackEnd ignore any that remain not-ready.
          .filter((client) => client.capabilities.some(
            (capability) => capability.canPlay && capability.canStop
          ))
          .map((client) => client.id)
      ),
      playingClientIds: new Set()
    };
  }

  private clearPlaybackEndTracking(): void {
    this.clearPlaybackEndTimer();
    this.playbackEndTracking = undefined;
  }

  private clearPlaybackEndTimer(): void {
    if (!this.playbackEndTimer) {
      return;
    }

    clearTimeout(this.playbackEndTimer);
    this.playbackEndTimer = undefined;
  }

  private applyAdapterPlaybackToTransport(clientId: string, now: number): boolean {
    if (
      this.transport.status !== "running" ||
      this.transport.action !== "play"
    ) {
      return false;
    }

    if (!this.playbackEndTracking || this.playbackEndTracking.sequenceId !== this.transport.sequenceId) {
      this.startPlaybackEndTracking(this.transport.sequenceId);
    }

    const playback = this.clients.get(clientId)?.status?.playback;
    if (playback === "playing") {
      // Also include an adapter that became ready just after the downbeat but
      // demonstrably joined playback during this run.
      this.playbackEndTracking?.requiredClientIds.add(clientId);
      this.playbackEndTracking?.playingClientIds.add(clientId);
      this.clearPlaybackEndTimer();
      return false;
    }

    if (playback !== "stopped" || !this.shouldStopFromPlaybackEnd()) {
      return false;
    }

    this.schedulePlaybackEndStop(now);
    return false;
  }

  private shouldStopFromPlaybackEnd(): boolean {
    const tracking = this.playbackEndTracking;
    if (!tracking || tracking.sequenceId !== this.transport.sequenceId || !tracking.playingClientIds.size) {
      return false;
    }

    // Every ready adapter participating in this run must have both actually
    // started and currently report stopped. A disconnected/not-ready adapter
    // no longer participates, and a newly connected idle adapter is not in the
    // snapshot, so neither can hold the room open forever.
    for (const clientId of tracking.requiredClientIds) {
      const client = this.clients.get(clientId);
      if (!client || !hasReadyTransportCapability(client)) {
        continue;
      }

      if (!tracking.playingClientIds.has(clientId) || client.status?.playback !== "stopped") {
        return false;
      }
    }

    return true;
  }

  private schedulePlaybackEndStop(now: number): void {
    if (this.playbackEndTimer) {
      return;
    }

    const sequenceId = this.transport.sequenceId;
    const leaderId = this.transport.leaderId;
    this.playbackEndTimer = setTimeout(() => {
      this.playbackEndTimer = undefined;
      if (
        this.transport.status !== "running" ||
        this.transport.action !== "play" ||
        this.transport.sequenceId !== sequenceId ||
        !this.shouldStopFromPlaybackEnd()
      ) {
        return;
      }

      if (this.stopRoomAutomatically("auto-playback-ended", leaderId, this.now())) {
        this.broadcastState();
      }
    }, Math.max(0, PLAYBACK_END_SETTLE_MS - Math.max(0, this.now() - now)));
  }

  private stopRoomAutomatically(reason: StopReason, leaderId: string | undefined, now: number): boolean {
    if (this.transport.status !== "running" || this.transport.action !== "play") {
      return false;
    }

    this.transport = {
      status: "stopped",
      leaderId,
      action: "stop",
      sequenceId: this.transport.sequenceId + 1,
      scheduledServerTime: now,
      stopReason: reason
    };
    this.clearAutoStopTimer();
    this.clearPlaybackEndTracking();
    return true;
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

  /**
   * One structured line per executed transport command with a measured fire
   * time, so "we were out of sync on song 4" is answerable after rehearsal.
   * Deviation is relative to the scheduled downbeat of the same sequence and
   * includes any intentional manual calibration offset.
   */
  private logCommandTiming(
    client: RoomClientSummary,
    lastCommand: NonNullable<RoomClientSummary["status"]>["lastCommand"]
  ): void {
    if (
      !lastCommand?.firedAtServerTime ||
      lastCommand.sequenceId === undefined ||
      lastCommand.sequenceId !== this.transport.sequenceId ||
      !this.transport.scheduledServerTime
    ) {
      return;
    }

    const key = `${lastCommand.sequenceId}:${lastCommand.firedAtServerTime}`;
    if (this.lastTimingLogByClientId.get(client.id) === key) {
      return;
    }
    this.lastTimingLogByClientId.set(client.id, key);

    const deviationMs = Math.round(lastCommand.firedAtServerTime - this.transport.scheduledServerTime);
    const signed = deviationMs >= 0 ? `+${deviationMs}` : `${deviationMs}`;
    console.log(
      `[timing] ${client.deviceName}: ${lastCommand.action}#${lastCommand.sequenceId} fired ${signed} ms vs scheduled start`
    );
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
    // Serialize once; the same JSON goes to every client, and stringifying a
    // large roomState (setlist + adapter status) per socket adds up at the
    // 400 ms clock-rebroadcast cadence.
    const serialized = JSON.stringify(message);
    for (const client of this.clients.values()) {
      this.sendSerialized(client, serialized);
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
    this.sendSerialized(client, JSON.stringify(message));
  }

  private sendSerialized(client: RoomClient, serialized: string): void {
    if (!client.socket || client.socket.readyState !== client.socket.OPEN) {
      return;
    }

    client.socket.send(serialized);
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

  return Math.max(-MANUAL_OFFSET_LIMIT_MS, Math.min(MANUAL_OFFSET_LIMIT_MS, Math.round(value)));
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
    songsterrUrl: trimText(song.songsterrUrl ?? "", 500) || undefined,
    songsterrBassUrl: trimText(song.songsterrBassUrl ?? "", 500) || undefined,
    songsterrDrumUrl: trimText(song.songsterrDrumUrl ?? "", 500) || undefined,
    museScoreSource: trimText(song.museScoreSource ?? "", 500) || undefined,
    durationMs: sanitizeDurationMs(song.durationMs),
    durationSource: sanitizeDurationSource(song.durationSource),
    helixSyncEnabled: Boolean(song.helixSyncEnabled),
    helixBpm: sanitizeHelixBpm(song.helixBpm),
    helixBeatsPerMeasure: sanitizeHelixBeatsPerMeasure(song.helixBeatsPerMeasure),
    helixTargetMeasure: sanitizeHelixTargetMeasure(song.helixTargetMeasure),
    helixOffsetMs: clampHelixOffsetMs(song.helixOffsetMs),
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

function sanitizeOptionalInteger(
  value: number | undefined,
  min: number,
  max: number
): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }

  const rounded = Math.round(value);
  return rounded >= min && rounded <= max ? rounded : undefined;
}

function sanitizeDurationSource(value: SongDurationSource | undefined): SongDurationSource | undefined {
  return value === "adapter" || value === "manual" ? value : undefined;
}

function sanitizeStatusText(
  value: string | undefined,
  previous: string | undefined,
  maxLength: number
): string | undefined {
  return value === undefined ? previous : trimText(value, maxLength) || undefined;
}

function sanitizeLastCommand(
  command: NonNullable<AdapterStatus["lastCommand"]>
): NonNullable<AdapterStatus["lastCommand"]> {
  return {
    action: command.action,
    sequenceId: Number.isFinite(command.sequenceId) ? Math.max(0, Math.round(command.sequenceId ?? 0)) : undefined,
    status: command.status as AdapterCommandStatus,
    at: Number.isFinite(command.at) ? Math.max(0, Math.round(command.at)) : 0,
    detail: trimText(command.detail ?? "", 500) || undefined,
    controlPath: trimText(command.controlPath ?? "", 80) || undefined,
    firedAtServerTime: Number.isFinite(command.firedAtServerTime)
      ? Math.max(0, Math.round(command.firedAtServerTime ?? 0))
      : undefined
  };
}

function sanitizeCatalog(value: AdapterStatus["catalog"]): AdapterStatus["catalog"] | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  // Individual entries are deliberately not kept in room state: nothing in the
  // room consumes them (matching happens on the adapter, the host UI shows
  // only totals and match status), and rebroadcasting up to 500 titles/paths
  // to every phone on every state update wastes rehearsal-Wi-Fi airtime.
  const validEntryCount = Array.isArray(value.entries)
    ? value.entries
      .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry) && typeof entry === "object")
      .map((entry) => ({
        title: trimText(entry.title, 140),
        relativePath: normalizeRelativeCatalogPath(entry.relativePath)
      }))
      .filter((entry) => entry.title && entry.relativePath)
      .length
    : undefined;
  const total = Number.isFinite(value.total)
    ? Math.max(0, Math.min(100_000, Math.round(value.total)))
    : validEntryCount ?? 0;

  return {
    total,
    rootCount: Number.isFinite(value.rootCount)
      ? Math.max(0, Math.min(100, Math.round(value.rootCount ?? 0)))
      : undefined,
    scannedAt: Number.isFinite(value.scannedAt)
      ? Math.max(0, Math.round(value.scannedAt ?? 0))
      : undefined,
    detail: trimText(value.detail ?? "", 500) || undefined
  };
}

function sanitizeSongMatch(value: AdapterStatus["songMatch"]): AdapterStatus["songMatch"] | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const status = ["matched", "ambiguous", "missing", "not-applicable"].includes(value.status)
    ? value.status
    : "not-applicable";

  return {
    status,
    count: Number.isFinite(value.count)
      ? Math.max(0, Math.min(1000, Math.round(value.count ?? 0)))
      : undefined,
    title: trimText(value.title ?? "", 140) || undefined,
    relativePath: normalizeRelativeCatalogPath(value.relativePath ?? "") || undefined,
    detail: trimText(value.detail ?? "", 500) || undefined
  };
}

function normalizeRelativeCatalogPath(value: string): string {
  const normalized = trimText(value, 260).replace(/\\/g, "/");
  if (!normalized || normalized.startsWith("/") || /^[a-z]:\//i.test(normalized) || normalized.includes("../")) {
    return "";
  }

  return normalized;
}

function adapterStatusMatchesSong(
  status: Omit<AdapterStatus, "type">,
  song: SetlistSong
): boolean {
  if (!adapterAppliesToSong(status.app, song)) {
    return false;
  }

  const references = adapterReferencesForSong(status.app, song);
  if (status.source && references.some((reference) => sameNormalizedSource(status.source!, reference))) {
    return true;
  }

  // Fall back to title only on a full match. A loose substring overlap would
  // wrongly bind, e.g. a song titled "Black" absorbing the duration reported
  // for "Black Dog". Songsterr titles look like "Song Name Tab by Artist", so
  // strip that trailing descriptor before requiring exact normalized equality.
  const statusTitle = stripTabSuffix(normalizeSongIdentity(status.title ?? ""));
  const songTitle = stripTabSuffix(normalizeSongIdentity(song.title));
  return Boolean(statusTitle && songTitle && statusTitle === songTitle);
}

function adapterAppliesToSong(app: AdapterStatus["app"], song: SetlistSong): boolean {
  if (app === "songsterr") {
    return appliesToSongsterr(song);
  }

  if (app === "musescore") {
    return appliesToMuseScore(song);
  }

  return false;
}

function adapterReferencesForSong(app: AdapterStatus["app"], song: SetlistSong): string[] {
  if (app === "songsterr") {
    return songsterrReferences(song);
  }

  if (app === "musescore") {
    const reference = museScoreReference(song);
    return reference ? [reference] : [];
  }

  return [];
}

function stripTabSuffix(value: string): string {
  return value
    .replace(/\s+(bass |rhythm |lead |acoustic |electric |guitar |drum )?(tab|tabs|chords)( by .*)?$/i, "")
    .trim();
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
