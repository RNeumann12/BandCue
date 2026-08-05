import { spawn } from "node:child_process";
import { MuseScoreTrigger } from "./musescore-trigger.js";
import { CueHotkeyListener, parseCueHotkey } from "./windows-cue-hotkey.js";
import {
  createServer,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse
} from "node:http";
import { hostname } from "node:os";
import { resolve } from "node:path";
import WebSocket, { WebSocketServer } from "ws";
import {
  matchMuseScoreSong,
  matchedCatalogEntry,
  publicCatalogEntries,
  scanMuseScoreCatalog,
  type LocalScoreCatalog
} from "./musescore-catalog.js";
import { appliesToMuseScore, museScoreReference } from "../shared/song-sources.js";
import { sanitizeStartMeasure } from "../shared/transport.js";
import {
  gotoMeasureLeadMs as gotoMeasureLeadMsWithConfig,
  keysForAction as keysForActionWithConfig,
  playControlPath as playControlPathWithConfig,
  type MuseScoreKeyStroke
} from "./musescore-keys.js";
import {
  blendOffset,
  calculateClockSample,
  calculateJitterMs,
  CLOCK_SAMPLE_WINDOW,
  CLOCK_STEADY_INTERVAL_MS,
  CLOCK_WARMUP_INTERVAL_MS,
  CLOCK_WARMUP_SAMPLES,
  delayUntilServerTime,
  summarizeClock,
  type ClockSample
} from "../shared/clock.js";
import {
  DEFAULT_ROOM_PORT,
  DEFAULT_LAN_SCAN_SUBNETS,
  buildLanScanCandidates,
  buildRoomDiscoveryCandidates,
  describeLanScanSubnets,
  discoveryPortForLocator,
  expectedRoomCodeForLocator,
  isAbsoluteRoomUrl,
  isPort,
  isRoomCode,
  isPlaceholderRoom,
  normalizeRoomLocator,
  roomDiscoveryCandidate,
  roomDiscoveryFallbackHint,
  roomUrlFromDiscovery,
  roomUrlToWebSocket,
  type RoomDiscoveryState
} from "../shared/room-locator.js";
import { discoverBandCueRooms } from "../shared/lan-discovery.js";
import type {
  AdapterPlaybackState,
  AdapterStatus,
  AdapterTempoStatus,
  SetlistSong,
  ServerMessage,
  TransportAction,
  TransportStatus
} from "../shared/protocol.js";

interface Args {
  room?: string;
  port: number;
  discoveryPort: number;
  name: string;
  playKey: string;
  playFromSelectionKey: string;
  resetKey: string;
  gotoMeasureKey: string;
  stopKey: string;
  playMode: "single-key" | "stop-then-play";
  processMatch: string;
  titleMatch?: string;
  activationRetries: number;
  activationDelayMs: number;
  commandGapMs: number;
  dispatchLeadMs: number;
  bridgePort?: number;
  bridgeFallbackMs: number;
  scoreFolders: string[];
  scoreCatalogRecursive: boolean;
  closeOldInstances: boolean;
  cueHotkey?: string;
}

// How long to wait for the freshly opened score's window before giving up on
// confirming it (the open itself may still succeed on a slow machine).
const OPEN_SCORE_WINDOW_TIMEOUT_MS = 15_000;
// Extra time for the new window's title to reflect the loaded score.
const OPEN_SCORE_TITLE_TIMEOUT_MS = 5_000;
// Grace period per old instance to exit after WM_CLOSE before it is reported
// as lingering (a "save changes?" prompt keeps it alive on purpose).
const OPEN_SCORE_CLOSE_WAIT_MS = 4_000;
// Starting powershell.exe, locating/activating MuseScore, and sending the
// reset prefix can take several hundred milliseconds. Do that work during the
// count-in and leave only the final Play key for the scheduled instant.
const DEFAULT_DISPATCH_LEAD_MS = 1000;
// A bridge that only contacted the HTTP API long ago must not add the fallback
// wait forever. Real bridge helpers poll much more frequently than this.
const BRIDGE_ACTIVE_WINDOW_MS = 5000;
// If activation/reset ever overruns the lead time, the final Play key fires
// immediately (late) instead of at the downbeat. Grow the lead time for later
// commands by the overrun plus this cushion so the session self-corrects
// instead of repeating the same late fire every song.
const DISPATCH_LEAD_OVERRUN_CUSHION_MS = 150;
// Upper bound for the self-adjusting lead time so a pathological machine
// doesn't grow it without limit (that would just move the setup work earlier
// without ever fixing the underlying slowness, and eats into the count-in).
const MAX_DISPATCH_LEAD_MS = 4000;
// How often to spawn a throwaway PowerShell that only loads the SendKeys /
// AppActivate assemblies. Windows keeps recently-used DLL pages in its
// standby cache, so a real trigger spawn later in the same session tends to
// load them from RAM instead of disk — the single biggest source of
// inconsistent (sometimes ~1s) startup latency observed for the Play command.
// Only needed while the resident trigger is down and commands fall back to a
// shell per command; a running trigger has the assemblies loaded already.
const ASSEMBLY_PRIME_INTERVAL_MS = 45_000;
// Count-in a Play needs when the resident trigger is standing by. The process
// launch and assembly load are already paid, the window scan happens when the
// room arms, and keys are posted straight to MuseScore's window rather than typed
// into the foreground -- so this only has to cover the stdin handover (2–7 ms
// measured) and the stop/reset pair at --command-gap-ms apart (~245 ms). The rest
// is headroom for a busy machine -- the first command of a session measured
// 436 ms while later ones settled at ~250 ms, so the margin is not spare.
const WARM_TRIGGER_LEAD_MS = 550;
// Ceiling for the warm path's self-correction. Well below MAX_DISPATCH_LEAD_MS:
// if a warm trigger ever needs this much, something is wrong that more count-in
// will not fix, and the room should not be dragged off an external timeline for it.
const MAX_WARM_TRIGGER_LEAD_MS = 1000;
// How long a resolved MuseScore window stays good before it is looked up again.
const TRIGGER_RESOLVE_TTL_MS = 10 * 60_000;

// Shared by every script that activates MuseScore and sends it keystrokes.
// Declared once so the priming spawn (below) loads exactly what a real
// trigger spawn will need. timeBeginPeriod/timeEndPeriod tighten the OS
// timer tick (normally ~15.6 ms) for the duration of the precise wait loop.
const SENDKEYS_ASSEMBLY_PREAMBLE = `
Add-Type -AssemblyName Microsoft.VisualBasic
Add-Type -AssemblyName System.Windows.Forms
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class BandCueWin32 {
  [DllImport("user32.dll")]
  public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")]
  public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  [DllImport("winmm.dll")]
  public static extern uint timeBeginPeriod(uint uMilliseconds);
  [DllImport("winmm.dll")]
  public static extern uint timeEndPeriod(uint uMilliseconds);
}
"@
`.trim();

// Fire-and-forget: loads the same assemblies a real trigger spawn needs, then
// exits. Never awaited and never affects command timing — it only exists to
// warm the OS DLL cache before a Play/Stop command needs it for real.
function primeSendKeysAssemblies(): void {
  void runPowerShell(`${SENDKEYS_ASSEMBLY_PREAMBLE}\nexit 0\n`).catch(() => {
    // Best-effort warm-up; a failure here just means the next real command
    // pays the full cold-start cost, same as before this optimization.
  });
}

interface MuseScoreStatus {
  ready: boolean;
  title?: string;
  detail?: string;
  processId?: number;
  processName?: string;
  windowTitle?: string;
  tempo?: AdapterTempoStatus;
}

interface BridgeCommand {
  action: TransportAction | "open-song";
  sequenceId: number;
  dueLocalAt: number;
  scheduledServerTime?: number;
  resetBeforePlay?: boolean;
  /** Where this play should start, 1-based; absent means the top of the score. */
  startMeasure?: number;
  /** Where a bridge helper says it actually started, reported back with its result. */
  reachedMeasure?: number;
  currentSong?: SetlistSong;
  status: "queued" | "claimed" | "succeeded" | "failed" | "expired";
  createdAt: number;
  claimedAt?: number;
  completedAt?: number;
  detail?: string;
  controlPath?: string;
  playback?: AdapterPlaybackState;
  title?: string;
  windowTitle?: string;
}

const args = parseArgs(process.argv.slice(2));
if (args.room && isAbsoluteRoomUrl(args.room) && isPlaceholderRoom(args.room)) {
  console.error("The --room value still contains HOST/TOKEN placeholders.");
  console.error("Start the coordinator with `npm run dev`, then use --room ROOM_CODE, --room PORT, or the printed room URL.");
  process.exit(1);
}

let ws: WebSocket | undefined;
let wsUrl: string | undefined;
let roomUrl: string | undefined;
let lastDiscoveryError = "";
let serverOffsetMs = 0;
let inferredPlayback: AdapterPlaybackState = "unknown";
let lastMuseScoreStatus: MuseScoreStatus | undefined;
let currentSong: SetlistSong | undefined;
let currentSongUpdatedAt: number | undefined;
let bridgeStatus: Partial<MuseScoreStatus> & { playback?: AdapterPlaybackState } = {};
let bridgeLastSeenAt: number | undefined;
let scoreCatalog: LocalScoreCatalog = scanMuseScoreCatalog([]);
let lastPublishedCatalogAt: number | undefined;
const bridgeCommands = new Map<number, BridgeCommand>();
let clockTimer: NodeJS.Timeout | undefined;
let pollTimer: NodeJS.Timeout | undefined;
let catalogTimer: NodeJS.Timeout | undefined;
let statusReportInFlight = false;
let statusReportQueued = false;
let bridgeServer: HttpServer | undefined;
let bridgeSocketServer: WebSocketServer | undefined;
// Attached MuseScore plugins. Normally one; a set so a stale socket during a
// plugin reload cannot displace the live one.
const bridgeSockets = new Set<WebSocket>();
const samples: ClockSample[] = [];
// Self-adjusting copy of --dispatch-lead-ms: grows when a command's setup
// (spawn + activate + prefix keys) overruns the lead time and fires the Play
// key late, so a slow first attempt doesn't keep repeating every song.
let adaptiveDispatchLeadMs = args.dispatchLeadMs;
let assemblyPrimeTimer: NodeJS.Timeout | undefined;
// Same idea as adaptiveDispatchLeadMs, for the resident-trigger path: grows when
// the handover plus window check eats into the downbeat instead of preceding it.
let adaptiveWarmLeadMs = WARM_TRIGGER_LEAD_MS;
// When the trigger last looked up the MuseScore window. Cleared when the score
// changes, so a Play never aims at a window that has been replaced.
let triggerResolvedAt: number | undefined;
// Set when a command had to fall back from the resident trigger to a one-shot
// shell, so the room is told the lead time the fallback really needs. Cleared by
// the next command the trigger handles itself.
let warmPathDegraded = false;
let lastArmed = false;
// The room's own view of the transport, so bridge preparation can tell "nothing
// is playing" from "a song is running" -- see prepareBridgeStartMeasure.
let lastTransportStatus: TransportStatus = "stopped";
let cueHotkeyListener: CueHotkeyListener | undefined;
const trigger = new MuseScoreTrigger(
  {
    processMatch: args.processMatch,
    titleMatch: args.titleMatch,
    activationRetries: args.activationRetries,
    activationDelayMs: args.activationDelayMs,
    commandGapMs: args.commandGapMs
  },
  (detail) => {
    triggerResolvedAt = undefined;
    console.warn(`MuseScore trigger stopped (${detail}); falling back to a shell per command.`);
    // Commands are about to start paying the full cold-start cost again, so the
    // room needs to hear that its count-in requirement just went back up.
    void reportMuseScoreStatus();
  }
);

