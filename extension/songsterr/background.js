importScripts("room-permissions.js");

let socket;
let roomInput;
let roomUrl;
let wsUrl;
// undefined until the first clockSyncResult so blendOffset adopts the first
// fresh sample as-is; seeding with 0 would slew a real offset from zero and
// leave a residual timing error after the warm-up burst.
let serverOffsetMs;
let samples = [];
// Clock cadence/estimator constants. Mirror of src/shared/clock.ts.
const CLOCK_SAMPLE_WINDOW = 20;
const CLOCK_WARMUP_SAMPLES = 8;
const CLOCK_WARMUP_INTERVAL_MS = 250;
const CLOCK_STEADY_INTERVAL_MS = 1000;
const CLOCK_OFFSET_JUMP_MS = 250;
const CLOCK_OFFSET_SMOOTHING = 0.3;
let connectionState = "not configured";
let connectionDetail = "Enter the BandCue room code, port, or URL and click Connect";
let clockTimer;
let reconnectTimer;
let heartbeatTimer;
let lastServerContactAt = 0;
let reconnectAttempts = 0;
let lastStatus = {
  ready: false,
  app: "songsterr",
  detail: "No Songsterr tab detected"
};
let latestCommand;
// This adapter's id in the room (from serverHello); used to find our own
// manual calibration offset inside roomState during reconciliation.
let myClientId;
// Highest transport sequence this adapter has acted on. Lets roomState
// reconciliation catch commands that were broadcast while we were disconnected
// without re-running ones the push path already handled. Survives reconnects
// on purpose: a missed Stop must still be caught after the socket comes back.
let lastTransportSequenceId = 0;
let lastTransportAction;
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
// Hosts that have served a room before (e.g. one entered as a URL/host:port).
// Probed directly ahead of the LAN scan, since Chrome can't reliably brute-force
// the whole LAN but a direct hit on a known host connects instantly.
let knownHosts = [];
// Each member plays a fixed instrument. Songsterr encodes the instrument category
// in the song-URL slug ("-bass-tab" / "-drum-tab", else the lead guitar tab), so
// when a song is opened/advanced we rewrite the host's URL to this member's
// instrument and everyone lands on their own part. The choice is picked once in
// the popup ("guitar" | "bass" | "drum"), or left on "auto" to inherit whatever
// instrument the member's currently-open Songsterr tab is already on. The category
// is portable across songs (unlike Songsterr's per-song "t<n>" track suffix), so a
// single example URL from the host is enough to build the right URL for everyone.
// Persisted per-machine.
let memberInstrument = "auto";

