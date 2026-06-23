import {
  createId,
  normalizeSong,
  normalizeStoredSong,
  nextSongIndex,
  previousSongIndex,
  adjustCurrentIndexAfterRemoval,
  appliesToMuseScore,
  getSongsterrUrl,
  isOpenableSong,
  calculateClockSample,
  summarizeClock,
  calculateJitterMs,
  clampManualOffset,
  getCalibrationKey,
  getTimingQuality,
  getReadyAdapters,
  canHostPlay,
  playBlockedReason,
  collectWarnings,
  formatElapsed,
  formatMs,
  formatSignedMs,
  formatSongMeta,
  parseDurationInput
} from "./host-logic.js";

const params = new URLSearchParams(location.search);
const token = params.get("token");
const isHost = location.pathname === "/host" || params.get("host") === "1";
const wsProtocol = location.protocol === "https:" ? "wss:" : "ws:";
const wsUrl = `${wsProtocol}//${location.host}/ws?token=${encodeURIComponent(token ?? "")}`;

const elements = {
  roomCode: document.querySelector("#roomCode"),
  transportBadge: document.querySelector("#transportBadge"),
  countdown: document.querySelector("#countdown"),
  subline: document.querySelector("#subline"),
  leaderName: document.querySelector("#leaderName"),
  elapsedTime: document.querySelector("#elapsedTime"),
  readySummary: document.querySelector("#readySummary"),
  currentSongTitle: document.querySelector("#currentSongTitle"),
  currentSongMeta: document.querySelector("#currentSongMeta"),
  warnings: document.querySelector("#warnings"),
  devices: document.querySelector("#devices"),
  companionUrl: document.querySelector("#companionUrl"),
  adapterHostPort: document.querySelector("#adapterHostPort"),
  hostPanel: document.querySelector("#hostPanel"),
  hostWarning: document.querySelector("#hostWarning"),
  armButton: document.querySelector("#armButton"),
  controlModeSelect: document.querySelector("#controlModeSelect"),
  safetyState: document.querySelector("#safetyState"),
  playButton: document.querySelector("#playButton"),
  stopButton: document.querySelector("#stopButton"),
  setlistPanel: document.querySelector("#setlistPanel"),
  setlistForm: document.querySelector("#setlistForm"),
  setlistCount: document.querySelector("#setlistCount"),
  setlistItems: document.querySelector("#setlistItems"),
  songTitleInput: document.querySelector("#songTitleInput"),
  songSourceTypeInput: document.querySelector("#songSourceTypeInput"),
  songSourceInput: document.querySelector("#songSourceInput"),
  songSongsterrUrlInput: document.querySelector("#songSongsterrUrlInput"),
  songMuseScoreSourceInput: document.querySelector("#songMuseScoreSourceInput"),
  songDurationInput: document.querySelector("#songDurationInput"),
  songNotesInput: document.querySelector("#songNotesInput"),
  previousSongButton: document.querySelector("#previousSongButton"),
  nextSongButton: document.querySelector("#nextSongButton"),
  clearSongButton: document.querySelector("#clearSongButton"),
  openSongButton: document.querySelector("#openSongButton"),
  exportSetlistButton: document.querySelector("#exportSetlistButton"),
  importSetlistButton: document.querySelector("#importSetlistButton"),
  importSetlistInput: document.querySelector("#importSetlistInput"),
  timingPanel: document.querySelector("#timingPanel"),
  timingRows: document.querySelector("#timingRows")
};

const SETLIST_STORAGE_KEY = "bandcue:setlist";
const CALIBRATION_STORAGE_KEY = "bandcue:calibration";
const DEVICE_NAME_STORAGE_KEY = "bandcue:name";
const LEGACY_SETLIST_STORAGE_KEY = "playsync:setlist";
const LEGACY_CALIBRATION_STORAGE_KEY = "playsync:calibration";
const LEGACY_DEVICE_NAME_STORAGE_KEY = "playsync:name";
migrateLegacyStorage();
let socket;
let serverOffsetMs = 0;
let samples = [];
let lastState;
let clientId;
let setlist = loadSetlist();
let currentSongIndex = -1;
let calibrations = loadCalibrations();
let appliedCalibrationByClientId = {};
let transportRequestPending = false;
let lastStableRoomSignature = "";
let pendingTimingState;
let timingRenderTimer;

const TIMING_RENDER_INTERVAL_MS = 1200;

if (!token) {
  setText(elements.roomCode, "Missing token");
  setText(elements.subline, "Open the room URL printed by the coordinator.");
} else {
  connect();
}