if (args.bridgePort !== undefined) {
  startBridge(args.bridgePort);
}
refreshScoreCatalog();
// Start the resident trigger now so its shell launch and assembly load (~1.8 s
// together) are spent while nothing is waiting, rather than inside a count-in.
trigger.start();
startCueHotkeyListener();
primeSendKeysAssemblies();
assemblyPrimeTimer = setInterval(() => {
  if (!trigger.running) {
    primeSendKeysAssemblies();
  }
}, ASSEMBLY_PRIME_INTERVAL_MS);
void connect();

async function connect(): Promise<void> {
  try {
    const endpoint = await resolveRoomEndpoint();
    roomUrl = endpoint.roomUrl;
    wsUrl = endpoint.wsUrl;
    lastDiscoveryError = "";
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    if (detail !== lastDiscoveryError) {
      console.warn(detail);
      console.warn("Waiting for a BandCue room; retrying in 2s.");
      lastDiscoveryError = detail;
    }
    setTimeout(() => {
      void connect();
    }, 2000);
    return;
  }

  ws = new WebSocket(wsUrl);

  ws.on("open", () => {
    console.log(`Connected to BandCue room at ${roomUrl}`);
    send({
      type: "clientHello",
      deviceName: args.name,
      role: "desktop-adapter",
      capabilities: [{ app: "musescore", canPlay: true, canStop: true, canSetTempo: true }]
    });
    startClockSync();
    pollMuseScore();
  });

  ws.on("message", (raw) => {
    const message = JSON.parse(raw.toString()) as ServerMessage;
    if (message.type === "clockSyncResult") {
      const sample = calculateClockSample(
        message.clientSentAt,
        Date.now(),
        message.serverReceivedAt,
        message.serverSentAt
      );
      samples.push(sample);
      if (samples.length > CLOCK_SAMPLE_WINDOW) {
        samples.splice(0, samples.length - CLOCK_SAMPLE_WINDOW);
      }
      const summary = summarizeClock(samples);
      serverOffsetMs = blendOffset(serverOffsetMs, summary.offsetMs);
      send({
        type: "clockStatus",
        rttMs: summary.rttMs,
        offsetMs: serverOffsetMs,
        jitterMs: calculateJitterMs(samples),
        sampleCount: samples.length
      });
      return;
    }

    if (message.type === "transportCommand") {
      currentSong = message.currentSong?.song;
      currentSongUpdatedAt = message.currentSong?.updatedAt;
      const manualOffsetMs = message.manualOffsetMs ?? 0;
      const dueLocalAt = message.scheduledServerTime + manualOffsetMs - serverOffsetMs;
      const delayMs = delayUntilServerTime(
        message.scheduledServerTime + manualOffsetMs,
        Date.now(),
        serverOffsetMs
      );
      reportCommandStatus({
        ready: true,
        action: message.action,
        sequenceId: message.sequenceId,
        status: "pending",
        detail: `MuseScore ${message.action} command scheduled${formatManualOffset(manualOffsetMs)}`,
        at: Date.now()
      });
      queueBridgeCommand({
        action: message.action,
        sequenceId: message.sequenceId,
        dueLocalAt,
        scheduledServerTime: message.scheduledServerTime + manualOffsetMs,
        resetBeforePlay: Boolean(message.resetBeforePlay),
        startMeasure: message.action === "play" && message.resetBeforePlay
          ? startMeasureForSong(currentSong)
          : undefined,
        currentSong,
        status: "queued",
        createdAt: Date.now()
      });
      const dispatchLeadMs = message.action === "play" && !hasActiveBridge()
        // Jumping to a measure adds prefix keys, and every prefix key costs a
        // command gap. Start that much earlier rather than letting the extra
        // keys push the setup past the lead time and grow it for the whole
        // session (adjustDispatchLeadForSetupMargin).
        ? Math.min(museScoreDispatchLeadMs() + gotoMeasureLeadMs(currentSong), delayMs)
        : 0;
      setTimeout(() => {
        void triggerMuseScoreTransport(
          message.action,
          message.sequenceId,
          dueLocalAt,
          Boolean(message.resetBeforePlay)
        );
      }, Math.max(0, delayMs - dispatchLeadMs));
    }

    if (message.type === "openSongCommand") {
      currentSong = message.currentSong?.song;
      currentSongUpdatedAt = message.currentSong?.updatedAt;
      void handleOpenSongCommand(message.sequenceId);
      return;
    }

    if (message.type === "error") {
      console.warn(`Coordinator rejected request: ${message.message}`);
    }

    if (message.type === "roomState") {
      const songChanged = message.currentSong?.updatedAt !== currentSongUpdatedAt;
      currentSong = message.currentSong?.song;
      currentSongUpdatedAt = message.currentSong?.updatedAt;
      // Arming is the room saying "a Play is coming", and it is the last moment
      // before the cue when nothing is waiting on a beat. Look the MuseScore
      // window up now, so the count-in does not pay for the process scan. This
      // deliberately stops short of activating it: the cue is a keystroke, and
      // taking the foreground here would take the cue away from the host page.
      lastTransportStatus = message.transport?.status ?? lastTransportStatus;
      const armed = Boolean(message.safety?.armed);
      if (armed && !lastArmed) {
        void resolveTriggerTarget();
        // Arming is the room's "a Play is coming": the last quiet moment to send
        // an attached plugin to the song's start measure, so the count-in has
        // nothing left to seek.
        prepareBridgeStartMeasure("the room armed");
      }
      lastArmed = armed;
      if (songChanged) {
        // A different score means a different window to aim at.
        triggerResolvedAt = undefined;
        broadcastBridgeSocket({
          type: "song",
          startMeasure: startMeasureForSong(currentSong),
          currentSong
        });
        prepareBridgeStartMeasure("the song changed");
        void reportMuseScoreStatus();
      }
      return;
    }
  });

  ws.on("close", () => {
    console.log("Disconnected from coordinator; reconnecting in 2s.");
    stopIntervals();
    setTimeout(() => {
      void connect();
    }, 2000);
  });

  ws.on("error", (error) => {
    console.error(error.message);
  });
}

async function resolveRoomEndpoint(): Promise<{ roomUrl: string; wsUrl: string }> {
  const locator = normalizeRoomLocator(args.room, args.port);
  if (isAbsoluteRoomUrl(locator)) {
    return {
      roomUrl: locator,
      wsUrl: roomUrlToWebSocket(locator)
    };
  }

  const candidates = buildRoomDiscoveryCandidates(locator, args.port);
  if (!candidates.length) {
    throw new Error(`Could not understand BandCue room locator "${locator}". Use a room URL, room code, port, or host:port.`);
  }

  const localResult = await resolveFromCandidates(candidates);
  if (localResult.endpoint) {
    return localResult.endpoint;
  }

  const errors: string[] = [];
  errors.push(...localResult.errors);
  if (isRoomCode(locator) || isPort(locator)) {
    const expectedRoomCode = expectedRoomCodeForLocator(locator);
    const scanPort = discoveryPortForLocator(locator, args.port);
    const discoveryPort = isPort(locator) ? scanPort : args.discoveryPort;
    const rooms = await discoverBandCueRooms({
      roomCode: expectedRoomCode,
      discoveryPort,
      timeoutMs: 1000
    });
    const lanCandidates = rooms
      .filter((room) => room.host)
      .map((room) => roomDiscoveryCandidate(room.host ?? "", room.port, expectedRoomCode));
    const lanResult = await resolveFromCandidates(lanCandidates);
    if (lanResult.endpoint) {
      return lanResult.endpoint;
    }

    if (!rooms.length) {
      errors.push(expectedRoomCode
        ? `No LAN discovery response for room ${expectedRoomCode} on UDP ${discoveryPort}`
        : `No LAN discovery response on UDP ${discoveryPort}`);
    }
    errors.push(...lanResult.errors);

    const scanCandidates = buildLanScanCandidates(locator, args.port);
    const scanResult = await resolveFromCandidateBatches(scanCandidates, 64, 450);
    if (scanResult.endpoint) {
      return scanResult.endpoint;
    }

    errors.push(`Scanned common HTTP ranges ${describeLanScanSubnets(DEFAULT_LAN_SCAN_SUBNETS)} on port ${scanPort}`);
  }

  throw new Error(`No BandCue room found for "${locator}". ${errors.join("; ")}. ${roomDiscoveryFallbackHint(discoveryPortForLocator(locator, args.port))}`);
}

async function resolveFromCandidates(
  candidates: ReturnType<typeof buildRoomDiscoveryCandidates>
): Promise<{ endpoint?: { roomUrl: string; wsUrl: string }; errors: string[] }> {
  const errors: string[] = [];
  for (const candidate of candidates) {
    try {
      const response = await fetch(candidate.apiUrl, { signal: AbortSignal.timeout(1000) });
      if (!response.ok) {
        errors.push(`${candidate.label} returned HTTP ${response.status}`);
        continue;
      }

      const state = await response.json() as RoomDiscoveryState;
      const discoveredRoomUrl = roomUrlFromDiscovery(state, candidate);
      if (!discoveredRoomUrl) {
        errors.push(candidate.expectedRoomCode
          ? `${candidate.label} did not match an active room`
          : `${candidate.label} did not return a usable room`);
        continue;
      }

      return {
        endpoint: {
          roomUrl: discoveredRoomUrl,
          wsUrl: roomUrlToWebSocket(discoveredRoomUrl)
        },
        errors
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`${candidate.label}: ${message}`);
    }
  }

  return { errors };
}

async function resolveFromCandidateBatches(
  candidates: ReturnType<typeof buildRoomDiscoveryCandidates>,
  batchSize: number,
  timeoutMs: number
): Promise<{ endpoint?: { roomUrl: string; wsUrl: string } }> {
  for (let index = 0; index < candidates.length; index += batchSize) {
    const batch = candidates.slice(index, index + batchSize);
    const results = await Promise.all(batch.map((candidate) => resolveCandidate(candidate, timeoutMs)));
    const match = results.find((result) => result.endpoint);
    if (match?.endpoint) {
      return { endpoint: match.endpoint };
    }
  }

  return {};
}

