export type ClientRole = "host" | "desktop-adapter" | "companion";

export type AppType = "musescore" | "songsterr" | "mock";

export type TransportAction = "play" | "stop";

export type AdapterCommandAction = TransportAction | "open-song";

export type TransportStatus = "stopped" | "scheduled" | "running";

/**
 * Why the room left the running state. `manual` is the only one that ever
 * carries a Stop command to the devices; the two `auto-` reasons just record
 * that the players finished on their own.
 *
 * `leader-disconnect` is legacy: coordinators used to stop the whole room when
 * the client that started playback dropped off, which turned a Wi-Fi blip on
 * the host laptop into a dead stop mid-song. No coordinator emits it any more —
 * it stays in the union so a client talking to an older coordinator still
 * understands what it is being told.
 */
export type StopReason = "manual" | "auto-duration" | "auto-playback-ended" | "leader-disconnect";

export type SongSourceType = "songsterr" | "musescore" | "other";

export type ControlMode = "host-only" | "leader-stop" | "everyone-can-stop";

export type AdapterState =
  | "ready"
  | "not-ready"
  | "command-pending"
  | "last-command-succeeded"
  | "last-command-failed";

export type AdapterCommandStatus = "pending" | "succeeded" | "failed";

export type AdapterPlaybackState = "playing" | "stopped" | "unknown";

export type SongDurationSource = "adapter" | "manual";

export interface AdapterCapability {
  app: AppType;
  canPlay: boolean;
  canStop: boolean;
  /** Whether this adapter can apply and verify a per-song playback tempo. */
  canSetTempo?: boolean;
}

export type AdapterTempoState = "pending" | "applied" | "failed" | "unsupported";

export interface AdapterTempoStatus {
  requestedPercent: number;
  appliedPercent?: number;
  state: AdapterTempoState;
  detail?: string;
}

export type CatalogMatchStatus = "matched" | "ambiguous" | "missing" | "not-applicable";

export interface SongCatalogEntry {
  title: string;
  relativePath: string;
  sourceId?: string;
}

export interface SongCatalogStatus {
  entries?: SongCatalogEntry[];
  total: number;
  rootCount?: number;
  scannedAt?: number;
  detail?: string;
}

export interface SongCatalogMatch {
  status: CatalogMatchStatus;
  count?: number;
  title?: string;
  relativePath?: string;
  detail?: string;
}

export interface ClientHello {
  type: "clientHello";
  deviceName: string;
  role: ClientRole;
  capabilities: AdapterCapability[];
}

export interface ServerHello {
  type: "serverHello";
  clientId: string;
  roomCode: string;
  serverTime: number;
  defaultScheduleDelayMs: number;
}

export interface ClockSyncRequest {
  type: "clockSync";
  clientSentAt: number;
}

export interface ClockSyncResult {
  type: "clockSyncResult";
  clientSentAt: number;
  serverReceivedAt: number;
  serverSentAt: number;
}

export interface ClockStatus {
  type: "clockStatus";
  rttMs: number;
  offsetMs: number;
  jitterMs?: number;
  /** How many clock samples this estimate is based on (for sync-readiness). */
  sampleCount?: number;
}

export interface CalibrationUpdate {
  type: "calibrationUpdate";
  targetClientId: string;
  manualOffsetMs: number;
}

