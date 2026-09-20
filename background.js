importScripts("presets.js");

const JEV_URL = "https://api.typesafe.ai/v1/systemone";
const MAX_CACHE_ENTRIES = 3000;
const MAX_LOG_ENTRIES = 500;
const BATCH_WINDOW_MS = 80;
const MAX_BATCH_SIZE = 20;
const MAX_QUESTIONS_PER_REQUEST = 40;
const CACHE_VERSION = 3;
const LEGACY_TV_CLIP_QUESTION =
  "Is this video primarily a clip or compilation from a television show or movie?";
const PRESET_BY_ID = Object.fromEntries(JEV_FILTER_PRESETS.map((preset) => [preset.id, preset]));
let memoryCache = null;
let memoryLog = null;
let logLoadPromise = null;
let cachePersistTimer = null;
let logPersistTimer = null;
let batchQueue = [];
let batchTimer = null;
let batchRunning = false;

const DEFAULT_SETTINGS = {
  enabled: true,
  debugMode: false,
  hideOnError: true,
  threshold: 0.7,
  rules: [PRESET_BY_ID.video_games, PRESET_BY_ID.tv_movie_clips].map((rule) => ({ ...rule })),
};

/** Prevents content scripts and webpages from reading extension-local data directly. */
async function restrictStorageAccess() {
  if (chrome.storage.local.setAccessLevel) {
    await chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
  }
}

void restrictStorageAccess();

/** Sanitizes persisted filter rules before using them in requests. */
function normalizeRules(rules) {
  if (!Array.isArray(rules)) return [];
  return rules
    .slice(0, 30)
    .map((rule, index) => ({
      id: String(rule.id || `custom_${index}`).replace(/[^a-z0-9_]/gi, "_").slice(0, 64),
      label: String(rule.label || "Custom filter").trim().slice(0, 80),
      description: String(rule.description || "").trim().slice(0, 180),
      question: String(rule.question || "").trim().slice(0, 1200),
    }))
    .filter((rule) => rule.label && rule.question);
}

/** Returns saved settings merged with current defaults and migrates legacy questions. */
async function getSettings() {
  const stored = await chrome.storage.local.get("settings");
  const saved = stored.settings || {};
  const { gamingQuestion, tvClipQuestion, ...savedSettings } = saved;
  const migratedRules = Array.isArray(saved.rules)
    ? normalizeRules(saved.rules)
    : normalizeRules([
        {
          ...PRESET_BY_ID.video_games,
          question: gamingQuestion || PRESET_BY_ID.video_games.question,
        },
        {
          ...PRESET_BY_ID.tv_movie_clips,
          question:
            !tvClipQuestion || tvClipQuestion === LEGACY_TV_CLIP_QUESTION
              ? PRESET_BY_ID.tv_movie_clips.question
              : tvClipQuestion,
        },
      ]);
  const settings = { ...DEFAULT_SETTINGS, ...savedSettings, rules: migratedRules };
  if (!Array.isArray(saved.rules) || gamingQuestion || tvClipQuestion) {
    memoryCache = {};
    await chrome.storage.local.set({
      settings,
      decisionCache: {},
      decisionCacheVersion: CACHE_VERSION,
    });
  }
  return settings;
}

/** Saves settings and invalidates decisions made under older instructions. */
async function saveSettings(settings) {
  const { gamingQuestion: _gamingQuestion, tvClipQuestion: _tvClipQuestion, ...current } = settings;
  const normalized = {
    ...DEFAULT_SETTINGS,
    ...current,
    rules: normalizeRules(settings.rules),
    threshold: Math.min(0.99, Math.max(0.01, Number(settings.threshold))),
  };
  memoryCache = {};
  await chrome.storage.local.set({
    settings: normalized,
    decisionCache: {},
    decisionCacheVersion: CACHE_VERSION,
  });
  const tabs = await chrome.tabs.query({ url: "https://www.youtube.com/*" });
  await Promise.all(
    tabs.map((tab) =>
      chrome.tabs
        .sendMessage(tab.id, { type: "SETTINGS_UPDATED", settings: normalized })
        .catch(() => {}),
    ),
  );
  return normalized;
}