async function resolveCandidate(
  candidate: ReturnType<typeof buildRoomDiscoveryCandidates>[number],
  timeoutMs: number
): Promise<{ endpoint?: { roomUrl: string; wsUrl: string }; error?: string }> {
  try {
    const response = await fetch(candidate.apiUrl, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) {
      return { error: `${candidate.label} returned HTTP ${response.status}` };
    }

    const state = await response.json() as RoomDiscoveryState;
    const discoveredRoomUrl = roomUrlFromDiscovery(state, candidate);
    if (!discoveredRoomUrl) {
      return {
        error: candidate.expectedRoomCode
          ? `${candidate.label} did not match an active room`
          : `${candidate.label} did not return a usable room`
      };
    }

    return {
      endpoint: {
        roomUrl: discoveredRoomUrl,
        wsUrl: roomUrlToWebSocket(discoveredRoomUrl)
      }
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { error: `${candidate.label}: ${message}` };
  }
}

function startClockSync(): void {
  if (clockTimer) {
    clearInterval(clockTimer);
  }

  // Warm up with a quick burst so the offset converges within ~2s, then settle
  // into the steady cadence (avoids playing on a cold, seconds-off estimate).
  const sendClockSync = () => send({ type: "clockSync", clientSentAt: Date.now() });
  let warmupRemaining = CLOCK_WARMUP_SAMPLES;
  sendClockSync();
  clockTimer = setInterval(() => {
    sendClockSync();
    warmupRemaining -= 1;
    if (warmupRemaining <= 0) {
      clearInterval(clockTimer);
      clockTimer = setInterval(sendClockSync, CLOCK_STEADY_INTERVAL_MS);
    }
  }, CLOCK_WARMUP_INTERVAL_MS);
}

function pollMuseScore(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
  }

  void reportMuseScoreStatus();
  pollTimer = setInterval(() => {
    void reportMuseScoreStatus();
  }, 2000);

  if (!catalogTimer) {
    catalogTimer = setInterval(() => {
      refreshScoreCatalog();
      void reportMuseScoreStatus();
    }, 30_000);
  }
}

async function reportMuseScoreStatus(): Promise<void> {
  if (statusReportInFlight) {
    statusReportQueued = true;
    return;
  }

  statusReportInFlight = true;
  try {
    const status = await getMuseScoreStatus();
    lastMuseScoreStatus = status;
    const match = matchMuseScoreSong(currentSong, scoreCatalog.entries);
    const mismatch = scoreMismatchDetail(status);
    // The full catalog can be large, so only attach it when it has actually been
    // (re)scanned since the last publish. The coordinator keeps the previous
    // catalog on status updates that omit it, while songMatch stays fresh every tick.
    const includeCatalog = scoreCatalog.scannedAt !== lastPublishedCatalogAt;
    if (includeCatalog) {
      lastPublishedCatalogAt = scoreCatalog.scannedAt;
    }
    send({
      type: "adapterStatus",
      app: "musescore",
      ready: status.ready,
      title: status.title,
      playback: status.ready ? inferredPlayback : "unknown",
      playbackDetail: playbackDetail(),
      ...(includeCatalog
        ? {
          catalog: {
            entries: publicCatalogEntries(scoreCatalog.entries),
            total: scoreCatalog.entries.length,
            rootCount: scoreCatalog.rootCount,
            scannedAt: scoreCatalog.scannedAt,
            detail: scoreCatalog.detail
          }
        }
        : {}),
      songMatch: match,
      detail: match.status === "missing" || match.status === "ambiguous"
        ? match.detail
        : mismatch ?? status.detail,
      // A bridge helper drives real playback state and isn't subject to the
      // keyboard fallback's setup latency, so it needs no extra count-in. The
      // resident trigger does its setup before the cue, so it asks for barely
      // more; only the shell-per-command fallback needs a count-in big enough to
      // launch PowerShell and prepare an app inside it.
      requiredLeadMs: hasActiveBridge() ? 0 : museScoreDispatchLeadMs(),
      tempo: currentTempoStatus()
    });
  } finally {
    statusReportInFlight = false;
    if (statusReportQueued) {
      statusReportQueued = false;
      void reportMuseScoreStatus();
    }
  }
}

// The resident helpers outlive a plain parent kill on Windows, and a stranded
// listener keeps owning the cue combination system-wide -- which would then fail
// to register on the next run. Release both on the way out.
for (const signal of ["SIGINT", "SIGTERM", "SIGBREAK"] as const) {
  process.on(signal, () => {
    cueHotkeyListener?.stop();
    trigger.stop();
    process.exit(0);
  });
}
process.on("exit", () => {
  cueHotkeyListener?.stop();
  trigger.stop();
});

function stopIntervals(): void {
  if (clockTimer) {
    clearInterval(clockTimer);
    clockTimer = undefined;
  }

  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = undefined;
  }

  if (catalogTimer) {
    clearInterval(catalogTimer);
    catalogTimer = undefined;
  }
}

async function getMuseScoreStatus(): Promise<MuseScoreStatus> {
  if (bridgeStatus.ready !== undefined) {
    return {
      ready: Boolean(bridgeStatus.ready),
      title: bridgeStatus.title,
      detail: bridgeStatus.detail || "MuseScore bridge status reported",
      windowTitle: bridgeStatus.windowTitle
    };
  }

  const script = `
$processMatch = '${escapePowerShellSingleQuoted(args.processMatch)}'
$titleMatch = '${escapePowerShellSingleQuoted(args.titleMatch ?? "")}'
$process = Get-Process | Where-Object {
  $_.MainWindowHandle -ne 0 -and ($_.ProcessName -match $processMatch) -and
    (-not $titleMatch -or $_.MainWindowTitle -match $titleMatch)
} | Sort-Object -Property StartTime -Descending | Select-Object -First 1
if ($process) {
  [PSCustomObject]@{
    processId = $process.Id
    processName = $process.ProcessName
    windowTitle = ($process.MainWindowTitle -replace '\\r|\\n', ' ')
  } | ConvertTo-Json -Compress
  exit 0
}
exit 1
`;

  const result = await runPowerShell(script);
  if (result.code === 0) {
    const detected = parsePowerShellJson<{
      processId?: number;
      processName?: string;
      windowTitle?: string;
    }>(result.stdout);
    const windowTitle = detected?.windowTitle?.trim() || "MuseScore";
    const title = scoreTitleFromWindowTitle(windowTitle);
    return {
      ready: true,
      title,
      detail: `MuseScore window detected: ${windowTitle}`,
      processId: detected?.processId,
      processName: detected?.processName,
      windowTitle
    };
  }

  return {
    ready: false,
    detail: args.titleMatch
      ? `No visible MuseScore window matched process /${args.processMatch}/ and title /${args.titleMatch}/`
      : `No visible MuseScore window matched process /${args.processMatch}/`
  };
}