if (isHost) {
  elements.hostPanel.hidden = false;
  elements.setlistPanel.hidden = false;
  elements.timingPanel.hidden = false;
  renderSetlist();
}

elements.playButton?.addEventListener("click", () => {
  if (transportRequestPending) {
    return;
  }

  if (!canHostPlay(lastState)) {
    setText(elements.hostWarning, playBlockedReason(lastState));
    return;
  }

  transportRequestPending = true;
  send({ type: "transportRequest", action: "play", requestedAt: Date.now() });
});

elements.stopButton?.addEventListener("click", () => {
  if (transportRequestPending) {
    return;
  }

  transportRequestPending = true;
  send({ type: "transportRequest", action: "stop", requestedAt: Date.now() });
});

elements.armButton?.addEventListener("click", () => {
  const nextArmed = !lastState?.safety?.armed;
  publishSafety({ armed: nextArmed });
});

elements.controlModeSelect?.addEventListener("change", () => {
  publishSafety({ controlMode: elements.controlModeSelect.value });
});

elements.setlistForm?.addEventListener("submit", (event) => {
  event.preventDefault();
  addSetlistSong();
});

elements.setlistItems?.addEventListener("click", (event) => {
  const target = event.target instanceof Element ? event.target : undefined;
  const button = target?.closest("button[data-setlist-action]");
  if (!button) {
    return;
  }

  const index = Number.parseInt(button.dataset.index ?? "", 10);
  if (!Number.isInteger(index)) {
    return;
  }

  if (button.dataset.setlistAction === "select") {
    selectCurrentSong(index);
  }

  if (button.dataset.setlistAction === "remove") {
    removeSetlistSong(index);
  }
});

elements.previousSongButton?.addEventListener("click", () => {
  if (!setlist.length) return;
  selectCurrentSong(previousSongIndex(currentSongIndex, setlist.length));
});

elements.nextSongButton?.addEventListener("click", () => {
  if (!setlist.length) return;
  selectCurrentSong(nextSongIndex(currentSongIndex, setlist.length));
});

elements.clearSongButton?.addEventListener("click", () => {
  currentSongIndex = -1;
  publishCurrentSong();
  renderSetlist();
});

elements.openSongButton?.addEventListener("click", () => {
  openCurrentSong();
});

elements.exportSetlistButton?.addEventListener("click", () => {
  exportSetlist();
});

elements.importSetlistButton?.addEventListener("click", () => {
  elements.importSetlistInput.click();
});

elements.importSetlistInput?.addEventListener("change", () => {
  importSetlist(elements.importSetlistInput.files?.[0]);
  elements.importSetlistInput.value = "";
});

elements.timingRows?.addEventListener("change", (event) => {
  const target = event.target instanceof HTMLInputElement ? event.target : undefined;
  if (!target?.matches("input[data-calibration-client-id]")) {
    return;
  }

  const clientId = target.dataset.calibrationClientId;
  const deviceName = target.dataset.calibrationDeviceName;
  if (!clientId || !deviceName) {
    return;
  }

  const manualOffsetMs = clampManualOffset(Number.parseInt(target.value || "0", 10));
  target.value = String(manualOffsetMs);
  setDeviceCalibration(clientId, deviceName, manualOffsetMs);
});

setInterval(updateCountdown, 60);

function connect() {
  socket = new WebSocket(wsUrl);

  socket.addEventListener("open", () => {
    send({
      type: "clientHello",
      deviceName: localStorage.getItem(DEVICE_NAME_STORAGE_KEY)
        || localStorage.getItem(LEGACY_DEVICE_NAME_STORAGE_KEY)
        || defaultDeviceName(),
      role: isHost ? "host" : "companion",
      capabilities: []
    });

    setInterval(() => {
      send({ type: "clockSync", clientSentAt: Date.now() });
    }, 1000);
  });

  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);

    if (message.type === "serverHello") {
      clientId = message.clientId;
      if (isHost) {
        publishSetlist();
      }
      if (isHost && currentSongIndex >= 0) {
        publishCurrentSong();
      }
      return;
    }

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

    if (message.type === "roomState") {
      transportRequestPending = false;
      lastState = message;
      renderState(message);
      return;
    }

    if (message.type === "error") {
      setText(elements.subline, message.message);
      setText(elements.hostWarning, message.message);
    }
  });

  socket.addEventListener("close", () => {
    setText(elements.subline, "Disconnected. Reconnecting...");
    setTimeout(connect, 1500);
  });
}

