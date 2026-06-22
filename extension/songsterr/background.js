let socket;
let roomInput;
let roomUrl;
let wsUrl;
let serverOffsetMs = 0;
let samples = [];
let connectionState = "not configured";
let connectionDetail = "Enter the BandCue room code, port, or URL and click Connect";
let clockTimer;
let reconnectTimer;
let lastStatus = {
  ready: false,
  app: "songsterr",
  detail: "No Songsterr tab detected"
};
let latestCommand;
let tabStatusTimer;
let tabStatusInFlight = false;
let tabStatusPending = false;
let lastDeliveredStatusSignature = "";
let lastSongsterrTabIdentity = "";
let lastContentScriptStatusAt = 0;
// When true, this machine never auto-opens a Songsterr tab. Use it on a host
// that plays from MuseScore so transport/open commands don't pop Songsterr.
let suppressAutoOpen = false;
let autoConnectEnabled = false;

const TAB_STATUS_DEBOUNCE_MS = 750;
const CONTENT_SCRIPT_STATUS_TTL_MS = 15_000;
const DEFAULT_ROOM_PORT = 4173;
const LAN_SCAN_BATCH_SIZE = 64;
const LAN_SCAN_TIMEOUT_MS = 350;
// Keep in sync with DEFAULT_LAN_SCAN_SUBNETS in src/shared/room-locator.ts
// (the canonical list) and LAN_SCAN_SUBNETS in android/.../RoomLocator.kt.
const LAN_SCAN_SUBNETS = [
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

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "popupConnect") {
    roomInput = normalizeRoomLocator(message.roomUrl);
    autoConnectEnabled = true;
    connectionState = "connecting";
    connectionDetail = `Looking for BandCue room ${roomInput}`;
    configureConnection(roomInput).then(() => {
      sendResponse(getPopupState());
    }).catch((error) => {
      connectionState = "error";
      connectionDetail = error.message;
      sendResponse(getPopupState());
    });
    return true;
  }

  if (message.type === "popupDisconnect") {
    disconnectByUser();
    sendResponse(getPopupState());
    return true;
  }

  if (message.type === "popupTransport") {
    send({ type: "transportRequest", action: message.action, requestedAt: Date.now() });
    sendResponse({ ok: true });
    return true;
  }

  if (message.type === "songsterrStatus") {
    lastContentScriptStatusAt = Date.now();
    const tabIdentity = getSongsterrTabIdentity(sender.tab);
    publishAdapterStatus({
      ready: Boolean(message.ready),
      app: "songsterr",
      title: selectStableTitle(message.title, tabIdentity),
      source: message.source,
      durationMs: message.durationMs,
      durationSource: message.durationMs ? "adapter" : undefined,
      state: message.ready ? "ready" : "not-ready",
      detail: message.detail,
      lastCommand: latestCommand
    });
    return false;
  }

  if (message.type === "popupSetSuppressAutoOpen") {
    suppressAutoOpen = Boolean(message.suppressAutoOpen);
    chrome.storage.local.set({ suppressAutoOpen });
    sendResponse(getPopupState());
    return true;
  }

  if (message.type === "popupState") {
    scheduleActiveTabStatusReport();
    sendResponse(getPopupState());
    return true;
  }

  return false;
});

chrome.storage.local.get(["roomInput", "roomUrl", "suppressAutoOpen", "autoConnectEnabled"], (stored) => {
  suppressAutoOpen = Boolean(stored.suppressAutoOpen);
  autoConnectEnabled = Boolean(stored.autoConnectEnabled);
  const storedInput = stored.roomInput || stored.roomUrl;
  if (storedInput) {
    roomInput = storedInput;
  }
  if (storedInput && autoConnectEnabled) {
    configureConnection(storedInput).catch((error) => {
      connectionState = "error";
      connectionDetail = error.message;
    });
  } else if (storedInput) {
    connectionState = "disconnected-by-user";
    connectionDetail = "Disconnected. Press Connect when you want this extension to join.";
  }
});

chrome.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
  if (!isRelevantSongsterrTabUpdate(changeInfo, tab)) {
    return;
  }

  scheduleActiveTabStatusReport();
});

chrome.tabs.onRemoved.addListener(() => {
  scheduleActiveTabStatusReport();
});

