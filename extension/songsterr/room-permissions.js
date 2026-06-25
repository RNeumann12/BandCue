(function () {
  const DEFAULT_ROOM_PORT = 4173;

  function permissionsForLocator(value) {
    const locator = normalizeRoomLocator(value);
    if (isAbsoluteRoomUrl(locator)) {
      return explicitHostPermissions(locator);
    }

    if (isPort(locator) || isRoomCode(locator)) {
      return {
        origins: ["http://*/*"],
        requiresBroadLanAccess: true,
        message: "Approve local network access so BandCue can find the rehearsal room on this Wi-Fi."
      };
    }

    const explicitHost = parseHostAndPort(locator, DEFAULT_ROOM_PORT);
    if (explicitHost) {
      return hostPermissions(explicitHost.host);
    }

    return {
      origins: [],
      requiresBroadLanAccess: false,
      message: "Use a room URL, room code, port, or host:port."
    };
  }

  function explicitHostPermissions(value) {
    try {
      const url = new URL(value);
      return hostPermissions(url.hostname);
    } catch {
      return {
        origins: [],
        requiresBroadLanAccess: false,
        message: "Use a room URL, room code, port, or host:port."
      };
    }
  }

  function hostPermissions(host) {
    const normalizedHost = normalizeHostForPattern(host);
    if (!normalizedHost) {
      return {
        origins: [],
        requiresBroadLanAccess: false,
        message: "Use a room URL, room code, port, or host:port."
      };
    }

    return {
      origins: [`http://${normalizedHost}/*`],
      requiresBroadLanAccess: false,
      message: `Approve local BandCue access for ${host}.`
    };
  }

  function normalizeHostForPattern(host) {
    const normalized = String(host || "").trim();
    if (!normalized || normalized.includes("*")) {
      return "";
    }
    if (normalized.includes(":") && !normalized.startsWith("[") && !normalized.endsWith("]")) {
      return `[${normalized}]`;
    }
    return normalized;
  }

  function normalizeRoomLocator(value) {
    const trimmed = String(value || "").trim();
    return trimmed || String(DEFAULT_ROOM_PORT);
  }

  function isAbsoluteRoomUrl(value) {
    return /^https?:\/\//i.test(value.trim());
  }

  function isPort(value) {
    const parsed = Number.parseInt(value, 10);
    return /^\d{2,5}$/.test(value) && Number.isFinite(parsed) && parsed > 0 && parsed <= 65535;
  }

  function isRoomCode(value) {
    return /^[a-f0-9]{6}$/i.test(value);
  }

  function parseHostAndPort(value, defaultPort) {
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

  globalThis.BandCueRoomPermissions = {
    permissionsForLocator
  };
})();
