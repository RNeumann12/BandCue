import { createSocket } from "node:dgram";
import { networkInterfaces } from "node:os";
import { DEFAULT_ROOM_PORT } from "./room-locator.js";

export const DISCOVERY_REQUEST_TYPE = "bandcue.discovery.request";
export const DISCOVERY_RESPONSE_TYPE = "bandcue.discovery.response";
export const DISCOVERY_PROTOCOL_VERSION = 1;

export interface BandCueDiscoveryResponse {
  type: typeof DISCOVERY_RESPONSE_TYPE;
  protocol: typeof DISCOVERY_PROTOCOL_VERSION;
  roomCode: string;
  port: number;
  host?: string;
}

export interface BandCueDiscoveryRequest {
  type: typeof DISCOVERY_REQUEST_TYPE;
  protocol: typeof DISCOVERY_PROTOCOL_VERSION;
  roomCode?: string;
}

export interface LanDiscoveryOptions {
  roomCode?: string;
  discoveryPort?: number;
  timeoutMs?: number;
}

export function discoverBandCueRooms(options: LanDiscoveryOptions = {}): Promise<BandCueDiscoveryResponse[]> {
  const discoveryPort = options.discoveryPort ?? DEFAULT_ROOM_PORT;
  const timeoutMs = options.timeoutMs ?? 900;
  const request: BandCueDiscoveryRequest = {
    type: DISCOVERY_REQUEST_TYPE,
    protocol: DISCOVERY_PROTOCOL_VERSION,
    roomCode: options.roomCode?.toUpperCase()
  };
  const payload = Buffer.from(JSON.stringify(request));

  return new Promise((resolve) => {
    const socket = createSocket("udp4");
    const responses = new Map<string, BandCueDiscoveryResponse>();
    let settled = false;

    const finish = () => {
      if (settled) {
        return;
      }

      settled = true;
      try {
        socket.close();
      } catch {
        clearTimeout(timer);
      }
      resolve([...responses.values()]);
    };

    const timer = setTimeout(finish, timeoutMs);

    socket.on("message", (message, remote) => {
      const response = parseDiscoveryResponse(message.toString());
      if (!response) {
        return;
      }

      if (request.roomCode && response.roomCode.toUpperCase() !== request.roomCode) {
        return;
      }

      responses.set(`${remote.address}:${response.roomCode}:${response.port}`, {
        ...response,
        host: remote.address
      });
    });

    socket.on("error", finish);

    socket.bind(0, () => {
      socket.setBroadcast(true);
      for (const host of getBroadcastHosts()) {
        socket.send(payload, discoveryPort, host);
      }
    });

    socket.on("close", () => {
      clearTimeout(timer);
    });
  });
}

export function parseDiscoveryRequest(raw: string): BandCueDiscoveryRequest | undefined {
  try {
    const parsed = JSON.parse(raw) as Partial<BandCueDiscoveryRequest>;
    if (
      parsed.type !== DISCOVERY_REQUEST_TYPE ||
      parsed.protocol !== DISCOVERY_PROTOCOL_VERSION ||
      (parsed.roomCode !== undefined && typeof parsed.roomCode !== "string")
    ) {
      return undefined;
    }

    return {
      type: DISCOVERY_REQUEST_TYPE,
      protocol: DISCOVERY_PROTOCOL_VERSION,
      roomCode: parsed.roomCode?.toUpperCase()
    };
  } catch {
    return undefined;
  }
}

export function parseDiscoveryResponse(raw: string): BandCueDiscoveryResponse | undefined {
  try {
    const parsed = JSON.parse(raw) as Partial<BandCueDiscoveryResponse>;
    if (
      parsed.type !== DISCOVERY_RESPONSE_TYPE ||
      parsed.protocol !== DISCOVERY_PROTOCOL_VERSION ||
      typeof parsed.roomCode !== "string" ||
      typeof parsed.port !== "number" ||
      parsed.port <= 0 ||
      parsed.port > 65535
    ) {
      return undefined;
    }

    return {
      type: DISCOVERY_RESPONSE_TYPE,
      protocol: DISCOVERY_PROTOCOL_VERSION,
      roomCode: parsed.roomCode.toUpperCase(),
      port: parsed.port
    };
  } catch {
    return undefined;
  }
}

export function getBroadcastHosts(): string[] {
  const hosts = new Set(["255.255.255.255"]);
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family !== "IPv4" || address.internal || !address.netmask) {
        continue;
      }

      const broadcast = ipv4ToNumber(address.address) | (~ipv4ToNumber(address.netmask) >>> 0);
      hosts.add(numberToIpv4(broadcast >>> 0));
    }
  }

  return [...hosts];
}

function ipv4ToNumber(value: string): number {
  return value
    .split(".")
    .map((part) => Number.parseInt(part, 10))
    .reduce((result, part) => ((result << 8) + part) >>> 0, 0);
}

function numberToIpv4(value: number): string {
  return [
    (value >>> 24) & 255,
    (value >>> 16) & 255,
    (value >>> 8) & 255,
    value & 255
  ].join(".");
}