export interface AdapterStatus {
  type: "adapterStatus";
  ready: boolean;
  app: AppType;
  state?: AdapterState;
  playback?: AdapterPlaybackState;
  playbackDetail?: string;
  title?: string;
  source?: string;
  durationMs?: number;
  durationSource?: SongDurationSource;
  catalog?: SongCatalogStatus;
  songMatch?: SongCatalogMatch;
  detail?: string;
  /**
   * How much dispatch lead (ms) this adapter's control path needs before a
   * scheduled Play to reliably land on time (e.g. process spawn + window
   * activation on a slow machine). The room's count-in grows to cover it —
   * see scheduleDelayForClients in shared/transport.ts.
   */
  requiredLeadMs?: number;
  tempo?: AdapterTempoStatus;
  lastCommand?: {
    action: AdapterCommandAction;
    sequenceId?: number;
    status: AdapterCommandStatus;
    at: number;
    detail?: string;
    controlPath?: string;
    /**
     * Which measure this command actually started the player from, when the
     * song asked for a later start. Adapters report the measure they reached
     * (1 when they had to fall back to the top), so the host can warn that one
     * device is about to play a different part of the song rather than leaving
     * it to be discovered by ear.
     */
    startMeasure?: number;
    /**
     * When the control action actually executed, in server time (local fire
     * time + measured clock offset). Lets the host show each device's real
     * start deviation from the scheduled downbeat and suggest calibration.
     */
    firedAtServerTime?: number;
  };
}

export interface TransportRequest {
  type: "transportRequest";
  action: TransportAction;
  requestedAt: number;
  /**
   * When the external cue that asked for this play actually happened, in server
   * time (the requester's local event time plus its measured clock offset). Only
   * meaningful for a play triggered by something with its own timeline -- today
   * the Helix's Play keystroke on the host page. The coordinator subtracts the
   * time the cue spent in transit from the Helix count-in so the room lands on
   * the Helix downbeat rather than a transit time later. Omit it when the play
   * has no external anchor (button press, setlist auto-start).
   */
  cueAtServerTime?: number;
}

/**
 * An external cue (a pedal sending BandCue's Play shortcut) captured by an
 * adapter that claimed the combination system-wide, rather than by the host page.
 *
 * It is deliberately *not* a `transportRequest`. Who may start playback is a room
 * policy -- in host-only mode nobody but the host may -- and a cue is a pedal
 * press, not a new authority. The coordinator relays this to the host, which then
 * makes its own ordinary play request carrying `cueAtServerTime`, so the pedal
 * behaves exactly like the host's own Play hotkey and every safety rule still
 * applies unchanged.
 */
export interface ExternalCue {
  type: "externalCue";
  /** Room time of the cue itself, for anchoring the count-in to the pedal's beat. */
  cueAtServerTime: number;
  /** Human-readable origin for host status text, e.g. "Ctrl+Alt+P on MASTASURFACE". */
  source?: string;
}

export interface OpenSongRequest {
  type: "openSongRequest";
  requestedAt: number;
}

export interface TransportCommand {
  type: "transportCommand";
  action: TransportAction;
  leaderId: string;
  sequenceId: number;
  scheduledServerTime: number;
  manualOffsetMs?: number;
  resetBeforePlay?: boolean;
  currentSong?: CurrentSongState;
}

export interface OpenSongCommand {
  type: "openSongCommand";
  leaderId: string;
  sequenceId: number;
  requestedAt: number;
  currentSong: CurrentSongState;
}

export interface SetlistSong {
  id: string;
  title: string;
  sourceType: SongSourceType;
  source?: string;
  /**
   * Optional Songsterr tab URL for this song. Lets a single setlist entry be
   * opened in Songsterr (e.g. by band mates) independently of its primary
   * source. When unset, a Songsterr adapter falls back to `source` if
   * `sourceType` is "songsterr".
   */
  songsterrUrl?: string;
  /**
   * Optional alternate Songsterr URL for bass players. Use this when Songsterr's
   * bass arrangement is a different song page, not just the same tab URL with a
   * bass slug.
   */
  songsterrBassUrl?: string;
  /**
   * Optional alternate Songsterr URL for drummers. Use this when Songsterr's
   * drum arrangement is a different song page, not just the same tab URL with a
   * drum slug.
   */
  songsterrDrumUrl?: string;
  /**
   * Optional local MuseScore score reference (relative path or title) for this
   * song. Lets the same entry also be opened in MuseScore. When unset, the
   * MuseScore adapter falls back to `source` if `sourceType` is "musescore".
   */
  museScoreSource?: string;
  /** Playback speed as an integer percentage. Missing legacy values mean 100%. */
  tempoPercent?: number;
  durationMs?: number;
  durationSource?: SongDurationSource;
  /**
   * Which measure a Play should start from, 1-based. Undefined or 1 means the
   * top of the song (the classic reset-before-play). Anything higher asks every
   * adapter to seek that far in before the downbeat, so the band can rehearse a
   * later section together. Each adapter resolves it in its own player's measure
   * numbering — see docs/Adapters.md.
   */
  startMeasure?: number;
  helixSyncEnabled?: boolean;
  helixBpm?: number;
  helixBeatsPerMeasure?: number;
  helixTargetMeasure?: number;
  helixOffsetMs?: number;
  notes?: string;
}

