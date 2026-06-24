const roomUrl = document.querySelector("#roomUrl");
const connect = document.querySelector("#connect");
const disconnect = document.querySelector("#disconnect");
const scanQr = document.querySelector("#scanQr");
const qrScanner = document.querySelector("#qrScanner");
const qrVideo = document.querySelector("#qrVideo");
const qrStatus = document.querySelector("#qrStatus");
const stopQrScan = document.querySelector("#stopQrScan");
const play = document.querySelector("#play");
const stop = document.querySelector("#stop");
const suppressAutoOpen = document.querySelector("#suppressAutoOpen");
const instrument = document.querySelector("#instrument");
const status = document.querySelector("#status");
const connectionState = document.querySelector("#connectionState");
const connectionDot = document.querySelector("#connectionDot");
const adapterState = document.querySelector("#adapterState");
const commandState = document.querySelector("#commandState");

// Once the user edits the room field, stop auto-filling it from saved state so
// they can clear it and type a different room without it being overwritten by
// the 1s refresh. Resets each time the popup reopens, so the last room is still
// prefilled for convenience.
let userEditedRoom = false;
let qrStream;
let qrDetector;
let qrScanTimer;
roomUrl.addEventListener("input", () => {
  userEditedRoom = true;
});

chrome.runtime.sendMessage({ type: "popupState" }, (state) => {
  if (!userEditedRoom && (state?.roomInput || state?.roomUrl)) {
    roomUrl.value = state.roomInput || state.roomUrl;
  }
  suppressAutoOpen.checked = Boolean(state?.suppressAutoOpen);
  instrument.value = state?.instrument || "auto";
  renderState(state);
});

setInterval(refreshState, 1000);
window.addEventListener("beforeunload", stopQrScanSession);

connect.addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "popupConnect", roomUrl: roomUrl.value }, renderState);
});

scanQr.addEventListener("click", () => {
  startQrScan();
});

stopQrScan.addEventListener("click", () => {
  stopQrScanSession();
});

disconnect.addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "popupDisconnect" }, renderState);
});

suppressAutoOpen.addEventListener("change", () => {
  chrome.runtime.sendMessage(
    { type: "popupSetSuppressAutoOpen", suppressAutoOpen: suppressAutoOpen.checked },
    renderState
  );
});

instrument.addEventListener("change", () => {
  chrome.runtime.sendMessage(
    { type: "popupSetInstrument", instrument: instrument.value },
    renderState
  );
});

play.addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "popupTransport", action: "play" }, renderState);
});

stop.addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "popupTransport", action: "stop" }, renderState);
});

function renderState(state) {
  const connected = state?.connected;
  const stateLabel = connected ? "connected" : state?.connectionState || "not connected";
  const adapter = state?.status?.ready ? "Songsterr ready" : "Songsterr not found";
  const detail = state?.status?.detail || state?.connectionDetail || "";
  const command = state?.status?.lastCommand
    ? `Last command: ${state.status.lastCommand.action} ${state.status.lastCommand.status}.`
    : "";
  const disconnectedByUser = state?.connectionState === "disconnected-by-user";

  connectionState.textContent = formatConnectionState(stateLabel);
  connectionDot.dataset.state = connected ? "connected" : disconnectedByUser ? "off" : stateLabel;
  adapterState.textContent = adapter;
  status.textContent = detail || "No connection detail yet.";
  commandState.textContent = command;
  disconnect.disabled = disconnectedByUser || (!connected && !state?.autoConnectEnabled);
  play.disabled = !connected;
  stop.disabled = !connected;
}

function formatConnectionState(value) {
  return String(value)
    .replaceAll("-", " ")
    .replace(/^./, (letter) => letter.toUpperCase());
}

function refreshState() {
  chrome.runtime.sendMessage({ type: "popupState" }, (state) => {
    if (!userEditedRoom && (state?.roomInput || state?.roomUrl) && !roomUrl.value) {
      roomUrl.value = state.roomInput || state.roomUrl;
    }
    renderState(state);
  });
}

async function startQrScan() {
  if (!("BarcodeDetector" in window)) {
    showQrMessage("QR scanning is not supported in this browser. Paste the join URL instead.");
    return;
  }

  stopQrScanSession({ keepPanelOpen: true });
  qrScanner.hidden = false;
  scanQr.disabled = true;
  qrStatus.textContent = "Starting camera...";

  try {
    qrDetector = new BarcodeDetector({ formats: ["qr_code"] });
    qrStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "environment" },
      audio: false
    });
    qrVideo.srcObject = qrStream;
    await qrVideo.play();
    qrStatus.textContent = "Point your camera at the BandCue join QR code.";
    scanQrFrame();
  } catch (error) {
    stopQrScanSession({ keepPanelOpen: true });
    showQrMessage(cameraErrorMessage(error));
  }
}

async function scanQrFrame() {
  if (!qrDetector || !qrStream) {
    return;
  }

  try {
    const codes = await qrDetector.detect(qrVideo);
    const value = codes.find((code) => code.rawValue)?.rawValue?.trim();
    if (value) {
      userEditedRoom = true;
      roomUrl.value = value;
      qrStatus.textContent = "QR code found. Connecting...";
      stopQrScanSession({ keepPanelOpen: true });
      chrome.runtime.sendMessage({ type: "popupConnect", roomUrl: value }, renderState);
      setTimeout(() => {
        qrScanner.hidden = true;
      }, 900);
      return;
    }
  } catch {
    // Camera frames can be unreadable while focus/exposure settles; keep polling.
  }

  qrScanTimer = setTimeout(scanQrFrame, 250);
}

function stopQrScanSession(options = {}) {
  if (qrScanTimer) {
    clearTimeout(qrScanTimer);
    qrScanTimer = undefined;
  }
  if (qrStream) {
    for (const track of qrStream.getTracks()) {
      track.stop();
    }
    qrStream = undefined;
  }
  qrDetector = undefined;
  qrVideo.srcObject = null;
  scanQr.disabled = false;
  if (!options.keepPanelOpen) {
    qrScanner.hidden = true;
  }
}

function showQrMessage(message) {
  qrScanner.hidden = false;
  qrStatus.textContent = message;
}

function cameraErrorMessage(error) {
  if (error?.name === "NotAllowedError") {
    return "Camera permission was blocked. Allow camera access to scan the join QR code.";
  }
  if (error?.name === "NotFoundError") {
    return "No camera was found. Paste the join URL instead.";
  }
  return "Could not start the camera. Paste the join URL instead.";
}
