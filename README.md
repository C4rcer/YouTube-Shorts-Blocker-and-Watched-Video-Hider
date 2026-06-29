# YouTube Channel Blocker & Cleaner (Firefox add-on)

A Firefox extension that cleans up YouTube and lets you **block whole channels**.
It is the successor to the original *YouTube Shorts Blocker and Watched Video Hider*
userscript — all of that behaviour is folded into the content script, plus:

- **Block an entire channel.** Open a video's **⋮ menu** and click **Block channel**
  (added right below YouTube's own *Don't recommend channel*), right-click any video →
  **Block this YouTube channel**, or add a channel in the popup/options by `@handle`,
  channel URL, `UC…` ID, or name. Every tile from a blocked channel is removed everywhere
  (home, search, sidebar, subscriptions, channel pages).
- **Best-effort native "Don't recommend channel".** When you block a channel from a
  tile, the add-on also tries to click YouTube's own *Don't recommend channel* item.
  YouTube only exposes that option on some surfaces, so — as you'd expect — it works
  *occasionally*. The channel is hidden by the add-on regardless.
- **Black out blocked channels.** If you land on a blocked channel's page, or a watch
  page for one of its videos, the add-on stops playback and replaces the player /
  thumbnails with a black panel — so no video, no image, and (best-effort) no view is
  registered. On watch pages the recommendations rail stays visible; a one-click
  *Unblock this channel* button is shown on the panel.
- **Easy import / export.** One-click **Export to file**, **Import from file** (merges,
  no duplicates), and **Copy JSON** to clipboard, from both the toolbar popup and the
  full options page. The block list lives in `browser.storage.local`.
- **Remove all Shorts** — sidebar entries, the channel "Shorts" tab, home/search
  shelves, and `/shorts/<id>` URLs (auto-redirected to `/watch?v=<id>`).
- **Auto max quality.** Sets each new video to the highest available resolution as it loads.
- **Volume boost.** Amplify past 100% (up to 500%) via a Web Audio gain node. Scroll up/down
  over the player to change volume — below 100% it sets native volume, above 100% it boosts.
  The audio graph is only built once you turn the boost up, so default users keep native audio.
- **Hide the sidebar loading spinner** in the recommendations rail (cosmetic; loading still happens).
- **Hide already-watched videos** once their progress bar passes a threshold (default 75%).
- **Hide individual videos** — right-click → **Hide this video**.
- **Strip clutter** — ad slots, promo banners, feed nudges, emergency one-boxes — so the
  grid reflows with no empty slots.

Works on `www.youtube.com` and `m.youtube.com`.

## Install (temporary, for development)

1. Open `about:debugging#/runtime/this-firefox` in Firefox.
2. Click **Load Temporary Add-on…**.
3. Select the [`manifest.json`](manifest.json) in this folder.
4. The toolbar icon appears. Open any YouTube tab (reload existing ones).

> Temporary add-ons are removed when Firefox restarts. For a permanent install, package
> the folder as a `.zip`/`.xpi` and sign it via [addons.mozilla.org](https://addons.mozilla.org/developers/)
> (or run Firefox Developer Edition / Nightly with `xpinstall.signatures.required` set to
> `false` in `about:config`).

## Usage

### Block a channel

- **From the ⋮ menu (recommended):** open a video's three-dot menu and click
  **Block channel** — it's injected right under YouTube's own *Don't recommend channel*.
  If *Auto "Don't recommend channel"* is on (Settings), it also clicks the native option
  in that same open menu.
- **From a video (browser menu):** right-click any tile → **Block this YouTube channel**.
- **From a channel's page:** right-click anywhere → **Block this YouTube channel** (the
  channel is read from the URL/header).
- **By hand:** open the popup (toolbar icon) or **Manage block list…**, type a
  `@handle`, full channel URL, `UC…` ID, or the channel's display name, and click **Block**.

### Hide a single video

Right-click the tile → **Hide this video**, or **Ctrl + right-click** the tile to hide it
instantly. Ctrl + right-click also works on the in-player **end-screen suggestions** (the
video wall shown when a video finishes), which otherwise have no hide affordance. The video
ID is saved and stays hidden across reloads — and hidden IDs / blocked channels are also
filtered out of the end-screen suggestions.

### Import / export

Open the popup or the options page → **Import / Export**:

| Button | What it does |
| --- | --- |
| **Export to file** | Downloads `youtube-blocklist-YYYY-MM-DD.json`. |
| **Import from file** | Merges a previously-exported file into your current list (no duplicates; settings come from the file). |
| **Copy JSON** | Copies the whole block list to the clipboard. |
| **Clear everything** | Removes all blocked channels and hidden videos (keeps settings). |

### Console helpers (on any YouTube page)

| Command | What it does |
| --- | --- |
| `ytsbListHidden()` | Array of hidden video IDs. |
| `ytsbListChannels()` | Array of blocked-channel records. |
| `ytsbUnhide("VIDEO_ID")` | Removes one video ID. |
| `ytsbResetHidden()` | Clears all hidden video IDs. |

## Settings

| Setting | Default | Effect |
| --- | --- | --- |
| Remove Shorts | on | Hides Shorts UI + redirects `/shorts/` to `/watch`. |
| Hide watched videos | on | Removes tiles whose progress bar ≥ threshold. |
| Watched threshold | 75% | The 75% (not 100%) value compensates for YouTube under-reporting completion on channel pages. |
| Auto "Don't recommend channel" | on | Best-effort native click when blocking from a tile. |
| Black out blocked channels | on | Stop playback and hide the player/thumbnails behind a black panel on a blocked channel's page or video (recommendations stay). |
| Auto max quality | on | Force each new video to the highest available resolution. |
| Scroll-over-player volume | on | Scroll on the player to change volume; past 100% it boosts. |
| Volume boost | 100% | Web Audio amplification (100–500%); the graph is only built when boost > 100%. |
| Hide sidebar loading spinner | on | Hide the recommendations-rail loading spinner (cosmetic). |
| Reduce flashing | on | Keep watched videos hidden from the start (CSS) instead of letting them paint then get removed — no pop-in/out when sorting oldest-first. |
| Hide end-screen suggestions | on | Remove the suggested-video grid shown over the player when a video ends, plus pause-screen suggestions. |

## How it works

- **`src/content.js`** runs at `document_start`. A debounced `MutationObserver` (added/removed
  nodes only) plus a 2 s safety interval re-runs the cleanup pass on infinite-scroll / SPA
  navigation — debouncing keeps channel pages with thousands of tiles responsive. Blocked-channel
  matching merges the `@handle`, `UC…` ID, and display name found across a tile's links and
  compares against the block list (case-insensitive). Tiles are tagged per config version so
  unchanged tiles aren't re-scanned.
- **`src/background.js`** registers the right-click menu entries and relays clicks to the
  content script of the active tab.
- **`src/popup.{html,js}`** and **`src/options.{html,js}`** are the management UI, sharing
  storage helpers in **`src/common.js`**. State lives in `browser.storage.local` under `data`
  and is kept in sync across all contexts via `storage.onChanged`.
- Existing data from the old userscript (`localStorage` key
  `ytShortsBlocker_manuallyHiddenIds`) is imported automatically the first time the add-on
  loads on a YouTube page.

## Project layout

```
manifest.json
icons/icon.svg
src/
  content.js     content.css   — the on-page engine
  background.js                 — context-menu registration + relay
  common.js                     — shared storage/import/export helpers
  popup.html     popup.js       — toolbar popup
  options.html   options.js     — full manager
  ui.css                        — shared popup/options styling
```

## License

No license file is included; treat as "all rights reserved" unless the author adds one.