/** Returns the durable decision cache. */
async function getCache() {
  if (memoryCache) return memoryCache;
  const stored = await chrome.storage.local.get(["decisionCache", "decisionCacheVersion"]);
  if (stored.decisionCacheVersion !== CACHE_VERSION) {
    memoryCache = {};
    await chrome.storage.local.set({
      decisionCache: {},
      decisionCacheVersion: CACHE_VERSION,
    });
    return memoryCache;
  }
  memoryCache = stored.decisionCache || {};
  return memoryCache;
}

/** Stores a bounded cache entry for one YouTube video. */
async function putCache(videoId, decision) {
  const cache = await getCache();
  cache[videoId] = { ...decision, cachedAt: new Date().toISOString() };
  const ids = Object.keys(cache);
  if (ids.length > MAX_CACHE_ENTRIES) {
    ids
      .sort((left, right) => cache[left].cachedAt.localeCompare(cache[right].cachedAt))
      .slice(0, ids.length - MAX_CACHE_ENTRIES)
      .forEach((id) => delete cache[id]);
  }
  if (!cachePersistTimer) {
    cachePersistTimer = setTimeout(async () => {
      cachePersistTimer = null;
      await chrome.storage.local.set({ decisionCache: memoryCache || {} });
    }, 100);
  }
}

/** Returns the in-memory diagnostic log after loading it once. */
async function getLog() {
  if (memoryLog) return memoryLog;
  if (!logLoadPromise) {
    logLoadPromise = chrome.storage.local.get("decisionLog").then((stored) => {
      memoryLog = stored.decisionLog || [];
      return memoryLog;
    });
  }
  return logLoadPromise;
}

/** Appends a bounded diagnostic record and coalesces persistence writes. */
async function appendLog(record) {
  const log = await getLog();
  log.push({ ...record, timestamp: new Date().toISOString() });
  if (log.length > MAX_LOG_ENTRIES) {
    log.splice(0, log.length - MAX_LOG_ENTRIES);
  }
  if (!logPersistTimer) {
    logPersistTimer = setTimeout(async () => {
      logPersistTimer = null;
      await chrome.storage.local.set({ decisionLog: memoryLog || [] });
    }, 100);
  }
}

/** Updates popup health information and the toolbar error badge. */
async function setHealth(health) {
  const value = { ...health, updatedAt: new Date().toISOString() };
  await chrome.storage.local.set({ health: value });
  if (health.ok) {
    await chrome.action.setBadgeText({ text: "" });
  } else {
    await chrome.action.setBadgeBackgroundColor({ color: "#b91c1c" });
    await chrome.action.setBadgeText({ text: "!" });
  }
}

/** Returns the locally stored Jev credential or a configuration error. */
async function getApiKey() {
  const stored = await chrome.storage.local.get("jevApiKey");
  const apiKey = String(stored.jevApiKey || "").trim();
  if (!apiKey) {
    throw {
      code: "missing_api_key",
      message: "Add a Jev API key in the extension settings.",
      httpStatus: 0,
    };
  }
  return apiKey;
}

/** Extracts a bounded message from a Jev error response. */
function providerMessage(payload) {
  const value = payload?.error ?? payload;
  if (typeof value === "string") return value.slice(0, 300);
  if (value && typeof value === "object") {
    const message =
      value.message ||
      value.detail?.message ||
      value.error?.message ||
      value.detail?.error_type ||
      value.code;
    if (typeof message === "string") return message.slice(0, 300);
  }
  return "Jev rejected the request.";
}

