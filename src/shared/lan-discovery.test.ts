import { describe, expect, it } from "vitest";
import {
  DISCOVERY_PROTOCOL_VERSION,
  DISCOVERY_REQUEST_TYPE,
  DISCOVERY_RESPONSE_TYPE,
  parseDiscoveryRequest,
  parseDiscoveryResponse
} from "./lan-discovery.js";

describe("LAN discovery protocol", () => {
  it("parses room discovery requests", () => {
    expect(parseDiscoveryRequest(JSON.stringify({
      type: DISCOVERY_REQUEST_TYPE,
      protocol: DISCOVERY_PROTOCOL_VERSION,
      roomCode: "abc123"
    }))).toEqual({
      type: DISCOVERY_REQUEST_TYPE,
      protocol: DISCOVERY_PROTOCOL_VERSION,
      roomCode: "ABC123"
    });
  });

  it("rejects malformed discovery requests", () => {
    expect(parseDiscoveryRequest(JSON.stringify({
      type: "other",
      protocol: DISCOVERY_PROTOCOL_VERSION
    }))).toBeUndefined();
  });

  it("parses room discovery responses", () => {
    expect(parseDiscoveryResponse(JSON.stringify({
      type: DISCOVERY_RESPONSE_TYPE,
      protocol: DISCOVERY_PROTOCOL_VERSION,
      roomCode: "abc123",
      port: 4173
    }))).toEqual({
      type: DISCOVERY_RESPONSE_TYPE,
      protocol: DISCOVERY_PROTOCOL_VERSION,
      roomCode: "ABC123",
      port: 4173
    });
  });

  it("rejects invalid discovery response ports", () => {
    expect(parseDiscoveryResponse(JSON.stringify({
      type: DISCOVERY_RESPONSE_TYPE,
      protocol: DISCOVERY_PROTOCOL_VERSION,
      roomCode: "ABC123",
      port: 70000
    }))).toBeUndefined();
  });
});