function renderState(state) {
  const stableSignature = getStableRoomSignature(state);
  if (stableSignature === lastStableRoomSignature) {
    renderVolatileState(state);
    return;
  }

  lastStableRoomSignature = stableSignature;
  pendingTimingState = undefined;
  const readyAdapters = getReadyAdapters(state);
  const desktopAdapters = state.clients.filter((device) => device.role === "desktop-adapter");
  const leader = state.clients.find((device) => device.id === state.transport.leaderId);
  const warnings = collectWarnings(state, readyAdapters, desktopAdapters);

  document.body.dataset.transport = state.transport.status;
  setText(elements.roomCode, state.roomCode);
  setText(elements.companionUrl, state.companionUrl);
  setText(elements.adapterHostPort, hostPortFromRoomUrl(state.companionUrl));
  setText(elements.transportBadge, formatStatus(state.transport.status));
  setText(elements.leaderName, leader ? leader.deviceName : "None");
  setText(elements.readySummary, `${readyAdapters.length} / ${desktopAdapters.length}`);
  renderCurrentSong(state.currentSong);
  renderDevices(state.clients);
  hydrateSetlistFromRoom(state.setlist);
  applySavedCalibrations(state);
  renderTimingRows(state);
  renderWarnings(warnings);
  renderHostControls(state, readyAdapters);
}

function renderVolatileState(state) {
  scheduleTimingRowsRender(state);
}

function scheduleTimingRowsRender(state) {
  if (!isHost || !elements.timingRows) {
    return;
  }

  pendingTimingState = state;
  if (timingRenderTimer) {
    return;
  }

  timingRenderTimer = setTimeout(() => {
    const nextState = pendingTimingState;
    pendingTimingState = undefined;
    timingRenderTimer = undefined;
    if (nextState) {
      renderTimingRows(nextState);
    }
  }, TIMING_RENDER_INTERVAL_MS);
}

function getStableRoomSignature(state) {
  return JSON.stringify({
    roomCode: state.roomCode,
    companionUrl: state.companionUrl,
    hostUrl: state.hostUrl,
    transport: state.transport,
    currentSong: state.currentSong,
    setlist: state.setlist,
    safety: state.safety,
    clients: state.clients
      .map(getStableClientSignature)
      .sort((a, b) => a.id.localeCompare(b.id))
  });
}

function hostPortFromRoomUrl(value) {
  try {
    return new URL(value).host;
  } catch {
    return "Unavailable";
  }
}

function getStableClientSignature(client) {
  return {
    id: client.id,
    deviceName: client.deviceName,
    role: client.role,
    capabilities: client.capabilities,
    status: client.status,
    manualOffsetMs: client.clock?.manualOffsetMs
  };
}

function renderCurrentSong(currentSong) {
  if (!currentSong?.song) {
    setText(elements.currentSongTitle, "None");
    setText(elements.currentSongMeta, "No setlist song selected");
    return;
  }

  setText(elements.currentSongTitle, currentSong.song.title);
  setText(elements.currentSongMeta, formatSongMeta(
    currentSong.song,
    currentSong.index,
    currentSong.total
  ));
}

function renderHostControls(state, readyAdapters) {
  if (!isHost) {
    return;
  }

  const playAvailable = canHostPlay(state);
  elements.playButton.disabled = !playAvailable || transportRequestPending;
  elements.stopButton.disabled = state.transport.status === "stopped" || transportRequestPending;
  elements.armButton.disabled = state.transport.status !== "stopped";
  elements.armButton.setAttribute("aria-pressed", String(Boolean(state.safety?.armed)));
  setText(elements.armButton, state.safety?.armed ? "Disarm" : "Arm");
  elements.controlModeSelect.value = state.safety?.controlMode || "host-only";
  setText(elements.safetyState, state.safety?.armed ? "Armed" : "Not armed");
  elements.safetyState.classList.toggle("armed", Boolean(state.safety?.armed));

  if (!state.safety?.armed && state.transport.status === "stopped") {
    setText(elements.hostWarning, "Arm playback before pressing Play.");
  } else if (!readyAdapters.length) {
    setText(elements.hostWarning, "Play is waiting for a ready desktop adapter.");
  } else if (state.transport.status !== "stopped") {
    setText(elements.hostWarning, "Transport is active. Stop before scheduling another play.");
  } else {
    setText(elements.hostWarning, "Ready to control: " + readyAdapters.map((device) => device.status.app).join(", "));
  }
}