/** Converts provider and network failures into stable user-facing error objects. */
function normalizeError(error, status = 0, payload = null) {
  if (error?.code) return error;
  const message = payload ? providerMessage(payload) : error?.message || "Jev request failed.";
  const messageLower = message.toLowerCase();
  let code = "jev_request_rejected";
  if (status === 0) code = "jev_unreachable";
  else if ([401, 403].includes(status)) code = "authentication_or_access_denied";
  else if (status === 402 || /(billing|credit|payment|trial)/.test(messageLower)) {
    code = "billing_or_credits_unavailable";
  } else if (status === 429 || messageLower.includes("quota")) code = "quota_or_rate_limited";
  else if (status >= 500) code = "jev_service_unavailable";
  return {
    code,
    message,
    httpStatus: status,
  };
}

/** Converts Jev rule scores into the extension's block decision. */
function buildDecision(scores, settings, model, latencyMs) {
  const entries = settings.rules.map((rule) => [rule.id, Number(scores?.[rule.id])]);
  if (entries.some(([, score]) => !Number.isFinite(score))) {
    throw normalizeError(new Error("Jev returned invalid probabilities."), 200);
  }
  const [topRuleId, topScore] = entries.sort((left, right) => right[1] - left[1])[0] || [null, 0];
  const matchedRule = settings.rules.find((rule) => rule.id === topRuleId) || null;
  const blocked = topScore >= settings.threshold;
  return {
    blocked,
    reason: blocked ? topRuleId : "allowed",
    matchedRule: blocked ? matchedRule?.label || topRuleId : null,
    scores: Object.fromEntries(entries),
    threshold: settings.threshold,
    latencyMs,
    model: model || "unknown",
    cached: false,
  };
}

/** Requests one uncached Jev decision directly from the extension worker. */
async function requestDecision(video, settings) {
  const startedAt = performance.now();
  const questions = {};
  settings.rules.forEach((rule, index) => {
    questions[`rule_${index}`] = { type: "noul", instructions: rule.question };
  });
  let response;
  try {
    const apiKey = await getApiKey();
    response = await fetch(JEV_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "jev-latest",
        state: { title: video.title, channel: video.channel },
        questions,
      }),
    });
  } catch (error) {
    throw normalizeError(error);
  }

  let payload;
  try {
    payload = await response.json();
  } catch (error) {
    throw normalizeError(error, response.status);
  }
  if (!response.ok) {
    throw normalizeError(new Error("Classifier request failed."), response.status, payload);
  }

  const scores = Object.fromEntries(
    settings.rules.map((rule, index) => [rule.id, payload.answers?.[`rule_${index}`]?.noul]),
  );
  return buildDecision(scores, settings, payload.model, Math.round(performance.now() - startedAt));
}

/** Calculates a batch size that keeps Jev question fan-out bounded. */
function batchSizeFor(settings) {
  return Math.min(
    MAX_BATCH_SIZE,
    Math.max(1, Math.floor(MAX_QUESTIONS_PER_REQUEST / Math.max(1, settings.rules.length))),
  );
}

/** Schedules the next recommendation batch after a short collection window. */
function scheduleBatch() {
  if (batchRunning || batchTimer || batchQueue.length === 0) return;
  batchTimer = setTimeout(() => {
    batchTimer = null;
    void flushBatch();
  }, BATCH_WINDOW_MS);
}