async function triggerMuseScoreTransport(
  action: TransportAction,
  sequenceId: number,
  dueLocalAt = Date.now(),
  resetBeforePlay = false
): Promise<void> {
  const queuedBridgeCommand = bridgeCommands.get(sequenceId);
  // A helper that claimed the command gets the configured grace period to
  // report its result. An unclaimed command has already had the whole count-in
  // to be noticed, so waiting another 900 ms here only makes fallback late.
  const bridgeResult = queuedBridgeCommand?.status === "claimed"
    ? await waitForBridgeResult(sequenceId, args.bridgeFallbackMs)
    : queuedBridgeCommand?.status === "succeeded" || queuedBridgeCommand?.status === "failed"
      ? queuedBridgeCommand
      : undefined;

  if (bridgeResult?.status === "succeeded") {
    applyBridgeCommandResult(action, sequenceId, bridgeResult);
    return;
  }

  if (bridgeResult?.status === "failed") {
    console.warn(`MuseScore bridge ${action} failed: ${bridgeResult.detail ?? "No detail reported"}`);
  }

  const requestedTempo = sanitizeTempoPercent(currentSong?.tempoPercent);
  if (action === "play" && requestedTempo !== 100) {
    reportCommandStatus({
      ready: false,
      action,
      sequenceId,
      status: "failed",
      detail: bridgeResult?.detail ?? `MuseScore Bridge did not confirm ${requestedTempo}% tempo; keyboard fallback was not used.`,
      controlPath: "tempo-preflight",
      at: Date.now()
    });
    return;
  }

  if (queuedBridgeCommand && queuedBridgeCommand.status !== "failed") {
    queuedBridgeCommand.status = "expired";
  }

  // Read at trigger time, not at queue time: the room can publish a corrected
  // start measure during the count-in, and the last word before the downbeat
  // should win.
  const startMeasure = action === "play" && resetBeforePlay
    ? startMeasureForSong(currentSong)
    : undefined;
  const keys = keysForAction(action, resetBeforePlay, startMeasure);
  // Preferred path: a process that is already warm only has to take the window,
  // send the reset, and wait out the remaining count-in. It reports failure
  // rather than throwing, so anything unexpected drops straight through to the
  // shell-per-command path below.
  if (await triggerTransportWithWarmProcess(action, sequenceId, dueLocalAt, keys, resetBeforePlay, startMeasure)) {
    return;
  }

  if (!warmPathDegraded && trigger.running) {
    // Loud, because the cost is hidden otherwise: the fallback needs seconds of
    // lead where the trigger needed hundreds of milliseconds, and a room that is
    // not told about it will keep scheduling starts the fallback cannot make.
    warmPathDegraded = true;
    console.warn(
      "MuseScore trigger could not run this command (usually because Windows would not let a "
        + "background process take the foreground); falling back to a shell per command and asking "
        + `the room for ${adaptiveDispatchLeadMs} ms of count-in. Give this machine's cue a global `
        + "hotkey (--cue-hotkey) so MuseScore can keep the foreground."
    );
    void reportMuseScoreStatus();
  }

  const script = `
${SENDKEYS_ASSEMBLY_PREAMBLE}
try { (Get-Process -Id $PID).PriorityClass = 'High' } catch {}
$processMatch = '${escapePowerShellSingleQuoted(args.processMatch)}'
$titleMatch = '${escapePowerShellSingleQuoted(args.titleMatch ?? "")}'
$process = Get-Process | Where-Object {
  $_.MainWindowHandle -ne 0 -and ($_.ProcessName -match $processMatch) -and
    (-not $titleMatch -or $_.MainWindowTitle -match $titleMatch)
} | Sort-Object -Property StartTime -Descending | Select-Object -First 1
if (-not $process) { exit 2 }
$activated = $false
for ($attempt = 0; $attempt -lt ${args.activationRetries}; $attempt++) {
  [Microsoft.VisualBasic.Interaction]::AppActivate($process.Id) | Out-Null
  Start-Sleep -Milliseconds ${args.activationDelayMs}
  $foreground = [BandCueWin32]::GetForegroundWindow()
  [uint32]$foregroundProcessId = 0
  [BandCueWin32]::GetWindowThreadProcessId($foreground, [ref]$foregroundProcessId) | Out-Null
  if ($foregroundProcessId -eq $process.Id) {
    $activated = $true
    break
  }
}
if (-not $activated) { exit 3 }
$prefixKeys = @(${keys.slice(0, -1).map((stroke) => `'${escapePowerShellSingleQuoted(stroke.key)}'`).join(", ")})
# Per-key pauses: a transport key needs MuseScore to settle, typing into its
# Find box does not (see GOTO_MEASURE_TYPE_GAP_MS).
$prefixGaps = @(${keys.slice(0, -1).map((stroke) => String(stroke.gapMs ?? args.commandGapMs)).join(", ")})
for ($index = 0; $index -lt $prefixKeys.Count; $index++) {
  [System.Windows.Forms.SendKeys]::SendWait($prefixKeys[$index])
  Start-Sleep -Milliseconds $prefixGaps[$index]
}
$setupCompletedLocal = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
$dueLocalAt = [int64]${Math.round(dueLocalAt)}
# Shrink the system timer granularity (normally ~15.6 ms) for the remainder of
# this process so Start-Sleep/SpinWait track dueLocalAt tightly instead of
# rounding up to the next tick.
[void][BandCueWin32]::timeBeginPeriod(1)
while ($true) {
  $remainingMs = $dueLocalAt - [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  if ($remainingMs -le 0) { break }
  if ($remainingMs -gt 25) {
    Start-Sleep -Milliseconds ($remainingMs - 15)
  } else {
    [System.Threading.Thread]::SpinWait(500)
  }
}
$firedAtLocal = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
[System.Windows.Forms.SendKeys]::SendWait('${escapePowerShellSingleQuoted(keys.at(-1)?.key ?? "")}')
[void][BandCueWin32]::timeEndPeriod(1)
[PSCustomObject]@{
  processId = $process.Id
  processName = $process.ProcessName
  windowTitle = ($process.MainWindowTitle -replace '\\r|\\n', ' ')
  keyCount = $prefixKeys.Count + 1
  firedAtLocal = $firedAtLocal
  setupCompletedLocal = $setupCompletedLocal
} | ConvertTo-Json -Compress
`;

  const result = await runPowerShell(script);
  if (result.code !== 0) {
    const detail = museScoreCommandFailureDetail(result);
    console.warn(`MuseScore ${action} failed: ${detail}`);
    reportCommandStatus({
      ready: false,
      action,
      sequenceId,
      status: "failed",
      detail: trimSingleLine(detail),
      at: Date.now()
    });
  } else {
    const commandResult = parsePowerShellJson<{
      processId?: number;
      processName?: string;
      windowTitle?: string;
      keyCount?: number;
      firedAtLocal?: number;
      setupCompletedLocal?: number;
    }>(result.stdout);
    inferredPlayback = action === "play" ? "playing" : "stopped";
    bridgeStatus.playback = inferredPlayback;
    if (commandResult?.windowTitle) {
      lastMuseScoreStatus = {
        ready: true,
        title: scoreTitleFromWindowTitle(commandResult.windowTitle),
        detail: `MuseScore window detected: ${commandResult.windowTitle}`,
        processId: commandResult.processId,
        processName: commandResult.processName,
        windowTitle: commandResult.windowTitle
      };
    }
    const lateDetail = action === "play"
      ? adjustDispatchLeadForSetupMargin(dueLocalAt, commandResult?.setupCompletedLocal)
      : undefined;
    console.log(`MuseScore ${action} triggered.`);
    const mismatch = scoreMismatchDetail(lastMuseScoreStatus);
    reportCommandStatus({
      ready: true,
      action,
      sequenceId,
      status: "succeeded",
      detail: mismatch ?? lateDetail ?? museScoreCommandSuccessDetail(action, keys, resetBeforePlay, bridgeResult, startMeasure),
      controlPath: `windows-sendkeys:${action === "play" ? playControlPath(resetBeforePlay, startMeasure) : "stop-key"}`,
      // MuseScore's Find box takes the measure number literally, so the keys
      // either land on it or the command failed outright.
      startMeasure: action === "play" && resetBeforePlay ? startMeasure ?? 1 : undefined,
      firedAtServerTime: Number.isFinite(commandResult?.firedAtLocal)
        ? Math.round((commandResult?.firedAtLocal ?? Date.now()) + serverOffsetMs)
        : undefined,
      at: Date.now()
    });
  }
}

/**
 * The lead a Play needs right now, given which control path will actually run
 * it. A trigger that is *running* but keeps failing to take the window is worse
 * than one that is down: every command silently falls back to a shell that needs
 * seconds, while the room is told it needs milliseconds. So the reported figure
 * follows the last command's real outcome, not merely whether the process is up.
 */
function museScoreDispatchLeadMs(): number {
  return trigger.running && !warmPathDegraded ? adaptiveWarmLeadMs : adaptiveDispatchLeadMs;
}

/**
 * Claims the external cue system-wide, on the machine the pedal is plugged into.
 *
 * Without this the cue only reaches BandCue while the host page holds the
 * keyboard focus -- which is the same focus MuseScore needs to be driven by
 * keystrokes, so one of the two always loses. With it, MuseScore can keep the
 * foreground all night and the cue still arrives.
 */
function startCueHotkeyListener(): void {
  if (!args.cueHotkey) {
    return;
  }

  const hotkey = parseCueHotkey(args.cueHotkey);
  if (!hotkey) {
    console.error(
      `--cue-hotkey "${args.cueHotkey}" is not a combination this adapter can register. `
        + 'Use at least one modifier and one key, e.g. "ctrl+alt+p".'
    );
    return;
  }

  cueHotkeyListener = new CueHotkeyListener(hotkey, {
    onReady: (registered) => {
      console.log(
        `Listening for the ${registered.label} cue system-wide; MuseScore can keep the foreground.`
      );
    },
    onCue: (cueAtLocalMs, ageMs) => forwardCue(cueAtLocalMs, ageMs),
    onError: (detail) => {
      console.warn(
        `Cue hotkey ${hotkey.label} unavailable (${detail}). Another application may already own `
          + "it; the host page's own hotkey still works while its window has focus."
      );
    }
  });
  cueHotkeyListener.start();
}

/**
 * Forwards a captured cue to the room, stamped with the instant Windows generated
 * the input so the count-in can be anchored to the pedal's beat -- the same
 * anchoring the host page does with the keydown's `event.timeStamp`.
 *
 * Sent as an `externalCue`, not a play request: the coordinator relays it to the
 * host, which issues its own Play. Claiming a hotkey must not promote this
 * adapter into an authority that may start playback -- host-only mode has to keep
 * meaning what it says.
 */
function forwardCue(cueAtLocalMs: number, ageMs: number): void {
  if (ws?.readyState !== WebSocket.OPEN) {
    console.warn("Cue ignored: not connected to a BandCue room.");
    return;
  }

  send({
    type: "externalCue",
    cueAtServerTime: Math.round(cueAtLocalMs + serverOffsetMs),
    source: `${args.cueHotkey ?? "cue"} on ${args.name}`
  });
  console.log(`Cue forwarded to the host (input was ${ageMs} ms old when it reached the adapter).`);
}

/**
 * Looks up the MuseScore window ahead of the cue, without disturbing the
 * foreground. Runs when the room arms. Failures are left for the command path to
 * retry or fall back on -- an arm is a hint that a Play is coming, not a command.
 */
async function resolveTriggerTarget(): Promise<boolean> {
  if (hasActiveBridge() || !trigger.start()) {
    return false;
  }

  // The window lookup. Play and stop are posted straight into MuseScore's message
  // queue and need no foreground window at all.
  const result = await trigger.resolve();
  triggerResolvedAt = result.ok ? Date.now() : undefined;
  if (!result.ok) {
    console.warn(`MuseScore trigger could not ready the window while arming: ${result.error ?? "unknown"}`);
    return false;
  }

  // The reset does need it, though. Ctrl+Home is matched as an application
  // shortcut rather than handled as a plain key event, and Qt only matches
  // shortcuts for the *active* window -- so a posted reset into a background
  // MuseScore is accepted and ignored, and playback resumes wherever it was left.
  // Bringing the window forward while the room merely arms is only safe once the
  // cue is claimed system-wide, since otherwise this would take the cue away from
  // the host page.
  if (cueHotkeyListener && result.processId) {
    await activateMuseScoreWindow(result.processId);
  }
  return true;
}

/**
 * Brings MuseScore forward from a *newly spawned* process.
 *
 * This cannot be done from the resident trigger: Windows grants the right to
 * change the foreground window only to a process that is already the foreground
 * one, was started by it, or received the last input event, and a long-lived
 * helper is none of those -- its AppActivate is simply refused. A fresh process
 * still gets the grant, which is why the old shell-per-command path could
 * activate at all. Best-effort: if it fails, playback still starts, just without
 * the rewind.
 */
