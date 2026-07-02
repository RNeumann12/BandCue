export type ClientRole = "host" | "desktop-adapter" | "companion";

export type AppType = "musescore" | "songsterr" | "mock";

export type TransportAction = "play" | "stop";

export type AdapterCommandAction = TransportAction | "open-song";

export type TransportStatus = "stopped" | "scheduled" | "running";

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
  lastCommand?: {
    action: AdapterCommandAction;
    sequenceId?: number;
    status: AdapterCommandStatus;
    at: number;
    detail?: string;
    controlPath?: string;
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
  durationMs?: number;
  durationSource?: SongDurationSource;
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
  | TransportRequest;

export type ServerMessage =
  | ServerHello
  | ClockSyncResult
  | TransportCommand
  | OpenSongCommand
  | RoomState
  | ErrorMessage;
