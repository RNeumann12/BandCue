// JSDoc casts so property access on the popup's inputs and buttons
// type-checks (tsconfig.web.json); querySelector alone returns a bare
// Element. `stopButton`/`statusEl` avoid shadowing window.stop/window.status,
// which tsc flags in a non-module script.
const roomUrl = /** @type {HTMLInputElement} */ (document.querySelector("#roomUrl"));
const connect = /** @type {HTMLButtonElement} */ (document.querySelector("#connect"));
const disconnect = /** @type {HTMLButtonElement} */ (document.querySelector("#disconnect"));
const scanQr = /** @type {HTMLButtonElement} */ (document.querySelector("#scanQr"));
const qrScanner = /** @type {HTMLElement} */ (document.querySelector("#qrScanner"));
const qrVideo = /** @type {HTMLVideoElement} */ (document.querySelector("#qrVideo"));
const qrStatus = /** @type {HTMLElement} */ (document.querySelector("#qrStatus"));
const stopQrScan = /** @type {HTMLButtonElement} */ (document.querySelector("#stopQrScan"));
const openCameraScan = /** @type {HTMLButtonElement} */ (document.querySelector("#openCameraScan"));
const play = /** @type {HTMLButtonElement} */ (document.querySelector("#play"));
const stopButton = /** @type {HTMLButtonElement} */ (document.querySelector("#stop"));
const suppressAutoOpen = /** @type {HTMLInputElement} */ (document.querySelector("#suppressAutoOpen"));
const instrument = /** @type {HTMLSelectElement} */ (document.querySelector("#instrument"));
const statusEl = /** @type {HTMLElement} */ (document.querySelector("#status"));
const connectionState = /** @type {HTMLElement} */ (document.querySelector("#connectionState"));
const connectionDot = /** @type {HTMLElement} */ (document.querySelector("#connectionDot"));
const adapterState = /** @type {HTMLElement} */ (document.querySelector("#adapterState"));
const commandState = /** @type {HTMLElement} */ (document.querySelector("#commandState"));

// Once the user edits the room field, stop auto-filling it from saved state so
// they can clear it and type a different room without it being overwritten by
// the 1s refresh. Resets each time the popup reopens, so the last room is still
// prefilled for convenience.
let userEditedRoom = false;
let qrStream;
let qrDetector;
let qrScanTimer;
const qrCanvas = document.createElement("canvas");
const qrCanvasContext = qrCanvas.getContext("2d", { willReadFrequently: true });
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

connect.addEventListener("click", async () => {
  const permission = await requestRoomPermissions(roomUrl.value);
  if (!permission.granted) {
    renderState({
      connected: false,
      connectionState: "permission-needed",
      connectionDetail: permission.message,
      autoConnectEnabled: false,
      status: {
        ready: false,
        detail: permission.message
      }
    });
    return;
  }

  chrome.runtime.sendMessage({ type: "popupConnect", roomUrl: roomUrl.value }, renderState);
});

scanQr.addEventListener("click", () => {
  startQrScan();
});

stopQrScan.addEventListener("click", () => {
  stopQrScanSession();
});