async function activateMuseScoreWindow(processId: number): Promise<void> {
  await new Promise<void>((resolve) => {
    // WScript.Shell over COM, so this pays no Add-Type compilation.
    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-Command", `(New-Object -ComObject WScript.Shell).AppActivate(${processId})`],
      { windowsHide: true }
    );
    const timer = setTimeout(() => {
      child.kill();
      resolve();
    }, 4000);
    child.on("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/**
 * Runs a transport command through the resident trigger. Returns false when the
 * trigger could not take it, so the caller falls back to a one-shot shell.
 */
async function triggerTransportWithWarmProcess(
  action: TransportAction,
  sequenceId: number,
  dueLocalAt: number,
  keys: MuseScoreKeyStroke[],
  resetBeforePlay: boolean,
  startMeasure: number | undefined
): Promise<boolean> {
  if (!trigger.start()) {
    return false;
  }

  // The trigger paces every prefix key with one uniform gap, so only the keys
  // themselves cross over (gotoMeasureLeadMs budgets the count-in for that).
  const pressed = keys.map((stroke) => stroke.key);
  // A measure jump types into MuseScore's Find box, which only listens to the
  // real keyboard focus: posted into the main window the digits would be taken
  // as note durations and edit the score. Verified on MuseScore 4 -- the posted
  // attempt left added beams and a system break behind.
  const allowPost = startMeasure === undefined;

  // Stop has no downbeat to hit -- send it and be done.
  if (action === "stop") {
    const stopped = await trigger.sendKeys(pressed, undefined, allowPost);
    if (!stopped.ok) {
      return false;
    }
    applyWarmTriggerSuccess(action, sequenceId, keys, false, stopped, undefined, undefined);
    return true;
  }

  // A window looked up long ago may be gone; the trigger re-resolves on its own
  // when that happens, this just keeps the common case off the critical path.
  if (triggerResolvedAt !== undefined && Date.now() - triggerResolvedAt > TRIGGER_RESOLVE_TTL_MS) {
    triggerResolvedAt = undefined;
  }

  const handedOverAt = Date.now();
  const fired = await trigger.fire(pressed.slice(0, -1), pressed.at(-1) ?? "", dueLocalAt, undefined, allowPost);
  if (!fired.ok || !Number.isFinite(fired.firedAtLocal)) {
    // A measure jump has to be typed, and Windows only lets a background process
    // take the foreground under conditions an adapter cannot count on. Rather
    // than leaving this device silent while the band plays, start it from the
    // top the way a room without a start measure does -- posted, so no
    // foreground is needed -- and report measure 1 so the host says out loud
    // that this device is playing a different part of the song.
    return startMeasure === undefined
      ? false
      : playFromTopAfterFailedJump(action, sequenceId, dueLocalAt, resetBeforePlay, startMeasure);
  }

  if (warmPathDegraded) {
    warmPathDegraded = false;
    console.log("MuseScore trigger is handling commands again; count-in requirement back to normal.");
  }
  const lateDetail = adjustWarmLeadForSetup(dueLocalAt, handedOverAt, fired.readyAtLocal);
  applyWarmTriggerSuccess(action, sequenceId, keys, resetBeforePlay, fired, lateDetail, startMeasure);
  return true;
}

/** The plain reset-to-top play, for when the measure jump could not be typed. */
async function playFromTopAfterFailedJump(
  action: TransportAction,
  sequenceId: number,
  dueLocalAt: number,
  resetBeforePlay: boolean,
  startMeasure: number
): Promise<boolean> {
  const plainKeys = keysForAction(action, resetBeforePlay);
  const pressed = plainKeys.map((stroke) => stroke.key);
  const handedOverAt = Date.now();
  const fired = await trigger.fire(pressed.slice(0, -1), pressed.at(-1) ?? "", dueLocalAt);
  if (!fired.ok || !Number.isFinite(fired.firedAtLocal)) {
    return false;
  }

  const lateDetail = adjustWarmLeadForSetup(dueLocalAt, handedOverAt, fired.readyAtLocal);
  applyWarmTriggerSuccess(
    action,
    sequenceId,
    plainKeys,
    resetBeforePlay,
    fired,
    `${lateDetail ? `${lateDetail}; ` : ""}could not take the MuseScore window to type measure ${startMeasure} `
      + "into Find / Go to, so it started from the top; bring MuseScore to the front to start at a measure",
    // What it really did, so the host warns about the mismatch.
    1
  );
  return true;
}

function applyWarmTriggerSuccess(
  action: TransportAction,
  sequenceId: number,
  keys: MuseScoreKeyStroke[],
  resetBeforePlay: boolean,
  result: { firedAtLocal?: number; processId?: number; processName?: string; windowTitle?: string },
  lateDetail: string | undefined,
  startMeasure: number | undefined
): void {
  inferredPlayback = action === "play" ? "playing" : "stopped";
  lastMuseScoreStatus = {
    ready: true,
    title: result.windowTitle,
    processId: result.processId,
    processName: result.processName,
    windowTitle: result.windowTitle
  };
  reportCommandStatus({
    ready: true,
    action,
    sequenceId,
    status: "succeeded",
    detail: lateDetail ?? museScoreCommandSuccessDetail(action, keys, resetBeforePlay, undefined, startMeasure),
    controlPath: `windows-trigger:${action === "play" ? "warm-play" : "stop-key"}`,
    // Same keys as the shell path, so the same measure was reached.
    startMeasure: action === "play" && resetBeforePlay ? startMeasure ?? 1 : undefined,
    firedAtServerTime: Number.isFinite(result.firedAtLocal)
      ? Math.round((result.firedAtLocal ?? Date.now()) + serverOffsetMs)
      : undefined,
    at: Date.now()
  });
}

/**
 * The handover, activation, and prefix keys are meant to finish before the
 * downbeat, leaving only the timed wait. When they don't, the key fires late --
 * so ask the room for a little more lead next time, the same way the shell path
 * does, but from a much smaller base and with a much lower ceiling.
 */
function adjustWarmLeadForSetup(
  dueLocalAt: number,
  handedOverAt: number,
  readyAtLocal: number | undefined
): string | undefined {
  if (!Number.isFinite(readyAtLocal)) {
    return undefined;
  }

  const marginMs = dueLocalAt - (readyAtLocal as number);
  if (marginMs >= 0) {
    return undefined;
  }

  const overrunMs = -marginMs;
  const neededMs = (readyAtLocal as number) - handedOverAt;
  const grownLeadMs = Math.min(
    MAX_WARM_TRIGGER_LEAD_MS,
    Math.max(adaptiveWarmLeadMs + overrunMs + DISPATCH_LEAD_OVERRUN_CUSHION_MS, neededMs)
  );
  const detail = `MuseScore Play fired late (the trigger needed ${Math.round(neededMs)} ms to take the window `
    + `and send the reset, but had ${adaptiveWarmLeadMs} ms of lead); `
    + (grownLeadMs > adaptiveWarmLeadMs
      ? `increasing lead time to ${Math.round(grownLeadMs)} ms for the rest of this session`
      : `lead time is already at its ${MAX_WARM_TRIGGER_LEAD_MS} ms cap`);
  console.warn(detail);
  adaptiveWarmLeadMs = Math.round(grownLeadMs);
  void reportMuseScoreStatus();
  return detail;
}

// Setup (spawn + activate + prefix keys) is meant to finish well before
// dueLocalAt, leaving only the precise wait loop before the final Play key.
// When it finishes late, that key fired immediately instead of on the
// downbeat — grow the lead time so later songs in the same session get more
// runway, since a slow machine tends to stay slow all night.
function adjustDispatchLeadForSetupMargin(
  dueLocalAt: number,
  setupCompletedLocal: number | undefined
): string | undefined {
  if (!Number.isFinite(setupCompletedLocal)) {
    return undefined;
  }

  const marginMs = dueLocalAt - (setupCompletedLocal as number);
  if (marginMs >= 0) {
    return undefined;
  }

  const overrunMs = -marginMs;
  const grownLeadMs = Math.min(
    MAX_DISPATCH_LEAD_MS,
    adaptiveDispatchLeadMs + overrunMs + DISPATCH_LEAD_OVERRUN_CUSHION_MS
  );
  const detail = `MuseScore Play fired late (setup overran the ${adaptiveDispatchLeadMs} ms lead time by ${overrunMs} ms); `
    + (grownLeadMs > adaptiveDispatchLeadMs
      ? `increasing lead time to ${grownLeadMs} ms for the rest of this session`
      : `lead time is already at its ${MAX_DISPATCH_LEAD_MS} ms cap`);
  console.warn(detail);
  adaptiveDispatchLeadMs = grownLeadMs;
  // Push the new requiredLeadMs immediately rather than waiting for the next
  // 2s poll, so the room's count-in grows before the next Play is requested.
  void reportMuseScoreStatus();
  return detail;
}

async function handleOpenSongCommand(sequenceId: number): Promise<void> {
  reportCommandStatus({
    ready: true,
    action: "open-song",
    sequenceId,
    status: "pending",
    detail: "MuseScore open-song command received",
    controlPath: bridgeServer ? "musescore-bridge" : "local-score-catalog",
    at: Date.now()
  });

  const match = matchMuseScoreSong(currentSong, scoreCatalog.entries);
  const entry = matchedCatalogEntry(match, scoreCatalog.entries);
  if (!entry) {
    reportCommandStatus({
      ready: false,
      action: "open-song",
      sequenceId,
      status: "failed",
      detail: match.detail ?? "No matching local MuseScore score was found.",
      controlPath: "local-score-catalog",
      at: Date.now()
    });
    return;
  }

  // A score change creates a new MuseScore process. Retire every currently
  // attached plugin first so an old window that refuses to close (for example
  // because it has unsaved edits) can never keep receiving Play/Stop too.
  broadcastBridgeSocket({ type: "retire", reason: "BandCue is opening another score" });
  await sleep(250);

  const opened = await openLocalScore(entry.absolutePath, entry.relativePath);
  if (opened.opened && opened.windowTitle) {
    lastMuseScoreStatus = {
      ready: true,
      title: scoreTitleFromWindowTitle(opened.windowTitle),
      windowTitle: opened.windowTitle,
      detail: opened.detail
    };
  }
  reportCommandStatus({
    ready: opened.opened,
    action: "open-song",
    sequenceId,
    status: opened.opened ? "succeeded" : "failed",
    detail: opened.detail,
    controlPath: "local-score-catalog",
    at: Date.now()
  });
  if (opened.opened) {
    // Normally the reopened score brings a fresh plugin, which gets the start
    // measure with its `hello`. This covers a plugin that survived the retire.
    prepareBridgeStartMeasure("the score was opened");
  }
}

function applyBridgeCommandResult(
  action: TransportAction,
  sequenceId: number,
  command: BridgeCommand
): void {
  if (command.playback) {
    inferredPlayback = command.playback;
    bridgeStatus.playback = command.playback;
  } else {
    inferredPlayback = action === "play" ? "playing" : "stopped";
    bridgeStatus.playback = inferredPlayback;
  }

  bridgeStatus = {
    ...bridgeStatus,
    ready: true,
    title: command.title ?? bridgeStatus.title,
    windowTitle: command.windowTitle ?? command.title ?? bridgeStatus.windowTitle,
    detail: command.detail ?? "MuseScore bridge completed the command"
  };

  if (command.title || command.windowTitle) {
    lastMuseScoreStatus = {
      ready: true,
      title: command.title ?? command.windowTitle,
      windowTitle: command.windowTitle ?? command.title,
      detail: command.detail ?? "MuseScore bridge completed the command"
    };
  }

  const mismatch = scoreMismatchDetail(lastMuseScoreStatus);
  console.log(`MuseScore ${action} completed through bridge.`);
  reportCommandStatus({
    ready: true,
    action,
    sequenceId,
    status: "succeeded",
    detail: mismatch ?? command.detail ?? "MuseScore bridge completed the command",
    controlPath: command.controlPath ?? "musescore-bridge",
    // A bridge helper says which measure it really started from; without an
    // answer we can only report the top, so the host warns instead of assuming
    // an external plugin honored the song's start measure.
    startMeasure: action === "play" && command.resetBeforePlay
      ? command.reachedMeasure ?? 1
      : undefined,
    at: command.completedAt ?? Date.now()
  });
}

function reportCommandStatus(command: {
  ready: boolean;
  action: TransportAction | "open-song";
  sequenceId: number;
  status: "pending" | "succeeded" | "failed";
  detail: string;
  at: number;
  controlPath?: string;
  startMeasure?: number;
  firedAtServerTime?: number;
}): void {
  const state: AdapterStatus["state"] =
    command.status === "pending"
      ? "command-pending"
      : command.status === "succeeded"
        ? "last-command-succeeded"
        : "last-command-failed";

  send({
    type: "adapterStatus",
    app: "musescore",
    ready: command.ready,
    state,
    title: lastMuseScoreStatus?.title,
    playback: inferredPlayback,
    playbackDetail: playbackDetail(),
    detail: command.detail,
    lastCommand: {
      action: command.action,
      sequenceId: command.sequenceId,
      status: command.status,
      at: command.at,
      detail: command.detail,
      controlPath: command.controlPath,
      startMeasure: command.startMeasure,
      firedAtServerTime: command.firedAtServerTime
    }
  });
}

function keysForAction(
  action: TransportAction,
  resetBeforePlay = false,
  startMeasure: number | undefined = undefined
): MuseScoreKeyStroke[] {
  return keysForActionWithConfig(args, action, resetBeforePlay, startMeasure);
}

function startMeasureForSong(song: SetlistSong | undefined): number | undefined {
  return sanitizeStartMeasure(song?.startMeasure);
}

/** Extra count-in this song's measure jump needs before the Play key waits. */
function gotoMeasureLeadMs(song: SetlistSong | undefined): number {
  return gotoMeasureLeadMsWithConfig(args, startMeasureForSong(song), args.commandGapMs);
}

function museScoreCommandSuccessDetail(
  action: TransportAction,
  keys: MuseScoreKeyStroke[],
  resetBeforePlay: boolean,
  bridgeResult?: BridgeCommand,
  startMeasure: number | undefined = undefined
): string {
  const fallbackPrefix = bridgeResult?.status === "failed"
    ? `MuseScore bridge failed (${bridgeResult.detail ?? "no detail"}); fallback `
    : "";

  if (action === "play" && resetBeforePlay && args.playMode === "stop-then-play") {
    const target = sanitizeStartMeasure(startMeasure)
      ? `, jumped to measure ${sanitizeStartMeasure(startMeasure)}`
      : "";
    return `${fallbackPrefix}stopped first, sent ${describeKey(args.resetKey)} to reset to the beginning${target}, then sent ${describeKey(args.playFromSelectionKey || args.playKey)} to MuseScore`;
  }

  if (action === "play" && args.playMode === "stop-then-play") {
    return `${fallbackPrefix}stopped first, then sent ${describeKey(args.playKey)} to MuseScore`;
  }

  return `${fallbackPrefix}sent ${keys.map((stroke) => describeKey(stroke.key)).join(", ")} to MuseScore`;
}

function playControlPath(resetBeforePlay: boolean, startMeasure?: number): string {
  return playControlPathWithConfig(args, resetBeforePlay, startMeasure);
}

function museScoreCommandFailureDetail(result: {
  code: number | null;
  stdout: string;
  stderr: string;
}): string {
  const output = trimSingleLine(result.stderr || result.stdout);
  if (output) {
    return output;
  }

  if (result.code === 2) {
    return "MuseScore window was not available when the command ran";
  }

  if (result.code === 3) {
    return "MuseScore window was found, but Windows did not make it the foreground app";
  }

  return "MuseScore command failed without additional output";
}

function playbackDetail(): string {
  if (bridgeStatus.playback) {
    return "Playback state was reported through the local MuseScore bridge";
  }

  if (inferredPlayback === "unknown") {
    return "Playback state is unknown until this helper successfully sends a play or stop command";
  }

  return `Playback is inferred ${inferredPlayback} from the last successful BandCue command`;
}

function scoreMismatchDetail(status: MuseScoreStatus | undefined): string | undefined {
  if (!status?.ready || !appliesToMuseScore(currentSong)) {
    return undefined;
  }

  const reference = museScoreReference(currentSong) || currentSong?.title || "";
  const expected = normalizeTitle(reference);
  const actual = normalizeTitle(status.title || status.windowTitle || "");
  if (!expected || !actual || actual.includes(expected) || expected.includes(actual)) {
    return undefined;
  }

  return `MuseScore is ready, but active score "${status.title || status.windowTitle}" does not match current song "${reference}"`;
}

function normalizeTitle(value: string): string {
  return value
    .replace(/\.(mscz|mscx)$/i, "")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function startBridge(port: number): void {
  bridgeServer = createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${port || 0}`);

    if (req.method === "GET" && url.pathname === "/status") {
      bridgeLastSeenAt = Date.now();
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({
        ok: true,
        status: bridgeStatus,
        currentSong,
        bridge: {
          fallbackMs: args.bridgeFallbackMs,
          lastSeenAt: bridgeLastSeenAt
        }
      }));
      return;
    }

    if (req.method === "GET" && url.pathname === "/catalog") {
      bridgeLastSeenAt = Date.now();
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({
        entries: publicCatalogEntries(scoreCatalog.entries),
        total: scoreCatalog.entries.length,
        rootCount: scoreCatalog.rootCount,
        scannedAt: scoreCatalog.scannedAt,
        detail: scoreCatalog.detail
      }));
      return;
    }

    if (req.method === "GET" && url.pathname === "/commands") {
      bridgeLastSeenAt = Date.now();
      cleanupBridgeCommands();
      const commands = [...bridgeCommands.values()]
        .filter((command) => command.status === "queued" || command.status === "claimed")
        .sort((a, b) => a.dueLocalAt - b.dueLocalAt);
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ commands }));
      return;
    }

    const commandMatch = url.pathname.match(/^\/commands\/(\d+)\/(claim|result)$/);
    if (req.method === "POST" && commandMatch) {
      const sequenceId = Number.parseInt(commandMatch[1] ?? "", 10);
      const action = commandMatch[2];
      readJsonBody(req, res, (body) => {
        if (action === "claim") {
          handleBridgeClaim(sequenceId, body, res);
          return;
        }

        handleBridgeResult(sequenceId, body, res);
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/status") {
      readJsonBody(req, res, (update) => {
        applyBridgeStatus(update);
        res.writeHead(204);
        res.end();
      });
      return;
    }

    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("Not found");
  });

  bridgeServer.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "EADDRINUSE") {
      console.error(`MuseScore bridge could not start: port ${port} is already in use.`);
      console.error("Another MuseScore helper (or a leftover one) is probably still running.");
      console.error(`Close it, or pass a different port with --bridge-port, e.g. --bridge-port ${port + 1}.`);
    } else {
      console.error(`MuseScore bridge failed to start: ${error.message}`);
    }
    bridgeServer = undefined;
  });

  bridgeServer.listen(port, "127.0.0.1", () => {
    const address = bridgeServer?.address();
    const actualPort = typeof address === "object" && address ? address.port : port;
    console.log(`MuseScore bridge listening on http://127.0.0.1:${actualPort}`);
    console.log(`MuseScore plugin socket on ws://127.0.0.1:${actualPort} (same port)`);
  });

  if (bridgeServer) {
    attachBridgeSocket(bridgeServer);
  }
}

function hasActiveBridge(now = Date.now()): boolean {
  return Boolean(bridgeServer && bridgeLastSeenAt && now - bridgeLastSeenAt <= BRIDGE_ACTIVE_WINDOW_MS);
}

function queueBridgeCommand(command: BridgeCommand): boolean {
  if (!bridgeServer) {
    return false;
  }

  cleanupBridgeCommands();
  bridgeCommands.set(command.sequenceId, command);
  // Pushed as well as queued. An HTTP poller only learns about a command on its
  // next tick, which puts its whole poll interval between the count-in and the
  // plugin -- a downbeat cannot afford that. Sockets that are attached get it now
  // and do their own waiting against dueLocalAt.
  broadcastBridgeSocket({
    type: "command",
    sequenceId: command.sequenceId,
    action: command.action,
    dueLocalAt: command.dueLocalAt,
    scheduledServerTime: command.scheduledServerTime,
    resetBeforePlay: Boolean(command.resetBeforePlay),
    // Must be sent explicitly: the plugin cannot re-derive it from currentSong,
    // because only the adapter applies sanitizeStartMeasure and only the adapter
    // sees a start measure the room corrects during the count-in. Omitting it is
    // what silently played every song from bar 1 over the socket transport while
    // the HTTP /commands transport (which serializes the whole command) was fine.
    startMeasure: command.startMeasure,
    currentSong: command.currentSong
  });
  reportCommandStatus({
    ready: true,
    action: command.action,
    sequenceId: command.sequenceId,
    status: "pending",
    detail: command.action === "open-song"
      ? `MuseScore bridge open-song queued; local catalog fallback in ${args.bridgeFallbackMs} ms if no bridge result arrives`
      : `MuseScore bridge command queued; Windows fallback in ${args.bridgeFallbackMs} ms if no bridge result arrives`,
    controlPath: "musescore-bridge",
    at: Date.now()
  });
  return true;
}

/**
 * The WebSocket half of the bridge, on the same `--bridge-port` as the HTTP API.
 *
 * MuseScore's plugin sandbox has no HTTP client, but it does expose a WebSocket
 * client (`api.websocket.open`), so this is what a plugin can actually reach.
 * Pushing commands also removes a poll interval from the critical path.
 *
 * Messages in: `claim`, `result`, `status` -- the same three operations as the
 * HTTP endpoints, routed through the same handlers so the two transports cannot
 * drift apart. Messages out: `hello`, `command`, `song`.
 */
function attachBridgeSocket(server: HttpServer): void {
  // No `path` restriction: MuseScore's client API is `api.websocket.open(port, cb)`
  // -- it takes a port, not a URL, so the plugin cannot choose a path. Sharing the
  // port with the HTTP API is safe because only upgrade requests land here.
  bridgeSocketServer = new WebSocketServer({ server });
  bridgeSocketServer.on("connection", (socket) => {
    bridgeSockets.add(socket);
    bridgeLastSeenAt = Date.now();
    console.log("MuseScore bridge plugin connected.");
    void reportMuseScoreStatus();

    sendBridgeSocket(socket, {
      type: "hello",
      fallbackMs: args.bridgeFallbackMs,
      startMeasure: startMeasureForSong(currentSong),
      currentSong
    });
    // A plugin that just attached has its cursor wherever MuseScore left it.
    prepareBridgeStartMeasure("the bridge connected");

    socket.on("message", (raw) => {
      bridgeLastSeenAt = Date.now();
      let message: Record<string, unknown> | undefined;
      try {
        message = JSON.parse(raw.toString()) as Record<string, unknown>;
      } catch {
        return;
      }
      if (!message || typeof message.type !== "string") {
        return;
      }
      handleBridgeSocketMessage(message);
    });

    socket.on("close", () => {
      bridgeSockets.delete(socket);
      console.log("MuseScore bridge plugin disconnected; commands fall back to keyboard control.");
      void reportMuseScoreStatus();
    });
    socket.on("error", () => bridgeSockets.delete(socket));
  });
}

function handleBridgeSocketMessage(message: Record<string, unknown>): void {
  const sequenceId = typeof message.sequenceId === "number" ? message.sequenceId : undefined;

  if (message.type === "claim" && sequenceId !== undefined) {
    applyBridgeClaim(sequenceId, message);
    return;
  }

  if (message.type === "result" && sequenceId !== undefined) {
    applyBridgeResult(sequenceId, message);
    return;
  }

  if (message.type === "status") {
    applyBridgeStatus(message);
  }
}

function sendBridgeSocket(socket: WebSocket, message: unknown): void {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(message));
  }
}

