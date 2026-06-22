import { describe, expect, it } from "vitest";
import {
  isLinkLocal,
  isPrivateLan,
  selectLanAddress,
  selectLanCandidates,
  type NetworkAddressInfo
} from "./lan-address.js";

function ipv4(address: string, internal = false): NetworkAddressInfo {
  return { family: "IPv4", internal, address };
}

describe("selectLanCandidates", () => {
  it("prefers a real private-LAN adapter over virtual and link-local ones", () => {
    // Mirrors the reporter's machine: WLAN sat on a 169.254 APIPA address and
    // came first, so the naive pick advertised an unroutable host.
    const interfaces = {
      "WLAN": [ipv4("169.254.83.107")],
      "vEthernet (WSL (Hyper-V firewall))": [ipv4("172.17.240.1")],
      "VMware Network Adapter VMnet8": [ipv4("192.168.2.1")],
      "Ethernet": [ipv4("192.168.178.38")]
    };

    expect(selectLanAddress(interfaces)).toBe("192.168.178.38");
    // Real private LAN first; virtual adapters follow in enumeration order.
    expect(selectLanCandidates(interfaces)).toEqual([
      "192.168.178.38",
      "172.17.240.1",
      "192.168.2.1"
    ]);
  });

  it("drops loopback and link-local addresses entirely", () => {
    const interfaces = {
      "Loopback Pseudo-Interface 1": [ipv4("127.0.0.1", true)],
      "Bluetooth-Netzwerkverbindung": [ipv4("169.254.221.70")],
      "Tailscale": [ipv4("169.254.83.107")]
    };

    expect(selectLanCandidates(interfaces)).toEqual([]);
    expect(selectLanAddress(interfaces)).toBe("127.0.0.1");
  });

  it("falls back to a public/other adapter when no private LAN exists", () => {
    const interfaces = {
      "Ethernet": [ipv4("203.0.113.5")]
    };

    expect(selectLanAddress(interfaces)).toBe("203.0.113.5");
  });

  it("ignores IPv6 and respects numeric family values", () => {
    const interfaces = {
      "Ethernet": [
        { family: "IPv6", internal: false, address: "fe80::1" },
        { family: 4, internal: false, address: "10.0.0.5" }
      ]
    };

    expect(selectLanCandidates(interfaces)).toEqual(["10.0.0.5"]);
  });
});

describe("address classifiers", () => {
  it("recognizes link-local APIPA addresses", () => {
    expect(isLinkLocal("169.254.1.1")).toBe(true);
    expect(isLinkLocal("192.168.1.1")).toBe(false);
  });

  it("recognizes RFC 1918 private ranges including the full 172.16-31 block", () => {
    expect(isPrivateLan("192.168.178.38")).toBe(true);
    expect(isPrivateLan("10.1.2.3")).toBe(true);
    expect(isPrivateLan("172.16.0.1")).toBe(true);
    expect(isPrivateLan("172.31.255.254")).toBe(true);
    expect(isPrivateLan("172.15.0.1")).toBe(false);
    expect(isPrivateLan("172.32.0.1")).toBe(false);
    expect(isPrivateLan("8.8.8.8")).toBe(false);
  });
});
