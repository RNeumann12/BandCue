export const DEFAULT_ROOM_PORT = 4173;
export const DEFAULT_LOCAL_DISCOVERY_HOSTS = ["127.0.0.1", "localhost"];
// Canonical LAN scan subnet list. Platforms that cannot import this module keep
// their own copy and MUST stay in sync: extension/songsterr/background.js
// (LAN_SCAN_SUBNETS) and android/.../RoomLocator.kt (LAN_SCAN_SUBNETS).
// Ordered most-likely-first so an HTTP scan reaches common home networks early:
// 192.168.0/1 are the most common router defaults and 192.168.178 is the
// Fritz!Box default. A scan that finds the room in the first subnet avoids
// probing ~250 dead hosts per later subnet.
export const DEFAULT_LAN_SCAN_SUBNETS = [
  "192.168.0",
  "192.168.1",
  "192.168.178",
  "192.168.2",
  "192.168.4",
  "192.168.86",
  "10.0.0",
  "10.0.1",
  "10.0.2",
  "172.16.0",
  "172.20.10"
];
export const LAN_SCAN_HOST_MIN = 1;
export const LAN_SCAN_HOST_MAX = 254;

export interface RoomDiscoveryCandidate {
  apiUrl: string;
  baseUrl: string;
  expectedRoomCode?: string;
  label: string;
}

export interface RoomDiscoveryState {
  type?: string;
  roomCode?: string;
  companionUrl?: string;
}

export function normalizeRoomLocator(value: string | undefined, defaultPort = DEFAULT_ROOM_PORT): string {
  const trimmed = value?.trim();
  return trimmed || String(defaultPort);
}

export function isAbsoluteRoomUrl(value: string): boolean {
  return /^https?:\/\//i.test(value.trim());
}

export function isPlaceholderRoom(room: string): boolean {
  try {
    const url = new URL(room);
    const tokenValue = url.searchParams.get("token") ?? "";
    return (
      /^(host|your_host)$/i.test(url.hostname) ||
      /^(token|room_token|real_token|real_token_from_server)$/i.test(tokenValue)
    );
  } catch {
    return false;
  }
}

export function roomUrlToWebSocket(room: string): string {
  const url = new URL(room);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/ws";
  return url.toString();
}

export function buildRoomDiscoveryCandidates(
  locator: string,
  defaultPort = DEFAULT_ROOM_PORT
): RoomDiscoveryCandidate[] {
  const value = normalizeRoomLocator(locator, defaultPort);
  if (isAbsoluteRoomUrl(value)) {
    return [];
  }

  if (isPort(value)) {
      return localCandidates(Number.parseInt(value, 10));
  }

  if (isRoomCode(value)) {
      return localCandidates(defaultPort, value.toUpperCase());
  }

  const explicitHost = parseHostAndPort(value, defaultPort);
  return explicitHost ? [roomDiscoveryCandidate(explicitHost.host, explicitHost.port)] : [];
}

export function buildLanScanCandidates(
  locator: string,
  defaultPort = DEFAULT_ROOM_PORT,
  subnets = DEFAULT_LAN_SCAN_SUBNETS
): RoomDiscoveryCandidate[] {
  const value = normalizeRoomLocator(locator, defaultPort);
  if (!isPort(value) && !isRoomCode(value)) {
    return [];
  }

  const expectedRoomCode = isRoomCode(value) ? value.toUpperCase() : undefined;
  const port = isPort(value) ? Number.parseInt(value, 10) : defaultPort;
  return subnets.flatMap((subnet) => (
    Array.from(
      { length: LAN_SCAN_HOST_MAX - LAN_SCAN_HOST_MIN + 1 },
      (_unused, index) => roomDiscoveryCandidate(
        `${subnet}.${LAN_SCAN_HOST_MIN + index}`,
        port,
        expectedRoomCode
      )
    )
  ));
}

// Hostname stem the server advertises over mDNS. The OS mDNS resolver
// (Windows 10 1703+, macOS, Linux+Avahi) resolves "<stem>.local" to the
// server's LAN IP, so a browser/extension can reach the room with a plain
// fetch instead of brute-forcing the LAN. Keep in sync with the server
// (src/server/mdns.ts) and the extension copy (extension/songsterr/background.js).
export const MDNS_HOST_STEM = "bandcue";

// mDNS hostnames advertised for a room, most-specific first. The room-code name
// disambiguates multiple rooms on one LAN; the generic name covers the common
// single-room case (and port-only locators).
export function mdnsRoomHosts(roomCode?: string): string[] {
  const hosts = [`${MDNS_HOST_STEM}.local`];
  if (roomCode && isRoomCode(roomCode)) {
    hosts.unshift(`${MDNS_HOST_STEM}-${roomCode.toLowerCase()}.local`);
  }
  return hosts;
}

