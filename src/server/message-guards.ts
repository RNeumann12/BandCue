import type {
  AdapterCapability,
  AdapterCommandAction,
  AdapterCommandStatus,
  AdapterStatus,
  ClientHello,
  ClientMessage,
  ClientRole,
  ControlMode,
  TransportAction
} from "../shared/protocol.js";

export const MAX_WS_MESSAGE_BYTES = 1024 * 1024;

const CLIENT_ROLES = new Set<ClientRole>(["host", "desktop-adapter", "companion"]);
const APP_TYPES = new Set<AdapterCapability["app"]>(["musescore", "songsterr", "mock"]);
const CONTROL_MODES = new Set<ControlMode>(["host-only", "leader-stop", "everyone-can-stop"]);
const TRANSPORT_ACTIONS = new Set<TransportAction>(["play", "stop"]);
const ADAPTER_STATES = new Set<NonNullable<AdapterStatus["state"]>>([
  "ready",
  "not-ready",
  "command-pending",
  "last-command-succeeded",
  "last-command-failed"
]);
const PLAYBACK_STATES = new Set<NonNullable<AdapterStatus["playback"]>>([
  "playing",
  "stopped",
  "unknown"
]);
const COMMAND_STATUSES = new Set(["pending", "succeeded", "failed"]);
const COMMAND_ACTIONS = new Set(["play", "stop", "open-song"]);

export function parseClientHelloPayload(raw: string): ClientHello | undefined {
  if (byteLength(raw) > MAX_WS_MESSAGE_BYTES) {
    return undefined;
  }

  const parsed = safeParseObject(raw);
  return sanitizeClientHello(parsed);
}

export function parseClientMessagePayload(raw: string): ClientMessage | undefined {
  if (byteLength(raw) > MAX_WS_MESSAGE_BYTES) {
    return undefined;
  }

  const parsed = safeParseObject(raw);
  return sanitizeClientMessage(parsed);
}

export function sanitizeClientHello(value: unknown): ClientHello | undefined {
  if (!isRecord(value) || value.type !== "clientHello" || !CLIENT_ROLES.has(value.role as ClientRole)) {
    return undefined;
  }

  return {
    type: "clientHello",
    deviceName: trimText(value.deviceName, 80) || "Unknown device",
    role: value.role as ClientRole,
    capabilities: sanitizeCapabilities(value.capabilities)
  };
}

export function sanitizeClientMessage(value: unknown): ClientMessage | undefined {
  if (!isRecord(value) || typeof value.type !== "string") {
    return undefined;
  }

  switch (value.type) {
    case "clockSync":
      return isFiniteNumber(value.clientSentAt)
        ? { type: "clockSync", clientSentAt: value.clientSentAt }
        : undefined;
    case "clockStatus":
      if (!isFiniteNumber(value.rttMs) || !isFiniteNumber(value.offsetMs)) {
        return undefined;
      }
      return {
        type: "clockStatus",
        rttMs: value.rttMs,
        offsetMs: value.offsetMs,
        jitterMs: isFiniteNumber(value.jitterMs) ? value.jitterMs : undefined,
        sampleCount: isFiniteNumber(value.sampleCount) ? value.sampleCount : undefined
      };
    case "calibrationUpdate":
      return typeof value.targetClientId === "string" && isFiniteNumber(value.manualOffsetMs)
        ? {
            type: "calibrationUpdate",
            targetClientId: value.targetClientId,
            manualOffsetMs: value.manualOffsetMs
          }
        : undefined;
    case "adapterStatus":
      return sanitizeAdapterStatus(value);
    case "currentSongUpdate":
      return {
        type: "currentSongUpdate",
        song: isRecord(value.song) ? value.song as never : undefined,
        index: isFiniteNumber(value.index) ? value.index : undefined,
        total: isFiniteNumber(value.total) ? value.total : undefined,
        updatedAt: isFiniteNumber(value.updatedAt) ? value.updatedAt : 0
      };
    case "setlistUpdate":
      return Array.isArray(value.songs)
        ? {
            type: "setlistUpdate",
            songs: value.songs as never,
            updatedAt: isFiniteNumber(value.updatedAt) ? value.updatedAt : 0
          }
        : undefined;
    case "safetyUpdate":
      if (
        value.armed !== undefined && typeof value.armed !== "boolean" ||
        value.controlMode !== undefined && !CONTROL_MODES.has(value.controlMode as ControlMode)
      ) {
        return undefined;
      }
      return {
        type: "safetyUpdate",
        armed: typeof value.armed === "boolean" ? value.armed : undefined,
        controlMode: value.controlMode as ControlMode | undefined,
        updatedAt: isFiniteNumber(value.updatedAt) ? value.updatedAt : 0
      };
    case "openSongRequest":
      return {
        type: "openSongRequest",
        requestedAt: isFiniteNumber(value.requestedAt) ? value.requestedAt : 0
      };
    case "transportRequest":
      return TRANSPORT_ACTIONS.has(value.action as TransportAction)
        ? {
            type: "transportRequest",
            action: value.action as TransportAction,
            requestedAt: isFiniteNumber(value.requestedAt) ? value.requestedAt : 0
          }
        : undefined;
    default:
      return undefined;
  }
}