/** Sends up to twenty queued recommendations through one parallel Jev request. */
async function flushBatch() {
  if (batchRunning || batchQueue.length === 0) return;
  batchRunning = true;
  const batch = batchQueue.splice(0, batchSizeFor(batchQueue[0].settings));
  const settings = batch[0].settings;
  const startedAt = performance.now();
  try {
    const apiKey = await getApiKey();
    const stateVideos = batch.map((entry, index) => ({
      reference: `video_${index}`,
      title: entry.video.title,
      channel: entry.video.channel,
    }));
    const questions = {};
    batch.forEach((entry, index) => {
      const reference = `video_${index}`;
      entry.settings.rules.forEach((rule, ruleIndex) => {
        questions[`${reference}_rule_${ruleIndex}`] = {
          type: "noul",
          instructions: `For ${reference} only: ${rule.question}`,
        };
      });
    });
    const response = await fetch(JEV_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "jev-latest",
        state: { videos: stateVideos },
        questions,
      }),
    });
    let payload;
    try {
      payload = await response.json();
    } catch (error) {
      throw normalizeError(error, response.status);
    }
    if (!response.ok) {
      throw normalizeError(new Error("Classifier request failed."), response.status, payload);
    }
    const latencyMs = Math.round(performance.now() - startedAt);
    void setHealth({
      ok: true,
      message: "Jev classification is working.",
      lastSuccessAt: new Date().toISOString(),
      model: payload.model || "unknown",
    });
    batch.forEach((entry, index) => {
      try {
        const scores = Object.fromEntries(
          entry.settings.rules.map((rule, ruleIndex) => [
            rule.id,
            payload.answers?.[`video_${index}_rule_${ruleIndex}`]?.noul,
          ]),
        );
        entry.resolve(
          buildDecision(scores, entry.settings, payload.model, latencyMs),
        );
      } catch (error) {
        entry.reject(error);
      }
    });
  } catch (error) {
    const normalized = error?.code ? error : normalizeError(error);
    void setHealth({ ok: false, ...normalized });
    batch.forEach((entry) => entry.reject(normalized));
  } finally {
    batchRunning = false;
    scheduleBatch();
  }
}

/** Stores a Jev API key locally without returning it to extension pages. */
async function saveApiKey(apiKey) {
  const normalized = String(apiKey || "").trim();
  if (!normalized) throw new Error("Enter a Jev API key.");
  memoryCache = {};
  await chrome.storage.local.set({
    jevApiKey: normalized,
    decisionCache: {},
    decisionCacheVersion: CACHE_VERSION,
    health: {
      ok: null,
      message: "API key saved. Run Test classifier now to verify access.",
      updatedAt: new Date().toISOString(),
    },
  });
  await chrome.action.setBadgeText({ text: "" });
  return { ok: true };
}

/** Removes the locally stored Jev credential and marks filtering unconfigured. */
async function clearApiKey() {
  await chrome.storage.local.remove("jevApiKey");
  await setHealth({
    ok: false,
    code: "missing_api_key",
    message: "Add a Jev API key in the extension settings.",
  });
  return { ok: true };
}

/** Adds one recommendation to the next parallel classification batch. */
function enqueueBatch(video, settings) {
  return new Promise((resolve, reject) => {
    batchQueue.push({ video, settings, resolve, reject });
    if (!batchRunning && batchQueue.length >= batchSizeFor(settings)) {
      if (batchTimer) clearTimeout(batchTimer);
      batchTimer = null;
      void flushBatch();
    } else {
      scheduleBatch();
    }
  });
}

/** Runs a small uncached provider request and updates visible health state. */
async function testClassifier() {
  const currentSettings = await getSettings();
  const settings = {
    ...currentSettings,
    rules: currentSettings.rules.length
      ? currentSettings.rules
      : normalizeRules([PRESET_BY_ID.video_games]),
  };
  try {
    const decision = await requestDecision(
      {
        videoId: "health-check",
        title: "Beginner guide to building a house in Minecraft",
        channel: "Example Gaming Channel",
      },
      settings,
    );
    await setHealth({
      ok: true,
      message: "Jev classification is working.",
      lastSuccessAt: new Date().toISOString(),
      model: decision.model,
    });
    return { ok: true, decision };
  } catch (error) {
    const normalized = error?.code ? error : normalizeError(error);
    await setHealth({ ok: false, ...normalized });
    return { ok: false, error: normalized };
  }
}

