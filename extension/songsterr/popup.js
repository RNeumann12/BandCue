const roomUrl = document.querySelector("#roomUrl");
const connect = document.querySelector("#connect");
const disconnect = document.querySelector("#disconnect");
const play = document.querySelector("#play");
const stop = document.querySelector("#stop");
const suppressAutoOpen = document.querySelector("#suppressAutoOpen");
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
roomUrl.addEventListener("input", () => {
  userEditedRoom = true;
});

chrome.runtime.sendMessage({ type: "popupState" }, (state) => {
  if (!userEditedRoom && (state?.roomInput || state?.roomUrl)) {
    roomUrl.value = state.roomInput || state.roomUrl;
  }
  suppressAutoOpen.checked = Boolean(state?.suppressAutoOpen);
  renderState(state);
});

setInterval(refreshState, 1000);

connect.addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "popupConnect", roomUrl: roomUrl.value }, renderState);
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
