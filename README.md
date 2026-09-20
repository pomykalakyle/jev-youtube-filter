# Jev YouTube Feed Filter

Jev YouTube Feed Filter is a browser extension that semantically filters recommendations on the YouTube Home page.
It sends each video's title and channel directly to [Jev](https://typesafe.ai/) and hides recommendations whose configurable probabilities exceed your threshold.

The default rules target video-game-related content and clips, scenes, excerpts, or compilations from scripted television shows and movies.
Both questions and the blocking threshold are editable.

## Features

- Batches up to 20 recommendations into one parallel Jev request
- Caches decisions by YouTube video ID
- Conceals cards while they are being classified
- Shows authentication, billing, quota, rate-limit, and availability failures
- Includes optional on-card debug annotations with inputs, probabilities, latency, and cache state
- Stores the user's Jev API key only in extension-local browser-profile storage
- Keeps the credential unavailable to YouTube and other content scripts
- Includes an exportable local decision log
- Contains no analytics or tracking
- Does not send YouTube “Not interested” feedback or otherwise modify the user's account

## Browser support

| Platform | Status |
| --- | --- |
| Brave and Chrome on desktop | Supported |
| Edge, Arc, and other Chromium desktop browsers | Expected to work through the same unpacked-extension flow |
| Firefox | Not packaged or tested yet; it may require background and manifest compatibility work |
| Safari | Requires a Safari Web Extension wrapper, Xcode project, and Apple signing |
| Mobile browsers and the YouTube mobile app | Not supported |

The extension itself has no macOS-specific components and should behave the same on macOS, Windows, and Linux Chromium browsers.

## Install

Clone the repository:

```shell
git clone https://github.com/pomykalakyle/jev-youtube-filter.git
cd jev-youtube-filter
```

Load it in Brave:

1. Open `brave://extensions`.
2. Enable **Developer mode**.
3. Choose **Load unpacked**.
4. Select the cloned `jev-youtube-filter` directory.
5. Open the extension's **Details**, then **Extension options**.
6. Paste your Jev API key and choose **Save and test**.

In a macOS folder picker, press **Command–Shift–G** to paste a directory path directly.
Chrome, Edge, Arc, and other Chromium browsers use the equivalent extensions-management page.

## Debugging classifications

Enable **Debug annotations** from the extension popup.
Each recommendation displays the final action and reason, gaming and TV/movie probabilities, threshold, latency or cache status, title and channel sent to Jev, and any API error.

The settings page includes an exportable recent-decision log.
Changing either question or the threshold clears cached decisions and reclassifies open YouTube tabs.

## How it works

```text
YouTube Home card
    -> title and channel extraction
    -> local cache lookup
    -> 80 ms batching window
    -> direct Jev API request from the extension service worker
    -> hide or reveal the card
```

The extension groups up to 20 videos into one request with two independent questions per video.
In prototype testing, a 20-video and 40-question request completed in roughly 400 ms.
Actual latency depends on the network and Jev service.

## Privacy and credential security

The extension sends video titles, channel names, and the configured questions to Jev for classification.
It does not send thumbnails, descriptions, watch history, cookies, or Google account credentials.

The user supplies their own Jev API key.
The key is stored in `chrome.storage.local`, is not synced between browsers, is never included in logs or exports, and is never returned to the YouTube content script.
The extension restricts local storage to trusted extension contexts, so webpages and content scripts cannot read it directly.

Browser extension storage is not equivalent to macOS Keychain or another operating-system credential vault.
A user or malicious program with access to the local browser profile may be able to recover it.
For a consumer service where the publisher pays for usage, the safer architecture is a separate authenticated backend that holds the publisher's provider key and proxies narrowly scoped requests.

## Limitations

- YouTube changes its markup periodically, so title and channel extraction may need maintenance.
- Ambiguous titles can still be misclassified without descriptions or thumbnails.
- Jev access, pricing, and quotas are controlled by the API provider.
- This repository provides an unpacked development extension rather than a signed browser-store release.

## Development checks

```shell
node --check background.js
node --check content.js
node --check options.js
node --check popup.js
node -e 'JSON.parse(require("fs").readFileSync("manifest.json", "utf8"))'
```

## License

MIT