// How far ahead of the scheduled downbeat a transport command is forwarded to
// the content script. Covers the tab query, the IPC hop, and Songsterr prep
// (synth source, reset-to-start); the content script waits out the remainder.
const DISPATCH_LEAD_MS = 400;
const TAB_STATUS_DEBOUNCE_MS = 750;
const CONTENT_SCRIPT_STATUS_TTL_MS = 15_000;
const DEFAULT_ROOM_PORT = 4173;
// The server replies to our 1 Hz clockSync, so no server contact for this long
// means a half-open socket (Wi-Fi drop / machine sleep) that never fired a close
// event. Force a reconnect instead of silently talking to a dead socket.
const HEARTBEAT_TIMEOUT_MS = 6000;
const HEARTBEAT_CHECK_INTERVAL_MS = 2000;
// Exponential backoff with jitter so a coordinator restart isn't hammered by
// every device reconnecting in lockstep (each retry also avoids a full LAN scan).
const RECONNECT_BASE_MS = 1000;
const RECONNECT_CAP_MS = 20_000;
// Re-run room discovery only every Nth automatic retry; in between we reuse the
// last resolved WebSocket URL so a downed server doesn't trigger a LAN scan
// storm in the MV3 service worker on every attempt.
const RESOLVE_EVERY_N_ATTEMPTS = 4;
// MV3 service workers are evicted after ~30s idle, which would drop a pending
// reconnect setTimeout. This periodic alarm wakes the worker to retry while
// disconnected. Chrome clamps alarm periods to a 1-minute minimum.
const RECONNECT_ALARM_NAME = "bandcue-reconnect";
const RECONNECT_ALARM_PERIOD_MINUTES = 1;
// Number of LAN probes in flight at once. High enough to cover a /24 quickly
// while staying under Chrome's ~256 total socket budget for the service worker.
const LAN_SCAN_CONCURRENCY = 150;
const LAN_SCAN_FAST_TIMEOUT_MS = 400;
// Weak rehearsal Wi-Fi can answer just after the fast LAN probe window. Keep the
// normal path snappy, then make a slower second pass over likely subnets.
const LAN_SCAN_WEAK_SIGNAL_TIMEOUT_MS = 900;
const LAN_SCAN_WEAK_SIGNAL_CONCURRENCY = 100;
const LAN_SCAN_WEAK_SIGNAL_SUBNET_LIMIT = 6;
const DIRECT_PROBE_TIMEOUT_MS = 1000;
const DIRECT_WEAK_SIGNAL_TIMEOUT_MS = 2500;
const ABSOLUTE_ROOM_PROBE_TIMEOUT_MS = 1500;
const ABSOLUTE_ROOM_WEAK_SIGNAL_TIMEOUT_MS = 3500;
// First-time mDNS resolution can take a beat longer than a direct host hit, so
// give the .local probes a bit more headroom than the 1000 ms direct probes.
const MDNS_PROBE_TIMEOUT_MS = 1500;
const MDNS_WEAK_SIGNAL_TIMEOUT_MS = 3000;
// Hostname stem the server advertises over mDNS. The OS resolver (Windows 10
// 1703+, macOS, Linux+Avahi) resolves "<stem>[-<roomcode>].local" to the
// server's IP, so a single fetch reaches the room on any subnet -- no LAN scan.
// Keep in sync with MDNS_HOST_STEM in src/shared/room-locator.ts.
const MDNS_HOST_STEM = "bandcue";
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

  if (message.type === "popupSetInstrument") {
    memberInstrument = normalizeInstrument(message.instrument);
    chrome.storage.local.set({ instrument: memberInstrument });
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

chrome.storage.local.get(["roomInput", "roomUrl", "suppressAutoOpen", "autoConnectEnabled", "knownHosts", "instrument"], (stored) => {
  suppressAutoOpen = Boolean(stored.suppressAutoOpen);
  autoConnectEnabled = Boolean(stored.autoConnectEnabled);
  knownHosts = Array.isArray(stored.knownHosts) ? stored.knownHosts : [];
  memberInstrument = normalizeInstrument(stored.instrument);
  // Seed from a previously successful room URL so a known host is probed first
  // even on the first connect after this feature shipped.
  if (!knownHosts.length && stored.roomUrl) {
    const seededHost = hostFromUrl(stored.roomUrl);
    if (isRememberableHost(seededHost)) {
      knownHosts = [seededHost];
    }
  }
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
  // A fresh user-initiated connect resets backoff so the first retry is quick.
  reconnectAttempts = 0;
  await refreshRoomEndpoint();
  autoConnectEnabled = true;
  chrome.storage.local.set({ roomInput, roomUrl, autoConnectEnabled });
  await connect();
}

async function refreshRoomEndpoint() {
  await assertRoomPermissions(roomInput);
  const endpoint = await resolveRoomEndpoint(roomInput);
  roomUrl = endpoint.roomUrl;
  wsUrl = endpoint.wsUrl;
}

async function assertRoomPermissions(input) {
  if (!chrome.permissions?.contains || !globalThis.BandCueRoomPermissions) {
    return;
  }

  const permission = globalThis.BandCueRoomPermissions.permissionsForLocator(input);
  if (!permission.origins.length) {
    throw new Error(permission.message);
  }

  const granted = await chrome.permissions.contains({ origins: permission.origins });
  if (!granted) {
    throw new Error(`${permission.message} Open the BandCue extension popup and press Connect to approve it.`);
  }
}

async function connect() {
  if (!autoConnectEnabled) {
    connectionState = "disconnected-by-user";
    connectionDetail = "Disconnected. Press Connect when you want this extension to join.";
    return;
  }

  // Reuse the last resolved endpoint on quick reconnects; only re-run discovery
  // periodically so a downed server can't trigger a LAN-scan storm every retry.
  const shouldResolve =
    !wsUrl || (reconnectAttempts > 0 && reconnectAttempts % RESOLVE_EVERY_N_ATTEMPTS === 0);
  if (roomInput && shouldResolve) {
    try {
      await refreshRoomEndpoint();
      chrome.storage.local.set({ roomInput, roomUrl, autoConnectEnabled });
    } catch (error) {
      if (wsUrl && reconnectAttempts > 0) {
        connectionDetail = `Discovery was slow (${error.message}); trying the last known room endpoint`;
      } else {
        connectionState = "error";
        connectionDetail = error.message;
        scheduleReconnect();
        return;
      }
    }
  }

  if (!wsUrl) return;
  const previousSocket = socket;
  socket = undefined;
  previousSocket?.close();
  if (clockTimer) clearInterval(clockTimer);
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = undefined;
  }
  connectionState = "connecting";
  connectionDetail = `Connecting to ${roomInput || roomUrl}`;
  try {
    socket = new WebSocket(wsUrl);
  } catch (error) {
    connectionState = "error";
    connectionDetail = `Could not open BandCue WebSocket: ${error.message}`;
    scheduleReconnect();
    return;
  }

  socket.addEventListener("open", () => {
    connectionState = "connected";
    connectionDetail = "Connected to BandCue coordinator";
    lastDeliveredStatusSignature = "";
    reconnectAttempts = 0;
    lastServerContactAt = Date.now();
    // Start each connection from a clean clock estimate. Stale pre-disconnect
    // samples are dangerous after a sleep/resume, where the machine clock may
    // have just stepped; the warm-up burst rebuilds the offset from scratch.
    samples = [];
    serverOffsetMs = undefined;
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    heartbeatTimer = setInterval(() => {
      if (Date.now() - lastServerContactAt > HEARTBEAT_TIMEOUT_MS) {
        // Closing a half-open socket fires the close handler, which reconnects.
        socket?.close();
      }
    }, HEARTBEAT_CHECK_INTERVAL_MS);
    send({
      type: "clientHello",
      deviceName: "Songsterr tab",
      role: "desktop-adapter",
      capabilities: [{ app: "songsterr", canPlay: true, canStop: true }]
    });

    // Warm up with a quick burst so the offset converges within ~2s, then settle
    // into the steady cadence (avoids playing on a cold, seconds-off estimate).
    const sendClockSync = () => send({ type: "clockSync", clientSentAt: Date.now() });
    let warmupRemaining = CLOCK_WARMUP_SAMPLES;
    sendClockSync();
    clockTimer = setInterval(() => {
      sendClockSync();
      warmupRemaining -= 1;
      if (warmupRemaining <= 0) {
        clearInterval(clockTimer);
        clockTimer = setInterval(sendClockSync, CLOCK_STEADY_INTERVAL_MS);
      }
    }, CLOCK_WARMUP_INTERVAL_MS);
    scheduleActiveTabStatusReport(0);
    requestSongsterrStatusFromTabs();
  });

  socket.addEventListener("message", (event) => {
    lastServerContactAt = Date.now();
    const message = JSON.parse(event.data);

    if (message.type === "clockSyncResult") {
      const sample = calculateClockSample(
        message.clientSentAt,
        Date.now(),
        message.serverReceivedAt,
        message.serverSentAt
      );
      samples.push(sample);
      samples = samples.slice(-CLOCK_SAMPLE_WINDOW);
      const summary = summarizeClock(samples);
      serverOffsetMs = blendOffset(serverOffsetMs, summary.offsetMs);
      send({
        type: "clockStatus",
        rttMs: summary.rttMs,
        offsetMs: serverOffsetMs,
        jitterMs: calculateJitterMs(samples),
        sampleCount: samples.length
      });
      return;
    }

    if (message.type === "serverHello") {
      myClientId = message.clientId;
      return;
    }

    if (message.type === "transportCommand") {
      handleTransportCommand(message);
      return;
    }

    if (message.type === "roomState") {
      reconcileTransportFromRoomState(message);
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
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = undefined;
    }
    if (!autoConnectEnabled) {
      connectionState = "disconnected-by-user";
      connectionDetail = "Disconnected. Press Connect when you want this extension to join.";
      return;
    }
    connectionState = "disconnected";
    connectionDetail = "Disconnected; reconnecting shortly";
    scheduleReconnect();
  });

  socket.addEventListener("error", () => {
    connectionState = "error";
    connectionDetail = "Could not connect. Is `npm run dev` still running, and is the room code, port, or URL current?";
  });
}

function disconnectByUser() {
  autoConnectEnabled = false;
  reconnectAttempts = 0;
  chrome.storage.local.set({ roomInput, roomUrl, autoConnectEnabled });
  clearReconnectAlarm();
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = undefined;
  }
  if (clockTimer) {
    clearInterval(clockTimer);
    clockTimer = undefined;
  }
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = undefined;
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
  ensureReconnectAlarm();
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
  }
  reconnectAttempts += 1;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = undefined;
    if (autoConnectEnabled) {
      connect();
    }
  }, reconnectDelayMs(reconnectAttempts));
}