function renderWarnings(warnings) {
  const signature = warnings.join("\n");
  if (elements.warnings.dataset.signature === signature) {
    elements.warnings.hidden = !warnings.length;
    return;
  }

  elements.warnings.dataset.signature = signature;
  if (!warnings.length) {
    elements.warnings.hidden = true;
    elements.warnings.innerHTML = "";
    return;
  }

  elements.warnings.hidden = false;
  elements.warnings.replaceChildren(
    ...warnings.map((warning) => {
      const element = document.createElement("div");
      element.className = "warning";
      element.textContent = warning;
      return element;
    })
  );
}

function renderDevices(clients) {
  if (!elements.devices) {
    return;
  }

  const sortedClients = getStableDeviceOrder(clients);
  const keyCounts = countDeviceKeys(sortedClients);
  const expectedKeys = new Set();

  for (const device of sortedClients) {
    const key = getDeviceRenderKey(device, keyCounts);
    expectedKeys.add(key);
    let card = getDeviceCardByKey(key);
    if (!card) {
      card = createDeviceCard(key);
      elements.devices.append(card);
    }
    updateDeviceCard(card, device);
  }

  for (const card of Array.from(elements.devices.querySelectorAll("[data-device-key]"))) {
    if (!expectedKeys.has(card.dataset.deviceKey)) {
      card.remove();
    }
  }
}

function createDeviceCard(key) {
  const card = document.createElement("div");
  card.className = "device";
  card.dataset.deviceKey = key;
  card.innerHTML = `
    <div class="device-head">
      <strong data-device-name></strong>
      <span class="pill" data-device-badge></span>
    </div>
    <div class="device-meta">
      <span data-device-self></span>
      <span data-device-capabilities></span>
    </div>
    <span class="small" data-device-title></span>
    <span class="small" data-device-catalog></span>
    <span class="small" data-device-playback></span>
    <span class="small" data-device-command></span>
    <span class="small" data-device-clock></span>
  `;
  return card;
}

function updateDeviceCard(card, device) {
  const status = device.status;
  const ready = Boolean(status?.ready);
  const state = status?.state || (ready ? "ready" : "not-ready");
  const badge = getDeviceBadge(device, state);
  const title = status?.title || status?.detail || "No adapter status";
  const playback = status?.playback
    ? `${status.playback}${status.playbackDetail ? ` - ${status.playbackDetail}` : ""}`
    : "playback not reported";
  const command = status?.lastCommand ? renderCommand(status.lastCommand) : "No command feedback yet";
  const clock = renderClock(device.clock);
  const self = device.id === clientId ? "you" : device.role;

  card.className = `device ${state}`;
  setText(card.querySelector("[data-device-name]"), device.deviceName);
  setText(card.querySelector("[data-device-self]"), self);
  setText(card.querySelector("[data-device-capabilities]"), formatCapabilities(device));
  setText(card.querySelector("[data-device-title]"), title);
  setText(card.querySelector("[data-device-catalog]"), renderCatalogMatch(status));
  setText(card.querySelector("[data-device-playback]"), playback);
  setText(card.querySelector("[data-device-command]"), command);
  setText(card.querySelector("[data-device-clock]"), clock);

  const badgeElement = card.querySelector("[data-device-badge]");
  setText(badgeElement, badge.label);
  badgeElement.className = `pill ${badge.className}`;
}

function getDeviceCardByKey(key) {
  return Array.from(elements.devices.querySelectorAll("[data-device-key]"))
    .find((card) => card.dataset.deviceKey === key);
}

function getStableDeviceOrder(clients) {
  return [...clients].sort((a, b) => {
    const roleOrder = roleSortOrder(a.role) - roleSortOrder(b.role);
    if (roleOrder) return roleOrder;
    return getBaseDeviceKey(a).localeCompare(getBaseDeviceKey(b));
  });
}

function roleSortOrder(role) {
  if (role === "host") return 0;
  if (role === "desktop-adapter") return 1;
  return 2;
}

