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
        autoDoNotRecommend: true
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
    let currentMenuTile = null;       // tile whose 3-dot menu is open
    let currentMenuInfo = null;       // channel info for that tile

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
        if (!handle && !channelId && !name) return null;
        return { handle, channelId, name };
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

    // On a watch page, read the channel from the owner/uploader byline.
    function getWatchPageOwnerInfo() {
        const a = document.querySelector(
            'ytd-video-owner-renderer a[href*="/channel/"], ytd-video-owner-renderer a[href^="/@"], ' +
            '#owner a[href*="/channel/"], #owner a[href^="/@"]'
        );
        return a ? getChannelInfoFromAnchor(a) : null;
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
    function findNativeDontRecommend(root) {
        const items = (root || document).querySelectorAll(
            'ytd-menu-service-item-renderer, tp-yt-paper-item, yt-list-item-view-model, *[role="menuitem"]'
        );
        for (const it of items) {
            if (it.classList && it.classList.contains('ytb-menu-item')) continue;
            const t = (it.textContent || '').trim().toLowerCase();
            if (t.includes("don't recommend channel") || t.includes('dont recommend channel')) return it;
        }
        return null;
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

    function onInjectedBlockClick(e) {
        e.preventDefault();
        e.stopPropagation();
        const popup = (e.currentTarget.closest && e.currentTarget.closest('ytd-menu-popup-renderer')) || document;
        const info = currentMenuInfo;
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
            const native = findNativeDontRecommend(popup);
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

    function buildMenuItem() {
        const el = document.createElement('div');
        el.className = 'ytb-menu-item';
        el.setAttribute('role', 'menuitem');
        el.tabIndex = 0;
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
        if (!currentMenuInfo) return;   // only inject for menus we can attribute to a channel
        const popups = document.querySelectorAll('ytd-menu-popup-renderer');
        for (const popup of popups) {
            if (popup.offsetParent === null) continue;            // not the visible menu
            if (popup.querySelector('.ytb-menu-item')) continue;  // already injected
            const items = popup.querySelector('tp-yt-paper-listbox#items') ||
                          popup.querySelector('#items') ||
                          popup.querySelector('tp-yt-paper-listbox');
            if (!items) continue;
            const text = (items.textContent || '').toLowerCase();
            const dnr = findNativeDontRecommend(popup);
            const looksLikeVideoMenu = !!dnr || /add to queue|save to watch later|save to playlist/.test(text);
            if (!looksLikeVideoMenu) continue;
            const item = buildMenuItem();
            const host = dnr ? (dnr.closest('ytd-menu-service-item-renderer') || dnr) : null;
            if (host && host.parentNode) host.parentNode.insertBefore(item, host.nextSibling);
            else items.appendChild(item);
        }
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

    // Track which tile's 3-dot menu is being opened so we can attribute the
    // injected "Block channel" item (and read its channel) correctly.
    document.addEventListener('click', (e) => {
        const trigger = e.target.closest && e.target.closest('ytd-menu-renderer');
        if (!trigger) return;
        const tile = findTileFromTarget(trigger);
        currentMenuTile = tile;
        currentMenuInfo = (tile && getChannelInfoFromNode(tile)) || getWatchPageOwnerInfo() || null;
        // Drop any stale injected items so the next-opened menu gets a fresh one.
        document.querySelectorAll('.ytb-menu-item').forEach(el => el.remove());
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