function reconnectDelayMs(attempt) {
  const exponential = Math.min(RECONNECT_CAP_MS, RECONNECT_BASE_MS * 2 ** Math.min(attempt, 6));
  const jitter = exponential * 0.2 * (Math.random() * 2 - 1);
  return Math.max(500, Math.round(exponential + jitter));
}

// A periodic alarm survives service-worker eviction; the short setTimeout above
// handles fast reconnects while the worker is alive, and the alarm is the
// backstop that revives the worker to retry after it has been suspended.
function ensureReconnectAlarm() {
  chrome.alarms?.create(RECONNECT_ALARM_NAME, {
    periodInMinutes: RECONNECT_ALARM_PERIOD_MINUTES
  });
}

function clearReconnectAlarm() {
  chrome.alarms?.clear(RECONNECT_ALARM_NAME);
}

chrome.alarms?.onAlarm.addListener((alarm) => {
  if (alarm.name !== RECONNECT_ALARM_NAME) {
    return;
  }
  if (!autoConnectEnabled) {
    clearReconnectAlarm();
    return;
  }
  if (socket?.readyState === WebSocket.OPEN || socket?.readyState === WebSocket.CONNECTING) {
    return;
  }
  connect();
});

function handleTransportCommand(message) {
  lastTransportSequenceId = message.sequenceId;
  lastTransportAction = message.action;
  const manualOffsetMs = message.manualOffsetMs || 0;
  // The room-time downbeat converted to this machine's clock. The content
  // script does the final wait against this instant.
  const dueLocalAt = message.scheduledServerTime + manualOffsetMs - (serverOffsetMs ?? 0);
  const delayMs = Math.max(0, dueLocalAt - Date.now());
  reportCommandStatus({
    action: message.action,
    sequenceId: message.sequenceId,
    status: "pending",
    ready: lastStatus.ready,
    detail: `Songsterr ${message.action} command scheduled${formatManualOffset(manualOffsetMs)}`,
    at: Date.now()
  });
  // Get the tab onto the right song when the count-in *starts*, not when it
  // reaches zero. Loading/navigating a tab takes longer than the count-in, so
  // doing it at play time would reload the page on the downbeat and throw the
  // band out of sync. This is the only place that navigates; the downbeat
  // (sendTransportToSongsterr) only locates the already-loaded tab.
  if (message.action === "play") {
    ensureSongsterrTabs(message.currentSong?.song).catch(() => undefined);
  }
  // Dispatch to the content script *ahead* of the downbeat: the tab query,
  // IPC hop, and Songsterr prep all happen during the count-in, and the
  // content script burns the remaining time so the control action itself
  // lands on the beat. (Waiting the full delay here made every browser
  // device start late by the tab-query + messaging + prep latency.)
  setTimeout(() => {
    sendTransportToSongsterr(
      message.action,
      message.sequenceId,
      message.currentSong?.song,
      Boolean(message.resetBeforePlay),
      dueLocalAt
    );
  }, Math.max(0, delayMs - DISPATCH_LEAD_MS));
}

