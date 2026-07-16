// JSDoc casts so property access type-checks (tsconfig.web.json);
// querySelector alone returns a bare Element.
const camera = /** @type {HTMLVideoElement} */ (document.querySelector("#camera"));
const statusText = /** @type {HTMLElement} */ (document.querySelector("#status"));
const start = /** @type {HTMLButtonElement} */ (document.querySelector("#start"));
const closeButton = /** @type {HTMLButtonElement} */ (document.querySelector("#close"));

let stream;
let scanTimer;
const canvas = document.createElement("canvas");
const canvasContext = canvas.getContext("2d", { willReadFrequently: true });

start.addEventListener("click", () => {
  startCamera();
});

closeButton.addEventListener("click", () => {
  stopCamera();
  window.close();
});

window.addEventListener("beforeunload", stopCamera);
startCamera();

async function startCamera() {
  if (typeof jsQR !== "function") {
    statusText.textContent = "QR decoder is unavailable. Reload the extension and try again.";
    return;
  }

  if (!navigator.mediaDevices?.getUserMedia) {
    statusText.textContent = "Camera access is unavailable in this browser.";
    return;
  }

  stopCamera();
  start.disabled = true;
  statusText.textContent = "Starting camera...";

  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "environment" },
      audio: false
    });
    camera.srcObject = stream;
    await camera.play();
    statusText.textContent = "Point the camera at the BandCue join QR code.";
    scanFrame();
  } catch (error) {
    start.disabled = false;
    statusText.textContent = cameraErrorMessage(error);
  }
}

function scanFrame() {
  if (!stream) {
    return;
  }

  const value = readQrValue();
  if (value) {
    statusText.textContent = "QR code found. Connecting...";
    stopCamera();
    chrome.runtime.sendMessage({ type: "popupConnect", roomUrl: value }, () => {
      setTimeout(() => window.close(), 900);
    });
    return;
  }

  scanTimer = setTimeout(scanFrame, 250);
}

function readQrValue() {
  if (!canvasContext || !camera.videoWidth || !camera.videoHeight) {
    return "";
  }

  canvas.width = camera.videoWidth;
  canvas.height = camera.videoHeight;
  canvasContext.drawImage(camera, 0, 0, canvas.width, canvas.height);
  const image = canvasContext.getImageData(0, 0, canvas.width, canvas.height);
  return jsQR(image.data, image.width, image.height, { inversionAttempts: "attemptBoth" })?.data?.trim() || "";
}

function stopCamera() {
  if (scanTimer) {
    clearTimeout(scanTimer);
    scanTimer = undefined;
  }
  if (stream) {
    for (const track of stream.getTracks()) {
      track.stop();
    }
    stream = undefined;
  }
  camera.srcObject = null;
  start.disabled = false;
}

function cameraErrorMessage(error) {
  if (error?.name === "NotAllowedError") {
    return "Camera permission is blocked for this extension. In browser camera settings, remove BandCue from the blocked list, then press Start Camera.";
  }
  if (error?.name === "NotFoundError") {
    return "No camera was found.";
  }
  return "Could not start the camera.";
}