async function configureConnection(input) {
  roomInput = normalizeRoomLocator(input);
  await refreshRoomEndpoint();
  autoConnectEnabled = true;
  chrome.storage.local.set({ roomInput, roomUrl, autoConnectEnabled });
  connect();
}

async function refreshRoomEndpoint() {
  const endpoint = await resolveRoomEndpoint(roomInput);
  roomUrl = endpoint.roomUrl;
  wsUrl = endpoint.wsUrl;
}

async function connect() {
  if (!autoConnectEnabled) {
    connectionState = "disconnected-by-user";
    connectionDetail = "Disconnected. Press Connect when you want this extension to join.";
    return;
  }

  if (roomInput) {
    try {
      await refreshRoomEndpoint();
      chrome.storage.local.set({ roomInput, roomUrl, autoConnectEnabled });
    } catch (error) {
      connectionState = "error";
      connectionDetail = error.message;
      scheduleReconnect();
      return;
    }
  }

  if (!wsUrl) return;
  const previousSocket = socket;
  socket = undefined;
  previousSocket?.close();
  if (clockTimer) clearInterval(clockTimer);
  connectionState = "connecting";
  connectionDetail = `Connecting to ${roomInput || roomUrl}`;
  socket = new WebSocket(wsUrl);

  socket.addEventListener("open", () => {
    connectionState = "connected";
    connectionDetail = "Connected to BandCue coordinator";
    lastDeliveredStatusSignature = "";
    send({
      type: "clientHello",
      deviceName: "Songsterr tab",
      role: "desktop-adapter",
      capabilities: [{ app: "songsterr", canPlay: true, canStop: true }]
    });

    clockTimer = setInterval(() => send({ type: "clockSync", clientSentAt: Date.now() }), 1000);
    scheduleActiveTabStatusReport(0);
    requestSongsterrStatusFromTabs();
  });

  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);

    if (message.type === "clockSyncResult") {
      const sample = calculateClockSample(
        message.clientSentAt,
        Date.now(),
        message.serverReceivedAt,
        message.serverSentAt
      );
      samples.push(sample);
      samples = samples.slice(-10);
      const summary = summarizeClock(samples);
      serverOffsetMs = summary.offsetMs;
      send({
        type: "clockStatus",
        rttMs: summary.rttMs,
        offsetMs: summary.offsetMs,
        jitterMs: calculateJitterMs(samples)
      });
      return;
    }

    if (message.type === "transportCommand") {
      const manualOffsetMs = message.manualOffsetMs || 0;
      const delayMs = Math.max(
        0,
        message.scheduledServerTime + manualOffsetMs - (Date.now() + serverOffsetMs)
      );
      reportCommandStatus({
        action: message.action,
        sequenceId: message.sequenceId,
        status: "pending",
        ready: lastStatus.ready,
        detail: `Songsterr ${message.action} command scheduled${formatManualOffset(manualOffsetMs)}`,
        at: Date.now()
      });
      setTimeout(() => {
        sendTransportToSongsterr(
          message.action,
          message.sequenceId,
          message.currentSong?.song,
          Boolean(message.resetBeforePlay)
        );
      }, delayMs);
      return;
    }

    if (message.type === "openSongCommand") {
      openSongsterrFromRoom(message.currentSong?.song, message.sequenceId);
    }
  });

  socket.addEventListener("close", (event) => {
    if (event.target !== socket) {
      return;
    }
    if (clockTimer) {
      clearInterval(clockTimer);
      clockTimer = undefined;
    }
    if (!autoConnectEnabled) {
      connectionState = "disconnected-by-user";
      connectionDetail = "Disconnected. Press Connect when you want this extension to join.";
      return;
    }
    connectionState = "disconnected";
    connectionDetail = "Disconnected; retrying in 2 seconds";
    scheduleReconnect();
  });

  socket.addEventListener("error", () => {
    connectionState = "error";
    connectionDetail = "Could not connect. Is `npm run dev` still running, and is the room code, port, or URL current?";
  });
}

