/* ==================================================================
 * Shared helpers for the popup and options pages.
 * Loaded as a plain script, so it exposes globals on window.
 * ================================================================== */
/* global browser, chrome */
const YTB = (function () {
    'use strict';

    const api = (typeof browser !== 'undefined') ? browser : chrome;
    const STORAGE_KEY = 'data';

    const DEFAULT_SETTINGS = {
        blockShorts: true,
        hideWatched: true,
        watchedThreshold: 75,
        autoDoNotRecommend: true,
        blackoutBlockedChannels: true
    };

    function normalize(d) {
        d = d || {};
        const settings = Object.assign({}, DEFAULT_SETTINGS, d.settings || {});
        settings.watchedThreshold = clampThreshold(settings.watchedThreshold);
        return {
            hiddenVideoIds: Array.isArray(d.hiddenVideoIds) ? [...new Set(d.hiddenVideoIds)] : [],
            blockedChannels: Array.isArray(d.blockedChannels)
                ? d.blockedChannels
                    .filter(c => c && (c.handle || c.channelId || c.name))
                    .map(c => ({
                        name: c.name || '',
                        handle: c.handle || '',
                        channelId: c.channelId || '',
                        addedAt: c.addedAt || Date.now()
                    }))
                : [],
            settings
        };
    }

    function clampThreshold(v) {
        v = parseInt(v, 10);
        if (isNaN(v)) return DEFAULT_SETTINGS.watchedThreshold;
        return Math.min(100, Math.max(1, v));
    }

    async function load() {
        const r = await api.storage.local.get(STORAGE_KEY);
        return normalize(r[STORAGE_KEY]);
    }

    async function save(data) {
        const clean = normalize(data);
        await api.storage.local.set({ [STORAGE_KEY]: clean });
        return clean;
    }

    function parseChannelInput(str) {
        str = (str || '').trim();
        if (!str) return null;
        const idM = str.match(/channel\/(UC[\w-]+)/) || str.match(/^(UC[\w-]{20,})$/);
        if (idM) return { channelId: idM[1], handle: '', name: '' };
        const handleM = str.match(/@([\w.\-]+)/);
        if (handleM) return { handle: handleM[1], channelId: '', name: '' };
        return { name: str, handle: '', channelId: '' };
    }

    function sameChannel(a, b) {
        if (a.channelId && b.channelId) return a.channelId === b.channelId;
        if (a.handle && b.handle) return a.handle.toLowerCase() === b.handle.toLowerCase();
        if (a.name && b.name) return a.name.toLowerCase().trim() === b.name.toLowerCase().trim();
        return false;
    }

    // Adds to data.blockedChannels (mutates). Returns true if newly added.
    function addChannel(data, info) {
        if (!info || (!info.handle && !info.channelId && !info.name)) return false;
        if (data.blockedChannels.some(c => sameChannel(c, info))) return false;
        data.blockedChannels.push({
            name: info.name || '',
            handle: info.handle || '',
            channelId: info.channelId || '',
            addedAt: Date.now()
        });
        return true;
    }

    function channelLabel(c) {
        if (c.name) return c.name;
        if (c.handle) return '@' + c.handle;
        return c.channelId;
    }

    function channelUrl(c) {
        if (c.handle) return 'https://www.youtube.com/@' + c.handle;
        if (c.channelId) return 'https://www.youtube.com/channel/' + c.channelId;
        return 'https://www.youtube.com/results?search_query=' + encodeURIComponent(c.name);
    }

    // Merge an imported payload into current data (union of lists).
    function mergeImport(current, incoming) {
        const out = normalize(current);
        const inc = normalize(incoming);
        let addedVideos = 0, addedChannels = 0;
        const vids = new Set(out.hiddenVideoIds);
        for (const v of inc.hiddenVideoIds) {
            if (!vids.has(v)) { vids.add(v); addedVideos++; }
        }
        out.hiddenVideoIds = [...vids];
        for (const c of inc.blockedChannels) {
            if (!out.blockedChannels.some(x => sameChannel(x, c))) {
                out.blockedChannels.push(c);
                addedChannels++;
            }
        }
        out.settings = Object.assign({}, out.settings, inc.settings);
        return { data: out, addedVideos, addedChannels };
    }

    function isValidPayload(obj) {
        return obj && typeof obj === 'object' &&
            (Array.isArray(obj.blockedChannels) || Array.isArray(obj.hiddenVideoIds) || obj.settings);
    }

    function onChanged(cb) {
        api.storage.onChanged.addListener((changes, area) => {
            if (area === 'local' && changes[STORAGE_KEY]) {
                cb(normalize(changes[STORAGE_KEY].newValue));
            }
        });
    }

    function exportFilename() {
        return 'youtube-blocklist-' + new Date().toISOString().slice(0, 10) + '.json';
    }

    function downloadJson(data, filename) {
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename || exportFilename();
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    }

    return {
        DEFAULT_SETTINGS,
        normalize, clampThreshold,
        load, save, onChanged,
        parseChannelInput, sameChannel, addChannel,
        channelLabel, channelUrl,
        mergeImport, isValidPayload,
        exportFilename, downloadJson
    };
})();
