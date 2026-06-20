import { spawn } from "node:child_process";
import {
  createServer,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse
} from "node:http";
import { hostname } from "node:os";
import { resolve } from "node:path";
import WebSocket from "ws";
import {
  matchMuseScoreSong,
  matchedCatalogEntry,
  publicCatalogEntries,
  scanMuseScoreCatalog,
  type LocalScoreCatalog
} from "./musescore-catalog.js";
import {
  calculateClockSample,
  calculateJitterMs,
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
  SetlistSong,
  ServerMessage,
  TransportAction
} from "../shared/protocol.js";

interface Args {
  room?: string;
  port: number;
  discoveryPort: number;
  name: string;
  playKey: string;
  resetKey: string;
  stopKey: string;
  playMode: "single-key" | "stop-then-play";
  processMatch: string;
  titleMatch?: string;
  activationRetries: number;
  activationDelayMs: number;
  commandGapMs: number;
  bridgePort?: number;
  bridgeFallbackMs: number;
  scoreFolders: string[];
  scoreCatalogRecursive: boolean;
}

interface MuseScoreStatus {
  ready: boolean;
  title?: string;
  detail?: string;
  processId?: number;
  processName?: string;
  windowTitle?: string;
}

interface BridgeCommand {
  action: TransportAction | "open-song";
  sequenceId: number;
  dueLocalAt: number;
  scheduledServerTime?: number;
  resetBeforePlay?: boolean;
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
let bridgeStatus: Partial<MuseScoreStatus> & { playback?: AdapterPlaybackState } = {};
let bridgeLastSeenAt: number | undefined;
let scoreCatalog: LocalScoreCatalog = scanMuseScoreCatalog([]);
let lastPublishedCatalogAt: number | undefined;
const bridgeCommands = new Map<number, BridgeCommand>();
let clockTimer: NodeJS.Timeout | undefined;
let pollTimer: NodeJS.Timeout | undefined;
let catalogTimer: NodeJS.Timeout | undefined;
let bridgeServer: HttpServer | undefined;
const samples: ClockSample[] = [];

if (args.bridgePort !== undefined) {
  startBridge(args.bridgePort);
}
refreshScoreCatalog();
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
      capabilities: [{ app: "musescore", canPlay: true, canStop: true }]
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
      const summary = summarizeClock(samples.slice(-10));
      serverOffsetMs = summary.offsetMs;
      send({
        type: "clockStatus",
        rttMs: summary.rttMs,
        offsetMs: summary.offsetMs,
        jitterMs: calculateJitterMs(samples.slice(-10))
      });
      return;
    }

    if (message.type === "transportCommand") {
      currentSong = message.currentSong?.song;
      const manualOffsetMs = message.manualOffsetMs ?? 0;
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
        dueLocalAt: Date.now() + delayMs,
        scheduledServerTime: message.scheduledServerTime + manualOffsetMs,
        resetBeforePlay: Boolean(message.resetBeforePlay),
        currentSong,
        status: "queued",
        createdAt: Date.now()
      });
      setTimeout(() => {
        void triggerMuseScoreTransport(message.action, message.sequenceId);
      }, delayMs);
    }

    if (message.type === "openSongCommand") {
      currentSong = message.currentSong?.song;
      void handleOpenSongCommand(message.sequenceId);
      return;
    }

    if (message.type === "error") {
      console.warn(`Coordinator rejected request: ${message.message}`);
    }

    if (message.type === "roomState") {
      currentSong = message.currentSong?.song;
      void reportMuseScoreStatus();
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

  clockTimer = setInterval(() => {
    send({ type: "clockSync", clientSentAt: Date.now() });
  }, 1000);
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
        : mismatch ?? status.detail
    });
}

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
} | Select-Object -First 1
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

