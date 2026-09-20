let settings;
let decisionLog = [];
let stateHasApiKey = false;

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

/** Returns the highest-scoring filter for a decision. */
function topMatch(decision) {
  const entry = Object.entries(decision?.scores || {}).sort((left, right) => right[1] - left[1])[0];
  if (!entry) return { label: "—", score: undefined };
  const rule = settings.rules.find((candidate) => candidate.id === entry[0]);
  return { label: rule?.label || entry[0], score: entry[1] };
}

/** Renders the most recent classifier decisions and failures. */
function renderLog() {
  const body = document.querySelector("#decision-log");
  body.replaceChildren();
  [...decisionLog].reverse().forEach((record) => {
    const row = document.createElement("tr");
    const decision = record.decision;
    const error = record.error;
    const match = topMatch(decision);
    row.append(
      cell(new Date(record.timestamp).toLocaleString()),
      cell(error ? "ERROR" : decision?.blocked ? "BLOCK" : "ALLOW"),
      cell(formatProbability(match.score)),
      cell(match.label),
      cell(record.video?.channel || ""),
      cell(record.video?.title || ""),
      cell(
        error
          ? `${error.code}: ${error.message}`
          : decision?.cached
            ? "cache"
            : `${decision?.latencyMs ?? "—"}ms`,
      ),
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

/** Displays connection state without exposing the saved credential. */
function renderCredentialStatus(message = "", isError = false) {
  const onboarding = document.querySelector("#onboarding");
  const status = document.querySelector("#credential-status");
  document.body.classList.toggle("has-api-key", stateHasApiKey);
  onboarding.classList.toggle("connected", stateHasApiKey);
  onboarding.classList.toggle("connection-error", isError);
  if (stateHasApiKey && !isError) onboarding.classList.remove("editing");
  status.textContent = message;
  status.hidden = !message;
}

/** Populates the preset picker with filters that are not already active. */
function renderPresetPicker() {
  const picker = document.querySelector("#preset-picker");
  if (settings.rules.length >= 30) {
    picker.replaceChildren(new Option("30-filter limit reached", ""));
    picker.disabled = true;
    return;
  }
  picker.disabled = false;
  const selectedIds = new Set(settings.rules.map((rule) => rule.id));
  picker.replaceChildren(new Option("Add a filter…", ""));
  JEV_FILTER_PRESETS.filter((preset) => !selectedIds.has(preset.id)).forEach((preset) => {
    picker.append(new Option(preset.label, preset.id));
  });
  picker.append(new Option("Write a custom filter…", "__custom__"));
}

/** Builds one compact editable row for an active filter. */
function createRuleRow(rule) {
  const row = document.createElement("article");
  row.className = "rule-row";

  const copy = document.createElement("div");
  copy.className = "rule-copy";
  const label = document.createElement("strong");
  label.textContent = rule.label;
  const description = document.createElement("span");
  description.textContent = rule.description || "Custom filter";
  copy.append(label, description);

  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "icon-button";
  remove.setAttribute("aria-label", `Remove ${rule.label}`);
  remove.textContent = "Remove";
  remove.addEventListener("click", async () => {
    settings.rules = settings.rules.filter((candidate) => candidate.id !== rule.id);
    await persistSettings(`Removed ${rule.label}.`);
  });

  const details = document.createElement("details");
  details.className = "rule-details";
  const summary = document.createElement("summary");
  summary.textContent = "Edit instruction";
  const question = document.createElement("textarea");
  question.className = "rule-question";
  question.dataset.ruleId = rule.id;
  question.rows = 3;
  question.maxLength = 1200;
  question.value = rule.question;
  details.append(summary, question);

  row.append(copy, remove, details);
  return row;
}

/** Renders the active filter list and its empty state. */
function renderRules() {
  const list = document.querySelector("#active-rules");
  list.replaceChildren();
  if (settings.rules.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = "Nothing is blocked yet. Add a filter above.";
    list.append(empty);
  } else {
    settings.rules.forEach((rule) => list.append(createRuleRow(rule)));
  }
  renderPresetPicker();
}

/** Reads common controls into the current settings object. */
function readGeneralControls() {
  settings.threshold = Number(document.querySelector("#threshold").value);
  settings.hideOnError = document.querySelector("#hide-on-error").checked;
  settings.debugMode = document.querySelector("#debug-mode").checked;
}

/** Persists settings, invalidates cached decisions, and refreshes the rule list. */
async function persistSettings(message) {
  readGeneralControls();
  settings = await chrome.runtime.sendMessage({ type: "SAVE_SETTINGS", settings });
  renderRules();
  const status = document.querySelector("#save-status");
  status.textContent = message;
  window.setTimeout(() => {
    if (status.textContent === message) status.textContent = "";
  }, 3000);
}

/** Loads settings, connection state, and diagnostics into the page. */
async function load() {
  const state = await chrome.runtime.sendMessage({ type: "GET_STATE" });
  settings = state.settings;
  stateHasApiKey = state.hasApiKey;
  document.querySelector("#threshold").value = settings.threshold;
  document.querySelector("#hide-on-error").checked = settings.hideOnError;
  document.querySelector("#debug-mode").checked = settings.debugMode;
  renderRules();
  renderCredentialStatus(
    stateHasApiKey && state.health?.ok === false ? state.health.message : "",
    stateHasApiKey && state.health?.ok === false,
  );
  await refreshLog();
}

/** Tests the saved credential with a small live Jev classification. */
async function testCredential() {
  renderCredentialStatus("Checking the connection…");
  const result = await chrome.runtime.sendMessage({ type: "TEST_CLASSIFIER" });
  if (result.ok) {
    stateHasApiKey = true;
    renderCredentialStatus(`Connected. Jev replied in ${result.decision.latencyMs}ms.`);
  } else {
    renderCredentialStatus(result.error.message, true);
  }
}

/** Saves a newly entered credential and immediately verifies it. */
async function saveCredential(event) {
  event.preventDefault();
  const input = document.querySelector("#api-key");
  const apiKey = input.value.trim();
  if (!apiKey) {
    renderCredentialStatus("Paste a key first.", true);
    return;
  }
  renderCredentialStatus("Saving and checking the key…");
  const result = await chrome.runtime.sendMessage({ type: "SAVE_API_KEY", apiKey });
  input.value = "";
  if (result.error) {
    renderCredentialStatus(result.error.message, true);
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
  document.querySelector("#onboarding").classList.remove("editing");
  renderCredentialStatus("Key removed.");
}

/** Opens the credential input while retaining the current key until replacement succeeds. */
function changeCredential() {
  document.querySelector("#onboarding").classList.add("editing");
  document.querySelector("#api-key").focus();
}

/** Adds a selected catalog preset or opens the custom-filter editor. */
async function choosePreset(event) {
  const id = event.target.value;
  if (!id) return;
  event.target.value = "";
  if (id === "__custom__") {
    document.querySelector("#custom-rule-builder").hidden = false;
    document.querySelector("#custom-rule-label").focus();
    return;
  }
  const preset = JEV_FILTER_PRESETS.find((candidate) => candidate.id === id);
  if (!preset) return;
  settings.rules.push({ ...preset });
  await persistSettings(`Added ${preset.label}.`);
}

/** Adds a user-authored filter to the active rule list. */
async function addCustomRule() {
  const labelInput = document.querySelector("#custom-rule-label");
  const questionInput = document.querySelector("#custom-rule-question");
  const label = labelInput.value.trim();
  const question = questionInput.value.trim();
  if (settings.rules.length >= 30) {
    document.querySelector("#save-status").textContent = "Remove a filter before adding another.";
    return;
  }
  if (!label || !question) {
    document.querySelector("#save-status").textContent = "Give the custom filter a name and instruction.";
    return;
  }
  settings.rules.push({
    id: `custom_${Date.now()}`,
    label,
    description: "Custom filter",
    question,
  });
  labelInput.value = "";
  questionInput.value = "";
  document.querySelector("#custom-rule-builder").hidden = true;
  await persistSettings(`Added ${label}.`);
}

/** Closes and clears the custom-filter editor. */
function cancelCustomRule() {
  document.querySelector("#custom-rule-label").value = "";
  document.querySelector("#custom-rule-question").value = "";
  document.querySelector("#custom-rule-builder").hidden = true;
}

/** Saves edited filter instructions and behavior controls. */
async function save(event) {
  event.preventDefault();
  document.querySelectorAll(".rule-question").forEach((textarea) => {
    const rule = settings.rules.find((candidate) => candidate.id === textarea.dataset.ruleId);
    if (rule) rule.question = textarea.value.trim();
  });
  await persistSettings("Saved. YouTube will reclassify visible recommendations.");
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
document.querySelector("#change-key").addEventListener("click", changeCredential);
document.querySelector("#remove-key").addEventListener("click", removeCredential);
document.querySelector("#preset-picker").addEventListener("change", choosePreset);
document.querySelector("#add-custom-rule").addEventListener("click", addCustomRule);
document.querySelector("#cancel-custom-rule").addEventListener("click", cancelCustomRule);
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