function countDeviceKeys(devices) {
  const counts = {};
  for (const device of devices) {
    const key = getBaseDeviceKey(device);
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

function getDeviceRenderKey(device, keyCounts) {
  const baseKey = getBaseDeviceKey(device);
  return keyCounts[baseKey] > 1 ? `${baseKey}:${device.id}` : baseKey;
}

function getBaseDeviceKey(device) {
  return [
    device.role,
    getCalibrationKey(device),
    device.status?.app || formatCapabilities(device)
  ].join(":");
}

function renderDevice(device) {
  const status = device.status;
  const ready = Boolean(status?.ready);
  const state = status?.state || (ready ? "ready" : "not-ready");
  const badge = getDeviceBadge(device, state);
  const title = status?.title || status?.detail || "No adapter status";
  const playback = status?.playback
    ? `${status.playback}${status.playbackDetail ? ` - ${status.playbackDetail}` : ""}`
    : "playback not reported";
  const command = status?.lastCommand ? renderCommand(status.lastCommand) : "No command feedback yet";
  const clock = renderClock(device.clock);
  const self = device.id === clientId ? "you" : device.role;

  return `
    <div class="device ${state}">
      <div class="device-head">
        <strong>${escapeHtml(device.deviceName)}</strong>
        <span class="pill ${badge.className}">${escapeHtml(badge.label)}</span>
      </div>
      <div class="device-meta">
        <span>${escapeHtml(self)}</span>
        <span>${escapeHtml(formatCapabilities(device))}</span>
      </div>
      <span class="small">${escapeHtml(title)}</span>
      <span class="small">${escapeHtml(renderCatalogMatch(status))}</span>
      <span class="small">${escapeHtml(playback)}</span>
      <span class="small">${escapeHtml(command)}</span>
      <span class="small">${escapeHtml(clock)}</span>
    </div>
  `;
}

function applySavedCalibrations(state) {
  if (!isHost) {
    return;
  }

  for (const device of state.clients) {
    const saved = calibrations[getCalibrationKey(device)];
    if (saved === undefined) {
      continue;
    }

    if (device.clock?.manualOffsetMs === saved || appliedCalibrationByClientId[device.id] === saved) {
      continue;
    }

    appliedCalibrationByClientId[device.id] = saved;
    send({
      type: "calibrationUpdate",
      targetClientId: device.id,
      manualOffsetMs: saved
    });
  }
}

function renderTimingRows(state) {
  if (!isHost || !elements.timingRows) {
    return;
  }

  const devices = state.clients.filter((device) => device.role !== "host" || device.id !== clientId);
  if (!devices.length) {
    if (elements.timingRows.dataset.empty !== "true") {
      elements.timingRows.innerHTML = '<p class="small" data-empty-state>No other devices connected yet.</p>';
      elements.timingRows.dataset.empty = "true";
    }
    return;
  }

  elements.timingRows.dataset.empty = "false";
  elements.timingRows.querySelector("[data-empty-state]")?.remove();

  const keyCounts = countTimingKeys(devices);
  const expectedKeys = new Set();
  for (const device of devices) {
    const key = getTimingRenderKey(device, keyCounts);
    expectedKeys.add(key);
    let row = getTimingRowByKey(key);
    if (!row) {
      row = createTimingRow(key);
      elements.timingRows.append(row);
    }
    updateTimingRow(row, device);
  }

  for (const row of Array.from(elements.timingRows.querySelectorAll("[data-timing-key]"))) {
    if (!expectedKeys.has(row.dataset.timingKey)) {
      row.remove();
    }
  }
}

function createTimingRow(key) {
  const row = document.createElement("div");
  row.className = "timing-row";
  row.dataset.timingKey = key;
  row.innerHTML = `
    <div class="timing-device">
      <strong data-timing-device></strong>
      <span class="small" data-timing-role></span>
    </div>
    <div>
      <span class="timing-label">RTT</span>
      <div class="timing-value" data-timing-rtt></div>
    </div>
    <div>
      <span class="timing-label">Clock</span>
      <div class="timing-value" data-timing-clock></div>
    </div>
    <div>
      <span class="timing-label">Jitter</span>
      <div class="timing-value" data-timing-jitter></div>
    </div>
    <span class="quality" data-timing-quality></span>
    <label>
      <span>Manual Offset</span>
      <input
        class="manual-offset"
        type="number"
        min="-1000"
        max="1000"
        step="10"
      />
    </label>
  `;
  return row;
}

function updateTimingRow(row, device) {
  const clock = device.clock;
  const quality = getTimingQuality(clock);
  const saved = calibrations[getCalibrationKey(device)];
  const manualOffsetMs = clock?.manualOffsetMs ?? saved ?? 0;
  const input = row.querySelector(".manual-offset");
  const qualityElement = row.querySelector("[data-timing-quality]");

  setText(row.querySelector("[data-timing-device]"), device.deviceName);
  setText(row.querySelector("[data-timing-role]"), device.role);
  setText(row.querySelector("[data-timing-rtt]"), formatMs(clock?.rttMs));
  setText(row.querySelector("[data-timing-clock]"), formatSignedMs(clock?.offsetMs));
  setText(row.querySelector("[data-timing-jitter]"), formatMs(clock?.jitterMs));
  setText(qualityElement, quality.label);
  qualityElement.className = `quality ${quality.className}`;

  input.dataset.calibrationClientId = device.id;
  input.dataset.calibrationDeviceName = device.deviceName;
  if (document.activeElement !== input) {
    input.value = String(manualOffsetMs);
  }
}

function getTimingRowByKey(key) {
  return Array.from(elements.timingRows.querySelectorAll("[data-timing-key]"))
    .find((row) => row.dataset.timingKey === key);
}

function countTimingKeys(devices) {
  const counts = {};
  for (const device of devices) {
    const key = getBaseTimingKey(device);
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

function getTimingRenderKey(device, keyCounts) {
  const baseKey = getBaseTimingKey(device);
  return keyCounts[baseKey] > 1 ? `${baseKey}:${device.id}` : baseKey;
}

function getBaseTimingKey(device) {
  return [
    device.role,
    getCalibrationKey(device),
    device.status?.app || formatCapabilities(device)
  ].join(":");
}

function addSetlistSong() {
  const title = elements.songTitleInput.value.trim();
  if (!title) {
    return;
  }

  const durationMs = parseDurationInput(elements.songDurationInput.value);
  const song = {
    id: createId(),
    title,
    sourceType: elements.songSourceTypeInput.value,
    source: elements.songSourceInput.value.trim(),
    songsterrUrl: elements.songSongsterrUrlInput.value.trim(),
    museScoreSource: elements.songMuseScoreSourceInput.value.trim(),
    durationMs,
    durationSource: durationMs ? "manual" : undefined,
    notes: elements.songNotesInput.value.trim()
  };

  setlist.push(song);
  persistSetlist();
  publishSetlist();
  elements.setlistForm.reset();

  if (currentSongIndex < 0) {
    currentSongIndex = 0;
    publishCurrentSong();
  }

  renderSetlist();
}

function selectCurrentSong(index) {
  if (index < 0 || index >= setlist.length) {
    return;
  }

  currentSongIndex = index;
  publishCurrentSong();
  renderSetlist();
}

function removeSetlistSong(index) {
  if (index < 0 || index >= setlist.length) {
    return;
  }

  setlist.splice(index, 1);
  currentSongIndex = adjustCurrentIndexAfterRemoval(currentSongIndex, index);

  persistSetlist();
  publishSetlist();
  publishCurrentSong();
  renderSetlist();
}

function publishSetlist() {
  if (!isHost) {
    return;
  }

  send({
    type: "setlistUpdate",
    songs: setlist.map(normalizeSong),
    updatedAt: Date.now()
  });
}

function publishCurrentSong() {
  if (!isHost) {
    return;
  }

  const song = currentSongIndex >= 0 ? normalizeSong(setlist[currentSongIndex]) : undefined;
  send({
    type: "currentSongUpdate",
    song,
    index: song ? currentSongIndex + 1 : undefined,
    total: setlist.length,
    updatedAt: Date.now()
  });
}

function renderSetlist() {
  if (!isHost || !elements.setlistItems) {
    return;
  }

  setText(elements.setlistCount, `${setlist.length} ${setlist.length === 1 ? "song" : "songs"}`);
  elements.previousSongButton.disabled = setlist.length < 2;
  elements.nextSongButton.disabled = setlist.length < 1;
  elements.clearSongButton.disabled = currentSongIndex < 0;
  elements.openSongButton.disabled = !getCurrentOpenableSong();

  if (!setlist.length) {
    elements.setlistItems.innerHTML = '<p class="small">No songs added yet.</p>';
    return;
  }

  elements.setlistItems.innerHTML = setlist
    .map((song, index) => renderSetlistItem(song, index))
    .join("");
}

function hydrateSetlistFromRoom(roomSetlist) {
  if (!isHost || !roomSetlist?.songs?.length || setlist.length) {
    return;
  }

  setlist = roomSetlist.songs.map(normalizeStoredSong).filter(Boolean);
  persistSetlist();
  renderSetlist();
}

function publishSafety(update) {
  if (!isHost) {
    return;
  }

  send({
    type: "safetyUpdate",
    ...update,
    updatedAt: Date.now()
  });
}

function openCurrentSong() {
  const song = getCurrentOpenableSong();
  if (!song) {
    setText(elements.hostWarning, "Current song needs a Songsterr URL or a MuseScore score.");
    return;
  }

  // The room broadcasts the open request to every adapter; each adapter resolves
  // its own reference (Songsterr URL or MuseScore score), so a single song can
  // open on both at once. We only inspect connected adapters here for feedback
  // and for the local Songsterr browser-tab fallback.
  const requestSent = send({ type: "openSongRequest", requestedAt: Date.now() });
  const songTitle = song.title || "current song";
  const songsterrUrl = getSongsterrUrl(song);
  const opensMuseScore = appliesToMuseScore(song);

  const adapters = lastState?.clients.filter((device) => device.role === "desktop-adapter") ?? [];
  const songsterrAdapters = adapters.filter((device) => device.status?.app === "songsterr");
  const museScoreAdapters = adapters.filter((device) => device.status?.app === "musescore");
  const messages = [];

  if (songsterrUrl) {
    if (requestSent && songsterrAdapters.length) {
      messages.push(`asked ${songsterrAdapters.length} Songsterr adapter${songsterrAdapters.length === 1 ? "" : "s"}`);
    } else {
      window.open(songsterrUrl, "_blank", "noopener,noreferrer");
      messages.push(requestSent ? "opened Songsterr locally (no adapter)" : "opened Songsterr locally (room not ready)");
    }
  }

  if (opensMuseScore) {
    if (requestSent && museScoreAdapters.length) {
      messages.push(`asked ${museScoreAdapters.length} MuseScore adapter${museScoreAdapters.length === 1 ? "" : "s"}`);
    } else {
      messages.push(requestSent ? "MuseScore skipped (no adapter connected)" : "MuseScore skipped (room not ready)");
    }
  }

  setText(elements.hostWarning, `Open ${songTitle}: ${messages.join("; ")}.`);
}

function getCurrentOpenableSong() {
  const song = currentSongIndex >= 0 ? setlist[currentSongIndex] : lastState?.currentSong?.song;
  return isOpenableSong(song) ? song : undefined;
}

function exportSetlist() {
  const payload = {
    version: 1,
    exportedAt: new Date().toISOString(),
    songs: setlist.map(normalizeSong)
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `bandcue-setlist-${new Date().toISOString().slice(0, 10)}.json`;
  link.click();
  URL.revokeObjectURL(url);
}

function importSetlist(file) {
  if (!file) {
    return;
  }

  const reader = new FileReader();
  reader.addEventListener("load", () => {
    try {
      const parsed = JSON.parse(String(reader.result || "{}"));
      const songs = Array.isArray(parsed) ? parsed : parsed.songs;
      if (!Array.isArray(songs)) {
        throw new Error("No songs array found.");
      }

      setlist = songs.map(normalizeStoredSong).filter(Boolean);
      currentSongIndex = setlist.length ? 0 : -1;
      persistSetlist();
      publishSetlist();
      publishCurrentSong();
      renderSetlist();
    } catch (error) {
      setText(elements.hostWarning, `Setlist import failed: ${error.message}`);
    }
  });
  reader.readAsText(file);
}

function renderSetlistItem(song, index) {
  const isCurrent = index === currentSongIndex;
  const meta = formatSongMeta(song, index + 1, setlist.length);
  const notes = song.notes ? `<span class="small">${escapeHtml(song.notes)}</span>` : "";

  return `
    <div class="setlist-item ${isCurrent ? "current" : ""}">
      <div class="setlist-item-head">
        <strong class="setlist-item-title">${escapeHtml(song.title)}</strong>
        <div class="setlist-item-actions">
          <button class="link-button" type="button" data-setlist-action="select" data-index="${index}">
            ${isCurrent ? "Current" : "Make Current"}
          </button>
          <button class="link-button" type="button" data-setlist-action="remove" data-index="${index}">
            Remove
          </button>
        </div>
      </div>
      <span class="small">${escapeHtml(meta)}</span>
      ${notes}
    </div>
  `;
}

function updateCountdown() {
  if (!lastState) {
    return;
  }

  const transport = lastState.transport;
  const serverNow = Date.now() + serverOffsetMs;

  if (transport.status === "scheduled" && transport.scheduledServerTime) {
    const remaining = Math.max(0, transport.scheduledServerTime - serverNow);
    setText(elements.countdown, (remaining / 1000).toFixed(2));
    setText(elements.elapsedTime, "00:00");
    setText(elements.subline, "Scheduled start is armed");
    return;
  }

  if (transport.status === "running" && transport.startedServerTime) {
    const elapsed = Math.max(0, serverNow - transport.startedServerTime);
    const elapsedText = formatElapsed(elapsed);
    setText(elements.countdown, elapsedText);
    setText(elements.elapsedTime, elapsedText);
    setText(elements.subline, "Playback running");
    return;
  }

  setText(elements.countdown, "--");
  setText(elements.elapsedTime, "00:00");
  setText(elements.subline, "Waiting for a transport command");
}

function getDeviceBadge(device, state) {
  if (state === "command-pending") return { label: "pending", className: "pending" };
  if (state === "last-command-succeeded") return { label: "ok", className: "ready" };
  if (state === "last-command-failed") return { label: "failed", className: "failed" };
  if (device.status?.ready) return { label: "ready", className: "ready" };
  if (device.role === "desktop-adapter") return { label: "not ready", className: "waiting" };
  return { label: device.id === clientId ? "you" : device.role, className: "neutral" };
}

function renderCommand(command) {
  const when = formatTime(command.at);
  const path = command.controlPath ? ` via ${command.controlPath}` : "";
  const detail = command.detail ? `: ${command.detail}` : "";
  return `${command.action} ${command.status}${path} at ${when}${detail}`;
}

function renderCatalogMatch(status) {
  if (!status?.catalog && !status?.songMatch) {
    return "catalog not reported";
  }

  const catalog = status.catalog
    ? `${status.catalog.total ?? 0} local score${status.catalog.total === 1 ? "" : "s"}`
    : "catalog pending";
  const match = status.songMatch;
  if (!match || match.status === "not-applicable") {
    return catalog;
  }

  const target = match.relativePath || match.title || match.detail || "";
  return target ? `${catalog}; ${match.status}: ${target}` : `${catalog}; ${match.status}`;
}

function renderClock(clock) {
  if (!clock) {
    return "clock pending";
  }

  const jitter = clock.jitterMs === undefined ? "" : `, ${Math.round(clock.jitterMs)} ms jitter`;
  const manual = clock.manualOffsetMs ? `, ${clock.manualOffsetMs} ms manual` : "";
  return `${Math.round(clock.rttMs)} ms RTT, ${Math.round(clock.offsetMs)} ms offset${jitter}${manual}`;
}

function formatCapabilities(device) {
  if (!device.capabilities.length) {
    return "display only";
  }

  return device.capabilities
    .map((capability) => capability.app)
    .join(", ");
}

function formatStatus(status) {
  return status.replace("-", " ");
}

function formatTime(timestamp) {
  if (!timestamp) {
    return "unknown";
  }

  return new Date(timestamp).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });
}

function send(message) {
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(message));
    return true;
  }

  return false;
}

function defaultDeviceName() {
  const mobile = matchMedia("(pointer: coarse)").matches ? "Phone" : "Browser";
  return `${mobile} companion`;
}

function loadSetlist() {
  try {
    const parsed = JSON.parse(localStorage.getItem(SETLIST_STORAGE_KEY) || "[]");
    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed
      .map(normalizeStoredSong)
      .filter(Boolean);
  } catch {
    return [];
  }
}

function migrateLegacyStorage() {
  for (const [legacyKey, nextKey] of [
    [LEGACY_SETLIST_STORAGE_KEY, SETLIST_STORAGE_KEY],
    [LEGACY_CALIBRATION_STORAGE_KEY, CALIBRATION_STORAGE_KEY],
    [LEGACY_DEVICE_NAME_STORAGE_KEY, DEVICE_NAME_STORAGE_KEY]
  ]) {
    if (localStorage.getItem(nextKey) === null && localStorage.getItem(legacyKey) !== null) {
      localStorage.setItem(nextKey, localStorage.getItem(legacyKey));
    }
  }
}

function persistSetlist() {
  localStorage.setItem(SETLIST_STORAGE_KEY, JSON.stringify(setlist.map(normalizeSong)));
}

function loadCalibrations() {
  try {
    const parsed = JSON.parse(localStorage.getItem(CALIBRATION_STORAGE_KEY) || "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }

    return Object.fromEntries(
      Object.entries(parsed)
        .map(([deviceName, value]) => [deviceName, clampManualOffset(Number(value))])
        .filter(([, value]) => Number.isFinite(value))
    );
  } catch {
    return {};
  }
}

function setDeviceCalibration(targetClientId, deviceName, manualOffsetMs) {
  const key = getCalibrationKey({ deviceName });
  if (manualOffsetMs === 0) {
    delete calibrations[key];
  } else {
    calibrations[key] = manualOffsetMs;
  }

  appliedCalibrationByClientId[targetClientId] = manualOffsetMs;
  persistCalibrations();
  send({
    type: "calibrationUpdate",
    targetClientId,
    manualOffsetMs
  });
}

function persistCalibrations() {
  localStorage.setItem(CALIBRATION_STORAGE_KEY, JSON.stringify(calibrations));
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function setText(element, value) {
  if (!element) {
    return;
  }

  const next = String(value ?? "");
  if (element.textContent !== next) {
    element.textContent = next;
  }
}
