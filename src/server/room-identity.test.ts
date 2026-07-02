import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadOrCreateRoomIdentity } from "./room-identity.js";

describe("loadOrCreateRoomIdentity", () => {
  let dir: string;
  let statePath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bandcue-room-"));
    statePath = join(dir, "room.json");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("generates and persists an identity when no state file exists", () => {
    const identity = loadOrCreateRoomIdentity(statePath);

    expect(identity.token).toMatch(/^[A-Za-z0-9_-]{8,}$/);
    expect(identity.roomCode).toMatch(/^[0-9A-F]{6}$/);
    const persisted = JSON.parse(readFileSync(statePath, "utf8"));
    expect(persisted.token).toBe(identity.token);
    expect(persisted.roomCode).toBe(identity.roomCode);
  });

  it("reuses the persisted identity across restarts", () => {
    const first = loadOrCreateRoomIdentity(statePath);
    const second = loadOrCreateRoomIdentity(statePath);

    expect(second).toEqual({ token: first.token, roomCode: first.roomCode });
  });

  it("prefers explicit overrides and writes them back", () => {
    loadOrCreateRoomIdentity(statePath);
    const overridden = loadOrCreateRoomIdentity(statePath, {
      token: "my-fixed-token",
      roomCode: "abc123"
    });

    expect(overridden.token).toBe("my-fixed-token");
    expect(overridden.roomCode).toBe("ABC123");
    const persisted = JSON.parse(readFileSync(statePath, "utf8"));
    expect(persisted.token).toBe("my-fixed-token");
    expect(persisted.roomCode).toBe("ABC123");
  });

  it("regenerates when the state file is corrupt or invalid", () => {
    writeFileSync(statePath, "{not json");
    const fromCorrupt = loadOrCreateRoomIdentity(statePath);
    expect(fromCorrupt.roomCode).toMatch(/^[0-9A-F]{6}$/);

    writeFileSync(statePath, JSON.stringify({ token: "short", roomCode: "zz" }));
    const fromInvalid = loadOrCreateRoomIdentity(statePath);
    expect(fromInvalid.token).not.toBe("short");
    expect(fromInvalid.roomCode).toMatch(/^[0-9A-F]{6}$/);
  });

  it("survives an unwritable state path by falling back to per-run identity", () => {
    const unwritable = join(dir, "missing-subdir", "room.json");
    const identity = loadOrCreateRoomIdentity(unwritable);

    expect(identity.token).toMatch(/^[A-Za-z0-9_-]{8,}$/);
    expect(identity.roomCode).toMatch(/^[0-9A-F]{6}$/);
  });
});
