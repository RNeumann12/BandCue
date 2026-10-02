import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RoomController } from "./room.js";
import { createRoomStateWriter, readRoomStateFile, roomStatePathFor } from "./room-state-file.js";

const host = { type: "clientHello" as const, deviceName: "Host", role: "host" as const, capabilities: [] };
const song = (id: string, title: string) => ({ id, title, sourceType: "other" as const });

describe("room state file", () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bandcue-state-"));
    path = join(dir, "room.setlist.json");
  });

  afterEach(() => {
    vi.useRealTimers();
    rmSync(dir, { recursive: true, force: true });
  });

  it("sits next to the identity file", () => {
    expect(roomStatePathFor("/x/.bandcue-room.json")).toBe("/x/.bandcue-room.setlist.json");
    expect(roomStatePathFor("/x/.bandcue-room.e2e.json")).toBe("/x/.bandcue-room.e2e.setlist.json");
  });

  it("debounces writes and leaves no temporary file behind", () => {
    vi.useFakeTimers();
    const writer = createRoomStateWriter(path, 400);
    writer.schedule({ n: 1 });
    writer.schedule({ n: 2 });
    expect(existsSync(path)).toBe(false);
    vi.advanceTimersByTime(400);
    expect(readRoomStateFile(path)).toEqual({ n: 2 });
    expect(existsSync(`${path}.tmp`)).toBe(false);
  });

  it("flushes a pending write at once", () => {
    const writer = createRoomStateWriter(path, 60_000);
    writer.schedule({ n: 3 });
    writer.flush();
    expect(readRoomStateFile(path)).toEqual({ n: 3 });
  });

  it("reads a missing or corrupt file as nothing", () => {
    expect(readRoomStateFile(path)).toBeUndefined();
    writeFileSync(path, "{half a json");
    expect(readRoomStateFile(path)).toBeUndefined();
  });

  it("carries a room's setlist and current song through a coordinator restart", () => {
    const before = new RoomController("ABC123", "http://room", "http://host", 1500);
    const saved: unknown[] = [];
    before.onPersistedStateChange((state) => saved.push(JSON.parse(JSON.stringify(state))));
    const client = before.addClient(undefined, host);
    before.handleMessage(client.id, {
      type: "setlistUpdate",
      songs: [song("a", "Creep"), song("b", "Iris")],
      updatedAt: 1
    });
    before.handleMessage(client.id, {
      type: "currentSongUpdate",
      song: { ...song("b", "Iris"), helixOffsetMs: 40 },
      index: 2,
      total: 2,
      updatedAt: 2
    });

    const after = new RoomController("ABC123", "http://room", "http://host", 1500);
    expect(after.restorePersistedState(saved.at(-1))).toBe(2);
    const state = after.getState();
    expect(state.setlist.songs.map((entry) => entry.title)).toEqual(["Creep", "Iris"]);
    expect(state.currentSong?.song?.title).toBe("Iris");
    expect(state.currentSong?.index).toBe(2);
    // The saved current song keeps what the host layered on top of the entry.
    expect(state.currentSong?.song?.helixOffsetMs).toBe(40);
    // Nobody leads a room that just started.
    expect(state.currentSong?.leaderId).toBeUndefined();
  });

  it("ignores saved data it cannot use", () => {
    const room = new RoomController("ABC123", "http://room", "http://host", 1500);
    expect(room.restorePersistedState(undefined)).toBe(0);
    expect(room.restorePersistedState({ setlist: { songs: [{ nope: 1 }, "x", { title: "" }] } })).toBe(0);
    expect(room.restorePersistedState({
      setlist: { songs: [song("a", "Creep")] },
      currentSong: { song: song("gone", "Not in the list") }
    })).toBe(1);
    expect(room.getState().currentSong).toBeUndefined();
  });

  it("writes real files a fresh room can restore", () => {
    const writer = createRoomStateWriter(path, 0);
    const room = new RoomController("ABC123", "http://room", "http://host", 1500);
    room.onPersistedStateChange((state) => writer.schedule(state));
    const client = room.addClient(undefined, host);
    room.handleMessage(client.id, { type: "setlistUpdate", songs: [song("a", "Creep")], updatedAt: 1 });
    writer.flush();

    expect(JSON.parse(readFileSync(path, "utf8")).setlist.songs[0].title).toBe("Creep");
    expect(new RoomController("ABC123", "http://room", "http://host", 1500)
      .restorePersistedState(readRoomStateFile(path))).toBe(1);
  });
});
