import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

export interface RoomIdentity {
  /** Joins the room: in the QR code and every companion link. */
  token: string;
  /**
   * Controls the room. Only a connection made with this token may join as the
   * host, so a bandmate who scanned the QR code cannot open /host and take over
   * the transport and the setlist. It is never part of the room state.
   */
  hostToken: string;
  roomCode: string;
}

/**
 * The room token and code used to be regenerated on every coordinator start,
 * which invalidated every saved URL and QR code mid-rehearsal: web companions
 * would retry a dead token forever, and adapters recovered only after re-running
 * discovery. Persisting the identity to a local state file makes a coordinator
 * restart invisible to clients — their reconnect backoff simply succeeds.
 *
 * Explicit env overrides (BANDCUE_TOKEN / BANDCUE_HOST_TOKEN / BANDCUE_ROOM_CODE)
 * always win and are written back to the state file so later unconfigured runs
 * stay consistent.
 *
 * A state file from before host tokens existed keeps its token as the room
 * token -- every link already handed out stays a plain join link -- and gets a
 * new host token, which the coordinator prints as the "Host controls" link.
 */
export function loadOrCreateRoomIdentity(
  statePath: string,
  overrides: { token?: string; hostToken?: string; roomCode?: string } = {}
): RoomIdentity {
  const persisted = readPersistedIdentity(statePath);
  const token = overrides.token || persisted?.token || newToken();
  let hostToken = overrides.hostToken || persisted?.hostToken || newToken();
  // The two must differ, or every join link would also be a host link.
  while (hostToken === token) {
    hostToken = newToken();
  }
  const identity: RoomIdentity = {
    token,
    hostToken,
    roomCode: normalizeRoomCode(overrides.roomCode || persisted?.roomCode) ||
      randomBytes(3).toString("hex").toUpperCase()
  };

  if (
    !persisted ||
    persisted.token !== identity.token ||
    persisted.hostToken !== identity.hostToken ||
    persisted.roomCode !== identity.roomCode
  ) {
    try {
      writeFileSync(statePath, `${JSON.stringify({ ...identity, note: "BandCue room identity; delete to rotate the tokens and room code." }, null, 2)}\n`);
    } catch {
      // A read-only working directory should not stop the rehearsal; the room
      // just falls back to per-run identity like before.
    }
  }

  return identity;
}

function newToken(): string {
  return randomBytes(9).toString("base64url");
}

function isToken(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{8,64}$/.test(value);
}

function readPersistedIdentity(
  statePath: string
): { token: string; hostToken?: string; roomCode: string } | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(statePath, "utf8"));
    if (!parsed || typeof parsed !== "object") {
      return undefined;
    }
    const token = (parsed as { token?: unknown }).token;
    const hostToken = (parsed as { hostToken?: unknown }).hostToken;
    const roomCode = normalizeRoomCode((parsed as { roomCode?: unknown }).roomCode);
    if (!isToken(token) || !roomCode) {
      return undefined;
    }
    return { token, hostToken: isToken(hostToken) ? hostToken : undefined, roomCode };
  } catch {
    return undefined;
  }
}

function normalizeRoomCode(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim().toUpperCase();
  return /^[0-9A-F]{6}$/.test(normalized) ? normalized : undefined;
}
