import { describe, expect, it } from "vitest";
import {
  DEFAULT_LAN_SCAN_SUBNETS,
  buildLanScanCandidates,
  buildRoomDiscoveryCandidates,
  describeLanScanSubnets,
  discoveryPortForLocator,
  expectedRoomCodeForLocator,
  normalizeRoomLocator,
  roomDiscoveryFallbackHint,
  roomUrlFromDiscovery,
  roomUrlToWebSocket
} from "./room-locator.js";

describe("room locator", () => {
  it("uses the default port when the locator is blank", () => {
    expect(normalizeRoomLocator(undefined)).toBe("4173");
    expect(normalizeRoomLocator("   ")).toBe("4173");
  });

  it("discovers a local room by port", () => {
    const candidates = buildRoomDiscoveryCandidates("4174");

    expect(candidates.map((candidate) => candidate.apiUrl)).toEqual([
      "http://127.0.0.1:4174/api/room",
      "http://localhost:4174/api/room"
    ]);
  });

  it("discovers a room code on the configured local port", () => {
    const candidates = buildRoomDiscoveryCandidates("ABC123", 5000);

    expect(candidates[0]).toMatchObject({
      apiUrl: "http://127.0.0.1:5000/api/room",
      expectedRoomCode: "ABC123"
    });
  });

  it("treats hostnames as hosts, not room codes", () => {
    const candidates = buildRoomDiscoveryCandidates("localhost", 5000);

    expect(candidates).toEqual([{
      apiUrl: "http://localhost:5000/api/room",
      baseUrl: "http://localhost:5000",
      expectedRoomCode: undefined,
      label: "localhost:5000"
    }]);
  });

  it("preserves the discovered token while using the queried host", () => {
    const candidates = buildRoomDiscoveryCandidates("127.0.0.1:5000");

    expect(roomUrlFromDiscovery({
      type: "roomState",
      roomCode: "ABC123",
      companionUrl: "http://192.168.1.5:5000/?token=SECRET"
    }, candidates[0])).toBe("http://127.0.0.1:5000/?token=SECRET");
  });

  it("rejects mismatched room codes", () => {
    const candidates = buildRoomDiscoveryCandidates("ABC123");

    expect(roomUrlFromDiscovery({
      type: "roomState",
      roomCode: "DEF456",
      companionUrl: "http://127.0.0.1:4173/?token=SECRET"
    }, candidates[0])).toBeUndefined();
  });

  it("converts room URLs to websocket URLs", () => {
    expect(roomUrlToWebSocket("http://127.0.0.1:4173/?token=SECRET"))
      .toBe("ws://127.0.0.1:4173/ws?token=SECRET");
  });

  it("builds documented LAN scan candidates for room codes", () => {
    const candidates = buildLanScanCandidates("ABC123", 5000, ["192.168.1"]);

    expect(candidates).toHaveLength(254);
    expect(candidates[0]).toMatchObject({
      apiUrl: "http://192.168.1.1:5000/api/room",
      expectedRoomCode: "ABC123"
    });
    expect(candidates.at(-1)?.apiUrl).toBe("http://192.168.1.254:5000/api/room");
  });

  it("describes room discovery diagnostics and fallback", () => {
    expect(discoveryPortForLocator("ABC123", 5000)).toBe(5000);
    expect(discoveryPortForLocator("4174", 5000)).toBe(4174);
    expect(expectedRoomCodeForLocator("abc123")).toBe("ABC123");
    expect(describeLanScanSubnets(["192.168.1"])).toBe("192.168.1.1-254");
    expect(roomDiscoveryFallbackHint(4173)).toContain("host:port shown on the host page");
    expect(DEFAULT_LAN_SCAN_SUBNETS).toContain("172.20.10");
  });
});