// Minimum lead time left on a reconciled play for it to still start together;
// with less than this there is no room for the tab/IPC/prep pipeline, and
// starting late would be worse than not starting.
const MIN_RECONCILE_LEAD_MS = 250;

// Adapters normally act on pushed transportCommand messages. A device that was
// disconnected (Wi-Fi blip, coordinator restart) while one was broadcast never
// sees it -- but every roomState carries the authoritative transport state, so
// catch up from there where it is safe to do so.
function reconcileTransportFromRoomState(state) {
  const transport = state?.transport;
  if (!transport || typeof transport.sequenceId !== "number") {
    return;
  }

  // A lower sequence than we've handled means a fresh room (coordinator was
  // restarted and its counter reset); adopt its numbering rather than treating
  // everything as already-seen.
  if (transport.sequenceId < lastTransportSequenceId) {
    lastTransportSequenceId = transport.sequenceId;
    lastTransportAction = undefined;
    return;
  }
  if (transport.sequenceId === lastTransportSequenceId) {
    return;
  }

  if (
    transport.status === "scheduled" &&
    transport.action === "play" &&
    transport.scheduledServerTime
  ) {
    const manualOffsetMs = manualOffsetForSelf(state);
    const dueLocalAt = transport.scheduledServerTime + manualOffsetMs - (serverOffsetMs ?? 0);
    if (dueLocalAt - Date.now() >= MIN_RECONCILE_LEAD_MS) {
      handleTransportCommand({
        action: "play",
        sequenceId: transport.sequenceId,
        scheduledServerTime: transport.scheduledServerTime,
        manualOffsetMs,
        resetBeforePlay: true,
        currentSong: state.currentSong
      });
    } else {
      // Too late to start together; skip rather than joining off-beat.
      lastTransportSequenceId = transport.sequenceId;
    }
    return;
  }

  // Only reconcile stops that were actually commanded (manual Stop or the
  // leader vanishing). The coordinator's automatic stops (song duration
  // elapsed, all playback ended) deliberately never broadcast a Stop command
  // because the players have already stopped on their own.
  const commandedStop =
    transport.stopReason === "manual" || transport.stopReason === "leader-disconnect";
  if (transport.status === "stopped" && commandedStop && lastTransportAction === "play") {
    // We missed the Stop while disconnected. Running it now is safe: the
    // content script treats Stop on already-stopped playback as a no-op.
    handleTransportCommand({
      action: "stop",
      sequenceId: transport.sequenceId,
      scheduledServerTime: transport.scheduledServerTime || Date.now() + (serverOffsetMs ?? 0),
      manualOffsetMs: 0,
      resetBeforePlay: false,
      currentSong: state.currentSong
    });
    return;
  }

  // Running mid-song (we cannot join cleanly) or stopped without a play of
  // ours to undo: adopt the sequence so future reconciliation stays quiet.
  lastTransportSequenceId = transport.sequenceId;
}

function manualOffsetForSelf(state) {
  if (!myClientId || !Array.isArray(state?.clients)) {
    return 0;
  }
  const self = state.clients.find((client) => client?.id === myClientId);
  return self?.clock?.manualOffsetMs || 0;
}

async function sendTransportToSongsterr(action, sequenceId, currentSong, resetBeforePlay = false, dueLocalAt = 0) {
  // This runs DISPATCH_LEAD_MS ahead of the downbeat; the content script waits
  // out the remainder against dueLocalAt and fires the control on the beat.
  // We only *locate* an existing Songsterr tab here -- we never navigate or
  // create one. The eager pre-open at count-in start (ensureSongsterrTabs) is
  // responsible for getting the right song loaded. Navigating at play time
  // reloads the page on the downbeat (Songsterr's SPA rewrites the path with a
  // track suffix, so an exact-URL match can miss even when the tab is already
  // on the song) and throws the band out of sync.
  let tabs = await findSongsterrTabs(currentSong);
  if (!tabs.length && dueLocalAt) {
    // A tab opened at count-in start may still be loading at lead time; give it
    // until the downbeat itself before declaring failure.
    const remainingMs = dueLocalAt - Date.now();
    if (remainingMs > 50) {
      await new Promise((resolve) => setTimeout(resolve, remainingMs));
      tabs = await findSongsterrTabs(currentSong);
    }
  }
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

  // Dispatch to every tab in parallel: each content script blocks until the
  // downbeat before responding, so awaiting tabs one at a time would delay
  // every tab after the first past the scheduled start.
  const results = await Promise.all(
    tabs
      .filter((tab) => tab.id)
      .map((tab) =>
        chrome.tabs
          .sendMessage(tab.id, { type: "bandcueTransport", action, resetBeforePlay, dueLocalAt })
          .catch((error) => ({
            ok: false,
            detail: error?.message || "Songsterr content script did not respond",
            controlPath: "content-script"
          }))
      )
  );

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
    firedAtServerTime: final.ok && Number.isFinite(final.firedAtLocal)
      ? Math.round(final.firedAtLocal + (serverOffsetMs ?? 0))
      : undefined,
    at: Date.now()
  });
}

