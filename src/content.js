/* ==================================================================
 * YouTube Channel Blocker & Cleaner — content script
 *
 * Runs on every YouTube page. Responsibilities:
 *   - Remove Shorts (sidebar, tabs, shelves, /shorts redirect)   [setting]
 *   - Hide already-watched videos past a threshold               [setting]
 *   - Hide individually-blocked video IDs
 *   - Hide every tile from a blocked channel
 *   - Strip ad / promo / nudge clutter so the grid reflows
 *   - Handle right-click menu actions relayed from the background
 *   - Best-effort click YouTube's native "Don't recommend channel"
 *
 * State lives in browser.storage.local under the key "data" and is
 * shared with the popup and options pages. Changes there flow back
 * here via storage.onChanged.
 * ================================================================== */
(function () {
    'use strict';

    const api = (typeof browser !== 'undefined') ? browser : chrome;
    const STORAGE_KEY = 'data';
    const LEGACY_HIDDEN_KEY = 'ytShortsBlocker_manuallyHiddenIds';

    const DEFAULT_SETTINGS = {
        blockShorts: true,
        hideWatched: true,
        watchedThreshold: 75,
        autoDoNotRecommend: true,
        blackoutBlockedChannels: true
    };

    /* ---- live state ------------------------------------------------ */
    let state = {
        hiddenVideoIds: [],
        blockedChannels: [],
        settings: Object.assign({}, DEFAULT_SETTINGS)
    };
    let settings = Object.assign({}, DEFAULT_SETTINGS);
    let hiddenSet = new Set();
    let blockedIndex = { handles: new Set(), ids: new Set(), names: new Set() };
    let configVersion = 0;
    let lastSerialized = '';          // guard against echoing our own writes
    let lastContextTarget = null;     // element under the last right-click
    let menuOwnerTile = null;         // tile whose 3-dot menu button was last pressed
    let menuOwnerIsMain = false;      // menu opened from the main watch video, not a tile
    let blackoutActive = false;       // current page is a blocked channel/video

    /* ------------------------------------------------------------------
     * Selectors (shared by removal passes)
     * ------------------------------------------------------------------ */
    const INNER_CONTAINERS = [
        'ytd-rich-item-renderer',
        'ytd-video-renderer',
        'ytd-grid-video-renderer',
        'ytd-compact-video-renderer',
        'ytd-playlist-video-renderer',
        'ytd-reel-item-renderer',
        'ytd-rich-grid-media',
        'yt-lockup-view-model',
        'ytm-shorts-lockup-view-model',
        'ytm-shorts-lockup-view-model-v2'
    ].join(',');

    const OUTER_GRID_CELLS = [
        'ytd-rich-item-renderer',
        'ytd-video-renderer',
        'ytd-grid-video-renderer',
        'ytd-compact-video-renderer',
        'ytd-playlist-video-renderer'
    ].join(',');

    const PROGRESS_SELECTORS = [
        'ytd-thumbnail-overlay-resume-playback-renderer #progress',
        '#progress[style*="width"]',
        '.ytThumbnailOverlayProgressBarHostWatchedProgressBarSegment',
        'yt-thumbnail-overlay-progress-bar-view-model div[style*="width"]'
    ].join(',');

    const WATCHED_BAR_CONTAINERS = [
        '.ytThumbnailOverlayProgressBarHostWatchedProgressBar',
        '.ytThumbnailOverlayProgressBarHostWatchedProgressBarLegacy'
    ].join(',');

    const NON_VIDEO_CARDS = [
        'ytd-feed-nudge-renderer',
        'ytd-emergency-onebox-renderer',
        'ytd-ad-slot-renderer',
        'ytd-promoted-video-renderer',
        'ytd-display-ad-renderer',
        'ytd-statement-banner-renderer',
        'ytd-banner-promo-renderer',
        'ytd-feed-tutorial-renderer',
        'ytd-clarification-renderer'
    ].join(',');

    const SHORTS_CSS = `
        ytd-guide-entry-renderer:has(a[title="Shorts"]),
        ytd-mini-guide-entry-renderer:has(a[title="Shorts"]),
        ytd-guide-entry-renderer a[title="Shorts"],
        ytd-mini-guide-entry-renderer a[title="Shorts"],
        yt-tab-shape[tab-title="Shorts"],
        tp-yt-paper-tab[aria-label="Shorts"],
        tp-yt-paper-tab:has(> .tab-content[title="Shorts"]) {
            display: none !important;
        }
    `;

    /* ==================================================================
     * 0. State load / save / derive
     * ================================================================== */
    function normalize(d) {
        d = d || {};
        return {
            hiddenVideoIds: Array.isArray(d.hiddenVideoIds) ? [...new Set(d.hiddenVideoIds)] : [],
            blockedChannels: Array.isArray(d.blockedChannels)
                ? d.blockedChannels.filter(c => c && (c.handle || c.channelId || c.name))
                : [],
            settings: Object.assign({}, DEFAULT_SETTINGS, d.settings || {})
        };
    }

    function rebuildDerived() {
        hiddenSet = new Set(state.hiddenVideoIds);
        blockedIndex = { handles: new Set(), ids: new Set(), names: new Set() };
        for (const c of state.blockedChannels) {
            if (c.handle) blockedIndex.handles.add(c.handle.toLowerCase());
            if (c.channelId) blockedIndex.ids.add(c.channelId);
            if (c.name) blockedIndex.names.add(c.name.toLowerCase().trim());
        }
        settings = Object.assign({}, DEFAULT_SETTINGS, state.settings);
        applyShortsCss(settings.blockShorts);
        configVersion++;
    }

    async function persist() {
        state = normalize(state);
        rebuildDerived();
        runAll();
        try {
            lastSerialized = JSON.stringify(state);
            await api.storage.local.set({ [STORAGE_KEY]: state });
        } catch (e) {
            console.warn('[YT Blocker] Could not persist:', e);
        }
    }

    function migrateLegacyLocalStorage() {
        try {
            const raw = window.localStorage.getItem(LEGACY_HIDDEN_KEY);
            if (!raw) return false;
            const arr = JSON.parse(raw);
            if (!Array.isArray(arr) || !arr.length) return false;
            const before = hiddenSet.size;
            state.hiddenVideoIds = [...new Set([...state.hiddenVideoIds, ...arr])];
            rebuildDerived();
            return hiddenSet.size > before;
        } catch (e) {
            return false;
        }
    }

    /* ==================================================================
     * 1. Shorts CSS toggle
     * ================================================================== */
    function applyShortsCss(on) {
        let s = document.getElementById('ytb-shorts-style');
        if (on) {
            if (!s) {
                s = document.createElement('style');
                s.id = 'ytb-shorts-style';
                (document.head || document.documentElement).appendChild(s);
            }
            s.textContent = SHORTS_CSS;
        } else if (s) {
            s.remove();
        }
    }

    /* ==================================================================
     * 2. Redirect /shorts/<id> -> /watch?v=<id>
     * ================================================================== */
    function redirectShortsUrl() {
        if (!settings.blockShorts) return;
        if (location.pathname.startsWith('/shorts/')) {
            const id = location.pathname.split('/')[2];
            if (id) location.replace('https://www.youtube.com/watch?v=' + id);
        }
    }

    /* ==================================================================
     * 3. Tile helpers
     * ================================================================== */
    function removeTile(tile) {
        let target = tile.closest(INNER_CONTAINERS) || tile;
        const outer = target.closest(OUTER_GRID_CELLS);
        if (outer) target = outer;
        target.remove();
    }

    function removeContainingTile(node) {
        const target = node.closest(INNER_CONTAINERS);
        if (target) removeTile(target);
    }

    function getVideoIdFromNode(node) {
        if (!node) return null;
        const a = node.querySelector('a[href*="/watch?v="]');
        if (!a) return null;
        const href = a.getAttribute('href') || a.href || '';
        const m = href.match(/[?&]v=([^&]+)/);
        return m ? m[1] : null;
    }

    function findTileFromTarget(target) {
        if (!target || !target.closest) return null;
        return target.closest(OUTER_GRID_CELLS) ||
               target.closest(INNER_CONTAINERS) ||
               null;
    }

    // Merge channel identifiers found across every channel-ish anchor in a tile.
    function getChannelInfoFromNode(node) {
        if (!node) return null;
        let handle = '', channelId = '', name = '';
        const anchors = node.querySelectorAll('a[href]');
        for (const a of anchors) {
            const href = a.getAttribute('href') || '';
            if (!href || href.includes('/watch') || href.includes('/shorts/') || href.includes('list=')) continue;
            const idM = href.match(/\/channel\/(UC[\w-]+)/);
            const handleM = href.match(/\/@([\w.\-]+)/);
            const legacy = /^\/(c|user)\//.test(href);
            if (!idM && !handleM && !legacy) continue;
            if (idM && !channelId) channelId = idM[1];
            if (handleM && !handle) handle = handleM[1];
            const t = (a.textContent || '').trim();
            if (t && !name) name = t;
        }
        // Newer lockup tiles render the channel name as plain text (no link),
        // so fall back to reading it from the byline element.
        if (!name) name = getChannelNameFromTile(node);
        if (!handle && !channelId && !name) return null;
        return { handle, channelId, name };
    }

    // Channel display name from a tile's byline when it isn't a link.
    function getChannelNameFromTile(node) {
        const el = node.querySelector(
            'ytd-channel-name #text, ytd-channel-name yt-formatted-string, ' +
            '#channel-name #text, #channel-name yt-formatted-string'
        );
        if (el) {
            const t = (el.textContent || '').trim();
            if (t) return t;
        }
        // yt-lockup-view-model: the first metadata row is the channel name.
        const meta = node.querySelector('yt-content-metadata-view-model');
        if (meta) {
            const row = meta.querySelector('[class*="metadata-row"]');
            if (row) {
                const t = (row.textContent || '').trim();
                if (t) return t;
            }
        }
        return '';
    }

    function getChannelInfoFromAnchor(node) {
        const a = node && node.closest && node.closest('a[href]');
        if (!a) return null;
        const href = a.getAttribute('href') || '';
        const idM = href.match(/\/channel\/(UC[\w-]+)/);
        const handleM = href.match(/\/@([\w.\-]+)/);
        if (!idM && !handleM) return null;
        return {
            channelId: idM ? idM[1] : '',
            handle: handleM ? handleM[1] : '',
            name: (a.textContent || '').trim()
        };
    }

    // When sitting on a channel's own page, read it from the URL + header.
    function getChannelInfoFromChannelPage() {
        const path = location.pathname;
        const idM = path.match(/\/channel\/(UC[\w-]+)/);
        const handleM = path.match(/\/@([\w.\-]+)/);
        if (!idM && !handleM) return null;
        const nameEl = document.querySelector(
            'ytd-channel-name #text, yt-dynamic-text-view-model h1, #channel-name #text, #channel-header #text'
        );
        return {
            channelId: idM ? idM[1] : '',
            handle: handleM ? handleM[1] : '',
            name: nameEl ? (nameEl.textContent || '').trim() : ''
        };
    }

    // On a watch page, read the channel from the owner/uploader byline, with a
    // microdata fallback that is present earlier in the page lifecycle.
    function getWatchPageOwnerInfo() {
        const a = document.querySelector(
            'ytd-video-owner-renderer a[href*="/channel/"], ytd-video-owner-renderer a[href^="/@"], ' +
            '#owner a[href*="/channel/"], #owner a[href^="/@"]'
        );
        if (a) return getChannelInfoFromAnchor(a);
        const meta = document.querySelector(
            'span[itemprop="author"] link[itemprop="url"][href*="/channel/"], ' +
            'span[itemprop="author"] link[itemprop="url"][href*="/@"], ' +
            'link[itemprop="url"][href*="/channel/"]'
        );
        if (meta) {
            const href = meta.getAttribute('href') || '';
            const idM = href.match(/\/channel\/(UC[\w-]+)/);
            const handleM = href.match(/\/@([\w.\-]+)/);
            if (idM || handleM) {
                return { channelId: idM ? idM[1] : '', handle: handleM ? handleM[1] : '', name: '' };
            }
        }
        return null;
    }

    function tileMatchesBlockedChannel(info) {
        if (!info) return false;
        if (info.channelId && blockedIndex.ids.has(info.channelId)) return true;
        if (info.handle && blockedIndex.handles.has(info.handle.toLowerCase())) return true;
        if (info.name && blockedIndex.names.has(info.name.toLowerCase().trim())) return true;
        return false;
    }

    function sameChannel(a, b) {
        if (a.channelId && b.channelId) return a.channelId === b.channelId;
        if (a.handle && b.handle) return a.handle.toLowerCase() === b.handle.toLowerCase();
        if (a.name && b.name) return a.name.toLowerCase().trim() === b.name.toLowerCase().trim();
        return false;
    }

    /* ==================================================================
     * 4. Removal passes
     * ================================================================== */
    function flattenRows() {
        document.querySelectorAll('ytd-rich-grid-renderer').forEach(grid => {
            const outerContents = grid.querySelector(':scope > #contents');
            if (!outerContents) return;
            grid.querySelectorAll(':scope > #contents > ytd-rich-grid-row').forEach(row => {
                const rowContents = row.querySelector(':scope > #contents');
                if (!rowContents) {
                    if (!row.children.length) row.remove();
                    return;
                }
                while (rowContents.firstChild) {
                    outerContents.insertBefore(rowContents.firstChild, row);
                }
                row.remove();
            });
        });
    }

    function removeSectionShelves() {
        document.querySelectorAll('ytd-rich-grid-renderer').forEach(grid => {
            grid.querySelectorAll(':scope > #contents > ytd-rich-section-renderer')
                .forEach(section => section.remove());
        });
        document.querySelectorAll([
            'ytd-rich-shelf-renderer[is-shorts]',
            'ytd-reel-shelf-renderer',
            'ytd-reel-item-renderer',
            'ytm-shorts-lockup-view-model',
            'ytm-shorts-lockup-view-model-v2'
        ].join(',')).forEach(el => el.remove());
        document.querySelectorAll('a[href*="/shorts/"]').forEach(a => {
            const cell = a.closest(OUTER_GRID_CELLS) || a.closest('yt-lockup-view-model');
            if (cell) cell.remove();
        });
    }

    function removeNonVideoCards() {
        document.querySelectorAll(NON_VIDEO_CARDS).forEach(card => {
            const cell = card.closest(OUTER_GRID_CELLS);
            (cell || card).remove();
        });
    }

    function processWatchedByProgressBar() {
        document.querySelectorAll(PROGRESS_SELECTORS).forEach(bar => {
            const w = bar.style && bar.style.width;
            if (!w) return;
            const pct = parseFloat(w);
            if (isNaN(pct) || pct < settings.watchedThreshold) return;
            removeContainingTile(bar);
        });
    }

    function processWatchedByContainer() {
        document.querySelectorAll(WATCHED_BAR_CONTAINERS).forEach(container => {
            const widthEls = container.querySelectorAll('[style*="width"]');
            for (const el of widthEls) {
                const w = el.style && el.style.width;
                if (!w) continue;
                const pct = parseFloat(w);
                if (isNaN(pct)) continue;
                if (pct >= settings.watchedThreshold) {
                    removeContainingTile(container);
                    return;
                }
            }
        });
    }

    // Single pass that handles both blocked video IDs and blocked channels.
    function processTiles() {
        if (!hiddenSet.size && !state.blockedChannels.length) return;
        const tiles = document.querySelectorAll(INNER_CONTAINERS);
        for (const tile of tiles) {
            const id = getVideoIdFromNode(tile);
            if (hiddenSet.size && id && hiddenSet.has(id)) {
                removeTile(tile);
                continue;
            }
            if (state.blockedChannels.length) {
                const key = (id || tile.tagName) + '|' + configVersion;
                if (tile.dataset.ytbChk === key) continue;   // already cleared at this config
                const info = getChannelInfoFromNode(tile);
                if (tileMatchesBlockedChannel(info)) {
                    removeTile(tile);
                    continue;
                }
                tile.dataset.ytbChk = key;
            }
        }
    }

    function runAll() {
        flattenRows();
        if (settings.blockShorts) removeSectionShelves();
        removeNonVideoCards();
        if (settings.hideWatched) {
            processWatchedByProgressBar();
            processWatchedByContainer();
        }
        processTiles();
        injectBlockChannelMenuItem();
        processBlackout();
    }

    /* ==================================================================
     * 5. Actions (hide video / block channel) + native don't-recommend
     * ================================================================== */
    function hideVideoAtTarget(target) {
        const tile = findTileFromTarget(target);
        if (!tile) { toast('No video tile under the cursor.'); return; }
        const id = getVideoIdFromNode(tile);
        if (!id) { toast('Could not read a video ID here.'); return; }
        if (!hiddenSet.has(id)) state.hiddenVideoIds.push(id);
        removeTile(tile);
        persist();
        toast('Hid video', id);
    }

    function channelLabel(info) {
        return info.name || (info.handle ? '@' + info.handle : info.channelId);
    }

    // Adds to the block list (no persist). Returns true if it was already present.
    function addChannelToList(info) {
        const already = state.blockedChannels.some(c => sameChannel(c, info));
        if (!already) {
            state.blockedChannels.push({
                name: info.name || '',
                handle: info.handle || '',
                channelId: info.channelId || '',
                addedAt: Date.now()
            });
        }
        return already;
    }

    // Right-click path (browser context menu). Opens the native menu fresh to
    // attempt "Don't recommend channel".
    function blockChannelAtTarget(target) {
        const tile = findTileFromTarget(target);
        const info = (tile && getChannelInfoFromNode(tile)) ||
                     getChannelInfoFromAnchor(target) ||
                     getChannelInfoFromChannelPage();
        if (!info || (!info.handle && !info.channelId && !info.name)) {
            toast('Could not detect a channel here. Try right-clicking the channel name.');
            return;
        }
        const already = addChannelToList(info);
        if (settings.autoDoNotRecommend && tile) tryDoNotRecommend(tile);
        persist();
        toast(already ? 'Already blocking' : 'Blocked channel', channelLabel(info));
    }

    // Best-effort: open the tile's 3-dot menu and click "Don't recommend
    // channel". YouTube only exposes this on some surfaces, so failures are
    // swallowed silently — channel tiles are already hidden regardless.
    function tryDoNotRecommend(tile) {
        try {
            const menuBtn = tile.querySelector(
                'ytd-menu-renderer yt-icon-button button, ytd-menu-renderer button, #menu button[aria-label], button.yt-icon-button'
            );
            if (!menuBtn) return;
            menuBtn.click();
            setTimeout(() => {
                const items = document.querySelectorAll(
                    'ytd-menu-service-item-renderer, tp-yt-paper-item, yt-list-item-view-model, tp-yt-paper-listbox *[role="menuitem"]'
                );
                let clicked = false;
                for (const it of items) {
                    const t = (it.textContent || '').trim().toLowerCase();
                    if (t.includes("don't recommend channel") ||
                        t.includes('dont recommend channel') ||
                        t.includes('not interested in this channel')) {
                        it.click();
                        clicked = true;
                        break;
                    }
                }
                if (!clicked) {
                    // Close the menu we opened so we don't leave a popup hanging.
                    document.body.dispatchEvent(new KeyboardEvent('keydown', {
                        key: 'Escape', keyCode: 27, which: 27, bubbles: true
                    }));
                }
            }, 350);
        } catch (e) { /* best-effort only */ }
    }

    /* ==================================================================
     * 5b. Inject a "Block channel" item into YouTube's native 3-dot menu
     * ================================================================== */
    // Selector covering both the classic (ytd-*) and newer (view-model) menus.
    const MENU_ITEM_SELECTOR = [
        'ytd-menu-service-item-renderer',
        'ytd-menu-navigation-item-renderer',
        'yt-list-item-view-model',
        'tp-yt-paper-item',
        '*[role="menuitem"]'
    ].join(',');

    function isVisible(el) {
        return el && el.offsetParent !== null;
    }

    function findNativeDontRecommend(root) {
        const items = (root || document).querySelectorAll(MENU_ITEM_SELECTOR);
        for (const it of items) {
            if (it.classList && it.classList.contains('ytb-menu-item')) continue;
            if (!isVisible(it)) continue;
            const t = (it.textContent || '').trim().toLowerCase();
            if (t.includes("don't recommend channel") || t.includes('dont recommend channel')) return it;
        }
        return null;
    }

    // Locate the currently-open video action menu regardless of which menu
    // implementation YouTube is using. Returns the items container + the
    // "Don't recommend channel" node (if present) to anchor insertion.
    function findOpenVideoMenu() {
        const nodes = document.querySelectorAll(MENU_ITEM_SELECTOR);
        let dnr = null, signal = null;
        for (const it of nodes) {
            if (it.classList && it.classList.contains('ytb-menu-item')) continue;
            if (!isVisible(it)) continue;
            const t = (it.textContent || '').trim().toLowerCase();
            if (!t) continue;
            if (t.includes("don't recommend channel") || t.includes('dont recommend channel')) {
                dnr = it;
            } else if (!signal &&
                       (t.includes('add to queue') || t.includes('save to watch later') ||
                        t.includes('save to playlist'))) {
                signal = it;
            }
        }
        const anchor = dnr || signal;
        if (!anchor || !anchor.parentNode) return null;
        return { container: anchor.parentNode, dnr };
    }

    function closeNativeMenu() {
        try {
            const dd = document.querySelector('ytd-popup-container tp-yt-iron-dropdown');
            if (dd && typeof dd.close === 'function') { dd.close(); return; }
        } catch (e) { /* fall through */ }
        document.body.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'Escape', keyCode: 27, which: 27, bubbles: true
        }));
    }

    // Channel for the menu that is currently open. When the menu was opened
    // from a tile, attribute ONLY to that tile — never fall back to the watch
    // page owner, or blocking from a recommendation would block the video you
    // are watching. The page owner is used only for the main video's own menu.
    function resolveMenuChannelInfo() {
        if (menuOwnerTile) return getChannelInfoFromNode(menuOwnerTile);
        if (menuOwnerIsMain) return getWatchPageOwnerInfo();
        return null;
    }

    function onInjectedBlockClick(e) {
        e.preventDefault();
        e.stopPropagation();
        const info = e.currentTarget._info || resolveMenuChannelInfo();
        if (!info || (!info.handle && !info.channelId && !info.name)) {
            toast('Could not detect a channel for this menu.');
            closeNativeMenu();
            return;
        }
        const already = addChannelToList(info);
        // The native menu is already open, so click its own "Don't recommend
        // channel" item rather than re-opening it. That also closes the menu.
        let nativeClicked = false;
        if (settings.autoDoNotRecommend) {
            const native = findNativeDontRecommend(document);
            if (native) { try { native.click(); nativeClicked = true; } catch (_) {} }
        }
        if (!nativeClicked) closeNativeMenu();
        persist();
        toast(already ? 'Already blocking' : 'Blocked channel', channelLabel(info));
    }

    function svgEl(name, attrs) {
        const e = document.createElementNS('http://www.w3.org/2000/svg', name);
        for (const k in attrs) e.setAttribute(k, attrs[k]);
        return e;
    }

    function buildMenuItem(info) {
        const el = document.createElement('div');
        el.className = 'ytb-menu-item';
        el.setAttribute('role', 'menuitem');
        el.tabIndex = 0;
        el._info = info;
        el._ownerTile = menuOwnerTile;
        const icon = document.createElement('div');
        icon.className = 'ytb-mi-icon';
        const svg = svgEl('svg', { viewBox: '0 0 24 24', 'stroke-width': '2', 'stroke-linecap': 'round' });
        svg.appendChild(svgEl('circle', { cx: 12, cy: 12, r: 9 }));
        svg.appendChild(svgEl('line', { x1: 5.6, y1: 5.6, x2: 18.4, y2: 18.4 }));
        icon.appendChild(svg);
        const text = document.createElement('div');
        text.className = 'ytb-mi-text';
        text.textContent = 'Block channel';
        el.appendChild(icon);
        el.appendChild(text);
        el.addEventListener('click', onInjectedBlockClick);
        el.addEventListener('keydown', (ev) => {
            if (ev.key === 'Enter' || ev.key === ' ') onInjectedBlockClick(ev);
        });
        return el;
    }

    function injectBlockChannelMenuItem() {
        const menu = findOpenVideoMenu();
        if (!menu) {
            // No video menu open — drop any stray injected item.
            document.querySelectorAll('.ytb-menu-item').forEach(el => el.remove());
            return;
        }
        const existing = menu.container.querySelector('.ytb-menu-item');
        if (existing) {
            if (existing._ownerTile === menuOwnerTile) return;  // still the same menu
            existing.remove();                                  // owner changed — refresh
        }
        const item = buildMenuItem(resolveMenuChannelInfo());
        if (menu.dnr && menu.dnr.parentNode === menu.container) {
            menu.container.insertBefore(item, menu.dnr.nextSibling);
        } else {
            menu.container.appendChild(item);
        }
    }

    /* ==================================================================
     * 5c. Blackout: if the current page is a blocked channel (its channel
     *     page, or a watch page for one of its videos), stop playback and
     *     hide the content behind a black panel — keeping the recommendations
     *     rail. Best-effort at preventing a view from being registered.
     * ================================================================== */
    function ensureNoPlayHook(v) {
        if (v.dataset.ytbHook) return;
        v.dataset.ytbHook = '1';
        // YouTube reuses one <video> across SPA navigations, so the guard must
        // read the live flag rather than pausing unconditionally.
        const guard = () => { if (blackoutActive) { try { v.pause(); } catch (e) {} } };
        v.addEventListener('play', guard, true);
        v.addEventListener('playing', guard, true);
        v.addEventListener('loadeddata', guard, true);
    }

    function stopPlayback() {
        const v = document.querySelector('video');
        if (!v) return;
        ensureNoPlayHook(v);
        try { v.pause(); } catch (e) {}
    }

    function blackoutLabel(info) {
        return info.name || (info.handle ? '@' + info.handle : info.channelId) || 'This channel';
    }

    function buildBlackoutPanel() {
        const panel = document.createElement('div');
        panel.id = 'ytb-blackout-panel';
        const icon = document.createElement('div');
        icon.className = 'ytb-bo-icon';
        icon.textContent = '🚫';
        const title = document.createElement('div');
        title.className = 'ytb-bo-title';
        title.textContent = 'Channel blocked';
        const sub = document.createElement('div');
        sub.className = 'ytb-bo-sub';
        const actions = document.createElement('div');
        actions.className = 'ytb-bo-actions';
        const unblock = document.createElement('button');
        unblock.className = 'ytb-bo-btn';
        unblock.textContent = 'Unblock this channel';
        unblock.addEventListener('click', () => {
            if (panel._info) unblockChannel(panel._info);
        });
        actions.appendChild(unblock);
        panel.appendChild(icon);
        panel.appendChild(title);
        panel.appendChild(sub);
        panel.appendChild(actions);
        return panel;
    }

    function setPanelInfo(panel, info) {
        panel._info = info;
        const sub = panel.querySelector('.ytb-bo-sub');
        if (sub) {
            sub.textContent = blackoutLabel(info) +
                ' is on your block list — its video, thumbnail and view count are not loaded.';
        }
    }

    function placePanel(container, info, asFirstChild) {
        if (!container) return;
        let panel = document.getElementById('ytb-blackout-panel');
        if (!panel) panel = buildBlackoutPanel();
        if (panel.parentNode !== container) {
            if (asFirstChild) container.insertBefore(panel, container.firstChild);
            else container.appendChild(panel);
        }
        setPanelInfo(panel, info);
    }

    function currentBlockedPage() {
        if (!state.blockedChannels.length) return null;
        if (location.pathname === '/watch') {
            const owner = getWatchPageOwnerInfo();
            return (owner && tileMatchesBlockedChannel(owner)) ? { type: 'watch', info: owner } : null;
        }
        const ch = getChannelInfoFromChannelPage();
        return (ch && tileMatchesBlockedChannel(ch)) ? { type: 'channel', info: ch } : null;
    }

    function clearBlackout() {
        if (!blackoutActive && !document.getElementById('ytb-blackout-panel')) return;
        blackoutActive = false;
        document.querySelectorAll('.ytb-blackout').forEach(el => el.classList.remove('ytb-blackout'));
        const p = document.getElementById('ytb-blackout-panel');
        if (p) p.remove();
    }

    function processBlackout() {
        if (!settings.blackoutBlockedChannels) { clearBlackout(); return; }
        const hit = currentBlockedPage();
        if (!hit) { clearBlackout(); return; }
        blackoutActive = true;
        stopPlayback();
        if (hit.type === 'watch') {
            const flexy = document.querySelector('ytd-watch-flexy');
            if (flexy) flexy.classList.add('ytb-blackout');
            const primaryInner = document.querySelector('ytd-watch-flexy #primary-inner') ||
                                 document.querySelector('#primary-inner');
            placePanel(primaryInner || flexy || document.body, hit.info, true);
        } else {
            const browse = document.querySelector('ytd-browse[page-subtype="channels"]') ||
                           document.querySelector('ytd-browse');
            if (browse) browse.classList.add('ytb-blackout');
            placePanel(browse || document.querySelector('#page-manager') || document.body, hit.info, true);
        }
    }

    async function unblockChannel(info) {
        state.blockedChannels = state.blockedChannels.filter(c => !sameChannel(c, info));
        await persist();
        // Content was never loaded, so reload to bring the page back cleanly.
        location.reload();
    }

    /* ==================================================================
     * 6. Toast
     * ================================================================== */
    let toastTimer = null;
    function toast(message, accent) {
        let el = document.getElementById('ytb-toast');
        if (!el) {
            if (!document.body) return;
            el = document.createElement('div');
            el.id = 'ytb-toast';
            document.body.appendChild(el);
        }
        el.textContent = message;
        if (accent) {
            el.appendChild(document.createTextNode(' '));
            const span = document.createElement('span');
            span.className = 'ytb-toast-accent';
            span.textContent = accent;
            el.appendChild(span);
        }
        // force reflow so the transition replays
        void el.offsetWidth;
        el.classList.add('ytb-show');
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => el.classList.remove('ytb-show'), 2600);
    }

    /* ==================================================================
     * 7. Wiring: context-menu target tracking + background messages
     * ================================================================== */
    document.addEventListener('contextmenu', (e) => {
        lastContextTarget = e.target;
    }, true);

    // Record which tile a menu is opened from. The 3-dot button lives inside
    // the tile, so closest(INNER_CONTAINERS) on the pressed element gives the
    // owning tile — independent of the (changing) menu-button markup. If the
    // press is in the main watch video's metadata instead, flag that so we
    // attribute to the page owner rather than a stale tile.
    document.addEventListener('pointerdown', (e) => {
        if (!e.target.closest) return;
        const tile = e.target.closest(INNER_CONTAINERS);
        if (tile) {
            menuOwnerTile = tile;
            menuOwnerIsMain = false;
        } else if (e.target.closest('ytd-watch-metadata, #above-the-fold')) {
            menuOwnerTile = null;
            menuOwnerIsMain = true;
        }
        // Anything else (e.g. our own popup item) leaves the attribution intact.
    }, true);

    api.runtime.onMessage.addListener((msg) => {
        if (!msg || !msg.action) return;
        switch (msg.action) {
            case 'ytb-block-channel': blockChannelAtTarget(lastContextTarget); break;
            case 'ytb-hide-video':    hideVideoAtTarget(lastContextTarget); break;
        }
    });

    api.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local' || !changes[STORAGE_KEY]) return;
        const incoming = JSON.stringify(normalize(changes[STORAGE_KEY].newValue));
        if (incoming === lastSerialized) return;     // our own write echoing back
        lastSerialized = incoming;
        state = normalize(changes[STORAGE_KEY].newValue);
        rebuildDerived();
        runAll();
    });

    /* ==================================================================
     * 8. Console helpers (parity with the old userscript, on YouTube pages)
     * ================================================================== */
    window.ytsbListHidden = () => [...hiddenSet];
    window.ytsbListChannels = () => state.blockedChannels.slice();
    window.ytsbUnhide = (id) => {
        const i = state.hiddenVideoIds.indexOf(id);
        if (i < 0) return false;
        state.hiddenVideoIds.splice(i, 1);
        persist();
        return true;
    };
    window.ytsbResetHidden = () => {
        const n = state.hiddenVideoIds.length;
        state.hiddenVideoIds = [];
        persist();
        return n;
    };

    /* ==================================================================
     * 9. Boot
     * ================================================================== */
    function bootObserver() {
        if (!document.body) {
            requestAnimationFrame(bootObserver);
            return;
        }
        let scheduled = false;
        const schedule = () => {
            if (scheduled) return;
            scheduled = true;
            requestAnimationFrame(() => { scheduled = false; runAll(); });
        };
        const observer = new MutationObserver(schedule);
        observer.observe(document.body, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['style', 'href', 'class']
        });
        runAll();
        setInterval(runAll, 1500);

        // Shorts redirect lifecycle
        redirectShortsUrl();
        document.addEventListener('yt-navigate-start', redirectShortsUrl, true);
        document.addEventListener('yt-navigate-finish', redirectShortsUrl, true);

        // Blackout lifecycle: drop it optimistically when navigation starts so a
        // good video isn't held paused, then re-evaluate when the page settles.
        document.addEventListener('yt-navigate-start', clearBlackout, true);
        document.addEventListener('yt-navigate-finish', runAll, true);
        let lastHref = location.href;
        setInterval(() => {
            if (location.href !== lastHref) {
                lastHref = location.href;
                redirectShortsUrl();
            }
        }, 500);
    }

    async function init() {
        try {
            const stored = await api.storage.local.get(STORAGE_KEY);
            state = normalize(stored[STORAGE_KEY]);
        } catch (e) {
            state = normalize(null);
        }
        lastSerialized = JSON.stringify(state);
        rebuildDerived();
        if (migrateLegacyLocalStorage()) persist();   // one-time import of old list
        bootObserver();
    }

    init();
})();