async function triggerMuseScoreTransport(action: TransportAction, sequenceId: number): Promise<void> {
  const bridgeResult = bridgeServer && bridgeLastSeenAt
    ? await waitForBridgeResult(sequenceId, args.bridgeFallbackMs)
    : undefined;

  if (bridgeResult?.status === "succeeded") {
    applyBridgeCommandResult(action, sequenceId, bridgeResult);
    return;
  }

  if (bridgeResult?.status === "failed") {
    console.warn(`MuseScore bridge ${action} failed: ${bridgeResult.detail ?? "No detail reported"}`);
  }

  const resetBeforePlay = Boolean(bridgeCommands.get(sequenceId)?.resetBeforePlay);
  const keys = keysForAction(action, resetBeforePlay);
  const script = `
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
}

"@
$processMatch = '${escapePowerShellSingleQuoted(args.processMatch)}'
$titleMatch = '${escapePowerShellSingleQuoted(args.titleMatch ?? "")}'
$process = Get-Process | Where-Object {
  $_.MainWindowHandle -ne 0 -and ($_.ProcessName -match $processMatch) -and
    (-not $titleMatch -or $_.MainWindowTitle -match $titleMatch)
} | Select-Object -First 1
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
$keys = @(${keys.map((key) => `'${escapePowerShellSingleQuoted(key)}'`).join(", ")})
foreach ($key in $keys) {
  [System.Windows.Forms.SendKeys]::SendWait($key)
  Start-Sleep -Milliseconds ${args.commandGapMs}
}
[PSCustomObject]@{
  processId = $process.Id
  processName = $process.ProcessName
  windowTitle = ($process.MainWindowTitle -replace '\\r|\\n', ' ')
  keyCount = $keys.Count
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
    console.log(`MuseScore ${action} triggered.`);
    const mismatch = scoreMismatchDetail(lastMuseScoreStatus);
    reportCommandStatus({
      ready: true,
      action,
      sequenceId,
      status: "succeeded",
      detail: mismatch ?? museScoreCommandSuccessDetail(action, keys, resetBeforePlay, bridgeResult),
      controlPath: `windows-sendkeys:${action === "play" ? playControlPath(resetBeforePlay) : "stop-key"}`,
      at: Date.now()
    });
  }
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

  const queued = queueBridgeCommand({
    action: "open-song",
    sequenceId,
    dueLocalAt: Date.now(),
    currentSong,
    status: "queued",
    createdAt: Date.now()
  });
  const bridgeResult = queued && bridgeLastSeenAt
    ? await waitForBridgeResult(sequenceId, args.bridgeFallbackMs)
    : undefined;

  if (bridgeResult?.status === "succeeded") {
    bridgeStatus = {
      ...bridgeStatus,
      ready: true,
      title: bridgeResult.title ?? currentSong?.title ?? bridgeStatus.title,
      windowTitle: bridgeResult.windowTitle ?? bridgeResult.title ?? bridgeStatus.windowTitle,
      detail: bridgeResult.detail ?? "MuseScore bridge opened the score"
    };
    reportCommandStatus({
      ready: true,
      action: "open-song",
      sequenceId,
      status: "succeeded",
      detail: bridgeResult.detail ?? "MuseScore bridge opened the score",
      controlPath: bridgeResult.controlPath ?? "musescore-bridge",
      at: bridgeResult.completedAt ?? Date.now()
    });
    return;
  }

  if (bridgeResult?.status === "failed") {
    console.warn(`MuseScore bridge open-song failed: ${bridgeResult.detail ?? "No detail reported"}`);
  }

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

  const opened = await openLocalScore(entry.absolutePath);
  reportCommandStatus({
    ready: opened,
    action: "open-song",
    sequenceId,
    status: opened ? "succeeded" : "failed",
    detail: opened
      ? `Opened MuseScore score ${entry.relativePath}`
      : `Windows could not open MuseScore score ${entry.relativePath}`,
    controlPath: "local-score-catalog",
    at: Date.now()
  });
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
      controlPath: command.controlPath
    }
  });
}

function keysForAction(action: TransportAction, resetBeforePlay = false): string[] {
  if (action === "stop") {
    return [args.stopKey];
  }

  if (resetBeforePlay) {
    const prefixKeys = args.playMode === "stop-then-play"
      ? [args.stopKey, args.resetKey]
      : [args.resetKey];
    return [...prefixKeys, args.playKey];
  }

  if (args.playMode === "single-key") {
    return [args.playKey];
  }

  return [args.stopKey, args.playKey];
}

function museScoreCommandSuccessDetail(
  action: TransportAction,
  keys: string[],
  resetBeforePlay: boolean,
  bridgeResult?: BridgeCommand
): string {
  const fallbackPrefix = bridgeResult?.status === "failed"
    ? `MuseScore bridge failed (${bridgeResult.detail ?? "no detail"}); fallback `
    : "";

  if (action === "play" && resetBeforePlay && args.playMode === "stop-then-play") {
    return `${fallbackPrefix}stopped first, sent ${describeKey(args.resetKey)} to reset to the beginning, then sent ${describeKey(args.playKey)} to MuseScore`;
  }

  if (action === "play" && args.playMode === "stop-then-play") {
    return `${fallbackPrefix}stopped first, then sent ${describeKey(args.playKey)} to MuseScore`;
  }

  return `${fallbackPrefix}sent ${keys.map(describeKey).join(", ")} to MuseScore`;
}

function playControlPath(resetBeforePlay: boolean): string {
  return resetBeforePlay
    ? `${args.playMode}+reset-to-start`
    : args.playMode;
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
  if (!status?.ready || currentSong?.sourceType !== "musescore") {
    return undefined;
  }

  const expected = normalizeTitle(currentSong.source || currentSong.title);
  const actual = normalizeTitle(status.title || status.windowTitle || "");
  if (!expected || !actual || actual.includes(expected) || expected.includes(actual)) {
    return undefined;
  }

  return `MuseScore is ready, but active score "${status.title || status.windowTitle}" does not match current song "${currentSong.source || currentSong.title}"`;
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
          playback: parsePlayback(update.playback) ?? bridgeStatus.playback
        };
        if (bridgeStatus.playback) {
          inferredPlayback = bridgeStatus.playback;
        }
        void reportMuseScoreStatus();
        res.writeHead(204);
        res.end();
      });
      return;
    }

    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("Not found");
  });

  bridgeServer.listen(port, "127.0.0.1", () => {
    const address = bridgeServer?.address();
    const actualPort = typeof address === "object" && address ? address.port : port;
    console.log(`MuseScore bridge listening on http://127.0.0.1:${actualPort}`);
  });
}