function disconnectByUser() {
  autoConnectEnabled = false;
  chrome.storage.local.set({ roomInput, roomUrl, autoConnectEnabled });
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = undefined;
  }
  if (clockTimer) {
    clearInterval(clockTimer);
    clockTimer = undefined;
  }
  if (tabStatusTimer) {
    clearTimeout(tabStatusTimer);
    tabStatusTimer = undefined;
  }
  lastDeliveredStatusSignature = "";
  connectionState = "disconnected-by-user";
  connectionDetail = "Disconnected. The extension will stay offline until you press Connect.";
  const closingSocket = socket;
  socket = undefined;
  closingSocket?.close();
}

function scheduleReconnect() {
  if (!autoConnectEnabled) {
    return;
  }
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
  }
  reconnectTimer = setTimeout(() => {
    reconnectTimer = undefined;
    if (autoConnectEnabled) {
      connect();
    }
  }, 2000);
}

async function sendTransportToSongsterr(action, sequenceId, currentSong, resetBeforePlay = false) {
  const tabs = await ensureSongsterrTabs(currentSong);
  if (!tabs.length) {
    reportCommandStatus({
      action,
      sequenceId,
      status: "failed",
      ready: false,
      detail: "No Songsterr tab was available when the command ran",
      at: Date.now()
    });
    return;
  }

  const results = [];
  for (const tab of tabs) {
    if (tab.id) {
      const result = await chrome.tabs
        .sendMessage(tab.id, { type: "bandcueTransport", action, resetBeforePlay })
        .catch((error) => ({
          ok: false,
          detail: error?.message || "Songsterr content script did not respond",
          controlPath: "content-script"
        }));
      results.push(result);
    }
  }

  const success = results.find((result) => result?.ok);
  const failure = results.find((result) => result && !result.ok);
  const final = success || failure || {
    ok: false,
    detail: "No controllable Songsterr tab responded",
    controlPath: "content-script"
  };

  reportCommandStatus({
    action,
    sequenceId,
    status: final.ok ? "succeeded" : "failed",
    ready: lastStatus.ready || tabs.length > 0,
    detail: final.detail,
    controlPath: final.controlPath,
    at: Date.now()
  });
}

async function openSongsterrFromRoom(currentSong, sequenceId) {
  if (!normalizeSongsterrUrl(songsterrReference(currentSong))) {
    reportCommandStatus({
      action: "open-song",
      sequenceId,
      status: "failed",
      ready: false,
      detail: "Current song does not have a usable Songsterr URL",
      controlPath: "browser-tab",
      at: Date.now()
    });
    return;
  }

  if (suppressAutoOpen) {
    reportCommandStatus({
      action: "open-song",
      sequenceId,
      status: "failed",
      ready: lastStatus.ready,
      detail: "Auto-open is off on this machine (MuseScore host); not opening Songsterr",
      controlPath: "browser-tab",
      at: Date.now()
    });
    return;
  }

  reportCommandStatus({
    action: "open-song",
    sequenceId,
    status: "pending",
    ready: lastStatus.ready,
    detail: "Opening current Songsterr song",
    controlPath: "browser-tab",
    at: Date.now()
  });

  const tabs = await ensureSongsterrTabs(currentSong, { active: true });
  const tab = tabs[0];
  if (!tab) {
    reportCommandStatus({
      action: "open-song",
      sequenceId,
      status: "failed",
      ready: false,
      detail: "Current song does not have a usable Songsterr URL",
      controlPath: "browser-tab",
      at: Date.now()
    });
    return;
  }

  reportCommandStatus({
    action: "open-song",
    sequenceId,
    status: "succeeded",
    ready: true,
    detail: currentSong?.title
      ? `Opened Songsterr tab for ${currentSong.title}`
      : "Opened current Songsterr tab",
    controlPath: "browser-tab",
    at: Date.now()
  });
  requestSongsterrStatusFromTabs([tab]);
}

