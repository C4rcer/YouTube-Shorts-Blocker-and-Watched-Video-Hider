/* global YTB */
(function () {
    'use strict';

    let data = null;

    const $ = (id) => document.getElementById(id);
    const els = {
        addInput: $('add-input'),
        addBtn: $('add-btn'),
        chCount: $('ch-count'),
        vidCount: $('vid-count'),
        channelList: $('channel-list'),
        videoList: $('video-list'),
        shorts: $('set-shorts'),
        watched: $('set-watched'),
        recommend: $('set-recommend'),
        threshold: $('set-threshold'),
        exportBtn: $('export-btn'),
        importBtn: $('import-btn'),
        importFile: $('import-file'),
        copyBtn: $('copy-btn'),
        clearBtn: $('clear-btn'),
        status: $('status')
    };

    function status(msg, isErr) {
        els.status.textContent = msg;
        els.status.classList.toggle('err', !!isErr);
        if (msg) setTimeout(() => { els.status.textContent = ''; els.status.classList.remove('err'); }, 4000);
    }

    async function commit() {
        data = await YTB.save(data);
        render();
    }

    /* ---- rendering ---- */
    function render() {
        renderChannels();
        renderVideos();
        els.shorts.checked = !!data.settings.blockShorts;
        els.watched.checked = !!data.settings.hideWatched;
        els.recommend.checked = !!data.settings.autoDoNotRecommend;
        els.threshold.value = data.settings.watchedThreshold;
    }

    function renderChannels() {
        els.chCount.textContent = data.blockedChannels.length;
        els.channelList.textContent = '';
        if (!data.blockedChannels.length) {
            els.channelList.appendChild(emptyRow('No channels blocked yet.'));
            return;
        }
        const sorted = data.blockedChannels.slice().sort(
            (a, b) => YTB.channelLabel(a).toLowerCase().localeCompare(YTB.channelLabel(b).toLowerCase())
        );
        for (const c of sorted) {
            const item = document.createElement('div');
            item.className = 'list-item';

            const grow = document.createElement('div');
            grow.className = 'grow';
            const label = document.createElement('a');
            label.className = 'label';
            label.href = YTB.channelUrl(c);
            label.target = '_blank';
            label.rel = 'noopener';
            label.textContent = YTB.channelLabel(c);
            const meta = document.createElement('div');
            meta.className = 'meta';
            meta.textContent = [c.handle ? '@' + c.handle : '', c.channelId].filter(Boolean).join('  ·  ') || 'matched by name';
            grow.appendChild(label);
            grow.appendChild(meta);

            const rm = document.createElement('button');
            rm.className = 'icon danger';
            rm.title = 'Remove';
            rm.textContent = '✕';
            rm.addEventListener('click', () => removeChannel(c));

            item.appendChild(grow);
            item.appendChild(rm);
            els.channelList.appendChild(item);
        }
    }

    function renderVideos() {
        els.vidCount.textContent = data.hiddenVideoIds.length;
        els.videoList.textContent = '';
        if (!data.hiddenVideoIds.length) {
            els.videoList.appendChild(emptyRow('No individually-hidden videos.'));
            return;
        }
        for (const id of data.hiddenVideoIds) {
            const item = document.createElement('div');
            item.className = 'list-item';

            const grow = document.createElement('div');
            grow.className = 'grow';
            const label = document.createElement('a');
            label.className = 'label';
            label.href = 'https://www.youtube.com/watch?v=' + id;
            label.target = '_blank';
            label.rel = 'noopener';
            label.textContent = id;
            grow.appendChild(label);

            const rm = document.createElement('button');
            rm.className = 'icon danger';
            rm.title = 'Unhide';
            rm.textContent = '✕';
            rm.addEventListener('click', () => removeVideo(id));

            item.appendChild(grow);
            item.appendChild(rm);
            els.videoList.appendChild(item);
        }
    }

    function emptyRow(text) {
        const d = document.createElement('div');
        d.className = 'empty';
        d.textContent = text;
        return d;
    }

    /* ---- actions ---- */
    async function addChannel() {
        const info = YTB.parseChannelInput(els.addInput.value);
        if (!info) { status('Enter a channel handle, URL, ID, or name.', true); return; }
        if (YTB.addChannel(data, info)) {
            await commit();
            status('Blocked ' + YTB.channelLabel(info));
            els.addInput.value = '';
        } else {
            status('Already in the block list.', true);
        }
    }

    async function removeChannel(c) {
        data.blockedChannels = data.blockedChannels.filter(x => !YTB.sameChannel(x, c));
        await commit();
        status('Removed ' + YTB.channelLabel(c) + ' (reload YouTube to see its videos again).');
    }

    async function removeVideo(id) {
        data.hiddenVideoIds = data.hiddenVideoIds.filter(x => x !== id);
        await commit();
        status('Unhid ' + id + ' (reload YouTube to see it again).');
    }

    async function saveSettings() {
        data.settings.blockShorts = els.shorts.checked;
        data.settings.hideWatched = els.watched.checked;
        data.settings.autoDoNotRecommend = els.recommend.checked;
        data.settings.watchedThreshold = YTB.clampThreshold(els.threshold.value);
        await commit();
    }

    function doExport() {
        YTB.downloadJson(data, YTB.exportFilename());
        status('Exported ' + data.blockedChannels.length + ' channels and ' + data.hiddenVideoIds.length + ' videos.');
    }

    function doImport(file) {
        const reader = new FileReader();
        reader.onload = async () => {
            try {
                const obj = JSON.parse(reader.result);
                if (!YTB.isValidPayload(obj)) throw new Error('bad');
                const res = YTB.mergeImport(data, obj);
                data = await YTB.save(res.data);
                render();
                status('Imported +' + res.addedChannels + ' channels, +' + res.addedVideos + ' videos.');
            } catch (e) {
                status('Could not read that file — is it a valid export?', true);
            }
        };
        reader.readAsText(file);
    }

    async function doCopy() {
        try {
            await navigator.clipboard.writeText(JSON.stringify(data, null, 2));
            status('Copied JSON to clipboard.');
        } catch (e) {
            status('Clipboard blocked — use Export to file instead.', true);
        }
    }

    async function doClear() {
        if (!confirm('Remove ALL blocked channels and hidden videos? Settings are kept.')) return;
        data.blockedChannels = [];
        data.hiddenVideoIds = [];
        await commit();
        status('Cleared the block list.');
    }

    function wire() {
        els.addBtn.addEventListener('click', addChannel);
        els.addInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') addChannel(); });
        [els.shorts, els.watched, els.recommend].forEach(c => c.addEventListener('change', saveSettings));
        els.threshold.addEventListener('change', saveSettings);
        els.exportBtn.addEventListener('click', doExport);
        els.importBtn.addEventListener('click', () => els.importFile.click());
        els.importFile.addEventListener('change', (e) => { if (e.target.files[0]) doImport(e.target.files[0]); e.target.value = ''; });
        els.copyBtn.addEventListener('click', doCopy);
        els.clearBtn.addEventListener('click', doClear);
        YTB.onChanged((d) => { data = d; render(); });
    }

    async function start() {
        data = await YTB.load();
        wire();
        render();
    }

    document.addEventListener('DOMContentLoaded', start);
})();