/** Classifies one recommendation with caching, logging, and health reporting. */
async function classify(video) {
  const settings = await getSettings();
  if (!settings.enabled) {
    return { blocked: false, reason: "filter_disabled", disabled: true };
  }
  if (settings.rules.length === 0) {
    return {
      blocked: false,
      reason: "no_filters_configured",
      scores: {},
      threshold: settings.threshold,
      cached: false,
    };
  }

  const cache = await getCache();
  if (cache[video.videoId]) {
    const cached = { ...cache[video.videoId], cached: true };
    await appendLog({ video, decision: cached });
    return cached;
  }

  try {
    const decision = await enqueueBatch(video, settings);
    await putCache(video.videoId, decision);
    await appendLog({ video, decision });
    return decision;
  } catch (error) {
    const normalized = error?.code ? error : normalizeError(error);
    await appendLog({ video, error: normalized });
    return { error: normalized, blocked: settings.hideOnError, reason: "classification_error" };
  }
}

/** Returns extension state for the popup and options page. */
async function getState() {
  const settings = await getSettings();
  const stored = await chrome.storage.local.get([
    "jevApiKey",
    "health",
    "decisionCache",
    "decisionLog",
  ]);
  const cache = stored.decisionCache || {};
  const log = stored.decisionLog || [];
  const hasApiKey = Boolean(String(stored.jevApiKey || "").trim());
  return {
    settings,
    hasApiKey,
    health: hasApiKey
      ? stored.health || { ok: null, message: "No classification attempted yet." }
      : {
          ok: false,
          code: "missing_api_key",
          message: "Add a Jev API key in the extension settings.",
        },
    cacheSize: Object.keys(cache).length,
    logSize: log.length,
  };
}

/** Handles messages from content, popup, and options pages. */
async function handleMessage(message) {
  switch (message.type) {
    case "CLASSIFY":
      return classify(message.video);
    case "GET_STATE":
      return getState();
    case "GET_SETTINGS":
      return getSettings();
    case "TEST_CLASSIFIER":
      return testClassifier();
    case "SAVE_SETTINGS":
      return saveSettings(message.settings);
    case "SAVE_API_KEY":
      return saveApiKey(message.apiKey);
    case "CLEAR_API_KEY":
      return clearApiKey();
    case "GET_LOG": {
      return getLog();
    }
    case "CLEAR_CACHE":
      memoryCache = {};
      await chrome.storage.local.set({
        decisionCache: {},
        decisionCacheVersion: CACHE_VERSION,
      });
      return { ok: true };
    case "CLEAR_LOG":
      memoryLog = [];
      logLoadPromise = Promise.resolve(memoryLog);
      await chrome.storage.local.set({ decisionLog: [] });
      return { ok: true };
    default:
      throw new Error(`Unknown message type: ${message.type}`);
  }
}

/** Returns whether a message came from this extension's own trusted UI. */
function isTrustedExtensionPage(sender) {
  return sender.id === chrome.runtime.id && sender.url?.startsWith(chrome.runtime.getURL(""));
}

/** Returns whether a message is an allowed request from the YouTube content script. */
function isAllowedContentRequest(message, sender) {
  if (sender.id !== chrome.runtime.id || !sender.tab?.url) return false;
  try {
    const url = new URL(sender.tab.url);
    return (
      url.protocol === "https:" &&
      url.hostname === "www.youtube.com" &&
      ["CLASSIFY", "GET_SETTINGS"].includes(message.type)
    );
  } catch {
    return false;
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!isTrustedExtensionPage(sender) && !isAllowedContentRequest(message, sender)) {
    sendResponse({
      error: { code: "untrusted_sender", message: "This extension action is not allowed here." },
    });
    return false;
  }
  handleMessage(message).then(sendResponse).catch((error) =>
    sendResponse({
      error: { code: "extension_error", message: error.message || String(error) },
    }),
  );
  return true;
});

chrome.runtime.onInstalled.addListener(async (details) => {
  await restrictStorageAccess();
  const stored = await chrome.storage.local.get("settings");
  if (!stored.settings) {
    await chrome.storage.local.set({
      settings: DEFAULT_SETTINGS,
      decisionCacheVersion: CACHE_VERSION,
    });
  }
  if (details.reason === "install") {
    await chrome.runtime.openOptionsPage();
  }
});

chrome.runtime.onStartup.addListener(restrictStorageAccess);