async function reportActiveTabStatus() {
  if (tabStatusInFlight) {
    tabStatusPending = true;
    return;
  }

  tabStatusInFlight = true;
  try {
    const tabs = await findSongsterrTabs();
    const tab = tabs[0];

    requestSongsterrStatusFromTabs(tabs);
    const tabIdentity = getSongsterrTabIdentity(tab);
    const hasFreshContentScriptStatus = Date.now() - lastContentScriptStatusAt < CONTENT_SCRIPT_STATUS_TTL_MS;
    const ready = Boolean(tab) || hasFreshContentScriptStatus;
    publishAdapterStatus({
      ready,
      app: "songsterr",
      title: tab ? selectStableTitle(tab.title, tabIdentity) : lastStatus.title,
      source: tab?.url || lastStatus.source,
      durationMs: hasFreshContentScriptStatus ? lastStatus.durationMs : undefined,
      durationSource: hasFreshContentScriptStatus ? lastStatus.durationSource : undefined,
      state: ready ? normalizeReadyState(lastStatus.state) : "not-ready",
      detail: ready
        ? getStableReadyDetail()
        : "No Songsterr tab detected. Open a Songsterr song tab.",
      lastCommand: latestCommand
    });
  } finally {
    tabStatusInFlight = false;
    if (tabStatusPending) {
      tabStatusPending = false;
      scheduleActiveTabStatusReport();
    }
  }
}

function reportCommandStatus(command) {
  const state = command.status === "pending"
    ? "command-pending"
    : command.status === "succeeded"
      ? "last-command-succeeded"
      : "last-command-failed";

  latestCommand = {
    action: command.action,
    sequenceId: command.sequenceId,
    status: command.status,
    at: command.at,
    detail: command.detail,
    controlPath: command.controlPath
  };
  publishAdapterStatus({
    ...lastStatus,
    ready: command.ready,
    state,
    detail: command.detail,
    lastCommand: latestCommand
  });
}

function publishAdapterStatus(status) {
  lastStatus = normalizeAdapterStatus(status);
  const signature = getAdapterStatusSignature(lastStatus);
  if (signature === lastDeliveredStatusSignature) {
    return;
  }

  if (!send({
    type: "adapterStatus",
    ...lastStatus
  })) {
    return;
  }

  lastDeliveredStatusSignature = signature;
}

function normalizeAdapterStatus(status) {
  return {
    ready: Boolean(status.ready),
    app: "songsterr",
    title: status.title,
    source: status.source,
    durationMs: sanitizeDurationMs(status.durationMs),
    durationSource: sanitizeDurationMs(status.durationMs) ? "adapter" : undefined,
    state: status.state ?? (status.ready ? "ready" : "not-ready"),
    detail: status.detail,
    lastCommand: status.lastCommand
  };
}

function getAdapterStatusSignature(status) {
  return JSON.stringify({
    ready: status.ready,
    title: status.title || "",
    source: status.source || "",
    durationMs: status.durationMs || 0,
    durationSource: status.durationSource || "",
    state: status.state || "",
    detail: status.detail || "",
    lastCommand: status.lastCommand || null
  });
}

function sanitizeDurationMs(value) {
  if (!Number.isFinite(value)) {
    return undefined;
  }

  const rounded = Math.round(value);
  return rounded > 0 && rounded <= 24 * 60 * 60 * 1000 ? rounded : undefined;
}

function scheduleActiveTabStatusReport(delayMs = TAB_STATUS_DEBOUNCE_MS) {
  if (tabStatusTimer) {
    clearTimeout(tabStatusTimer);
  }

  tabStatusTimer = setTimeout(() => {
    tabStatusTimer = undefined;
    reportActiveTabStatus();
  }, delayMs);
}

function isRelevantSongsterrTabUpdate(changeInfo, tab) {
  const nextUrl = changeInfo.url || tab?.url || "";
  if (nextUrl && isSongsterrUrl(nextUrl)) {
    return true;
  }

  if (!isSongsterrUrl(tab?.url || "")) {
    return false;
  }

  return Boolean(changeInfo.status || changeInfo.title);
}

function selectStableTitle(nextTitle, tabIdentity) {
  if (!tabIdentity) {
    lastSongsterrTabIdentity = "";
    return undefined;
  }

  if (tabIdentity === lastSongsterrTabIdentity && lastStatus.title) {
    return lastStatus.title;
  }

  lastSongsterrTabIdentity = tabIdentity;
  return nextTitle || lastStatus.title;
}

function getStableReadyDetail() {
  return lastStatus.ready && lastStatus.detail
    ? lastStatus.detail
    : "Songsterr tab detected";
}

function normalizeReadyState(state) {
  return state && state !== "not-ready" ? state : "ready";
}

