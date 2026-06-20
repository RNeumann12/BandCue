import { describe, expect, it, vi } from "vitest";
import type WebSocket from "ws";
import { RoomController } from "./room.js";

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
        sequenceId: 2
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