function broadcastBridgeSocket(message: unknown): void {
  for (const socket of bridgeSockets) {
    sendBridgeSocket(socket, message);
  }
}

/**
 * Asks an attached plugin to put the cursor where this song's Play should start,
 * now rather than during the count-in.
 *
 * Seeking is the slowest thing the plugin does (it walks the score measure by
 * measure) and it is the one part of a Play that does not have to happen on the
 * beat. Doing it whenever the room's intent is already known -- the score is
 * open, the song changed, the host armed -- means the downbeat itself is only
 * ever "start playing", and a jump that goes wrong is visible on screen while
 * there is still time to do something about it.
 */
function prepareBridgeStartMeasure(reason: string): void {
  if (!bridgeSockets.size) {
    return;
  }

  // Never mid-run: moving the selection republishes the score view, and a band
  // reading from that screen should not have it jump back to bar 10 because the
  // host was lining up the next song. The plugin cannot make this call itself --
  // it sees playback start but never sees a song end on its own -- so the
  // adapter, which follows the room's transport state, makes it here.
  if (lastTransportStatus !== "stopped") {
    return;
  }

  broadcastBridgeSocket({
    type: "prepare",
    startMeasure: startMeasureForSong(currentSong),
    reason,
    currentSong
  });
}

/** Shared by both bridge transports; `undefined` means accepted. */
interface BridgeRejection {
  code: number;
  error: string;
}