function getSongsterrTabIdentity(tab) {
  if (!tab?.id || !tab.url || !isSongsterrUrl(tab.url)) {
    return "";
  }

  try {
    const url = new URL(tab.url);
    return `${tab.id}:${normalizePath(url.pathname)}`;
  } catch {
    return "";
  }
}

async function ensureSongsterrTabs(currentSong, options = {}) {
  const url = normalizeSongsterrUrl(songsterrReference(currentSong));
  if (songsterrReference(currentSong)) {
    if (!url) {
      return [];
    }

    const existing = await findSongsterrTabsForUrl(url);
    if (existing.length) {
      return options.active ? [await activateSongsterrTab(existing[0]), ...existing.slice(1)] : existing;
    }

    if (suppressAutoOpen) {
      return [];
    }

    const tab = await chrome.tabs.create({ url, active: Boolean(options.active) });
    const loaded = tab.id ? await waitForTabReady(tab.id, 7000) : undefined;
    return loaded ? [loaded] : tab.id ? [tab] : [];
  }

  const existing = await findSongsterrTabs();
  if (options.active && existing[0]) {
    return [await activateSongsterrTab(existing[0]), ...existing.slice(1)];
  }

  return existing;
}

async function activateSongsterrTab(tab) {
  if (!tab?.id) {
    return tab;
  }

  const updated = await chrome.tabs.update(tab.id, { active: true }).catch(() => tab);
  if (tab.windowId) {
    await chrome.windows.update(tab.windowId, { focused: true }).catch(() => undefined);
  }

  return updated || tab;
}

async function findSongsterrTabsForUrl(targetUrl) {
  const target = new URL(targetUrl);
  const tabs = (await chrome.tabs.query({}))
    .filter((tab) => isSongsterrUrl(tab.url || ""));
  return tabs.filter((tab) => {
    if (!tab.url) return false;
    try {
      const url = new URL(tab.url);
      return normalizePath(url.pathname) === normalizePath(target.pathname);
    } catch {
      return false;
    }
  });
}

async function requestSongsterrStatusFromTabs(tabs) {
  let songsterrTabs = tabs;
  if (!songsterrTabs) {
    try {
      songsterrTabs = await findSongsterrTabs();
    } catch {
      return;
    }
  }

  for (const tab of songsterrTabs) {
    if (!tab.id) {
      continue;
    }

    chrome.tabs
      .sendMessage(tab.id, { type: "bandcueReportStatus" })
      .catch(() => undefined);
  }
}

async function findSongsterrTabs(currentSong) {
  const targetUrl = normalizeSongsterrUrl(songsterrReference(currentSong));
  const tabs = (await chrome.tabs.query({}))
    .filter((tab) => isSongsterrUrl(tab.url || ""));
  if (!targetUrl) {
    return tabs;
  }

  const target = new URL(targetUrl);
  const matching = tabs.filter((tab) => {
    if (!tab.url) return false;
    try {
      const url = new URL(tab.url);
      return normalizePath(url.pathname) === normalizePath(target.pathname);
    } catch {
      return false;
    }
  });

  return matching.length ? matching : tabs;
}

// Resolve the Songsterr URL for a song, mirroring src/shared/song-sources.ts:
// the dedicated songsterrUrl field wins, otherwise the primary source is used
// when sourceType is "songsterr". Lets a single setlist entry target both
// Songsterr and MuseScore at once.
function songsterrReference(song) {
  const dedicated = song?.songsterrUrl?.trim();
  if (dedicated) {
    return dedicated;
  }
  return song?.sourceType === "songsterr" ? (song.source?.trim() ?? "") : "";
}

function normalizeSongsterrUrl(value) {
  if (!value) {
    return "";
  }

  try {
    const url = new URL(value);
    if (!/songsterr\.com$/i.test(url.hostname) && !/\.songsterr\.com$/i.test(url.hostname)) {
      return "";
    }

    url.protocol = "https:";
    return url.toString();
  } catch {
    return "";
  }
}

function isSongsterrUrl(value) {
  if (!value) {
    return false;
  }

  try {
    const url = new URL(value);
    return /songsterr\.com$/i.test(url.hostname) || /\.songsterr\.com$/i.test(url.hostname);
  } catch {
    return false;
  }
}

