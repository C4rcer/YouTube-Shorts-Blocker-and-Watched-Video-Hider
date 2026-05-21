# YouTube Shorts Blocker and Watched Video Hider

A Tampermonkey / Greasemonkey userscript that cleans up YouTube by:

- Removing **all Shorts** — sidebar entries, the channel "Shorts" tab, shelves on the home page and search results, and `/shorts/<id>` URLs (auto-redirected to `/watch?v=<id>`).
- Hiding **already-watched videos** once their progress bar passes a configurable threshold (default 75%).
- Letting you **permanently hide any tile** with `Ctrl + right-click`. Hidden IDs are persisted in `localStorage` and stay hidden across reloads.
- Stripping non-video clutter — ad slots, promo banners, feed nudges, emergency one-boxes, clarification cards — so the home-page grid reflows with no empty slots.

Works on `www.youtube.com` and `m.youtube.com`.

## Install

1. Install [Tampermonkey](https://www.tampermonkey.net/) (Chrome, Edge, Firefox, Safari) or another userscript manager (Violentmonkey, Greasemonkey).
2. Create a new userscript and paste the contents of [`YouTube-Shorts-Blocker-and-Watched-Video-Hider`](YouTube-Shorts-Blocker-and-Watched-Video-Hider) into it, or drag the file onto the Tampermonkey dashboard.
3. Save. Reload any open YouTube tab.

## Usage

### Hiding a tile manually

Hold **Ctrl** and right-click any video tile (home feed, subscriptions, search results, channel page, sidebar recommendations). The tile is removed immediately and its video ID is saved so it stays hidden on future visits.

> Firefox unconditionally bypasses page context-menu handlers when **Shift** is held, so `Ctrl` is used instead. A plain right-click still opens the normal YouTube/browser menu.

### Console helpers

Open DevTools on any YouTube page and run:

| Command | What it does |
| --- | --- |
| `ytsbListHidden()` | Returns the array of currently hidden video IDs. |
| `ytsbUnhide("VIDEO_ID")` | Removes one ID from the hidden list. Reload to see the video again. |
| `ytsbResetHidden()` | Clears the entire hidden list. Returns how many were removed. |

## Configuration

Edit the constants at the top of the script:

```js
const WATCHED_THRESHOLD = 75;   // hide videos watched >= this %
const HIDDEN_STORAGE_KEY = 'ytShortsBlocker_manuallyHiddenIds';
```

The 75% threshold (rather than 100%) compensates for YouTube under-reporting completion, especially on channel pages.

## How it works

- A `MutationObserver` plus a 1.5 s safety interval re-runs the cleanup pass whenever YouTube swaps in new tiles (infinite scroll, SPA navigation).
- `ytd-rich-grid-row` wrappers are flattened with `display: contents` so removing tiles doesn't leave gaps in the grid.
- Watched-state is detected from the thumbnail progress bar's inline `width` style — both the legacy `#progress` element and the newer `ytThumbnailOverlayProgressBarHostWatchedProgressBar*` Lit components are handled.
- Manually-hidden IDs are stored as a JSON array in `localStorage` under `ytShortsBlocker_manuallyHiddenIds`.

## License

No license file is included; treat as "all rights reserved" unless the author adds one.