async function openSongsterrFromRoom(currentSong, sequenceId) {
  if (!songsterrReferences(currentSong).some((reference) => normalizeSongsterrUrl(reference))) {
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
    controlPath: command.controlPath,
    firedAtServerTime: command.firedAtServerTime
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

  return `${tab.id}:${songKey(tab.url)}`;
}

async function ensureSongsterrTabs(currentSong, options = {}) {
  const references = songsterrReferences(currentSong);
  const urls = references.map(normalizeSongsterrUrl).filter(Boolean);
  if (references.length) {
    if (!urls.length) {
      return [];
    }

    const existing = await findSongsterrTabsForUrls(urls);
    if (existing.length) {
      return options.active ? [await activateSongsterrTab(existing[0]), ...existing.slice(1)] : existing;
    }

    if (suppressAutoOpen) {
      return [];
    }

    // No tab is on this song yet, so we're about to open/navigate fresh. Prefer
    // reusing an already-open Songsterr tab by navigating it to the new song --
    // spawning a fresh tab is slow and resets the clock/status handshake, throwing
    // the room out of sync. Only fall back to opening a new tab when no Songsterr
    // tab exists yet.
    const reusable = (await findSongsterrTabs())[0];

    // Rewrite the host's URL to this member's instrument so they land on their own
    // part rather than the host's. On "auto" the instrument is read from the tab
    // we're about to reuse. Tabs already on the song are handled above and left
    // untouched.
    const targetUrl = normalizeSongsterrUrl(resolveMemberInstrumentUrl(currentSong, reusable));
    if (!targetUrl) {
      return [];
    }

    if (reusable?.id) {
      const navigated = await navigateSongsterrTab(reusable, targetUrl, Boolean(options.active));
      const loaded = navigated.id ? await waitForTabReady(navigated.id, 7000) : undefined;
      return [loaded || navigated];
    }

    const tab = await chrome.tabs.create({ url: targetUrl, active: Boolean(options.active) });
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

// Point an existing Songsterr tab at a new song instead of opening a new tab,
// optionally bringing it to the foreground.
async function navigateSongsterrTab(tab, url, active) {
  const updated = await chrome.tabs.update(tab.id, { url, active }).catch(() => tab);
  if (active && tab.windowId) {
    await chrome.windows.update(tab.windowId, { focused: true }).catch(() => undefined);
  }

  return updated || tab;
}

async function findSongsterrTabsForUrl(targetUrl) {
  return findSongsterrTabsForUrls([targetUrl]);
}

async function findSongsterrTabsForUrls(targetUrls) {
  const targetKeys = new Set(targetUrls.map(songKey).filter(Boolean));
  const tabs = (await chrome.tabs.query({}))
    .filter((tab) => isSongsterrUrl(tab.url || ""));
  return tabs.filter((tab) => tab.url && targetKeys.has(songKey(tab.url)));
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
  const targetUrls = songsterrReferences(currentSong).map(normalizeSongsterrUrl).filter(Boolean);
  const tabs = (await chrome.tabs.query({}))
    .filter((tab) => isSongsterrUrl(tab.url || ""));
  if (!targetUrls.length) {
    return tabs;
  }

  const targetKeys = new Set(targetUrls.map(songKey).filter(Boolean));
  const matching = tabs.filter((tab) => tab.url && targetKeys.has(songKey(tab.url)));

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

function songsterrReferences(song) {
  const references = [
    songsterrReference(song),
    song?.songsterrBassUrl?.trim() ?? "",
    song?.songsterrDrumUrl?.trim() ?? ""
  ].filter(Boolean);
  return [...new Set(references)];
}

function explicitSongsterrInstrumentReference(song, instrument) {
  if (instrument === "bass") {
    return song?.songsterrBassUrl?.trim() ?? "";
  }
  if (instrument === "drum") {
    return song?.songsterrDrumUrl?.trim() ?? "";
  }
  return "";
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

// Track-agnostic identity for a Songsterr song. Songsterr encodes the selected
// instrument in the URL -- a "bass"/"drum" word in the slug right before "-tab",
// and/or a "t<n>" suffix on the "-s<id>" song segment (plus the legacy "?track="
// query). Two URLs for the same song on different instruments must compare equal
// so a member already on the song is never reloaded onto someone else's
// instrument. Returns "" for non-Songsterr/invalid.
function songKey(value) {
  try {
    const url = value instanceof URL ? value : new URL(value);
    // Collapse the instrument slug ("-bass-tab"/"-drum-tab" -> "-tab") and strip
    // the per-track "t<n>" suffix so every instrument of one song shares a key.
    // The track query is ignored implicitly since we key on the path alone.
    const path = normalizePath(url.pathname)
      .replace(/-(?:bass|drum)-tab(-s\d+)/i, "-tab$1")
      .replace(/(-s\d+)t\d+/i, "$1");
    return path;
  } catch {
    return "";
  }
}

// The instrument category a Songsterr URL points at: "bass"/"drum" when the slug
// carries that word right before "-tab-s<id>", otherwise "guitar" (the lead tab).
// The category is portable across songs; the per-song "t<n>" track number is not.
// Returns undefined for a non-Songsterr/invalid URL.
function instrumentFromUrl(value) {
  try {
    const path = new URL(value).pathname;
    if (/-bass-tab-s\d/i.test(path)) {
      return "bass";
    }
    if (/-drum-tab-s\d/i.test(path)) {
      return "drum";
    }
    return "guitar";
  } catch {
    return undefined;
  }
}

// Rewrite a Songsterr URL to a given instrument category. First normalizes to the
// lead-guitar base -- drops any existing instrument slug and the "t<n>"/"?track="
// track tokens -- then inserts the "bass"/"drum" slug word before "-tab" for those
// categories. "guitar" yields the clean base. Falls back to the input on a URL
// that has no "-tab-s<id>" anchor to splice into (e.g. legacy slugs).
function applyInstrument(value, instrument) {
  try {
    const url = value instanceof URL ? value : new URL(value);
    let path = url.pathname
      .replace(/-(?:bass|drum)-tab(-s\d+)/i, "-tab$1")
      .replace(/(-s\d+)t\d+/i, "$1");
    url.searchParams.delete("track");
    if (instrument === "bass") {
      path = path.replace(/-tab(-s\d+)/i, "-bass-tab$1");
    } else if (instrument === "drum") {
      path = path.replace(/-tab(-s\d+)/i, "-drum-tab$1");
    }
    url.pathname = path;
    return url.toString();
  } catch {
    return typeof value === "string" ? value : "";
  }
}

// The URL to open/navigate to for this member. Explicit per-song bass/drum URLs
// win because some Songsterr arrangements are separate song pages. Otherwise we
// keep the old portable slug rewrite for songs whose parts share one song id.
function resolveMemberInstrumentUrl(song, currentTab) {
  const hostUrl = songsterrReference(song);

  if (memberInstrument !== "auto") {
    return explicitSongsterrInstrumentReference(song, memberInstrument) ||
      (hostUrl ? applyInstrument(hostUrl, memberInstrument) : "");
  }

  const detected =
    currentTab?.url && isSongsterrUrl(currentTab.url)
      ? instrumentFromUrl(currentTab.url)
      : undefined;
  return detected
    ? explicitSongsterrInstrumentReference(song, detected) || (hostUrl ? applyInstrument(hostUrl, detected) : "")
    : hostUrl;
}

// Coerce stored/incoming instrument values to a known category, defaulting to
// "auto" (inherit from the open tab) for anything unrecognized or absent.
function normalizeInstrument(value) {
  return value === "guitar" || value === "bass" || value === "drum" ? value : "auto";
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
    return resolveAbsoluteRoomEndpoint(locator);
  }

  const candidates = buildRoomDiscoveryCandidates(locator);
  if (!candidates.length) {
    throw new Error(`Use a room URL, room code, port, or host:port.`);
  }

  // Try previously-successful hosts first, then localhost, then the mDNS name
  // the server advertises, then (last) the LAN brute-force scan. The first pass
  // is fast; if it misses, a slower pass gives weak Wi-Fi a chance without
  // slowing down normal joins.
  const errors = [];
  const rememberedCandidates = uniqueCandidates(knownHostCandidates(locator));
  const directCandidates = uniqueCandidates([...rememberedCandidates, ...candidates]);
  const directResult = await resolveFromCandidates(directCandidates, DIRECT_PROBE_TIMEOUT_MS, errors);
  if (directResult) {
    return directResult;
  }

  const mdnsResult = await resolveFromCandidates(mdnsCandidates(locator), MDNS_PROBE_TIMEOUT_MS, errors);
  if (mdnsResult) {
    return mdnsResult;
  }

  if (rememberedCandidates.length) {
    const slowRememberedResult = await resolveFromCandidates(
      rememberedCandidates,
      DIRECT_WEAK_SIGNAL_TIMEOUT_MS,
      errors
    );
    if (slowRememberedResult) {
      return slowRememberedResult;
    }
  }

  if (isRoomCode(locator) || isPort(locator)) {
    const scanResult = await scanLanForRoom(locator);
    if (scanResult.endpoint) {
      rememberHost(hostFromUrl(scanResult.endpoint.roomUrl));
      return scanResult.endpoint;
    }

    errors.push(scanResult.error);
  }

  const slowDirectCandidates = rememberedCandidates.length
    ? withoutCandidates(directCandidates, rememberedCandidates)
    : directCandidates;
  const slowDirectResult = await resolveFromCandidates(
    slowDirectCandidates,
    DIRECT_WEAK_SIGNAL_TIMEOUT_MS,
    errors
  );
  if (slowDirectResult) {
    return slowDirectResult;
  }

  const slowMdnsResult = await resolveFromCandidates(
    mdnsCandidates(locator),
    MDNS_WEAK_SIGNAL_TIMEOUT_MS,
    errors
  );
  if (slowMdnsResult) {
    return slowMdnsResult;
  }

  if (isRoomCode(locator) || isPort(locator)) {
    connectionDetail = isRoomCode(locator)
      ? `Retrying weak-signal scan for room ${locator.toUpperCase()}`
      : `Retrying weak-signal scan on port ${locator}`;
    const slowScanResult = await scanLanForRoom(locator, {
      timeoutMs: LAN_SCAN_WEAK_SIGNAL_TIMEOUT_MS,
      concurrency: LAN_SCAN_WEAK_SIGNAL_CONCURRENCY,
      subnets: weakSignalScanSubnets(),
      statusPrefix: "Retrying weak-signal scan"
    });
    if (slowScanResult.endpoint) {
      rememberHost(hostFromUrl(slowScanResult.endpoint.roomUrl));
      return slowScanResult.endpoint;
    }

    errors.push(slowScanResult.error);
  }

  throw new Error(`No BandCue room found for "${locator}". ${errors.join("; ")}`);
}

async function resolveAbsoluteRoomEndpoint(locator) {
  const candidate = absoluteRoomDiscoveryCandidate(locator);
  const result = await tryResolveRoomCandidate(candidate, ABSOLUTE_ROOM_PROBE_TIMEOUT_MS);
  if (result.endpoint) {
    rememberHost(hostFromUrl(result.endpoint.roomUrl));
    return result.endpoint;
  }

  const slowResult = await tryResolveRoomCandidate(candidate, ABSOLUTE_ROOM_WEAK_SIGNAL_TIMEOUT_MS);
  if (slowResult.endpoint) {
    rememberHost(hostFromUrl(slowResult.endpoint.roomUrl));
    return slowResult.endpoint;
  }

  throw new Error(`The scanned URL is not an active BandCue room. ${result.error}; ${slowResult.error}`);
}

async function resolveFromCandidates(candidates, timeoutMs, errors) {
  for (const candidate of candidates) {
    const result = await tryResolveRoomCandidate(candidate, timeoutMs);
    if (result.endpoint) {
      rememberHost(hostFromUrl(result.endpoint.roomUrl));
      return result.endpoint;
    }
    errors.push(result.error);
  }
  return undefined;
}

function uniqueCandidates(candidates) {
  const seen = new Set();
  return candidates.filter((candidate) => {
    const key = candidate.apiUrl;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function withoutCandidates(candidates, excluded) {
  const excludedUrls = new Set(excluded.map((candidate) => candidate.apiUrl));
  return candidates.filter((candidate) => !excludedUrls.has(candidate.apiUrl));
}

// Direct candidates for hosts known to have served a room, for room-code/port
// locators (an explicit host locator is already its own direct candidate).
function knownHostCandidates(locator) {
  if (!isPort(locator) && !isRoomCode(locator)) {
    return [];
  }
  const port = isPort(locator) ? Number.parseInt(locator, 10) : DEFAULT_ROOM_PORT;
  const expectedRoomCode = isRoomCode(locator) ? locator.toUpperCase() : undefined;
  return knownRoomHosts().map((host) => discoveryCandidate(host, port, expectedRoomCode));
}

function knownRoomHosts() {
  const hosts = [];
  const currentRoomHost = hostFromUrl(roomUrl);
  for (const host of [currentRoomHost, ...knownHosts]) {
    if (isRememberableHost(host) && !hosts.includes(host)) {
      hosts.push(host);
    }
  }
  return hosts;
}

// mDNS hostnames the server advertises for a room, most-specific first. Keep in
// sync with mdnsRoomHosts in src/shared/room-locator.ts.
function mdnsRoomHosts(roomCode) {
  const hosts = [`${MDNS_HOST_STEM}.local`];
  if (isRoomCode(roomCode)) {
    hosts.unshift(`${MDNS_HOST_STEM}-${roomCode.toLowerCase()}.local`);
  }
  return hosts;
}

// Discovery candidates resolved via the OS mDNS resolver, for room-code/port
// locators (an explicit host/URL locator already names its own host).
function mdnsCandidates(locator) {
  if (!isPort(locator) && !isRoomCode(locator)) {
    return [];
  }
  const port = isPort(locator) ? Number.parseInt(locator, 10) : DEFAULT_ROOM_PORT;
  const expectedRoomCode = isRoomCode(locator) ? locator.toUpperCase() : undefined;
  return mdnsRoomHosts(locator).map((host) => discoveryCandidate(host, port, expectedRoomCode));
}

function rememberHost(host) {
  if (!isRememberableHost(host)) {
    return;
  }
  knownHosts = [host, ...knownHosts.filter((existing) => existing !== host)].slice(0, 8);
  chrome.storage.local.set({ knownHosts });
}

function isRememberableHost(host) {
  return Boolean(host) && host !== "localhost" && host !== "127.0.0.1";
}

function hostFromUrl(value) {
  try {
    return new URL(value).hostname;
  } catch {
    return undefined;
  }
}

function subnetPrefix(host) {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.\d{1,3}$/.exec(host || "");
  return match ? `${match[1]}.${match[2]}.${match[3]}` : undefined;
}

// LAN scan subnet order with the subnets of known hosts first.
function scanSubnetsWithKnownFirst() {
  const ordered = [];
  for (const host of knownRoomHosts()) {
    const prefix = subnetPrefix(host);
    if (prefix && !ordered.includes(prefix)) {
      ordered.push(prefix);
    }
  }
  for (const subnet of LAN_SCAN_SUBNETS) {
    if (!ordered.includes(subnet)) {
      ordered.push(subnet);
    }
  }
  return ordered;
}

function weakSignalScanSubnets() {
  return scanSubnetsWithKnownFirst().slice(0, LAN_SCAN_WEAK_SIGNAL_SUBNET_LIMIT);
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

// Scans the candidate hosts with a fixed pool of concurrent probes and resolves
// the moment any host answers as the room, instead of waiting for whole batches
// of dead hosts to time out. A sequential batch scan made the service worker
// spend several seconds (and sometimes get killed) before reaching the room's
// subnet; first-success-wins returns as soon as the real server responds.
async function scanLanForRoom(roomCode, options = {}) {
  const timeoutMs = options.timeoutMs ?? LAN_SCAN_FAST_TIMEOUT_MS;
  const subnets = options.subnets ?? scanSubnetsWithKnownFirst();
  const statusPrefix = options.statusPrefix ?? "Scanning local network";
  const candidates = buildLanScanCandidates(roomCode, subnets);
  const expectedRoomCode = isRoomCode(roomCode) ? roomCode.toUpperCase() : undefined;
  const port = isPort(roomCode) ? Number.parseInt(roomCode, 10) : DEFAULT_ROOM_PORT;
  const total = candidates.length;
  const concurrency = Math.min(options.concurrency ?? LAN_SCAN_CONCURRENCY, total);

  return new Promise((resolve) => {
    let next = 0;
    let active = 0;
    let checked = 0;
    let settled = false;

    const finish = (value) => {
      if (!settled) {
        settled = true;
        resolve(value);
      }
    };

    const pump = () => {
      if (settled) {
        return;
      }
      while (active < concurrency && next < total) {
        const candidate = candidates[next++];
        active += 1;
        tryResolveRoomCandidate(candidate, timeoutMs).then((result) => {
          active -= 1;
          checked += 1;
          if (settled) {
            return;
          }
          if (result.endpoint) {
            finish({ endpoint: result.endpoint });
            return;
          }
          if (checked % concurrency === 0) {
            connectionDetail = expectedRoomCode
              ? `${statusPrefix} for room ${expectedRoomCode} (${checked}/${total})`
              : `${statusPrefix} on port ${port} (${checked}/${total})`;
          }
          if (active === 0 && next >= total) {
            finish({
              error: expectedRoomCode
                ? `No room ${expectedRoomCode} found after scanning ${formatLanScanSubnets()} on port ${port}. ${manualDiscoveryFallback(port)}`
                : `No BandCue room found after scanning ${formatLanScanSubnets()} on port ${port}. ${manualDiscoveryFallback(port)}`
            });
            return;
          }
          pump();
        });
      }
    };

    pump();
  });
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

function buildLanScanCandidates(roomCode, subnets = LAN_SCAN_SUBNETS) {
  const candidates = [];
  const expectedRoomCode = isRoomCode(roomCode) ? roomCode.toUpperCase() : undefined;
  const port = isPort(roomCode) ? Number.parseInt(roomCode, 10) : DEFAULT_ROOM_PORT;
  for (const subnet of subnets) {
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

function absoluteRoomDiscoveryCandidate(value) {
  try {
    const url = new URL(value);
    url.pathname = "";
    url.search = "";
    url.hash = "";
    return {
      apiUrl: `${url.origin}/api/room`,
      baseUrl: url.origin,
      label: url.host
    };
  } catch {
    throw new Error(`Use a room URL, room code, port, or host:port.`);
  }
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
    instrument: memberInstrument,
    status: lastStatus
  };
}

function calculateClockSample(clientSentAt, clientReceivedAt, serverReceivedAt, serverSentAt) {
  const rttMs = clientReceivedAt - clientSentAt - (serverSentAt - serverReceivedAt);
  const offsetMs = (serverReceivedAt - clientSentAt + (serverSentAt - clientReceivedAt)) / 2;
  return { rttMs: Math.max(0, rttMs), offsetMs };
}

function summarizeClock(clockSamples) {
  if (!clockSamples.length) {
    return { rttMs: 0, offsetMs: 0 };
  }
  const sorted = [...clockSamples].sort((a, b) => a.rttMs - b.rttMs);
  const best = sorted.slice(0, 5);
  return {
    rttMs: median(best.map((sample) => sample.rttMs)),
    // Offset from the single lowest-RTT sample (NTP clock filter); jitter is
    // damped over time by blendOffset.
    offsetMs: sorted[0].offsetMs
  };
}

function blendOffset(previous, next) {
  if (previous === undefined || !Number.isFinite(previous)) {
    return next;
  }
  if (Math.abs(next - previous) > CLOCK_OFFSET_JUMP_MS) {
    return next;
  }
  return previous + CLOCK_OFFSET_SMOOTHING * (next - previous);
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
