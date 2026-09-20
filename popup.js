let state;

/** Formats an ISO timestamp for compact display. */
function formatTime(value) {
  if (!value) return "—";
  return new Date(value).toLocaleString();
}

/** Renders current classifier health and extension settings. */
function render() {
  const health = state.health;
  const dot = document.querySelector("#status-dot");
  dot.className = `status-dot ${health.ok === true ? "ok" : health.ok === false ? "error" : "unknown"}`;
  document.querySelector("#status-message").textContent = health.message;
  document.querySelector("#last-update").textContent = formatTime(
    health.lastSuccessAt || health.updatedAt,
  );
  document.querySelector("#model").textContent = health.model || "—";
  document.querySelector("#cache-size").textContent = String(state.cacheSize);
  document.querySelector("#enabled").checked = state.settings.enabled;
  document.querySelector("#debug-mode").checked = state.settings.debugMode;
}

/** Saves one popup setting while preserving all other settings. */
async function updateSetting(name, value) {
  state.settings[name] = value;
  state.settings = await chrome.runtime.sendMessage({
    type: "SAVE_SETTINGS",
    settings: state.settings,
  });
  render();
}

/** Runs a live Jev request and refreshes popup health. */
async function testClassifier() {
  const button = document.querySelector("#test-classifier");
  button.disabled = true;
  button.textContent = "Testing…";
  await chrome.runtime.sendMessage({ type: "TEST_CLASSIFIER" });
  state = await chrome.runtime.sendMessage({ type: "GET_STATE" });
  render();
  button.disabled = false;
  button.textContent = "Test classifier now";
}

document.querySelector("#enabled").addEventListener("change", (event) =>
  updateSetting("enabled", event.target.checked),
);
document.querySelector("#debug-mode").addEventListener("change", (event) =>
  updateSetting("debugMode", event.target.checked),
);
document.querySelector("#open-options").addEventListener("click", () =>
  chrome.runtime.openOptionsPage(),
);
document.querySelector("#test-classifier").addEventListener("click", testClassifier);

chrome.runtime.sendMessage({ type: "GET_STATE" }).then((result) => {
  state = result;
  render();
});