function normalizePath(pathname) {
  return pathname.replace(/\/+$/, "").toLowerCase();
}

function waitForTabReady(tabId, timeoutMs) {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      chrome.tabs.get(tabId).then(resolve).catch(() => resolve(undefined));
    }, timeoutMs);

    const listener = (updatedTabId, changeInfo, tab) => {
      if (updatedTabId !== tabId || changeInfo.status !== "complete") {
        return;
      }

      clearTimeout(timeout);
      chrome.tabs.onUpdated.removeListener(listener);
      setTimeout(() => resolve(tab), 500);
    };

    chrome.tabs.onUpdated.addListener(listener);
  });
}

function send(message) {
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(message));
    return true;
  }

  return false;
}

function toWsUrl(value) {
  const url = new URL(value);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/ws";
  return url.toString();
}

async function resolveRoomEndpoint(input) {
  const locator = normalizeRoomLocator(input);
  if (isAbsoluteRoomUrl(locator)) {
    return {
      roomUrl: locator,
      wsUrl: toWsUrl(locator)
    };
  }

  const candidates = buildRoomDiscoveryCandidates(locator);
  if (!candidates.length) {
    throw new Error(`Use a room URL, room code, port, or host:port.`);
  }

  const errors = [];
  for (const candidate of candidates) {
    const result = await tryResolveRoomCandidate(candidate, 1000);
    if (result.endpoint) {
      return result.endpoint;
    }
    errors.push(result.error);
  }

  if (isRoomCode(locator) || isPort(locator)) {
    const scanResult = await scanLanForRoom(locator);
    if (scanResult.endpoint) {
      return scanResult.endpoint;
    }

    errors.push(scanResult.error);
  }

  throw new Error(`No BandCue room found for "${locator}". ${errors.join("; ")}`);
}

async function tryResolveRoomCandidate(candidate, timeoutMs) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await fetch(candidate.apiUrl, { signal: controller.signal });
    } finally {
      clearTimeout(timeout);
    }
    if (!response.ok) {
      return { error: `${candidate.label} returned HTTP ${response.status}` };
    }

    const state = await response.json();
    const discoveredRoomUrl = roomUrlFromDiscovery(state, candidate);
    if (!discoveredRoomUrl) {
      return {
        error: candidate.expectedRoomCode
          ? `${candidate.label} did not match an active room`
          : `${candidate.label} did not return a usable room`
      };
    }

    return {
      endpoint: {
        roomUrl: discoveredRoomUrl,
        wsUrl: toWsUrl(discoveredRoomUrl)
      }
    };
  } catch (error) {
    return { error: `${candidate.label}: ${error.message}` };
  }
}

async function scanLanForRoom(roomCode) {
  const candidates = buildLanScanCandidates(roomCode);
  const expectedRoomCode = isRoomCode(roomCode) ? roomCode.toUpperCase() : undefined;
  const port = isPort(roomCode) ? Number.parseInt(roomCode, 10) : DEFAULT_ROOM_PORT;
  let checked = 0;
  for (let index = 0; index < candidates.length; index += LAN_SCAN_BATCH_SIZE) {
    const batch = candidates.slice(index, index + LAN_SCAN_BATCH_SIZE);
    checked += batch.length;
    connectionDetail = expectedRoomCode
      ? `Scanning local network for room ${expectedRoomCode} (${checked}/${candidates.length})`
      : `Scanning local network on port ${port} (${checked}/${candidates.length})`;
    const results = await Promise.all(
      batch.map((candidate) => tryResolveRoomCandidate(candidate, LAN_SCAN_TIMEOUT_MS))
    );
    const match = results.find((result) => result.endpoint);
    if (match?.endpoint) {
      return { endpoint: match.endpoint };
    }
  }

  return {
    error: expectedRoomCode
      ? `No room ${expectedRoomCode} found after scanning ${formatLanScanSubnets()} on port ${port}. ${manualDiscoveryFallback(port)}`
      : `No BandCue room found after scanning ${formatLanScanSubnets()} on port ${port}. ${manualDiscoveryFallback(port)}`
  };
}

function formatLanScanSubnets() {
  return LAN_SCAN_SUBNETS.map((subnet) => `${subnet}.1-254`).join(", ");
}