function sanitizeAdapterStatus(value: Record<string, unknown>): ClientMessage | undefined {
  if (typeof value.ready !== "boolean" || !APP_TYPES.has(value.app as AdapterCapability["app"])) {
    return undefined;
  }

  return {
    type: "adapterStatus",
    ready: value.ready,
    app: value.app as AdapterCapability["app"],
    state: ADAPTER_STATES.has(value.state as NonNullable<AdapterStatus["state"]>)
      ? value.state as NonNullable<AdapterStatus["state"]>
      : undefined,
    playback: PLAYBACK_STATES.has(value.playback as NonNullable<AdapterStatus["playback"]>)
      ? value.playback as NonNullable<AdapterStatus["playback"]>
      : undefined,
    playbackDetail: typeof value.playbackDetail === "string" ? value.playbackDetail : undefined,
    title: typeof value.title === "string" ? value.title : undefined,
    source: typeof value.source === "string" ? value.source : undefined,
    durationMs: isFiniteNumber(value.durationMs) ? value.durationMs : undefined,
    durationSource: value.durationSource === "adapter" || value.durationSource === "manual"
      ? value.durationSource
      : undefined,
    catalog: isRecord(value.catalog) ? value.catalog as never : undefined,
    songMatch: isRecord(value.songMatch) ? value.songMatch as never : undefined,
    detail: typeof value.detail === "string" ? value.detail : undefined,
    requiredLeadMs: isFiniteNumber(value.requiredLeadMs) ? value.requiredLeadMs : undefined,
    lastCommand: sanitizeLastCommand(value.lastCommand)
  };
}

function sanitizeLastCommand(value: unknown): AdapterStatus["lastCommand"] | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  if (
    !COMMAND_ACTIONS.has(String(value.action)) ||
    !COMMAND_STATUSES.has(String(value.status)) ||
    !isFiniteNumber(value.at)
  ) {
    return undefined;
  }

  return {
    action: value.action as AdapterCommandAction,
    sequenceId: isFiniteNumber(value.sequenceId) ? value.sequenceId : undefined,
    status: value.status as AdapterCommandStatus,
    at: value.at,
    detail: typeof value.detail === "string" ? value.detail : undefined,
    controlPath: typeof value.controlPath === "string" ? value.controlPath : undefined,
    firedAtServerTime: isFiniteNumber(value.firedAtServerTime) ? value.firedAtServerTime : undefined
  };
}

function sanitizeCapabilities(value: unknown): AdapterCapability[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter(isRecord)
    .map((capability) => ({
      app: capability.app,
      canPlay: capability.canPlay,
      canStop: capability.canStop
    }))
    .filter((capability): capability is AdapterCapability => (
      APP_TYPES.has(capability.app as AdapterCapability["app"]) &&
      typeof capability.canPlay === "boolean" &&
      typeof capability.canStop === "boolean"
    ))
    .slice(0, 8);
}

function safeParseObject(raw: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(raw);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function trimText(value: unknown, maxLength: number): string {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, maxLength);
}
