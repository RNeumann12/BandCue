export const DEFAULT_ROOM_PORT = 4173;

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
  return [
    roomDiscoveryCandidate("127.0.0.1", port, expectedRoomCode),
    roomDiscoveryCandidate("localhost", port, expectedRoomCode)
  ];
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