// Discovery candidates that resolve via the OS mDNS resolver, for room-code or
// port locators (an explicit host/URL locator already names its own host).
export function buildMdnsDiscoveryCandidates(
  locator: string,
  defaultPort = DEFAULT_ROOM_PORT
): RoomDiscoveryCandidate[] {
  const value = normalizeRoomLocator(locator, defaultPort);
  if (!isPort(value) && !isRoomCode(value)) {
    return [];
  }
  const expectedRoomCode = isRoomCode(value) ? value.toUpperCase() : undefined;
  const port = isPort(value) ? Number.parseInt(value, 10) : defaultPort;
  const roomCode = isRoomCode(value) ? value : undefined;
  return mdnsRoomHosts(roomCode).map((host) => roomDiscoveryCandidate(host, port, expectedRoomCode));
}

// Extracts the /24 subnet prefix ("a.b.c") from a private-LAN IPv4 address, or
// undefined for public, loopback, link-local, or non-IPv4 input. Lets a client
// scan its own network first instead of brute-forcing every documented default.
export function lanSubnetPrefix(address: string | undefined): string | undefined {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(address?.trim() ?? "");
  if (!match) {
    return undefined;
  }
  const octets = match.slice(1, 5).map(Number);
  if (octets.some((octet) => octet > 255)) {
    return undefined;
  }
  const [a, b] = octets;
  const isPrivate = a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31);
  return isPrivate ? `${octets[0]}.${octets[1]}.${octets[2]}` : undefined;
}

// Returns the scan subnet list with the client's own subnets first (deduped),
// then the documented defaults, so discovery reaches the local network at once
// and only falls back to brute force when the local IP is unknown.
export function prioritizeScanSubnets(
  localSubnets: string[],
  subnets = DEFAULT_LAN_SCAN_SUBNETS
): string[] {
  const ordered: string[] = [];
  for (const subnet of [...localSubnets, ...subnets]) {
    if (subnet && !ordered.includes(subnet)) {
      ordered.push(subnet);
    }
  }
  return ordered;
}

export function discoveryPortForLocator(locator: string, defaultPort = DEFAULT_ROOM_PORT): number {
  const value = normalizeRoomLocator(locator, defaultPort);
  return isPort(value) ? Number.parseInt(value, 10) : defaultPort;
}

export function expectedRoomCodeForLocator(locator: string): string | undefined {
  const value = normalizeRoomLocator(locator);
  return isRoomCode(value) ? value.toUpperCase() : undefined;
}

export function describeLanScanSubnets(subnets = DEFAULT_LAN_SCAN_SUBNETS): string {
  return subnets.map((subnet) => `${subnet}.${LAN_SCAN_HOST_MIN}-${LAN_SCAN_HOST_MAX}`).join(", ");
}

export function roomDiscoveryFallbackHint(port: number): string {
  return `If discovery is blocked by Wi-Fi isolation, firewall, VPN, or a different subnet, enter the host:port shown on the host page, such as 192.168.1.12:${port}, or paste the full room URL.`;
}

export function roomUrlFromDiscovery(
  state: RoomDiscoveryState,
  candidate: RoomDiscoveryCandidate
): string | undefined {
  if (state.type !== "roomState" || typeof state.companionUrl !== "string") {
    return undefined;
  }

  if (
    candidate.expectedRoomCode &&
    state.roomCode?.toUpperCase() !== candidate.expectedRoomCode.toUpperCase()
  ) {
    return undefined;
  }

  try {
    const discoveredUrl = new URL(state.companionUrl);
    const token = discoveredUrl.searchParams.get("token");
    if (!token) {
      return undefined;
    }

    const url = new URL(candidate.baseUrl);
    url.pathname = "/";
    url.search = "";
    url.searchParams.set("token", token);
    return url.toString();
  } catch {
    return undefined;
  }
}

function localCandidates(port: number, expectedRoomCode?: string): RoomDiscoveryCandidate[] {
  return DEFAULT_LOCAL_DISCOVERY_HOSTS.map((host) => roomDiscoveryCandidate(host, port, expectedRoomCode));
}

export function roomDiscoveryCandidate(
  host: string,
  port: number,
  expectedRoomCode?: string
): RoomDiscoveryCandidate {
  const baseUrl = `http://${host}:${port}`;
  return {
    apiUrl: `${baseUrl}/api/room`,
    baseUrl,
    expectedRoomCode,
    label: expectedRoomCode ? `${expectedRoomCode} on ${host}:${port}` : `${host}:${port}`
  };
}

export function isPort(value: string): boolean {
  const parsed = Number.parseInt(value, 10);
  return /^\d{2,5}$/.test(value) && Number.isFinite(parsed) && parsed > 0 && parsed <= 65535;
}

export function isRoomCode(value: string): boolean {
  return /^[a-f0-9]{6}$/i.test(value);
}

function parseHostAndPort(value: string, defaultPort: number): { host: string; port: number } | undefined {
  try {
    const url = new URL(`http://${value}`);
    const host = url.hostname;
    const port = url.port ? Number.parseInt(url.port, 10) : defaultPort;
    if (!host || !Number.isFinite(port) || port <= 0 || port > 65535) {
      return undefined;
    }

    return { host, port };
  } catch {
    return undefined;
  }
}
