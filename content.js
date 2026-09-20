const CARD_SELECTOR = "ytd-rich-item-renderer";
const PROCESSED_ATTRIBUTE = "data-jev-filter-video-id";
let currentSettings = null;
let scanScheduled = false;

/** Extracts stable recommendation metadata from a YouTube Home card. */
function extractVideo(card) {
  let titleLink = card.querySelector(
    [
      "a#video-title-link[href*='/watch?v=']",
      "a#video-title[href*='/watch?v=']",
      "a.yt-lockup-metadata-view-model__title[href*='/watch?v=']",
      "h3 a[href*='/watch?v=']",
    ].join(", "),
  );
  if (!titleLink) {
    titleLink = [...card.querySelectorAll("a[href*='/watch?v=']")].find(
      (link) => (link.getAttribute("title") || link.textContent || "").trim().length > 0,
    );
  }
  if (!titleLink) return null;
  const url = new URL(titleLink.href, location.origin);
  const videoId = url.searchParams.get("v");
  const title = (titleLink.getAttribute("title") || titleLink.textContent || "").trim();
  const channelElement = card.querySelector(
    [
      "ytd-channel-name a",
      "#channel-name a",
      ".yt-content-metadata-view-model__metadata-row:first-child a[href^='/@']",
      ".yt-content-metadata-view-model__metadata-row:first-child a[href^='/channel/']",
    ].join(", "),
  );
  let channel = (channelElement?.textContent || "").trim();
  if (!channel) {
    const channelLink = [...card.querySelectorAll("a[href]")].find((link) =>
      /^\/(?:@|channel\/|c\/|user\/)/.test(link.getAttribute("href") || ""),
    );
    channel = (channelLink?.textContent || "").trim();
  }
  if (!channel) {
    const metadataRow = card.querySelector(
      ".yt-content-metadata-view-model__metadata-row:first-child",
    );
    channel = (metadataRow?.textContent || "").split(/[•·]/, 1)[0].trim();
  }
  if (!videoId || !title) return null;
  return { videoId, title, channel };
}

/** Creates or updates the visible diagnostic annotation for a card. */
function renderDebug(card, video, decision) {
  let panel = card.querySelector(".jev-filter-debug");
  if (!panel) {
    panel = document.createElement("div");
    panel.className = "jev-filter-debug";
    const host =
      card.querySelector("ytd-rich-grid-media, yt-lockup-view-model, #content") || card;
    host.append(panel);
  }
  panel.replaceChildren();
  const heading = document.createElement("strong");
  heading.textContent = decision.error
    ? `ERROR · ${decision.error.code}`
    : `${decision.blocked ? "BLOCK" : "ALLOW"} · ${decision.matchedRule || decision.reason}`;
  const details = document.createElement("span");
  const topScores = Object.entries(decision.scores || {})
    .sort((left, right) => right[1] - left[1])
    .slice(0, 4)
    .map(([ruleId, score]) => {
      const rule = currentSettings?.rules?.find((candidate) => candidate.id === ruleId);
      return `${rule?.label || ruleId} ${(score * 100).toFixed(0)}%`;
    })
    .join(" · ");
  details.textContent = decision.error
    ? decision.error.message
    : `${topScores || "no active filters"} · threshold ${(decision.threshold * 100).toFixed(0)}% · ${decision.cached ? "cache" : `${decision.latencyMs}ms`}`;
  const input = document.createElement("span");
  input.textContent = `${video.channel || "Unknown channel"} · ${video.title}`;
  panel.append(heading, details, input);
}

/** Applies a classifier response to one recommendation card. */
function applyDecision(card, video, decision) {
  card.classList.remove("jev-filter-pending", "jev-filter-blocked", "jev-filter-error");
  if (decision.error) card.classList.add("jev-filter-error");
  if (decision.blocked) card.classList.add("jev-filter-blocked");
  if (currentSettings?.debugMode) {
    card.classList.add("jev-filter-debug-visible");
    renderDebug(card, video, decision);
  } else {
    card.classList.remove("jev-filter-debug-visible");
    card.querySelector(".jev-filter-debug")?.remove();
  }
}

/** Sends one unseen recommendation to the extension classifier. */
async function processCard(card) {
  const video = extractVideo(card);
  if (!video) return;
  if (card.getAttribute(PROCESSED_ATTRIBUTE) === video.videoId) return;

  card.setAttribute(PROCESSED_ATTRIBUTE, video.videoId);
  card.classList.remove("jev-filter-blocked", "jev-filter-error", "jev-filter-debug-visible");
  card.classList.add("jev-filter-pending");
  try {
    const decision = await chrome.runtime.sendMessage({ type: "CLASSIFY", video });
    if (card.getAttribute(PROCESSED_ATTRIBUTE) !== video.videoId) return;
    applyDecision(card, video, decision);
  } catch (error) {
    applyDecision(card, video, {
      blocked: currentSettings?.hideOnError ?? true,
      error: { code: "extension_unreachable", message: error.message || String(error) },
    });
  }
}

/** Scans the current YouTube Home grid for recommendation cards. */
function scan() {
  scanScheduled = false;
  if (location.pathname !== "/") return;
  document.querySelectorAll(CARD_SELECTOR).forEach((card) => void processCard(card));
}

/** Coalesces YouTube's frequent DOM mutations into one feed scan per frame. */
function scheduleScan() {
  if (scanScheduled) return;
  scanScheduled = true;
  requestAnimationFrame(scan);
}

/** Clears card state so changed questions and thresholds apply immediately. */
function resetCards() {
  document.querySelectorAll(CARD_SELECTOR).forEach((card) => {
    card.removeAttribute(PROCESSED_ATTRIBUTE);
    card.classList.remove(
      "jev-filter-pending",
      "jev-filter-blocked",
      "jev-filter-error",
      "jev-filter-debug-visible",
    );
    card.querySelector(".jev-filter-debug")?.remove();
  });
  scan();
}

/** Loads settings and starts observing YouTube's dynamically updated feed. */
async function start() {
  currentSettings = await chrome.runtime.sendMessage({ type: "GET_SETTINGS" });
  const observer = new MutationObserver(scheduleScan);
  observer.observe(document.documentElement, { childList: true, subtree: true });
  document.addEventListener("yt-navigate-finish", scheduleScan);
  scheduleScan();
}

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === "SETTINGS_UPDATED") {
    currentSettings = message.settings;
    resetCards();
  }
});

void start();