function manualDiscoveryFallback(port) {
  return `If discovery is blocked by Wi-Fi isolation, firewall, VPN, or a different subnet, enter the host:port shown on the host page, such as 192.168.1.12:${port}, or paste the full room URL.`;
}

function normalizeRoomLocator(value) {
  const trimmed = String(value || "").trim();
  return trimmed || String(DEFAULT_ROOM_PORT);
}

function isAbsoluteRoomUrl(value) {
  return /^https?:\/\//i.test(value.trim());
}

function buildRoomDiscoveryCandidates(locator) {
  if (isAbsoluteRoomUrl(locator)) {
    return [];
  }

  if (isPort(locator)) {
    return localCandidates(Number.parseInt(locator, 10));
  }

  if (isRoomCode(locator)) {
    return localCandidates(DEFAULT_ROOM_PORT, locator.toUpperCase());
  }

  const explicitHost = parseHostAndPort(locator, DEFAULT_ROOM_PORT);
  return explicitHost ? [discoveryCandidate(explicitHost.host, explicitHost.port)] : [];
}

function buildLanScanCandidates(roomCode) {
  const candidates = [];
  const expectedRoomCode = isRoomCode(roomCode) ? roomCode.toUpperCase() : undefined;
  const port = isPort(roomCode) ? Number.parseInt(roomCode, 10) : DEFAULT_ROOM_PORT;
  for (const subnet of LAN_SCAN_SUBNETS) {
    for (let host = 1; host <= 254; host += 1) {
      candidates.push(discoveryCandidate(`${subnet}.${host}`, port, expectedRoomCode));
    }
  }
  return candidates;
}

function roomUrlFromDiscovery(state, candidate) {
  if (state?.type !== "roomState" || typeof state.companionUrl !== "string") {
    return "";
  }

  if (
    candidate.expectedRoomCode &&
    state.roomCode?.toUpperCase() !== candidate.expectedRoomCode.toUpperCase()
  ) {
    return "";
  }

  try {
    const discoveredUrl = new URL(state.companionUrl);
    const token = discoveredUrl.searchParams.get("token");
    if (!token) {
      return "";
    }

    const url = new URL(candidate.baseUrl);
    url.pathname = "/";
    url.search = "";
    url.searchParams.set("token", token);
    return url.toString();
  } catch {
    return "";
  }
}

function localCandidates(port, expectedRoomCode) {
  return [
    discoveryCandidate("127.0.0.1", port, expectedRoomCode),
    discoveryCandidate("localhost", port, expectedRoomCode)
  ];
}

function discoveryCandidate(host, port, expectedRoomCode) {
  const baseUrl = `http://${host}:${port}`;
  return {
    apiUrl: `${baseUrl}/api/room`,
    baseUrl,
    expectedRoomCode,
    label: expectedRoomCode ? `${expectedRoomCode} on ${host}:${port}` : `${host}:${port}`
  };
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

function getPopupState() {
  return {
    connected: socket?.readyState === WebSocket.OPEN,
    connectionState,
    connectionDetail,
    roomInput,
    roomUrl,
    autoConnectEnabled,
    suppressAutoOpen,
    status: lastStatus
  };
}

function calculateClockSample(clientSentAt, clientReceivedAt, serverReceivedAt, serverSentAt) {
  const rttMs = clientReceivedAt - clientSentAt - (serverSentAt - serverReceivedAt);
  const offsetMs = (serverReceivedAt - clientSentAt + (serverSentAt - clientReceivedAt)) / 2;
  return { rttMs: Math.max(0, rttMs), offsetMs };
}

function summarizeClock(clockSamples) {
  const best = [...clockSamples].sort((a, b) => a.rttMs - b.rttMs).slice(0, 5);
  return {
    rttMs: median(best.map((sample) => sample.rttMs)),
    offsetMs: median(best.map((sample) => sample.offsetMs))
  };
}

function calculateJitterMs(clockSamples) {
  if (clockSamples.length < 2) return 0;
  const offsets = clockSamples.map((sample) => sample.offsetMs);
  const center = median(offsets);
  return median(offsets.map((offset) => Math.abs(offset - center)));
}

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function formatManualOffset(offsetMs) {
  if (!offsetMs) {
    return "";
  }

  return ` with ${offsetMs} ms manual offset`;
}