function queueBridgeCommand(command: BridgeCommand): boolean {
  if (!bridgeServer) {
    return false;
  }

  cleanupBridgeCommands();
  bridgeCommands.set(command.sequenceId, command);
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

function handleBridgeClaim(
  sequenceId: number,
  body: Record<string, unknown>,
  res: ServerResponse
): void {
  bridgeLastSeenAt = Date.now();
  const command = bridgeCommands.get(sequenceId);
  if (!command) {
    writeJson(res, 404, { ok: false, error: "Unknown command sequenceId" });
    return;
  }

  if (command.status !== "queued" && command.status !== "claimed") {
    writeJson(res, 409, { ok: false, error: `Command is already ${command.status}` });
    return;
  }

  command.status = "claimed";
  command.claimedAt = Date.now();
  command.controlPath = typeof body.controlPath === "string" ? body.controlPath : "musescore-bridge";
  command.detail = typeof body.detail === "string" ? trimSingleLine(body.detail) : "MuseScore bridge claimed the command";
  writeJson(res, 200, { ok: true, command });
}

function handleBridgeResult(
  sequenceId: number,
  body: Record<string, unknown>,
  res: ServerResponse
): void {
  bridgeLastSeenAt = Date.now();
  const command = bridgeCommands.get(sequenceId);
  if (!command) {
    writeJson(res, 404, { ok: false, error: "Unknown command sequenceId" });
    return;
  }

  if (command.status === "expired") {
    writeJson(res, 409, { ok: false, error: "Command already fell back to Windows keyboard control" });
    return;
  }

  if (command.status === "succeeded" || command.status === "failed") {
    writeJson(res, 409, { ok: false, error: `Command is already ${command.status}` });
    return;
  }

  const status = body.status === "failed" ? "failed" : "succeeded";
  command.status = status;
  command.completedAt = Date.now();
  command.detail = typeof body.detail === "string"
    ? trimSingleLine(body.detail)
    : status === "succeeded"
      ? "MuseScore bridge completed the command"
      : "MuseScore bridge reported command failure";
  command.controlPath = typeof body.controlPath === "string" ? body.controlPath : "musescore-bridge";
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

  writeJson(res, 200, { ok: true, command });
}

async function openLocalScore(absolutePath: string): Promise<boolean> {
  const script = `
$path = '${escapePowerShellSingleQuoted(resolve(absolutePath))}'
if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { exit 2 }
Invoke-Item -LiteralPath $path
`;
  const result = await runPowerShell(script);
  return result.code === 0;
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
    // Ctrl+Home moves the cursor to the start of the score; MuseScore then
    // plays from that selection. Plain Home only jumps within the current row.
    resetKey: "^{HOME}",
    stopKey: "{ESC}",
    playMode: "stop-then-play",
    processMatch: "MuseScore|mscore",
    activationRetries: 5,
    activationDelayMs: 90,
    commandGapMs: 120,
    bridgeFallbackMs: 900,
    scoreFolders: parseScoreFolders(process.env.BANDCUE_MUSESCORE_FOLDERS),
    scoreCatalogRecursive: process.env.BANDCUE_MUSESCORE_RECURSIVE !== "0"
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
    if (value === "--reset-key") parsed.resetKey = raw[index + 1] ?? parsed.resetKey;
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
