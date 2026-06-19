const roomUrl = document.querySelector("#roomUrl");
const connect = document.querySelector("#connect");
const play = document.querySelector("#play");
const stop = document.querySelector("#stop");
const status = document.querySelector("#status");

chrome.runtime.sendMessage({ type: "popupState" }, (state) => {
  if (state?.roomInput || state?.roomUrl) {
    roomUrl.value = state.roomInput || state.roomUrl;
  }
  renderState(state);
});

setInterval(refreshState, 1000);

connect.addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "popupConnect", roomUrl: roomUrl.value }, renderState);
});

play.addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "popupTransport", action: "play" }, renderState);
});

stop.addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "popupTransport", action: "stop" }, renderState);
});

function renderState(state) {
  const connected = state?.connected ? "connected" : state?.connectionState || "not connected";
  const adapter = state?.status?.ready ? "Songsterr ready" : "Songsterr not found";
  const detail = state?.status?.detail || state?.connectionDetail || "";
  const command = state?.status?.lastCommand
    ? ` Last command: ${state.status.lastCommand.action} ${state.status.lastCommand.status}.`
    : "";
  status.textContent = `${connected}; ${adapter}. ${detail}${command}`;
}

function refreshState() {
  chrome.runtime.sendMessage({ type: "popupState" }, (state) => {
    if ((state?.roomInput || state?.roomUrl) && !roomUrl.value) {
      roomUrl.value = state.roomInput || state.roomUrl;
    }
    renderState(state);
  });
}