function applyBridgeClaim(
  sequenceId: number,
  body: Record<string, unknown>
): BridgeRejection | undefined {
  bridgeLastSeenAt = Date.now();
  const command = bridgeCommands.get(sequenceId);
  if (!command) {
    return { code: 404, error: "Unknown command sequenceId" };
  }

  if (command.status !== "queued" && command.status !== "claimed") {
    return { code: 409, error: `Command is already ${command.status}` };
  }

  command.status = "claimed";
  command.claimedAt = Date.now();
  command.controlPath = typeof body.controlPath === "string" ? body.controlPath : "musescore-bridge";
  command.detail = typeof body.detail === "string" ? trimSingleLine(body.detail) : "MuseScore bridge claimed the command";
  return undefined;
}

function handleBridgeClaim(
  sequenceId: number,
  body: Record<string, unknown>,
  res: ServerResponse
): void {
  const rejection = applyBridgeClaim(sequenceId, body);
  if (rejection) {
    writeJson(res, rejection.code, { ok: false, error: rejection.error });
    return;
  }
  writeJson(res, 200, { ok: true, command: bridgeCommands.get(sequenceId) });
}

function applyBridgeStatus(update: Record<string, unknown>): void {
  bridgeLastSeenAt = Date.now();
  bridgeStatus = {
    ready: Boolean(update.ready ?? true),
    title: typeof update.title === "string" ? update.title : bridgeStatus.title,
    detail: typeof update.detail === "string" ? update.detail : "MuseScore bridge status reported",
    windowTitle: typeof update.windowTitle === "string"
      ? update.windowTitle
      : typeof update.title === "string"
        ? update.title
        : bridgeStatus.windowTitle,
    playback: parsePlayback(update.playback) ?? bridgeStatus.playback,
    tempo: parseBridgeTempo(update.tempo) ?? bridgeStatus.tempo
  };
  if (bridgeStatus.playback) {
    inferredPlayback = bridgeStatus.playback;
  }
  void reportMuseScoreStatus();
}

function currentTempoStatus(): AdapterTempoStatus {
  const requestedPercent = sanitizeTempoPercent(currentSong?.tempoPercent);
  if (requestedPercent === 100 && !hasActiveBridge()) {
    return { requestedPercent, appliedPercent: 100, state: "applied", detail: "100% tempo uses normal MuseScore playback" };
  }
  if (!hasActiveBridge()) {
    return { requestedPercent, state: "unsupported", detail: `MuseScore Bridge must be connected to set ${requestedPercent}% tempo.` };
  }
  return bridgeStatus.tempo ?? { requestedPercent, state: "pending", detail: `Waiting for MuseScore Bridge to apply ${requestedPercent}% tempo.` };
}

function parseBridgeTempo(value: unknown): AdapterTempoStatus | undefined {
  if (!value || typeof value !== "object") return undefined;
  const tempo = value as Record<string, unknown>;
  if (typeof tempo.requestedPercent !== "number" || typeof tempo.state !== "string") return undefined;
  return {
    requestedPercent: sanitizeTempoPercent(tempo.requestedPercent),
    appliedPercent: typeof tempo.appliedPercent === "number" ? sanitizeTempoPercent(tempo.appliedPercent) : undefined,
    state: ["pending", "applied", "failed", "unsupported"].includes(tempo.state)
      ? tempo.state as AdapterTempoStatus["state"] : "failed",
    detail: typeof tempo.detail === "string" ? trimSingleLine(tempo.detail) : undefined
  };
}

function sanitizeTempoPercent(value: number | undefined): number {
  return Math.max(15, Math.min(175, Math.round(Number(value) || 100)));
}

function applyBridgeResult(
  sequenceId: number,
  body: Record<string, unknown>
): BridgeRejection | undefined {
  bridgeLastSeenAt = Date.now();
  const command = bridgeCommands.get(sequenceId);
  if (!command) {
    return { code: 404, error: "Unknown command sequenceId" };
  }

  if (command.status === "expired") {
    return { code: 409, error: "Command already fell back to Windows keyboard control" };
  }

  if (command.status === "succeeded" || command.status === "failed") {
    return { code: 409, error: `Command is already ${command.status}` };
  }

  applyBridgeResultBody(command, body);
  return undefined;
}

function handleBridgeResult(
  sequenceId: number,
  body: Record<string, unknown>,
  res: ServerResponse
): void {
  const rejection = applyBridgeResult(sequenceId, body);
  if (rejection) {
    writeJson(res, rejection.code, { ok: false, error: rejection.error });
    return;
  }
  writeJson(res, 200, { ok: true, command: bridgeCommands.get(sequenceId) });
}

function applyBridgeResultBody(command: BridgeCommand, body: Record<string, unknown>): void {
  const status = body.status === "failed" ? "failed" : "succeeded";
  command.status = status;
  command.completedAt = Date.now();
  command.detail = typeof body.detail === "string"
    ? trimSingleLine(body.detail)
    : status === "succeeded"
      ? "MuseScore bridge completed the command"
      : "MuseScore bridge reported command failure";
  command.controlPath = typeof body.controlPath === "string" ? body.controlPath : "musescore-bridge";
  // Only what the helper claims it reached. A helper that says nothing about the
  // measure is reported as having started from the top, so the host warns rather
  // than assuming an external plugin honored the song's start measure.
  command.reachedMeasure = typeof body.startMeasure === "number"
    ? sanitizeStartMeasure(body.startMeasure)
    : undefined;
  command.playback = parsePlayback(body.playback);
  command.title = typeof body.title === "string" ? body.title : undefined;
  command.windowTitle = typeof body.windowTitle === "string"
    ? body.windowTitle
    : typeof body.title === "string"
      ? body.title
      : undefined;

  if (command.playback) {
    bridgeStatus.playback = command.playback;
    inferredPlayback = command.playback;
  }
}

interface OpenScoreResult {
  opened: boolean;
  detail: string;
  windowTitle?: string;
}

// Opens a score with the default app, waits for its window, then closes the
// previously running MuseScore instances. MuseScore 4 opens every score in a
// fresh instance, and keystroke commands become unreliable once several
// instances compete for the foreground — so the old one has to go, but only
// after the new window is confirmed (never before, and never force-killed).
async function openLocalScore(absolutePath: string, relativePath: string): Promise<OpenScoreResult> {
  const script = `
$path = '${escapePowerShellSingleQuoted(resolve(absolutePath))}'
$processMatch = '${escapePowerShellSingleQuoted(args.processMatch)}'
$closeOld = ${args.closeOldInstances ? "$true" : "$false"}
if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { exit 2 }
$before = @(Get-Process | Where-Object { $_.ProcessName -match $processMatch })
$beforeIds = @($before | ForEach-Object { $_.Id })
$oldWindowIds = @($before | Where-Object { $_.MainWindowHandle -ne 0 } | ForEach-Object { $_.Id })
Invoke-Item -LiteralPath $path
$scoreName = [System.IO.Path]::GetFileNameWithoutExtension($path)
$scorePattern = '*' + [System.Management.Automation.WildcardPattern]::Escape($scoreName) + '*'
$deadline = (Get-Date).AddMilliseconds(${OPEN_SCORE_WINDOW_TIMEOUT_MS})
$new = $null
$reused = $null
while ((Get-Date) -lt $deadline) {
  $candidates = @(Get-Process | Where-Object {
    $_.MainWindowHandle -ne 0 -and ($_.ProcessName -match $processMatch)
  })
  $new = $candidates |
    Where-Object { $beforeIds -notcontains $_.Id } |
    Sort-Object -Property StartTime -Descending |
    Select-Object -First 1
  if ($new) { break }
  $reused = $candidates | Where-Object { $_.MainWindowTitle -like $scorePattern } | Select-Object -First 1
  if ($reused) { break }
  Start-Sleep -Milliseconds 250
}
if ($new) {
  $titleDeadline = (Get-Date).AddMilliseconds(${OPEN_SCORE_TITLE_TIMEOUT_MS})
  while ((Get-Date) -lt $titleDeadline) {
    try { $new.Refresh() } catch { break }
    if ($new.MainWindowTitle -like $scorePattern) { break }
    Start-Sleep -Milliseconds 250
  }
}
$closed = @()
$lingering = @()
if ($closeOld -and $new) {
  foreach ($id in $oldWindowIds) {
    if ($id -eq $new.Id) { continue }
    $old = Get-Process -Id $id -ErrorAction SilentlyContinue
    if (-not $old -or $old.HasExited) { $closed += $id; continue }
    $old.CloseMainWindow() | Out-Null
    if ($old.WaitForExit(${OPEN_SCORE_CLOSE_WAIT_MS})) { $closed += $id } else { $lingering += $id }
  }
}
$active = if ($new) { $new } elseif ($reused) { $reused } else { $null }
$outcome = if ($new) { 'new-instance' } elseif ($reused) { 'reused-instance' } else { 'no-window' }
$activeId = $null
$activeTitle = $null
$pluginStarted = $false
if ($active) {
  try { $active.Refresh() } catch {}
  $activeId = $active.Id
  if (-not $active.HasExited) {
    $activeTitle = ($active.MainWindowTitle -replace '\\r|\\n', ' ')
    try {
      Add-Type -AssemblyName System.Windows.Forms
      $shell = New-Object -ComObject WScript.Shell
      if ($shell.AppActivate([int]$active.Id)) {
        try { $active.WaitForInputIdle(5000) | Out-Null } catch {}
        # A freshly created MuseScore window reports its title before the menu
        # bar is ready to accept keyboard input.
        Start-Sleep -Milliseconds 1500
        [System.Windows.Forms.SendKeys]::SendWait('%p')
        Start-Sleep -Milliseconds 500
        # Manage Plugins is first; BandCue Bridge is the first enabled command.
        [System.Windows.Forms.SendKeys]::SendWait('{DOWN}{ENTER}')
        $pluginStarted = $true
        Start-Sleep -Milliseconds 1500
      }
    } catch {}
  }
}
[PSCustomObject]@{
  outcome = $outcome
  processId = $activeId
  windowTitle = $activeTitle
  closedOld = $closed
  lingering = $lingering
  pluginStarted = $pluginStarted
} | ConvertTo-Json -Compress
`;
  const result = await runPowerShell(script);
  if (result.code === 2) {
    return { opened: false, detail: `MuseScore score ${relativePath} no longer exists on disk` };
  }

  if (result.code !== 0) {
    const output = trimSingleLine(result.stderr || result.stdout);
    return {
      opened: false,
      detail: output
        ? `Windows could not open MuseScore score ${relativePath}: ${output}`
        : `Windows could not open MuseScore score ${relativePath}`
    };
  }

  const outcome = parsePowerShellJson<{
    outcome?: string;
    processId?: number;
    windowTitle?: string;
    closedOld?: number[];
    lingering?: number[];
    pluginStarted?: boolean;
  }>(result.stdout);
  const windowTitle = outcome?.windowTitle?.trim() || undefined;
  const closedCount = outcome?.closedOld?.length ?? 0;
  const lingeringCount = outcome?.lingering?.length ?? 0;
  const closeSummary = [
    closedCount ? `closed ${closedCount} previous MuseScore instance${closedCount === 1 ? "" : "s"}` : "",
    lingeringCount
      ? `${lingeringCount} previous instance${lingeringCount === 1 ? "" : "s"} did not close (unsaved changes?)`
      : ""
  ].filter(Boolean).join("; ");
  const pluginSummary = outcome?.pluginStarted
    ? "BandCue Bridge launch requested automatically in the opened score"
    : "BandCue Bridge could not be started automatically";

  if (outcome?.outcome === "new-instance") {
    return {
      opened: true,
      detail: `Opened MuseScore score ${relativePath} in a new window; ${pluginSummary}${closeSummary ? `; ${closeSummary}` : ""}`,
      windowTitle
    };
  }

  if (outcome?.outcome === "reused-instance") {
    return {
      opened: true,
      detail: `MuseScore loaded score ${relativePath} in an existing window; ${pluginSummary}`,
      windowTitle
    };
  }

  return {
    opened: true,
    detail: `Launched MuseScore score ${relativePath}, but no window appeared within ${Math.round(OPEN_SCORE_WINDOW_TIMEOUT_MS / 1000)} s; previous instances were left open`
  };
}

