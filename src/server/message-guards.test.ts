import { describe, expect, it } from "vitest";
import {
  MAX_WS_MESSAGE_BYTES,
  parseClientHelloPayload,
  parseClientMessagePayload,
  sanitizeClientHello,
  sanitizeClientMessage
} from "./message-guards.js";

describe("server message guards", () => {
  it("sanitizes a valid client hello and caps capabilities", () => {
    const hello = sanitizeClientHello({
      type: "clientHello",
      deviceName: "  Stage Laptop  ",
      role: "desktop-adapter",
      capabilities: [
        { app: "songsterr", canPlay: true, canStop: true },
        { app: "unknown", canPlay: true, canStop: true },
        ...Array.from({ length: 10 }, () => ({ app: "musescore", canPlay: true, canStop: true }))
      ]
    });

    expect(hello).toMatchObject({
      type: "clientHello",
      deviceName: "Stage Laptop",
      role: "desktop-adapter"
    });
    expect(hello?.capabilities).toHaveLength(8);
    expect(hello?.capabilities.every((capability) => capability.app === "songsterr" || capability.app === "musescore"))
      .toBe(true);
  });

  it("rejects invalid hello roles and oversized payloads", () => {
    expect(sanitizeClientHello({
      type: "clientHello",
      deviceName: "Bad",
      role: "admin",
      capabilities: []
    })).toBeUndefined();

    expect(parseClientHelloPayload("x".repeat(MAX_WS_MESSAGE_BYTES + 1))).toBeUndefined();
  });

  it("accepts valid mutating messages and rejects malformed ones", () => {
    expect(sanitizeClientMessage({
      type: "transportRequest",
      action: "play",
      requestedAt: 1000
    })).toEqual({
      type: "transportRequest",
      action: "play",
      requestedAt: 1000
    });

    expect(sanitizeClientMessage({
      type: "transportRequest",
      action: "launch",
      requestedAt: 1000
    })).toBeUndefined();

    expect(sanitizeClientMessage({
      type: "adapterStatus",
      ready: true,
      app: "songsterr",
      playback: "invalid"
    })).toEqual({
      type: "adapterStatus",
      ready: true,
      app: "songsterr",
      state: undefined,
      playback: undefined,
      playbackDetail: undefined,
      title: undefined,
      source: undefined,
      durationMs: undefined,
      durationSource: undefined,
      catalog: undefined,
      songMatch: undefined,
      detail: undefined,
      lastCommand: undefined
    });
  });

  it("parses only known JSON client messages", () => {
    expect(parseClientMessagePayload(JSON.stringify({
      type: "safetyUpdate",
      armed: true,
      controlMode: "host-only",
      updatedAt: 2000
    }))).toEqual({
      type: "safetyUpdate",
      armed: true,
      controlMode: "host-only",
      updatedAt: 2000
    });

    expect(parseClientMessagePayload("{not json")).toBeUndefined();
    expect(parseClientMessagePayload(JSON.stringify({ type: "unknown" }))).toBeUndefined();
  });
});
