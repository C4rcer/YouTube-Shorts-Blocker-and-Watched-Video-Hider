/* global YTB */
(function () {
    'use strict';

    let data = null;

    const $ = (id) => document.getElementById(id);
    const els = {
        channels: $('count-channels'),
        videos: $('count-videos'),
        addInput: $('add-input'),
        addBtn: $('add-btn'),
        shorts: $('set-shorts'),
        watched: $('set-watched'),
        recommend: $('set-recommend'),
        threshold: $('set-threshold'),
        boost: $('set-boost'),
        boostReadout: $('boost-readout'),
        exportBtn: $('export-btn'),
        importBtn: $('import-btn'),
        importFile: $('import-file'),
        copyBtn: $('copy-btn'),
        optionsBtn: $('options-btn'),
        status: $('status')
    };

    function render() {
        els.channels.textContent = data.blockedChannels.length;
        els.videos.textContent = data.hiddenVideoIds.length;
        els.shorts.checked = !!data.settings.blockShorts;
        els.watched.checked = !!data.settings.hideWatched;
        els.recommend.checked = !!data.settings.autoDoNotRecommend;
        els.threshold.value = data.settings.watchedThreshold;
        els.boost.value = Math.round((data.settings.volumeBoost || 1) * 100);
        els.boostReadout.textContent = els.boost.value + '%';
    }

    function status(msg, isErr) {
        els.status.textContent = msg;
        els.status.classList.toggle('err', !!isErr);
        if (msg) setTimeout(() => { els.status.textContent = ''; els.status.classList.remove('err'); }, 3500);
    }

    async function commit() {
        data = await YTB.save(data);
        render();
    }

    async function addChannel() {
        const info = YTB.parseChannelInput(els.addInput.value);
        if (!info) { status('Enter a channel handle, URL, or name.', true); return; }
        if (YTB.addChannel(data, info)) {
            await commit();
            status('Blocked ' + YTB.channelLabel(info));
            els.addInput.value = '';
        } else {
            status('Already in the block list.', true);
        }
    }

    async function saveSettings() {
        data.settings.blockShorts = els.shorts.checked;
        data.settings.hideWatched = els.watched.checked;
        data.settings.autoDoNotRecommend = els.recommend.checked;
        data.settings.watchedThreshold = YTB.clampThreshold(els.threshold.value);
        data.settings.volumeBoost = YTB.clampBoost((parseInt(els.boost.value, 10) || 100) / 100);
        await commit();
    }

    function doExport() {
        YTB.downloadJson(data, YTB.exportFilename());
        status('Exported block list.');
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
                status('Could not read that file.', true);
            }
        };
        reader.readAsText(file);
    }

    async function doCopy() {
        try {
            await navigator.clipboard.writeText(JSON.stringify(data, null, 2));
            status('Copied JSON to clipboard.');
        } catch (e) {
            status('Clipboard blocked — use Export instead.', true);
        }
    }

    function wire() {
        els.addBtn.addEventListener('click', addChannel);
        els.addInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') addChannel(); });
        [els.shorts, els.watched, els.recommend].forEach(c => c.addEventListener('change', saveSettings));
        els.threshold.addEventListener('change', saveSettings);
        els.boost.addEventListener('input', () => { els.boostReadout.textContent = els.boost.value + '%'; });
        els.boost.addEventListener('change', saveSettings);
        els.exportBtn.addEventListener('click', doExport);
        els.importBtn.addEventListener('click', () => els.importFile.click());
        els.importFile.addEventListener('change', (e) => { if (e.target.files[0]) doImport(e.target.files[0]); e.target.value = ''; });
        els.copyBtn.addEventListener('click', doCopy);
        els.optionsBtn.addEventListener('click', () => {
            const api = (typeof browser !== 'undefined') ? browser : chrome;
            api.runtime.openOptionsPage();
            window.close();
        });
        YTB.onChanged((d) => { data = d; render(); });
    }

    async function start() {
        data = await YTB.load();
        wire();
        render();
    }

    document.addEventListener('DOMContentLoaded', start);
})();