function refreshScoreCatalog(): void {
  scoreCatalog = scanMuseScoreCatalog(args.scoreFolders, {
    recursive: args.scoreCatalogRecursive
  });
}

async function waitForBridgeResult(
  sequenceId: number,
  fallbackMs: number
): Promise<BridgeCommand | undefined> {
  const command = bridgeCommands.get(sequenceId);
  if (!command) {
    return undefined;
  }

  const deadline = Date.now() + Math.max(0, fallbackMs);
  while (Date.now() <= deadline) {
    if (command.status === "succeeded" || command.status === "failed") {
      return command;
    }

    await sleep(40);
  }

  command.status = "expired";
  return undefined;
}

function cleanupBridgeCommands(): void {
  const cutoff = Date.now() - 60_000;
  for (const [sequenceId, command] of bridgeCommands) {
    const lastActivity = command.completedAt ?? command.claimedAt ?? command.createdAt;
    if (lastActivity < cutoff) {
      bridgeCommands.delete(sequenceId);
    }
  }
}

function readJsonBody(
  req: IncomingMessage,
  res: ServerResponse,
  onBody: (body: Record<string, unknown>) => void
): void {
  let body = "";
  req.on("data", (chunk) => {
    body += chunk.toString();
    if (body.length > 20_000) {
      req.destroy();
    }
  });
  req.on("end", () => {
    try {
      const parsed = JSON.parse(body || "{}");
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("Expected JSON object");
      }
      onBody(parsed as Record<string, unknown>);
    } catch {
      res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
      res.end("Invalid JSON");
    }
  });
}

function writeJson(
  res: ServerResponse,
  status: number,
  body: unknown
): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function parsePlayback(value: unknown): AdapterPlaybackState | undefined {
  if (value === "playing" || value === "stopped" || value === "unknown") {
    return value;
  }

  return undefined;
}

function scoreTitleFromWindowTitle(windowTitle: string): string {
  const cleaned = windowTitle
    .replace(/\s+-\s+MuseScore(?:\s+Studio)?\s*$/i, "")
    .replace(/\s+\[\*\]\s*$/i, "")
    .replace(/\s+/g, " ")
    .trim();

  return cleaned || "MuseScore";
}

function describeKey(key: string): string {
  if (key === " ") {
    return "Space";
  }

  if (key === "^{HOME}") {
    return "Ctrl+Home";
  }

  return key;
}

function formatManualOffset(offsetMs: number): string {
  if (!offsetMs) {
    return "";
  }

  return ` with ${offsetMs} ms manual offset`;
}

function parsePowerShellJson<T>(stdout: string): T | undefined {
  const trimmed = stdout.trim();
  if (!trimmed) {
    return undefined;
  }

  try {
    return JSON.parse(trimmed) as T;
  } catch {
    return undefined;
  }
}

function runPowerShell(script: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-STA", "-Command", script], {
      windowsHide: true
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

function send(message: unknown): void {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(message));
  }
}

function escapePowerShellSingleQuoted(value: string): string {
  return value.replaceAll("'", "''");
}

function trimSingleLine(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 220);
}

function parseArgs(raw: string[]): Args {
  const parsed: Args = {
    port: parsePositiveInt(process.env.BANDCUE_PORT ?? process.env.PORT, DEFAULT_ROOM_PORT),
    discoveryPort: parsePositiveInt(process.env.BANDCUE_DISCOVERY_PORT, 0),
    name: `${hostname()} MuseScore`,
    playKey: " ",
    // Shift+Space is MuseScore's "play-from-selection". Plain Space resumes from
    // the playback position, which the reset key does not move -- so it is the
    // reset, not the play, that this key exists to make effective.
    playFromSelectionKey: "+ ",
    // Ctrl+Home ("first-element") moves the cursor and the view to the start of
    // the score. Plain Home only jumps within the current row.
    resetKey: "^{HOME}",
    // Ctrl+F opens MuseScore's Find / Go to box; a bare number in it jumps to
    // that measure, which is how a song can start somewhere other than bar 1.
    gotoMeasureKey: "^f",
    stopKey: "{ESC}",
    playMode: "stop-then-play",
    processMatch: "MuseScore|mscore",
    activationRetries: 5,
    activationDelayMs: 90,
    commandGapMs: 120,
    dispatchLeadMs: DEFAULT_DISPATCH_LEAD_MS,
    bridgeFallbackMs: 900,
    scoreFolders: parseScoreFolders(process.env.BANDCUE_MUSESCORE_FOLDERS),
    scoreCatalogRecursive: process.env.BANDCUE_MUSESCORE_RECURSIVE !== "0",
    closeOldInstances: process.env.BANDCUE_MUSESCORE_CLOSE_OLD !== "0",
    cueHotkey: process.env.BANDCUE_CUE_HOTKEY
  };

  for (let index = 0; index < raw.length; index += 1) {
    const value = raw[index];
    if (value === "--room") parsed.room = raw[index + 1];
    if (value === "--port") parsed.port = parsePositiveInt(raw[index + 1], parsed.port);
    if (value === "--discovery-port") {
      parsed.discoveryPort = parsePositiveInt(raw[index + 1], parsed.discoveryPort || parsed.port);
    }
    if (value === "--name") parsed.name = raw[index + 1] ?? parsed.name;
    if (value === "--play-key") parsed.playKey = raw[index + 1] ?? parsed.playKey;
    if (value === "--play-from-selection-key") {
      parsed.playFromSelectionKey = raw[index + 1] ?? parsed.playFromSelectionKey;
    }
    if (value === "--reset-key") parsed.resetKey = raw[index + 1] ?? parsed.resetKey;
    if (value === "--goto-measure-key") parsed.gotoMeasureKey = raw[index + 1] ?? parsed.gotoMeasureKey;
    if (value === "--stop-key") parsed.stopKey = raw[index + 1] ?? parsed.stopKey;
    if (value === "--play-mode") parsed.playMode = parsePlayMode(raw[index + 1], parsed.playMode);
    if (value === "--process-match") parsed.processMatch = raw[index + 1] ?? parsed.processMatch;
    if (value === "--title-match") parsed.titleMatch = raw[index + 1];
    if (value === "--activation-retries") {
      parsed.activationRetries = parsePositiveInt(raw[index + 1], parsed.activationRetries);
    }
    if (value === "--activation-delay-ms") {
      parsed.activationDelayMs = parsePositiveInt(raw[index + 1], parsed.activationDelayMs);
    }
    if (value === "--command-gap-ms") {
      parsed.commandGapMs = parsePositiveInt(raw[index + 1], parsed.commandGapMs);
    }
    if (value === "--dispatch-lead-ms") {
      parsed.dispatchLeadMs = parseNonNegativeInt(raw[index + 1], parsed.dispatchLeadMs);
    }
    if (value === "--cue-hotkey") {
      parsed.cueHotkey = raw[index + 1];
    }
    if (value === "--bridge-port") {
      parsed.bridgePort = parseNonNegativeInt(raw[index + 1], 0);
    }
    if (value === "--bridge-fallback-ms") {
      parsed.bridgeFallbackMs = parsePositiveInt(raw[index + 1], parsed.bridgeFallbackMs);
    }
    if (value === "--score-folder") {
      const folder = raw[index + 1];
      if (folder) parsed.scoreFolders.push(folder);
    }
    if (value === "--score-recursive") {
      parsed.scoreCatalogRecursive = parseBooleanFlag(raw[index + 1], parsed.scoreCatalogRecursive);
    }
    if (value === "--close-old-instances") {
      parsed.closeOldInstances = parseBooleanFlag(raw[index + 1], parsed.closeOldInstances);
    }
  }

  if (!parsed.discoveryPort) {
    parsed.discoveryPort = parsed.port;
  }

  return parsed;
}

function parseScoreFolders(value: string | undefined): string[] {
  return String(value ?? "")
    .split(";")
    .map((folder) => folder.trim())
    .filter(Boolean);
}

function parseBooleanFlag(value: string | undefined, fallback: boolean): boolean {
  if (value === "0" || value === "false" || value === "no") {
    return false;
  }

  if (value === "1" || value === "true" || value === "yes") {
    return true;
  }

  return fallback;
}

function parsePlayMode(value: string | undefined, fallback: Args["playMode"]): Args["playMode"] {
  if (value === "single-key" || value === "stop-then-play") {
    return value;
  }

  return fallback;
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseNonNegativeInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}