openCameraScan.addEventListener("click", () => {
  openCameraScannerPage();
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

stopButton.addEventListener("click", () => {
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
  statusEl.textContent = detail || "No connection detail yet.";
  commandState.textContent = command;
  disconnect.disabled = disconnectedByUser || (!connected && !state?.autoConnectEnabled);
  play.disabled = !connected;
  stopButton.disabled = !connected;
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

function requestRoomPermissions(input) {
  if (!chrome.permissions?.request || !globalThis.BandCueRoomPermissions) {
    return Promise.resolve({ granted: true, message: "" });
  }

  const permission = globalThis.BandCueRoomPermissions.permissionsForLocator(input);
  if (!permission.origins.length) {
    return Promise.resolve({ granted: false, message: permission.message });
  }

  return new Promise((resolve) => {
    chrome.permissions.request({ origins: permission.origins }, (granted) => {
      const error = chrome.runtime.lastError;
      if (error) {
        resolve({
          granted: false,
          message: `Chrome could not request BandCue network access: ${error.message}`
        });
        return;
      }

      resolve({
        granted: Boolean(granted),
        message: granted
          ? ""
          : `${permission.message} Without this, paste a full room URL and approve that host when prompted.`
      });
    });
  });
}

async function startQrScan() {
  qrDetector = createBarcodeDetector();
  if (!qrDetector && typeof jsQR !== "function") {
    showQrMessage("QR scanning is not available in this browser. Paste the join URL instead.");
    return;
  }

  stopQrScanSession({ keepPanelOpen: true });
  qrScanner.hidden = false;
  qrVideo.hidden = true;
  openCameraScan.hidden = true;
  scanQr.disabled = true;
  qrStatus.textContent = "Looking for a QR code in the current tab...";

  const visibleTabValue = await scanVisibleTabForQr();
  if (visibleTabValue) {
    useQrValue(visibleTabValue);
    return;
  }

  qrStatus.textContent = "No QR code found in the current tab. Starting camera...";

  if (!navigator.mediaDevices?.getUserMedia) {
    scanQr.disabled = false;
    openCameraScan.hidden = false;
    showQrMessage("Camera access is not available. Open the join QR in the current tab or paste the URL.");
    return;
  }

  try {
    qrStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "environment" },
      audio: false
    });
    qrVideo.srcObject = qrStream;
    qrVideo.hidden = false;
    await qrVideo.play();
    qrStatus.textContent = "Point your camera at the BandCue join QR code.";
    scanQrFrame();
  } catch (error) {
    stopQrScanSession({ keepPanelOpen: true });
    openCameraScan.hidden = false;
    showQrMessage(cameraErrorMessage(error));
  }
}

async function scanQrFrame() {
  if (!qrStream) {
    return;
  }

  try {
    const value = (await readQrValue())?.trim();
    if (value) {
      useQrValue(value);
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
  qrVideo.hidden = false;
  scanQr.disabled = false;
  if (!options.keepPanelOpen) {
    qrScanner.hidden = true;
  }
}

function openCameraScannerPage() {
  stopQrScanSession();
  chrome.tabs.create({ url: chrome.runtime.getURL("scanner.html") });
}

async function useQrValue(value) {
  userEditedRoom = true;
  roomUrl.value = value;
  qrStatus.textContent = "QR code found. Checking BandCue network access...";
  stopQrScanSession({ keepPanelOpen: true });
  const permission = await requestRoomPermissions(value);
  if (!permission.granted) {
    showQrMessage(permission.message);
    renderState({
      connected: false,
      connectionState: "permission-needed",
      connectionDetail: permission.message,
      autoConnectEnabled: false,
      status: {
        ready: false,
        detail: permission.message
      }
    });
    return;
  }

  qrStatus.textContent = "QR code found. Connecting...";
  chrome.runtime.sendMessage({ type: "popupConnect", roomUrl: value }, renderState);
  setTimeout(() => {
    qrScanner.hidden = true;
  }, 900);
}

function createBarcodeDetector() {
  if (!("BarcodeDetector" in window)) {
    return undefined;
  }

  try {
    return new BarcodeDetector({ formats: ["qr_code"] });
  } catch {
    return undefined;
  }
}

async function readQrValue() {
  if (qrDetector) {
    const codes = await qrDetector.detect(qrVideo);
    const value = codes.find((code) => code.rawValue)?.rawValue;
    if (value) {
      return value;
    }
  }

  return readQrValueWithJsQr();
}

function readQrValueWithJsQr() {
  if (typeof jsQR !== "function" || !qrCanvasContext || !qrVideo.videoWidth || !qrVideo.videoHeight) {
    return "";
  }

  qrCanvas.width = qrVideo.videoWidth;
  qrCanvas.height = qrVideo.videoHeight;
  qrCanvasContext.drawImage(qrVideo, 0, 0, qrCanvas.width, qrCanvas.height);
  return readQrValueFromCanvas();
}

async function scanVisibleTabForQr() {
  if (typeof jsQR !== "function" || !chrome.tabs?.captureVisibleTab) {
    return "";
  }

  try {
    const dataUrl = await captureVisibleTab();
    if (!dataUrl) {
      return "";
    }

    const image = await loadImage(dataUrl);
    qrCanvas.width = image.naturalWidth;
    qrCanvas.height = image.naturalHeight;
    qrCanvasContext.drawImage(image, 0, 0, qrCanvas.width, qrCanvas.height);
    return readQrValueFromCanvas();
  } catch {
    return "";
  }
}

function captureVisibleTab() {
  return new Promise((resolve, reject) => {
    chrome.tabs.captureVisibleTab({ format: "png" }, (dataUrl) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      resolve(dataUrl || "");
    });
  });
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.addEventListener("load", () => resolve(image), { once: true });
    image.addEventListener("error", reject, { once: true });
    image.src = src;
  });
}

function readQrValueFromCanvas() {
  if (typeof jsQR !== "function" || !qrCanvasContext || !qrCanvas.width || !qrCanvas.height) {
    return "";
  }

  const image = qrCanvasContext.getImageData(0, 0, qrCanvas.width, qrCanvas.height);
  return jsQR(image.data, image.width, image.height, { inversionAttempts: "attemptBoth" })?.data || "";
}

function showQrMessage(message) {
  qrScanner.hidden = false;
  qrStatus.textContent = message;
}

function cameraErrorMessage(error) {
  if (error?.name === "NotAllowedError") {
    return "Camera permission was blocked in the popup. Open the camera scanner tab or scan the QR from the current tab.";
  }
  if (error?.name === "NotFoundError") {
    return "No camera was found. Paste the join URL instead.";
  }
  return "Could not start the camera. Paste the join URL instead.";
}
