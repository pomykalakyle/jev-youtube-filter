let settings;
let decisionLog = [];

/** Formats probability values for the diagnostic table. */
function formatProbability(value) {
  return Number.isFinite(value) ? `${(value * 100).toFixed(0)}%` : "—";
}

/** Creates a plain text table cell without injecting HTML. */
function cell(text) {
  const element = document.createElement("td");
  element.textContent = text;
  return element;
}

/** Renders the most recent classifier decisions and failures. */
function renderLog() {
  const body = document.querySelector("#decision-log");
  body.replaceChildren();
  [...decisionLog].reverse().forEach((record) => {
    const row = document.createElement("tr");
    const decision = record.decision;
    const error = record.error;
    row.append(
      cell(new Date(record.timestamp).toLocaleString()),
      cell(error ? "ERROR" : decision?.blocked ? "BLOCK" : "ALLOW"),
      cell(formatProbability(decision?.probabilities?.gaming)),
      cell(formatProbability(decision?.probabilities?.tvClip)),
      cell(record.video?.channel || ""),
      cell(record.video?.title || ""),
      cell(error ? `${error.code}: ${error.message}` : decision?.cached ? "cache" : `${decision?.latencyMs ?? "—"}ms`),
    );
    body.append(row);
  });
  document.querySelector("#log-summary").textContent = `${decisionLog.length} recent classification events`;
}

/** Reloads the diagnostic log from extension storage. */
async function refreshLog() {
  decisionLog = await chrome.runtime.sendMessage({ type: "GET_LOG" });
  renderLog();
}

/** Displays whether an API key is configured without exposing its value. */
function renderCredentialStatus(message = "") {
  const status = document.querySelector("#credential-status");
  status.textContent = message || (stateHasApiKey ? "A key is saved in this browser profile." : "No key saved.");
}

let stateHasApiKey = false;

/** Loads current settings and credential state into the form. */
async function load() {
  const state = await chrome.runtime.sendMessage({ type: "GET_STATE" });
  settings = state.settings;
  stateHasApiKey = state.hasApiKey;
  document.querySelector("#gaming-question").value = settings.gamingQuestion;
  document.querySelector("#tv-question").value = settings.tvClipQuestion;
  document.querySelector("#threshold").value = settings.threshold;
  document.querySelector("#hide-on-error").checked = settings.hideOnError;
  document.querySelector("#debug-mode").checked = settings.debugMode;
  renderCredentialStatus();
  await refreshLog();
}

/** Tests the saved credential with a small live Jev classification. */
async function testCredential() {
  renderCredentialStatus("Testing…");
  const result = await chrome.runtime.sendMessage({ type: "TEST_CLASSIFIER" });
  if (result.ok) {
    stateHasApiKey = true;
    renderCredentialStatus(`Working (${result.decision.latencyMs}ms).`);
  } else {
    renderCredentialStatus(`${result.error.code}: ${result.error.message}`);
  }
}

/** Saves a newly entered credential and immediately verifies it. */
async function saveCredential(event) {
  event.preventDefault();
  const input = document.querySelector("#api-key");
  const apiKey = input.value.trim();
  if (!apiKey) {
    renderCredentialStatus("Paste a key before saving.");
    return;
  }
  const result = await chrome.runtime.sendMessage({ type: "SAVE_API_KEY", apiKey });
  input.value = "";
  if (result.error) {
    renderCredentialStatus(result.error.message);
    return;
  }
  stateHasApiKey = true;
  await testCredential();
}

/** Removes the saved credential from this browser profile. */
async function removeCredential() {
  await chrome.runtime.sendMessage({ type: "CLEAR_API_KEY" });
  document.querySelector("#api-key").value = "";
  stateHasApiKey = false;
  renderCredentialStatus("Key removed.");
}

/** Saves editable classifier instructions and behavior. */
async function save(event) {
  event.preventDefault();
  settings = await chrome.runtime.sendMessage({
    type: "SAVE_SETTINGS",
    settings: {
      ...settings,
      gamingQuestion: document.querySelector("#gaming-question").value.trim(),
      tvClipQuestion: document.querySelector("#tv-question").value.trim(),
      threshold: Number(document.querySelector("#threshold").value),
      hideOnError: document.querySelector("#hide-on-error").checked,
      debugMode: document.querySelector("#debug-mode").checked,
    },
  });
  const status = document.querySelector("#save-status");
  status.textContent = "Saved; cached decisions cleared.";
  window.setTimeout(() => (status.textContent = ""), 3000);
}

/** Downloads the current decision log as JSON. */
function exportLog() {
  const blob = new Blob([JSON.stringify(decisionLog, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `youtube-feed-filter-${new Date().toISOString().replaceAll(":", "-")}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
}

document.querySelector("#settings-form").addEventListener("submit", save);
document.querySelector("#credential-form").addEventListener("submit", saveCredential);
document.querySelector("#test-key").addEventListener("click", testCredential);
document.querySelector("#remove-key").addEventListener("click", removeCredential);
document.querySelector("#refresh-log").addEventListener("click", refreshLog);
document.querySelector("#export-log").addEventListener("click", exportLog);
document.querySelector("#clear-log").addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "CLEAR_LOG" });
  await refreshLog();
});
document.querySelector("#clear-cache").addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "CLEAR_CACHE" });
  document.querySelector("#save-status").textContent = "Decision cache cleared.";
});

void load();
