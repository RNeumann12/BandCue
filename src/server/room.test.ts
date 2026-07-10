import { describe, expect, it, vi } from "vitest";
import type WebSocket from "ws";
import { MAX_SETLIST_SONGS, RoomController } from "./room.js";

describe("RoomController", () => {
  it("broadcast state reflects a scheduled mock transport command", () => {
    const room = new RoomController("ABC123", "http://room", "http://host", 1500);
    const client = room.addClient(undefined, {
      type: "clientHello",
      deviceName: "Host",
      role: "host",
      capabilities: []
    }, 1000);

    room.handleMessage(client.id, {
      type: "safetyUpdate",
      armed: true,
      updatedAt: 1150
    }, 1150);

    room.handleMessage(client.id, {
      type: "currentSongUpdate",
      index: 1,
      total: 1,
      updatedAt: 1175,
      song: {
        id: "song-1",
        title: "Test Song",
        sourceType: "other"
      }
    }, 1100);

    room.handleMessage(client.id, {
      type: "transportRequest",
      action: "play",
      requestedAt: 1200
    }, 1200);

    expect(room.getState(1200).transport).toMatchObject({
      status: "scheduled",
      leaderId: client.id,
      sequenceId: 1,
      scheduledServerTime: 2700
    });
    expect(room.getState(1200).safety.armed).toBe(false);
    expect(room.getState(1200).currentSong?.song?.title).toBe("Test Song");
  });

  it("broadcasts play commands with a reset-to-start instruction", () => {
    const adapterMessages: string[] = [];
    const room = new RoomController("ABC123", "http://room", "http://host", 1500);
    const host = room.addClient(undefined, {
      type: "clientHello",
      deviceName: "Host",
      role: "host",
      capabilities: []
    }, 1000);
    room.addClient(fakeSocket(adapterMessages), {
      type: "clientHello",
      deviceName: "Songsterr",
      role: "desktop-adapter",
      capabilities: [{ app: "songsterr", canPlay: true, canStop: true }]
    }, 1000);

    room.handleMessage(host.id, {
      type: "safetyUpdate",
      armed: true,
      updatedAt: 1100
    }, 1100);
    adapterMessages.length = 0;

    room.handleMessage(host.id, {
      type: "transportRequest",
      action: "play",
      requestedAt: 1200
    }, 1200);

    const playCommand = adapterMessages
      .map((message) => JSON.parse(message))
      .find((message) => message.type === "transportCommand" && message.action === "play");
    expect(playCommand).toMatchObject({
      action: "play",
      resetBeforePlay: true
    });
  });

  it("schedules Helix-enabled songs from measure metadata", () => {
    const room = new RoomController("ABC123", "http://room", "http://host", 1500);
    const host = room.addClient(undefined, {
      type: "clientHello",
      deviceName: "Host",
      role: "host",
      capabilities: []
    }, 1000);

    room.handleMessage(host.id, {
      type: "currentSongUpdate",
      index: 1,
      total: 1,
      updatedAt: 1100,
      song: {
        id: "song-1",
        title: "Helix Song",
        sourceType: "other",
        helixSyncEnabled: true,
        helixBpm: 120,
        helixBeatsPerMeasure: 4,
        helixTargetMeasure: 2,
        helixOffsetMs: -80
      }
    }, 1100);
    room.handleMessage(host.id, { type: "safetyUpdate", armed: true, updatedAt: 1150 }, 1150);
    room.handleMessage(host.id, { type: "transportRequest", action: "play", requestedAt: 1200 }, 1200);

    expect(room.getState(1200).transport).toMatchObject({
      status: "scheduled",
      leaderId: host.id,
      sequenceId: 1,
      scheduledServerTime: 3120
    });
    expect(room.getState(1200).safety.armed).toBe(false);
  });

  it("rejects Helix sync when the musical target leaves too little lead time", () => {
    const hostMessages: string[] = [];
    const room = new RoomController("ABC123", "http://room", "http://host", 1500);
    const host = room.addClient(fakeSocket(hostMessages), {
      type: "clientHello",
      deviceName: "Host",
      role: "host",
      capabilities: []
    }, 1000);

    room.handleMessage(host.id, {
      type: "currentSongUpdate",
      index: 1,
      total: 1,
      updatedAt: 1100,
      song: {
        id: "song-1",
        title: "Too Soon",
        sourceType: "other",
        helixSyncEnabled: true,
        helixBpm: 200,
        helixBeatsPerMeasure: 4,
        helixTargetMeasure: 2,
        helixOffsetMs: 0
      }
    }, 1100);
    room.handleMessage(host.id, { type: "safetyUpdate", armed: true, updatedAt: 1150 }, 1150);
    hostMessages.length = 0;

    room.handleMessage(host.id, { type: "transportRequest", action: "play", requestedAt: 1200 }, 1200);

    expect(room.getState(1200).transport.status).toBe("stopped");
    expect(room.getState(1200).safety.armed).toBe(true);
    expect(hostMessages.map((message) => JSON.parse(message)).find((message) => message.type === "error"))
      .toMatchObject({
        message: expect.stringContaining("Helix sync target is 1200 ms away")
      });
  });

  it("still attaches per-device manual offsets to Helix-scheduled play commands", () => {
    const adapterMessages: string[] = [];
    const room = new RoomController("ABC123", "http://room", "http://host", 1500);
    const host = room.addClient(undefined, {
      type: "clientHello",
      deviceName: "Host",
      role: "host",
      capabilities: []
    }, 1000);
    const adapter = room.addClient(fakeSocket(adapterMessages), {
      type: "clientHello",
      deviceName: "Songsterr",
      role: "desktop-adapter",
      capabilities: [{ app: "songsterr", canPlay: true, canStop: true }]
    }, 1000);

    room.handleMessage(host.id, {
      type: "calibrationUpdate",
      targetClientId: adapter.id,
      manualOffsetMs: 35
    }, 1050);
    room.handleMessage(host.id, {
      type: "currentSongUpdate",
      index: 1,
      total: 1,
      updatedAt: 1100,
      song: {
        id: "song-1",
        title: "Helix Song",
        sourceType: "songsterr",
        helixSyncEnabled: true,
        helixBpm: 120,
        helixBeatsPerMeasure: 4,
        helixTargetMeasure: 2,
        helixOffsetMs: 0
      }
    }, 1100);
    room.handleMessage(host.id, { type: "safetyUpdate", armed: true, updatedAt: 1150 }, 1150);
    adapterMessages.length = 0;

    room.handleMessage(host.id, { type: "transportRequest", action: "play", requestedAt: 1200 }, 1200);

    const playCommand = adapterMessages
      .map((message) => JSON.parse(message))
      .find((message) => message.type === "transportCommand" && message.action === "play");
    expect(playCommand).toMatchObject({
      scheduledServerTime: 3200,
      manualOffsetMs: 35
    });
  });

  it("stores clock telemetry from clients", () => {
    const room = new RoomController("ABC123", "http://room", "http://host", 1500);
    const client = room.addClient(undefined, {
      type: "clientHello",
      deviceName: "Phone",
      role: "companion",
      capabilities: []
    }, 1000);

    room.handleMessage(client.id, {
      type: "clockStatus",
      rttMs: 44,
      offsetMs: -7,
      jitterMs: 3
    }, 1100);

    expect(room.getState(1200).clients[0]?.clock).toEqual({
      rttMs: 44,
      offsetMs: -7,
      jitterMs: 3
    });
  });

  it("restores recent clock telemetry when a device reconnects quickly", () => {
    const room = new RoomController("ABC123", "http://room", "http://host", 1500);
    const firstConnection = room.addClient(undefined, {
      type: "clientHello",
      deviceName: "Songsterr tab",
      role: "desktop-adapter",
      capabilities: [{ app: "songsterr", canPlay: true, canStop: true }]
    }, 1000);

    room.handleMessage(firstConnection.id, {
      type: "clockStatus",
      rttMs: 12,
      offsetMs: 3,
      jitterMs: 1
    }, 1200);
    room.removeClient(firstConnection.id);

    const secondConnection = room.addClient(undefined, {
      type: "clientHello",
      deviceName: "Songsterr tab",
      role: "desktop-adapter",
      capabilities: [{ app: "songsterr", canPlay: true, canStop: true }]
    }, 2000);

    expect(room.getState(2000).clients.find((client) => client.id === secondConnection.id)?.clock)
      .toEqual({
        rttMs: 12,
        offsetMs: 3,
        jitterMs: 1
      });
  });

  it("lets the host set manual calibration for a connected device", () => {
    const room = new RoomController("ABC123", "http://room", "http://host", 1500);
    const host = room.addClient(undefined, {
      type: "clientHello",
      deviceName: "Host",
      role: "host",
      capabilities: []
    }, 1000);
    const adapter = room.addClient(undefined, {
      type: "clientHello",
      deviceName: "MuseScore",
      role: "desktop-adapter",
      capabilities: [{ app: "musescore", canPlay: true, canStop: true }]
    }, 1000);

    room.handleMessage(host.id, {
      type: "calibrationUpdate",
      targetClientId: adapter.id,
      manualOffsetMs: -80
    }, 1100);

    expect(room.getState(1200).clients.find((client) => client.id === adapter.id)?.clock)
      .toMatchObject({
        manualOffsetMs: -80
      });

    room.handleMessage(adapter.id, {
      type: "clockStatus",
      rttMs: 32,
      offsetMs: 4,
      jitterMs: 2
    }, 1300);

    expect(room.getState(1400).clients.find((client) => client.id === adapter.id)?.clock)
      .toEqual({
        rttMs: 32,
        offsetMs: 4,
        jitterMs: 2,
        manualOffsetMs: -80
      });
  });

  it("rejects manual calibration updates from non-host clients", () => {
    const room = new RoomController("ABC123", "http://room", "http://host", 1500);
    const adapter = room.addClient(undefined, {
      type: "clientHello",
      deviceName: "MuseScore",
      role: "desktop-adapter",
      capabilities: [{ app: "musescore", canPlay: true, canStop: true }]
    }, 1000);

    room.handleMessage(adapter.id, {
      type: "calibrationUpdate",
      targetClientId: adapter.id,
      manualOffsetMs: -80
    }, 1100);

    expect(room.getState(1200).clients[0]?.clock).toBeUndefined();
  });

  it("preserves command feedback across adapter readiness polls", () => {
    const room = new RoomController("ABC123", "http://room", "http://host", 1500);
    const client = room.addClient(undefined, {
      type: "clientHello",
      deviceName: "MuseScore",
      role: "desktop-adapter",
      capabilities: [{ app: "musescore", canPlay: true, canStop: true }]
    }, 1000);

    room.handleMessage(client.id, {
      type: "adapterStatus",
      app: "musescore",
      ready: true,
      state: "last-command-succeeded",
      playback: "playing",
      playbackDetail: "Playback is inferred playing from the last successful BandCue command",
      detail: "Sent Space to MuseScore",
      lastCommand: {
        action: "play",
        sequenceId: 9,
        status: "succeeded",
        at: 1200,
        detail: "Sent Space to MuseScore",
        controlPath: "windows-sendkeys"
      }
    }, 1200);

    room.handleMessage(client.id, {
      type: "adapterStatus",
      app: "musescore",
      ready: true,
      title: "Score title",
      detail: "MuseScore window detected"
    }, 1300);

    expect(room.getState(1400).clients[0]?.status).toMatchObject({
      ready: true,
      state: "ready",
      playback: "playing",
      title: "Score title",
      lastCommand: {
        action: "play",
        sequenceId: 9,
        status: "succeeded",
        controlPath: "windows-sendkeys"
      }
    });
  });

  it("caps adapter status text before rebroadcasting it", () => {
    const room = new RoomController("ABC123", "http://room", "http://host", 1500);
    const client = room.addClient(undefined, {
      type: "clientHello",
      deviceName: "MuseScore",
      role: "desktop-adapter",
      capabilities: [{ app: "musescore", canPlay: true, canStop: true }]
    }, 1000);

    room.handleMessage(client.id, {
      type: "adapterStatus",
      app: "musescore",
      ready: false,
      title: `  ${"t".repeat(200)}  `,
      playbackDetail: "p".repeat(700),
      detail: "d".repeat(700),
      lastCommand: {
        action: "play",
        status: "failed",
        at: 1234.8,
        detail: "c".repeat(700),
        controlPath: "x".repeat(120)
      }
    }, 1200);

    const status = room.getState(1300).clients[0]?.status;
    expect(status?.title).toHaveLength(140);
    expect(status?.playbackDetail).toHaveLength(500);
    expect(status?.detail).toHaveLength(500);
    expect(status?.lastCommand?.detail).toHaveLength(500);
    expect(status?.lastCommand?.controlPath).toHaveLength(80);
    expect(status?.lastCommand?.at).toBe(1235);
  });

  it("does not broadcast repeated identical adapter status", () => {
    const messages: string[] = [];
    const socket = fakeSocket(messages);
    const room = new RoomController("ABC123", "http://room", "http://host", 1500);
    const client = room.addClient(socket, {
      type: "clientHello",
      deviceName: "Songsterr tab",
      role: "desktop-adapter",
      capabilities: [{ app: "songsterr", canPlay: true, canStop: true }]
    }, 1000);
    messages.length = 0;

    const status = {
      type: "adapterStatus" as const,
      app: "songsterr" as const,
      ready: true,
      state: "ready" as const,
      title: "Song title",
      detail: "Songsterr tab detected"
    };

    room.handleMessage(client.id, status, 1100);
    room.handleMessage(client.id, status, 1200);

    const roomStates = messages
      .map((message) => JSON.parse(message))
      .filter((message) => message.type === "roomState");
    expect(roomStates).toHaveLength(1);
  });

  it("lets the host publish the current setlist song", () => {
    const room = new RoomController("ABC123", "http://room", "http://host", 1500);
    const host = room.addClient(undefined, {
      type: "clientHello",
      deviceName: "Host",
      role: "host",
      capabilities: []
    }, 1000);

    room.handleMessage(host.id, {
      type: "currentSongUpdate",
      index: 1,
      total: 3,
      updatedAt: 1200,
      song: {
        id: "song-1",
        title: "First Song",
        sourceType: "songsterr",
        source: "https://songsterr.com/a/song",
        notes: "Start at chorus"
      }
    }, 1200);

    expect(room.getState(1300).currentSong).toMatchObject({
      index: 1,
      total: 3,
      leaderId: host.id,
      updatedAt: 1200,
      song: {
        title: "First Song",
        sourceType: "songsterr",
        notes: "Start at chorus"
      }
    });
  });

  it("sanitizes current song updates like setlist songs", () => {
    const room = new RoomController("ABC123", "http://room", "http://host", 1500);
    const host = room.addClient(undefined, {
      type: "clientHello",
      deviceName: "Host",
      role: "host",
      capabilities: []
    }, 1000);

    room.handleMessage(host.id, {
      type: "currentSongUpdate",
      index: -5,
      total: 100_001,
      updatedAt: 1200,
      song: {
        id: "song-1",
        title: "  Long Song  ",
        sourceType: "not-real",
        source: "x".repeat(700),
        durationMs: 25 * 60 * 60 * 1000,
        notes: "n".repeat(700)
      }
    } as never, 1200);

    const currentSong = room.getState(1300).currentSong;
    expect(currentSong?.index).toBeUndefined();
    expect(currentSong?.total).toBeUndefined();
    expect(currentSong?.song).toMatchObject({
      id: "song-1",
      title: "Long Song",
      sourceType: "other"
    });
    expect(currentSong?.song?.source).toHaveLength(500);
    expect(currentSong?.song?.durationMs).toBeUndefined();
    expect(currentSong?.song?.notes).toHaveLength(500);
  });

  it("broadcasts a host request to open the current Songsterr song", () => {
    const hostMessages: string[] = [];
    const adapterMessages: string[] = [];
    const room = new RoomController("ABC123", "http://room", "http://host", 1500);
    const host = room.addClient(fakeSocket(hostMessages), {
      type: "clientHello",
      deviceName: "Host",
      role: "host",
      capabilities: []
    }, 1000);
    room.addClient(fakeSocket(adapterMessages), {
      type: "clientHello",
      deviceName: "Songsterr",
      role: "desktop-adapter",
      capabilities: [{ app: "songsterr", canPlay: true, canStop: true }]
    }, 1000);

    room.handleMessage(host.id, {
      type: "currentSongUpdate",
      index: 1,
      total: 1,
      updatedAt: 1200,
      song: {
        id: "song-1",
        title: "Correct Song",
        sourceType: "songsterr",
        source: "https://www.songsterr.com/a/wsa/correct-song-tab-s1"
      }
    }, 1200);
    hostMessages.length = 0;
    adapterMessages.length = 0;

    room.handleMessage(host.id, {
      type: "openSongRequest",
      requestedAt: 1300
    }, 1300);

    const command = adapterMessages
      .map((message) => JSON.parse(message))
      .find((message) => message.type === "openSongCommand");
    expect(command).toMatchObject({
      leaderId: host.id,
      sequenceId: 1,
      requestedAt: 1300,
      currentSong: {
        song: {
          title: "Correct Song",
          sourceType: "songsterr",
          source: "https://www.songsterr.com/a/wsa/correct-song-tab-s1"
        }
      }
    });
  });

  it("broadcasts a host request to open the current MuseScore song", () => {
    const adapterMessages: string[] = [];
    const room = new RoomController("ABC123", "http://room", "http://host", 1500);
    const host = room.addClient(undefined, {
      type: "clientHello",
      deviceName: "Host",
      role: "host",
      capabilities: []
    }, 1000);
    room.addClient(fakeSocket(adapterMessages), {
      type: "clientHello",
      deviceName: "MuseScore",
      role: "desktop-adapter",
      capabilities: [{ app: "musescore", canPlay: true, canStop: true }]
    }, 1000);

    room.handleMessage(host.id, {
      type: "currentSongUpdate",
      index: 1,
      total: 1,
      updatedAt: 1200,
      song: {
        id: "song-1",
        title: "Bad Moon Rising",
        sourceType: "musescore",
        source: "CCR/Bad Moon Rising"
      }
    }, 1200);
    adapterMessages.length = 0;

    room.handleMessage(host.id, {
      type: "openSongRequest",
      requestedAt: 1300
    }, 1300);

    const command = adapterMessages
      .map((message) => JSON.parse(message))
      .find((message) => message.type === "openSongCommand");
    expect(command).toMatchObject({
      leaderId: host.id,
      sequenceId: 1,
      requestedAt: 1300,
      currentSong: {
        song: {
          title: "Bad Moon Rising",
          sourceType: "musescore",
          source: "CCR/Bad Moon Rising"
        }
      }
    });
  });

  it("accepts malformed catalog payloads and never rebroadcasts entries", () => {
    const room = new RoomController("ABC123", "http://room", "http://host", 1500);
    const adapter = room.addClient(undefined, {
      type: "clientHello",
      deviceName: "MuseScore",
      role: "desktop-adapter",
      capabilities: [{ app: "musescore", canPlay: true, canStop: true }]
    }, 1000);

    expect(() => {
      room.handleMessage(adapter.id, {
        type: "adapterStatus",
        app: "musescore",
        ready: true,
        catalog: {
          entries: [
            null,
            "not-an-object",
            { title: "Bad Moon Rising", relativePath: "CCR/Bad Moon Rising.mscz" },
            { title: "Escapes", relativePath: "../secrets/escape.mscz" }
          ],
          total: 4
        }
      } as never, 1100);
    }).not.toThrow();

    const stored = room.getState(1200).clients.find((client) => client.id === adapter.id);
    // Entries stay on the adapter; room state only carries the counts so the
    // catalog is not rebroadcast to every client on each state update.
    expect(stored?.status?.catalog?.entries).toBeUndefined();
    expect(stored?.status?.catalog?.total).toBe(4);
  });

  it("associates matching adapter-reported duration with the current setlist song", () => {
    const room = new RoomController("ABC123", "http://room", "http://host", 1500);
    const host = room.addClient(undefined, {
      type: "clientHello",
      deviceName: "Host",
      role: "host",
      capabilities: []
    }, 1000);
    const adapter = room.addClient(undefined, {
      type: "clientHello",
      deviceName: "Songsterr",
      role: "desktop-adapter",
      capabilities: [{ app: "songsterr", canPlay: true, canStop: true }]
    }, 1000);

    room.handleMessage(host.id, {
      type: "setlistUpdate",
      updatedAt: 1100,
      songs: [{
        id: "song-1",
        title: "Correct Song",
        sourceType: "songsterr",
        source: "https://www.songsterr.com/a/wsa/correct-song-tab-s1"
      }]
    }, 1100);
    room.handleMessage(host.id, {
      type: "currentSongUpdate",
      index: 1,
      total: 1,
      updatedAt: 1200,
      song: {
        id: "song-1",
        title: "Correct Song",
        sourceType: "songsterr",
        source: "https://www.songsterr.com/a/wsa/correct-song-tab-s1"
      }
    }, 1200);

    room.handleMessage(adapter.id, {
      type: "adapterStatus",
      app: "songsterr",
      ready: true,
      title: "Correct Song Tab by Artist",
      source: "https://www.songsterr.com/a/wsa/correct-song-tab-s1?track=1",
      durationMs: 184_500,
      durationSource: "adapter"
    }, 1300);

    expect(room.getState(1400).currentSong?.song).toMatchObject({
      id: "song-1",
      durationMs: 184_500,
      durationSource: "adapter"
    });
    expect(room.getState(1400).setlist.songs[0]).toMatchObject({
      id: "song-1",
      durationMs: 184_500,
      durationSource: "adapter"
    });
  });

  it("associates Songsterr duration reported from an alternate drum URL", () => {
    const room = new RoomController("ABC123", "http://room", "http://host", 1500);
    const host = room.addClient(undefined, {
      type: "clientHello",
      deviceName: "Host",
      role: "host",
      capabilities: []
    }, 1000);
    const adapter = room.addClient(undefined, {
      type: "clientHello",
      deviceName: "Songsterr Drums",
      role: "desktop-adapter",
      capabilities: [{ app: "songsterr", canPlay: true, canStop: true }]
    }, 1000);

    const song = {
      id: "song-1",
      title: "Correct Song",
      sourceType: "musescore" as const,
      museScoreSource: "Correct Song.mscz",
      songsterrUrl: "https://www.songsterr.com/a/wsa/correct-song-tab-s1",
      songsterrDrumUrl: "https://www.songsterr.com/a/wsa/correct-song-easy-drum-tab-s2"
    };

    room.handleMessage(host.id, {
      type: "setlistUpdate",
      updatedAt: 1100,
      songs: [song]
    }, 1100);
    room.handleMessage(host.id, {
      type: "currentSongUpdate",
      index: 1,
      total: 1,
      updatedAt: 1200,
      song
    }, 1200);

    room.handleMessage(adapter.id, {
      type: "adapterStatus",
      app: "songsterr",
      ready: true,
      title: "Correct Song Easy Drum Tab by Artist",
      source: "https://www.songsterr.com/a/wsa/correct-song-easy-drum-tab-s2?track=1",
      durationMs: 184_500,
      durationSource: "adapter"
    }, 1300);

    expect(room.getState(1400).currentSong?.song).toMatchObject({
      id: "song-1",
      durationMs: 184_500,
      durationSource: "adapter"
    });
    expect(room.getState(1400).setlist.songs[0]).toMatchObject({
      id: "song-1",
      durationMs: 184_500,
      durationSource: "adapter"
    });
  });

  it("does not bind adapter duration to a song with a loose substring title overlap", () => {
    const room = new RoomController("ABC123", "http://room", "http://host", 1500);
    const host = room.addClient(undefined, {
      type: "clientHello",
      deviceName: "Host",
      role: "host",
      capabilities: []
    }, 1000);
    const adapter = room.addClient(undefined, {
      type: "clientHello",
      deviceName: "Songsterr",
      role: "desktop-adapter",
      capabilities: [{ app: "songsterr", canPlay: true, canStop: true }]
    }, 1000);

    // Current song "Black" must not absorb the duration reported for "Black Dog".
    room.handleMessage(host.id, {
      type: "currentSongUpdate",
      index: 1,
      total: 1,
      updatedAt: 1200,
      song: { id: "song-1", title: "Black", sourceType: "songsterr" }
    }, 1200);

    room.handleMessage(adapter.id, {
      type: "adapterStatus",
      app: "songsterr",
      ready: true,
      title: "Black Dog Tab by Led Zeppelin",
      durationMs: 296_000,
      durationSource: "adapter"
    }, 1300);

    expect(room.getState(1400).currentSong?.song?.durationMs).toBeUndefined();
  });

  it("binds adapter duration by title when only the tab descriptor differs", () => {
    const room = new RoomController("ABC123", "http://room", "http://host", 1500);
    const host = room.addClient(undefined, {
      type: "clientHello",
      deviceName: "Host",
      role: "host",
      capabilities: []
    }, 1000);
    const adapter = room.addClient(undefined, {
      type: "clientHello",
      deviceName: "Songsterr",
      role: "desktop-adapter",
      capabilities: [{ app: "songsterr", canPlay: true, canStop: true }]
    }, 1000);

    room.handleMessage(host.id, {
      type: "currentSongUpdate",
      index: 1,
      total: 1,
      updatedAt: 1200,
      song: { id: "song-1", title: "Black Dog", sourceType: "songsterr" }
    }, 1200);

    room.handleMessage(adapter.id, {
      type: "adapterStatus",
      app: "songsterr",
      ready: true,
      title: "Black Dog Bass Tab by Led Zeppelin",
      durationMs: 296_000,
      durationSource: "adapter"
    }, 1300);

    expect(room.getState(1400).currentSong?.song?.durationMs).toBe(296_000);
  });

  it("auto-stops the room state after a known duration without broadcasting stop", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1000);
      const adapterMessages: string[] = [];
      const room = new RoomController("ABC123", "http://room", "http://host", 100);
      const host = room.addClient(undefined, {
        type: "clientHello",
        deviceName: "Host",
        role: "host",
        capabilities: []
      }, 1000);
      room.addClient(fakeSocket(adapterMessages), {
        type: "clientHello",
        deviceName: "Songsterr",
        role: "desktop-adapter",
        capabilities: [{ app: "songsterr", canPlay: true, canStop: true }]
      }, 1000);

      room.handleMessage(host.id, {
        type: "currentSongUpdate",
        index: 1,
        total: 1,
        updatedAt: 1000,
        song: {
          id: "song-1",
          title: "Short Song",
          sourceType: "songsterr",
          durationMs: 2_000,
          durationSource: "adapter"
        }
      }, 1000);
      room.handleMessage(host.id, {
        type: "safetyUpdate",
        armed: true,
        updatedAt: 1000
      }, 1000);
      adapterMessages.length = 0;

      room.handleMessage(host.id, {
        type: "transportRequest",
        action: "play",
        requestedAt: 1000
      }, 1000);

      await vi.advanceTimersByTimeAsync(100);
      expect(room.getState(1100).transport.status).toBe("running");

      await vi.advanceTimersByTimeAsync(2000);

      expect(room.getState(3100).transport).toMatchObject({
        status: "stopped",
        action: "stop",
        sequenceId: 2,
        stopReason: "auto-duration"
      });
      const stopCommands = adapterMessages
        .map((message) => JSON.parse(message))
        .filter((message) => message.type === "transportCommand" && message.action === "stop");
      expect(stopCommands).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("auto-stops the room when observed playback clients all report stopped", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1000);
      const adapterMessages: string[] = [];
      const room = new RoomController("ABC123", "http://room", "http://host", 100);
      const host = room.addClient(undefined, {
        type: "clientHello",
        deviceName: "Host",
        role: "host",
        capabilities: []
      }, 1000);
      const adapter = room.addClient(fakeSocket(adapterMessages), {
        type: "clientHello",
        deviceName: "MuseScore",
        role: "desktop-adapter",
        capabilities: [{ app: "musescore", canPlay: true, canStop: true }]
      }, 1000);

      room.handleMessage(host.id, {
        type: "currentSongUpdate",
        index: 1,
        total: 1,
        updatedAt: 1000,
        song: {
          id: "song-1",
          title: "Song Without Duration",
          sourceType: "musescore"
        }
      }, 1000);
      room.handleMessage(host.id, {
        type: "safetyUpdate",
        armed: true,
        updatedAt: 1000
      }, 1000);
      adapterMessages.length = 0;

      room.handleMessage(host.id, {
        type: "transportRequest",
        action: "play",
        requestedAt: 1000
      }, 1000);

      await vi.advanceTimersByTimeAsync(100);
      expect(room.getState(1100).transport.status).toBe("running");

      room.handleMessage(adapter.id, {
        type: "adapterStatus",
        app: "musescore",
        ready: true,
        playback: "playing"
      }, 1100);
      room.handleMessage(adapter.id, {
        type: "adapterStatus",
        app: "musescore",
        ready: true,
        playback: "stopped"
      }, 1100);

      await vi.advanceTimersByTimeAsync(749);
      expect(room.getState(1849).transport.status).toBe("running");

      await vi.advanceTimersByTimeAsync(1);
      expect(room.getState(1850).transport).toMatchObject({
        status: "stopped",
        action: "stop",
        sequenceId: 2,
        stopReason: "auto-playback-ended"
      });
      const stopCommands = adapterMessages
        .map((message) => JSON.parse(message))
        .filter((message) => message.type === "transportCommand" && message.action === "stop");
      expect(stopCommands).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects current song updates from companions", () => {
    const room = new RoomController("ABC123", "http://room", "http://host", 1500);
    const companion = room.addClient(undefined, {
      type: "clientHello",
      deviceName: "Phone",
      role: "companion",
      capabilities: []
    }, 1000);

    room.handleMessage(companion.id, {
      type: "currentSongUpdate",
      index: 0,
      total: 1,
      updatedAt: 1200,
      song: {
        id: "song-1",
        title: "Unauthorized Song",
        sourceType: "other"
      }
    }, 1200);

    expect(room.getState(1300).currentSong).toBeUndefined();
  });

  it("lets the host publish a shared setlist", () => {
    const room = new RoomController("ABC123", "http://room", "http://host", 1500);
    const host = room.addClient(undefined, {
      type: "clientHello",
      deviceName: "Host",
      role: "host",
      capabilities: []
    }, 1000);

    room.handleMessage(host.id, {
      type: "setlistUpdate",
      updatedAt: 1200,
      songs: [
        { id: "one", title: "One", sourceType: "songsterr", source: "https://songsterr.com/a/song" },
        { id: "two", title: "Two", sourceType: "musescore", source: "Two.mscz" }
      ]
    }, 1200);

    expect(room.getState(1300).setlist).toMatchObject({
      leaderId: host.id,
      updatedAt: 1200,
      songs: [
        { title: "One", sourceType: "songsterr" },
        { title: "Two", sourceType: "musescore" }
      ]
    });
  });

  it("rejects oversized setlists without replacing the current setlist", () => {
    const hostMessages: string[] = [];
    const room = new RoomController("ABC123", "http://room", "http://host", 1500);
    const host = room.addClient(fakeSocket(hostMessages), {
      type: "clientHello",
      deviceName: "Host",
      role: "host",
      capabilities: []
    }, 1000);

    room.handleMessage(host.id, {
      type: "setlistUpdate",
      updatedAt: 1100,
      songs: [{ id: "kept", title: "Keep me", sourceType: "other" }]
    }, 1100);
    hostMessages.length = 0;

    room.handleMessage(host.id, {
      type: "setlistUpdate",
      updatedAt: 1200,
      songs: Array.from({ length: MAX_SETLIST_SONGS + 1 }, (_, index) => ({
        id: `song-${index}`,
        title: `Song ${index}`,
        sourceType: "other" as const
      }))
    }, 1200);

    expect(room.getState(1300).setlist.songs.map((song) => song.id)).toEqual(["kept"]);
    expect(hostMessages.map((message) => JSON.parse(message))).toContainEqual({
      type: "error",
      message: `A setlist can contain at most ${MAX_SETLIST_SONGS} songs.`
    });
  });

  it("lets the host arm playback and change control mode", () => {
    const room = new RoomController("ABC123", "http://room", "http://host", 1500);
    const host = room.addClient(undefined, {
      type: "clientHello",
      deviceName: "Host",
      role: "host",
      capabilities: []
    }, 1000);

    room.handleMessage(host.id, {
      type: "safetyUpdate",
      armed: true,
      controlMode: "everyone-can-stop",
      updatedAt: 1200
    }, 1200);

    expect(room.getState(1300).safety).toMatchObject({
      armed: true,
      controlMode: "everyone-can-stop",
      leaderId: host.id
    });
  });

  it("broadcasts a stop command when the active leader disconnects", () => {
    const adapterMessages: string[] = [];
    const adapterSocket = fakeSocket(adapterMessages);
    const room = new RoomController("ABC123", "http://room", "http://host", 1500);
    const host = room.addClient(undefined, {
      type: "clientHello",
      deviceName: "Host",
      role: "host",
      capabilities: []
    }, 1000);
    room.addClient(adapterSocket, {
      type: "clientHello",
      deviceName: "MuseScore",
      role: "desktop-adapter",
      capabilities: [{ app: "musescore", canPlay: true, canStop: true }]
    }, 1000);

    room.handleMessage(host.id, {
      type: "safetyUpdate",
      armed: true,
      updatedAt: 1100
    }, 1100);
    room.handleMessage(host.id, {
      type: "transportRequest",
      action: "play",
      requestedAt: 1200
    }, 1200);

    room.removeClient(host.id);

    const stopCommand = adapterMessages
      .map((message) => JSON.parse(message))
      .find((message) => message.type === "transportCommand" && message.action === "stop");
    expect(stopCommand).toMatchObject({
      action: "stop",
      leaderId: host.id,
      sequenceId: 2
    });
    expect(room.getState(1300).transport.status).toBe("stopped");
  });

  it("evicts clients that have gone silent past the idle timeout", () => {
    const room = new RoomController("ABC123", "http://room", "http://host", 1500);
    const stale = room.addClient(undefined, {
      type: "clientHello",
      deviceName: "Ghost",
      role: "companion",
      capabilities: []
    }, 1000);
    const fresh = room.addClient(undefined, {
      type: "clientHello",
      deviceName: "Live",
      role: "companion",
      capabilities: []
    }, 1000);

    // Keep the "fresh" client alive with a recent message.
    room.handleMessage(fresh.id, { type: "clockSync", clientSentAt: 20_000 }, 20_000);

    // 15s later: stale client (last seen at 1000) is well past the 12s timeout,
    // fresh client (last seen at 20000) is not.
    room.sweepIdleClients(21_000);

    const ids = room.getState(21_000).clients.map((client) => client.id);
    expect(ids).toContain(fresh.id);
    expect(ids).not.toContain(stale.id);
  });

  it("stops transport when the silent client was the leader", () => {
    const adapterMessages: string[] = [];
    const room = new RoomController("ABC123", "http://room", "http://host", 1500);
    const host = room.addClient(undefined, {
      type: "clientHello",
      deviceName: "Host",
      role: "host",
      capabilities: []
    }, 1000);
    room.addClient(fakeSocket(adapterMessages), {
      type: "clientHello",
      deviceName: "MuseScore",
      role: "desktop-adapter",
      capabilities: [{ app: "musescore", canPlay: true, canStop: true }]
    }, 1000);

    room.handleMessage(host.id, { type: "safetyUpdate", armed: true, updatedAt: 1100 }, 1100);
    room.handleMessage(host.id, { type: "transportRequest", action: "play", requestedAt: 1200 }, 1200);

    // The host never sends another message; sweep well past the timeout.
    room.sweepIdleClients(20_000);

    const stopCommand = adapterMessages
      .map((message) => JSON.parse(message))
      .find((message) => message.type === "transportCommand" && message.action === "stop");
    expect(stopCommand).toMatchObject({ action: "stop", leaderId: host.id });
    expect(room.getState(20_000).transport.status).toBe("stopped");
  });
});

function fakeSocket(messages: string[]): WebSocket {
  return {
    OPEN: 1,
    readyState: 1,
    send: (message: string) => {
      messages.push(message);
    }
  } as unknown as WebSocket;
}
