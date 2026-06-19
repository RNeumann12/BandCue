let socket;
let roomUrl;
let wsUrl;
let serverOffsetMs = 0;
let samples = [];
let connectionState = "not configured";
let connectionDetail = "Paste the BandCue room URL and click Connect";
let clockTimer;
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

const TAB_STATUS_DEBOUNCE_MS = 750;
const CONTENT_SCRIPT_STATUS_TTL_MS = 15_000;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "popupConnect") {
    try {
      roomUrl = message.roomUrl;
      wsUrl = toWsUrl(roomUrl);
      chrome.storage.local.set({ roomUrl });
      connect();
      sendResponse(getPopupState());
    } catch (error) {
      connectionState = "error";
      connectionDetail = error.message;
      sendResponse(getPopupState());
    }
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
      state: message.ready ? "ready" : "not-ready",
      detail: message.detail,
      lastCommand: latestCommand
    });
    return false;
  }

  if (message.type === "popupState") {
    scheduleActiveTabStatusReport();
    sendResponse(getPopupState());
    return true;
  }

  return false;
});

chrome.storage.local.get(["roomUrl"], (stored) => {
  if (stored.roomUrl) {
    roomUrl = stored.roomUrl;
    wsUrl = toWsUrl(roomUrl);
    connect();
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

function connect() {
  if (!wsUrl) return;
  socket?.close();
  if (clockTimer) clearInterval(clockTimer);
  connectionState = "connecting";
  connectionDetail = `Connecting to ${wsUrl}`;
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
        sendTransportToSongsterr(message.action, message.sequenceId, message.currentSong?.song);
      }, delayMs);
    }
  });

  socket.addEventListener("close", () => {
    connectionState = "disconnected";
    connectionDetail = "Disconnected; retrying in 2 seconds";
    if (clockTimer) clearInterval(clockTimer);
    setTimeout(() => {
      if (wsUrl) connect();
    }, 2000);
  });

  socket.addEventListener("error", () => {
    connectionState = "error";
    connectionDetail = "Could not connect. Is `npm run dev` still running, and did you paste the current room URL?";
  });
}

async function sendTransportToSongsterr(action, sequenceId, currentSong) {
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
        .sendMessage(tab.id, { type: "bandcueTransport", action })
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
    state: status.state ?? (status.ready ? "ready" : "not-ready"),
    detail: status.detail,
    lastCommand: status.lastCommand
  };
}

function getAdapterStatusSignature(status) {
  return JSON.stringify({
    ready: status.ready,
    title: status.title || "",
    state: status.state || "",
    detail: status.detail || "",
    lastCommand: status.lastCommand || null
  });
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

async function ensureSongsterrTabs(currentSong) {
  const existing = await findSongsterrTabs(currentSong);
  if (existing.length || currentSong?.sourceType !== "songsterr" || !currentSong.source) {
    return existing;
  }

  const url = normalizeSongsterrUrl(currentSong.source);
  if (!url) {
    return existing;
  }

  const tab = await chrome.tabs.create({ url, active: false });
  const loaded = tab.id ? await waitForTabReady(tab.id, 7000) : undefined;
  return loaded ? [loaded] : tab.id ? [tab] : [];
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
  const targetUrl = normalizeSongsterrUrl(currentSong?.source);
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

function getPopupState() {
  return {
    connected: socket?.readyState === WebSocket.OPEN,
    connectionState,
    connectionDetail,
    roomUrl,
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