export interface CurrentSongState {
  song?: SetlistSong;
  index?: number;
  total?: number;
  leaderId?: string;
  updatedAt: number;
}

export interface CurrentSongUpdate {
  type: "currentSongUpdate";
  song?: SetlistSong;
  index?: number;
  total?: number;
  updatedAt: number;
}

export interface SetlistState {
  songs: SetlistSong[];
  updatedAt: number;
  leaderId?: string;
}

export interface SetlistUpdate {
  type: "setlistUpdate";
  songs: SetlistSong[];
  updatedAt: number;
}

export interface SafetyState {
  armed: boolean;
  controlMode: ControlMode;
  updatedAt: number;
  leaderId?: string;
}

export interface SafetyUpdate {
  type: "safetyUpdate";
  armed?: boolean;
  controlMode?: ControlMode;
  updatedAt: number;
}

export interface RoomClientSummary {
  id: string;
  deviceName: string;
  role: ClientRole;
  connectedAt: number;
  lastSeenAt: number;
  capabilities: AdapterCapability[];
  status?: Omit<AdapterStatus, "type">;
  clock?: {
    rttMs: number;
    offsetMs: number;
    jitterMs?: number;
    sampleCount?: number;
    manualOffsetMs?: number;
  };
}

export interface TransportState {
  status: TransportStatus;
  leaderId?: string;
  action?: TransportAction;
  sequenceId: number;
  scheduledServerTime?: number;
  startedServerTime?: number;
  stopReason?: StopReason;
}

export interface RoomState {
  type: "roomState";
  roomCode: string;
  serverTime: number;
  clients: RoomClientSummary[];
  transport: TransportState;
  currentSong?: CurrentSongState;
  setlist: SetlistState;
  safety: SafetyState;
  companionUrl: string;
  hostUrl: string;
}

export interface ErrorMessage {
  type: "error";
  message: string;
}

/**
 * Sent right after a Helix-synced Play, so host UIs can show whether the
 * configured count-in/offset was honored as-is or held to the room's
 * network/device-prep floor.
 */
export interface HelixScheduleUpdate {
  type: "helixScheduleUpdate";
  /** Configured count-in plus offset, measured from the Helix cue itself. */
  countInMs: number;
  /** How long the cue took to reach the coordinator; already deducted below. */
  cueLatencyMs: number;
  requestedDelayMs: number;
  minimumDelayMs: number;
  appliedDelayMs: number;
  extendedMs: number;
  measureDurationMs: number;
}

export type ClientMessage =
  | ClientHello
  | ClockSyncRequest
  | ClockStatus
  | CalibrationUpdate
  | AdapterStatus
  | CurrentSongUpdate
  | SetlistUpdate
  | SafetyUpdate
  | OpenSongRequest
  | TransportRequest
  | ExternalCue;

export type ServerMessage =
  | ServerHello
  | ClockSyncResult
  | TransportCommand
  | OpenSongCommand
  | RoomState
  | ErrorMessage
  | HelixScheduleUpdate
  | ExternalCue;
