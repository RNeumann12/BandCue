import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

export interface RoomIdentity {
  token: string;
  roomCode: string;
}

/**
 * The room token and code used to be regenerated on every coordinator start,
 * which invalidated every saved URL and QR code mid-rehearsal: web companions
 * would retry a dead token forever, and adapters recovered only after re-running
 * discovery. Persisting the identity to a local state file makes a coordinator
 * restart invisible to clients — their reconnect backoff simply succeeds.
 *
 * Explicit env overrides (BANDCUE_TOKEN / BANDCUE_ROOM_CODE) always win and are
 * written back to the state file so later unconfigured runs stay consistent.
 */
export function loadOrCreateRoomIdentity(
  statePath: string,
  overrides: { token?: string; roomCode?: string } = {}
): RoomIdentity {
  const persisted = readPersistedIdentity(statePath);
  const identity: RoomIdentity = {
    token: overrides.token || persisted?.token || randomBytes(9).toString("base64url"),
    roomCode: normalizeRoomCode(overrides.roomCode || persisted?.roomCode) ||
      randomBytes(3).toString("hex").toUpperCase()
  };

  if (!persisted || persisted.token !== identity.token || persisted.roomCode !== identity.roomCode) {
    try {
      writeFileSync(statePath, `${JSON.stringify({ ...identity, note: "BandCue room identity; delete to rotate the token and room code." }, null, 2)}\n`);
    } catch {
      // A read-only working directory should not stop the rehearsal; the room
      // just falls back to per-run identity like before.
    }
  }

  return identity;
}

function readPersistedIdentity(statePath: string): RoomIdentity | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(statePath, "utf8"));
    if (!parsed || typeof parsed !== "object") {
      return undefined;
    }
    const token = (parsed as { token?: unknown }).token;
    const roomCode = normalizeRoomCode((parsed as { roomCode?: unknown }).roomCode);
    if (typeof token !== "string" || !/^[A-Za-z0-9_-]{8,64}$/.test(token) || !roomCode) {
      return undefined;
    }
    return { token, roomCode };
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
