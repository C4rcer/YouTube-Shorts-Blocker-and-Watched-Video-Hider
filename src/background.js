/* ==================================================================
 * Background script — registers right-click menu entries on YouTube
 * and relays clicks to the content script of the active tab.
 * ================================================================== */
(function () {
    'use strict';

    const api = (typeof browser !== 'undefined') ? browser : chrome;
    const YT_PATTERNS = ['*://www.youtube.com/*', '*://m.youtube.com/*'];

    function buildMenus() {
        api.contextMenus.removeAll(() => {
            api.contextMenus.create({
                id: 'ytb-block-channel',
                title: 'Block this YouTube channel',
                contexts: ['all'],
                documentUrlPatterns: YT_PATTERNS
            });
            api.contextMenus.create({
                id: 'ytb-hide-video',
                title: 'Hide this video',
                contexts: ['all'],
                documentUrlPatterns: YT_PATTERNS
            });
            api.contextMenus.create({
                id: 'ytb-sep',
                type: 'separator',
                contexts: ['all'],
                documentUrlPatterns: YT_PATTERNS
            });
            api.contextMenus.create({
                id: 'ytb-open-options',
                title: 'Manage block list…',
                contexts: ['all'],
                documentUrlPatterns: YT_PATTERNS
            });
        });
    }

    api.runtime.onInstalled.addListener(buildMenus);
    api.runtime.onStartup.addListener(buildMenus);

    api.contextMenus.onClicked.addListener((info, tab) => {
        if (info.menuItemId === 'ytb-open-options') {
            api.runtime.openOptionsPage();
            return;
        }
        if (tab && tab.id != null) {
            api.tabs.sendMessage(tab.id, { action: info.menuItemId }).catch(() => {});
        }
    });
})();
