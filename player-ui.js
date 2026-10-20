/*
 * player-ui.js  -  browser side of the TRM player (served by index.js at /player-ui.js)
 *
 *  - Plyr setup, external-player intent links, landscape lock
 *  - Fullscreen state (.trm-fs-active), Right-Center 44x44 Lock button, Zoom (Fit -> Fill -> Stretch)
 *  - Subtitle overlay (shared demux stream with audio)
 *  - ffmpeg-core Web Worker, WebCodecs, Web Audio graph (master boost + compressor)
 *  - Matroska demuxer (demuxCore): progressive range chunks 512 KB -> 3 MB
 *  - Zero-delay start/seek: engine pre-buffers on page load, Play UI is locked by a
 *    "Buffering Audio..." shield until audio is ready (video is NEVER paused by the engine),
 *    expired audio (behind video.currentTime - 0.15) is never queued or decoded.
 *
 * Expects (from index.js HTML): <video id="main-video">, #trm-diag-box, #trm-diag-step,
 * #trm-diag-log, #trm-copy-btn, #link-dl / #link-vlc / #link-playit / #link-mx,
 * the Plyr library loaded first, and optionally window.__AUDIO_META__.
 *
 * Startup routing: sniff container (EBML = mkv/webm, ftyp = mp4, ...) -> Matroska family reads tracks,
 * everything else (or any probe failure) fails OPEN to the native <video> pipeline. Per track, the engine is
 * used only for non-native codecs, multi-channel audio or non-default tracks without audioTracks support.
 */

/* ===== 1. Plyr + external player links ===== */
(function () {
        document.addEventListener('DOMContentLoaded', () => {
            // Plyr would otherwise save volume/muted to localStorage. The audio engine silences the native <video>
            // (volume 0) while it plays 5.1 audio, and that saved 0 would make every later native file (e.g. a stereo AAC
            // MP4) start silent - with no volume control to fix it. Storage is disabled and any old saved value removed.
            try { localStorage.removeItem('plyr'); } catch (eLs) {}
            const player = new Plyr('.player', {
                controls: ['play-large', 'play', 'progress', 'current-time', 'pip', 'fullscreen'],
                captions: { active: false, update: false },
                storage: { enabled: false },
                volume: 1,
                muted: false
            });
            window.__trmPlayer = player;

            const videoElement = document.getElementById('main-video');

            function lockLandscape() {
                try {
                    if (screen.orientation && typeof screen.orientation.lock === 'function') {
                        screen.orientation.lock('landscape').catch(function () {});
                    }
                } catch (e) {}
            }
            function unlockOrientation() {
                try {
                    if (screen.orientation && typeof screen.orientation.unlock === 'function') {
                        screen.orientation.unlock();
                    }
                } catch (e) {}
            }

            player.on('enterfullscreen', function () {
                lockLandscape();
                if (window.__trmFs) window.__trmFs.set(true, 'plyr enterfullscreen');
            });
            player.on('exitfullscreen', function () {
                unlockOrientation();
                if (window.__trmFs) window.__trmFs.set(false, 'plyr exitfullscreen');
            });

            function onNativeFsOrientation() {
                if (document.fullscreenElement || document.webkitFullscreenElement) lockLandscape();
                else unlockOrientation();
            }
            document.addEventListener('fullscreenchange', onNativeFsOrientation);
            document.addEventListener('webkitfullscreenchange', onNativeFsOrientation);

            const videoSrc = videoElement.getAttribute('src') || (videoElement.querySelector('source') ? videoElement.querySelector('source').src : '');

            document.getElementById('link-dl').addEventListener('click', function(e) {
                e.preventDefault();
                window.location.href = this.getAttribute('href');
            });

            const vlcUrl = videoSrc.replace(/^https?:\/\//, '');
            document.getElementById('link-vlc').href = "intent://" + vlcUrl + "#Intent;package=org.videolan.vlc;type=video/*;scheme=https;end";

            const playitUrl = videoSrc.replace(/^https?:\/\//, '');
            document.getElementById('link-playit').href = "intent://" + playitUrl + "#Intent;package=com.playit.videoplayer;type=video/*;scheme=https;end";

            const mxUrl = videoSrc.replace(/^https?:\/\//, '');
            document.getElementById('link-mx').href = "intent://" + mxUrl + "#Intent;package=com.mxtech.videoplayer.ad;type=video/*;scheme=https;end";
        });
})();

/* ===== 2. 5.1 audio engine + subtitles + fullscreen UI ===== */
    (function () {
        'use strict';

        var video = document.getElementById('main-video');
        var diagBox = document.getElementById('trm-diag-box');
        var diagStep = document.getElementById('trm-diag-step');
        var diagLog = document.getElementById('trm-diag-log');
        var copyBtn = document.getElementById('trm-copy-btn');

        var DEBUG = /[?&]debug=1(?:&|$)/.test(window.location.search);
        if (DEBUG && diagBox) diagBox.classList.add('is-on');

        var logLines = [];
        function trmReport(stepName, detail, isError) {
            var line = '[' + stepName + '] ' + detail;
            console.log(line);
            logLines.push(line);
            if (logLines.length > 600) logLines.shift();
            if (!DEBUG) return;
            if (diagStep) diagStep.textContent = (isError ? 'ERROR AT ' : 'OK ') + stepName;
            if (diagBox) {
                if (isError) diagBox.classList.add('is-err');
                else diagBox.classList.remove('is-err');
            }
            if (diagLog) {
                diagLog.textContent = logLines.join('\n');
                diagLog.scrollTop = diagLog.scrollHeight;
            }
        }

        if (copyBtn) {
            copyBtn.addEventListener('click', function () {
                try {
                    navigator.clipboard.writeText(logLines.join('\n'));
                    copyBtn.textContent = 'Copied!';
                    setTimeout(function () { copyBtn.textContent = 'Copy Log'; }, 1500);
                } catch (e) {}
            });
        }

        function nowMs() { return Math.round(performance.now()); }
        trmReport('AUDIO STARTUP', 'inspector script started at +' + nowMs() + 'ms since page load (debug=' + DEBUG + ')', false);

        trmReport('BUILD', 'player-ui.js build 2026-10-20.3 | subtitle overlay + native-audio subtitle seek fix | container sniff + native/engine routing | batches 4/12/45 | chunks 512KB then 3MB | shield + seek/switch/underrun hold', false);
        if (!video) return;
        video.addEventListener('error', function () {
            var er = video.error;
            trmReport('VIDEO ERROR', 'code=' + (er ? er.code : '?') + (er && er.message ? ' ' + er.message : '') + ' - the browser cannot play this file; use the VLC / MX Player / PlayIt buttons below', true);
        });
        var url = video.getAttribute('src') || (video.querySelector('source') ? video.querySelector('source').src : video.currentSrc);

        function formatErr(e) {
            if (!e) return 'Unknown error';
            if (typeof e === 'string') return e;
            if (e.message) return e.message;
            try { return JSON.stringify(e); } catch (x) { return String(e); }
        }

        // =============================================================
        // FULLSCREEN STATE (.trm-fs-active), ZOOM MODES, LOCK BUTTON
        //
        // The state is driven by:
        //  - a direct click on the [data-plyr="fullscreen"] button
        //  - Plyr enterfullscreen / exitfullscreen events
        //  - fullscreenchange / webkitfullscreenchange
        //  - webkitbeginfullscreen / webkitendfullscreen (iOS video)
        //  - resize / orientationchange (landscape changes)
        // so the Lock and Zoom buttons do not depend on Plyr's own CSS class.
        // =============================================================
        var fsActive = false;
        var fsNativeSeen = false;
        var lastFsClick = 0;
        var zoomMode = 0; // 0 = Original Fit (default), 1 = Zoom Fill, 2 = Full Stretch
        var uiRefs = { plyr: null, lockBtn: null, zoomBtn: null, toast: null, toastTimer: null, unlock: null };
        var fitTimers = [];

        function getPlyrEl() {
            return uiRefs.plyr || video.closest('.plyr') || document.querySelector('.plyr');
        }

        function nativeFsElement() {
            return document.fullscreenElement || document.webkitFullscreenElement || document.mozFullScreenElement || document.msFullscreenElement || null;
        }

        function describeEl(el) {
            if (!el) return 'none';
            var d = String(el.tagName || '?').toLowerCase();
            if (el.id) d += '#' + el.id;
            if (el.className && typeof el.className === 'string') d += '.' + el.className.trim().replace(/\s+/g, '.');
            return d;
        }

        function detectFs() {
            var pl = getPlyrEl();
            var cls = !!(pl && (pl.classList.contains('plyr--fullscreen-active') || pl.classList.contains('plyr--fullscreen-fallback')));
            return !!nativeFsElement() || cls;
        }

        function fsZoomInspect(label) {
            var pl = getPlyrEl();
            var line = label +
                ' | fullscreenElement=' + describeEl(nativeFsElement()) +
                ' | plyr.class="' + (pl ? pl.className : 'n/a') + '"' +
                ' | window=' + window.innerWidth + 'x' + window.innerHeight +
                ' screen=' + screen.width + 'x' + screen.height +
                ' landscape=' + (window.innerWidth > window.innerHeight) +
                ' | video intrinsic=' + video.videoWidth + 'x' + video.videoHeight +
                ' rendered=' + video.clientWidth + 'x' + video.clientHeight +
                ' | zoomMode=' + zoomMode +
                ' | trm-fs-active=' + (pl ? pl.classList.contains('trm-fs-active') : false) +
                ' fsActive=' + fsActive;
            trmReport('FS/ZOOM INSPECT', line, false);
        }

        function setStyleImportant(el, map) {
            if (!el) return;
            for (var k in map) {
                if (Object.prototype.hasOwnProperty.call(map, k)) el.style.setProperty(k, map[k], 'important');
            }
        }

        var FIT_PROPS = ['position', 'left', 'top', 'width', 'height', 'max-width', 'max-height', 'padding', 'margin', 'overflow', 'background', 'transform', 'transform-origin', 'object-fit'];

        function clearVideoFit() {
            var pl = getPlyrEl();
            var wrap = pl ? pl.querySelector('.plyr__video-wrapper') : null;
            for (var i = 0; i < FIT_PROPS.length; i++) {
                if (wrap) wrap.style.removeProperty(FIT_PROPS[i]);
                video.style.removeProperty(FIT_PROPS[i]);
            }
        }

        // Exact edge-to-edge fit: size the <video> box to the contained picture, then
        // scale it (uniform scale for Fill, scaleX/scaleY for Stretch) so it covers the container.
        function applyVideoFit() {
            var pl = getPlyrEl();
            if (!pl) return;
            if (!fsActive || zoomMode === 0) {
                clearVideoFit();
                return;
            }
            var wrap = pl.querySelector('.plyr__video-wrapper');
            setStyleImportant(wrap, {
                'position': 'absolute',
                'left': '0',
                'top': '0',
                'width': '100%',
                'height': '100%',
                'max-width': 'none',
                'max-height': 'none',
                'padding': '0',
                'margin': '0',
                'overflow': 'hidden',
                'background': '#000'
            });

            var cw = pl.clientWidth || window.innerWidth;
            var ch = pl.clientHeight || window.innerHeight;
            var vw = video.videoWidth;
            var vh = video.videoHeight;

            if (!vw || !vh || !cw || !ch) {
                setStyleImportant(video, {
                    'position': 'absolute',
                    'left': '0',
                    'top': '0',
                    'width': '100%',
                    'height': '100%',
                    'max-width': 'none',
                    'max-height': 'none',
                    'transform': 'none',
                    'object-fit': zoomMode === 1 ? 'cover' : 'fill'
                });
                return;
            }

            var contain = Math.min(cw / vw, ch / vh);
            var bw = vw * contain;
            var bh = vh * contain;
            var sx, sy;
            if (zoomMode === 1) {
                var cover = Math.max(cw / vw, ch / vh);
                sx = cover / contain;
                sy = sx;
            } else {
                sx = cw / bw;
                sy = ch / bh;
            }
            setStyleImportant(video, {
                'position': 'absolute',
                'left': ((cw - bw) / 2) + 'px',
                'top': ((ch - bh) / 2) + 'px',
                'width': bw + 'px',
                'height': bh + 'px',
                'max-width': 'none',
                'max-height': 'none',
                'object-fit': 'fill',
                'transform-origin': 'center center',
                'transform': 'scale(' + sx + ',' + sy + ')'
            });
        }

        function scheduleFit() {
            for (var i = 0; i < fitTimers.length; i++) clearTimeout(fitTimers[i]);
            fitTimers = [];
            var delays = [0, 120, 400, 900];
            for (var j = 0; j < delays.length; j++) {
                fitTimers.push(setTimeout(applyVideoFit, delays[j]));
            }
        }

        function showZoomToast(txt) {
            var toast = uiRefs.toast;
            if (!toast) return;
            clearTimeout(uiRefs.toastTimer);
            toast.textContent = txt;
            toast.classList.add('is-show');
            uiRefs.toastTimer = setTimeout(function () {
                toast.classList.remove('is-show');
            }, 1300);
        }

        function applyZoomMode(mode, silent) {
            zoomMode = mode;
            var pl = getPlyrEl();
            if (pl) {
                pl.classList.remove('trm-zoom-fill', 'trm-zoom-stretch');
                if (mode === 1) pl.classList.add('trm-zoom-fill');
                else if (mode === 2) pl.classList.add('trm-zoom-stretch');
            }
            var label = 'Zoom: Original Fit';
            if (mode === 1) label = 'Zoom: Fill';
            else if (mode === 2) label = 'Zoom: Full Stretch';
            applyVideoFit();
            scheduleFit();
            if (!silent) showZoomToast(label);
        }

        function syncFsUi() {
            var pl = getPlyrEl();
            if (pl) pl.classList.toggle('trm-fs-active', fsActive);
            if (uiRefs.zoomBtn) uiRefs.zoomBtn.style.setProperty('display', fsActive ? 'inline-flex' : 'none', 'important');
            if (uiRefs.lockBtn) uiRefs.lockBtn.style.setProperty('display', fsActive ? 'flex' : 'none', 'important');
        }

        function setFsState(active, reason) {
            active = !!active;
            var was = fsActive;
            fsActive = active;
            if (active) {
                if (detectFs()) fsNativeSeen = true;
            } else {
                fsNativeSeen = false;
                if (uiRefs.unlock) uiRefs.unlock();
                if (zoomMode !== 0) applyZoomMode(0, true);
                if (uiRefs.toast) uiRefs.toast.classList.remove('is-show');
            }
            syncFsUi();
            if (active !== was) trmReport('FS STATE', 'trm-fs-active=' + active + ' (' + reason + ')', false);
            applyVideoFit();
        }

        function onNativeFsChange(ev) {
            if (nativeFsElement()) {
                fsNativeSeen = true;
                setFsState(true, ev.type);
            } else {
                setFsState(false, ev.type);
            }
            scheduleFit();
        }

        function onGeometryChange(reason) {
            var d = detectFs();
            if (d) {
                fsNativeSeen = true;
                if (!fsActive) setFsState(true, reason);
            } else if (fsActive && fsNativeSeen && (Date.now() - lastFsClick) > 1500) {
                setFsState(false, reason);
            }
            scheduleFit();
        }

        function onFsButtonClick() {
            lastFsClick = Date.now();
            setFsState(!fsActive, 'fullscreen button click');
            scheduleFit();
            fsZoomInspect('FS button tapped (immediate)');
            setTimeout(function () { fsZoomInspect('FS button tapped (+500ms)'); }, 500);
            setTimeout(function () {
                if (fsActive && !detectFs()) {
                    trmReport('FS/ZOOM INSPECT', 'WARNING: trm-fs-active is ON but the browser reports no fullscreen element and no plyr fullscreen class', true);
                }
                fsZoomInspect('FS button tapped (+1200ms)');
            }, 1200);
        }

        window.__trmFs = {
            set: function (active, reason) {
                setFsState(active, reason);
                scheduleFit();
            },
            inspect: fsZoomInspect
        };

        document.addEventListener('fullscreenchange', onNativeFsChange);
        document.addEventListener('webkitfullscreenchange', onNativeFsChange);
        video.addEventListener('webkitbeginfullscreen', function () { setFsState(true, 'webkitbeginfullscreen'); });
        video.addEventListener('webkitendfullscreen', function () { setFsState(false, 'webkitendfullscreen'); });
        window.addEventListener('resize', function () { onGeometryChange('resize'); });
        window.addEventListener('orientationchange', function () { onGeometryChange('orientationchange'); });
        try {
            if (screen.orientation && typeof screen.orientation.addEventListener === 'function') {
                screen.orientation.addEventListener('change', function () { onGeometryChange('screen.orientation change'); });
            }
        } catch (eOri) {}
        video.addEventListener('loadedmetadata', scheduleFit);
        video.addEventListener('resize', scheduleFit);

        function mountLockAndZoomUI(controls) {
            var plyrContainer = controls.closest('.plyr') || video.closest('.plyr');
            if (!plyrContainer || plyrContainer.querySelector('.trm-lock-btn')) return;
            uiRefs.plyr = plyrContainer;

            // ---------- 1. Right-Center Lock Button ----------
            var isScreenLocked = false;
            var unlockHideTimer = null;
            var LOCK_SVG = '<svg viewBox="0 0 24 24"><path d="M12 17a2 2 0 1 0 0-4 2 2 0 0 0 0 4zm6-9h-1V6a5 5 0 0 0-10 0v2H6a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V10a2 2 0 0 0-2-2zM8.9 6a3.1 3.1 0 1 1 6.2 0v2H8.9V6z"/></svg>';

            var lockBtn = document.createElement('button');
            lockBtn.type = 'button';
            lockBtn.className = 'trm-lock-btn';
            lockBtn.title = 'Lock Screen';
            lockBtn.setAttribute('aria-label', 'Lock Screen');
            lockBtn.innerHTML = LOCK_SVG;

            var shield = document.createElement('div');
            shield.className = 'trm-lock-shield';
            shield.innerHTML =
                '<div class="trm-unlock-pill">' +
                '<div class="trm-unlock-icon">' + LOCK_SVG + '</div>' +
                '<span>SWIPE TO UNLOCK</span>' +
                '</div>';

            var pill = shield.querySelector('.trm-unlock-pill');
            var pillIcon = shield.querySelector('.trm-unlock-icon');

            function showUnlockPillTemporarily() {
                clearTimeout(unlockHideTimer);
                pill.classList.remove('is-hidden');
                unlockHideTimer = setTimeout(function () {
                    if (isScreenLocked) pill.classList.add('is-hidden');
                }, 3200);
            }

            function setScreenLock(locked) {
                isScreenLocked = locked;
                clearTimeout(unlockHideTimer);
                pillIcon.style.transform = '';
                if (locked) {
                    plyrContainer.classList.add('trm-screen-locked');
                    showUnlockPillTemporarily();
                } else {
                    plyrContainer.classList.remove('trm-screen-locked');
                    pill.classList.remove('is-hidden');
                }
            }

            uiRefs.unlock = function () { setScreenLock(false); };
            uiRefs.lockBtn = lockBtn;

            lockBtn.addEventListener('click', function (e) {
                e.stopPropagation();
                e.preventDefault();
                setScreenLock(true);
            });
            lockBtn.addEventListener('touchstart', function (e) { e.stopPropagation(); }, { passive: true });

            // Any tap on the shield only re-shows the pill, it never reaches the player.
            shield.addEventListener('click', function (e) {
                e.stopPropagation();
                e.preventDefault();
                showUnlockPillTemporarily();
            });
            shield.addEventListener('touchstart', function (e) { e.stopPropagation(); }, { passive: true });

            // Real swipe-to-unlock: drag the pill horizontally past a threshold.
            var SWIPE_UNLOCK_PX = 40;
            var swipeStartX = null;
            pill.addEventListener('pointerdown', function (e) {
                e.stopPropagation();
                swipeStartX = e.clientX;
                clearTimeout(unlockHideTimer);
                pillIcon.classList.add('is-dragging');
                try { pill.setPointerCapture(e.pointerId); } catch (x) {}
            });
            pill.addEventListener('pointermove', function (e) {
                if (swipeStartX === null) return;
                var dx = e.clientX - swipeStartX;
                if (dx > 90) dx = 90;
                if (dx < -90) dx = -90;
                pillIcon.style.transform = 'translateX(' + dx + 'px)';
            });
            function endSwipe(e, cancelled) {
                if (swipeStartX === null) return;
                var dx = Math.abs(e.clientX - swipeStartX);
                swipeStartX = null;
                pillIcon.classList.remove('is-dragging');
                pillIcon.style.transform = '';
                try { pill.releasePointerCapture(e.pointerId); } catch (x) {}
                if (!cancelled && dx > SWIPE_UNLOCK_PX) setScreenLock(false);
                else showUnlockPillTemporarily();
            }
            pill.addEventListener('pointerup', function (e) { e.stopPropagation(); endSwipe(e, false); });
            pill.addEventListener('pointercancel', function (e) { endSwipe(e, true); });
            pill.addEventListener('click', function (e) {
                e.stopPropagation();
                e.preventDefault();
            });

            plyrContainer.appendChild(lockBtn);
            plyrContainer.appendChild(shield);

            // Tapping the screen in fullscreen brings the controls (and the lock button) back.
            plyrContainer.addEventListener('touchend', function () {
                if (!fsActive || isScreenLocked) return;
                if (plyrContainer.classList.contains('plyr--hide-controls')) {
                    try {
                        if (window.__trmPlayer && typeof window.__trmPlayer.toggleControls === 'function') {
                            window.__trmPlayer.toggleControls(true);
                        }
                    } catch (eTap) {}
                }
            }, { passive: true });

            // ---------- 2. Zoom / Aspect Button ----------
            var toast = document.createElement('div');
            toast.className = 'trm-zoom-toast';
            plyrContainer.appendChild(toast);
            uiRefs.toast = toast;

            var zoomBtn = document.createElement('button');
            zoomBtn.type = 'button';
            zoomBtn.className = 'plyr__controls__item plyr__control trm-zoom-ctrl';
            zoomBtn.title = 'Zoom / Aspect Ratio';
            zoomBtn.setAttribute('aria-label', 'Zoom / Aspect Ratio');
            zoomBtn.innerHTML =
                '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">' +
                '<path fill="currentColor" d="M19 12h-2v3h-3v2h5v-5zM7 9h3V7H5v5h2V9zm14-6H3c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h18c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 16.01H3V4.99h18v14.02z"/>' +
                '</svg><span class="plyr__sr-only">Zoom</span>';

            zoomBtn.addEventListener('click', function (e) {
                e.stopPropagation();
                e.preventDefault();
                applyZoomMode((zoomMode + 1) % 3, false);
                fsZoomInspect('Zoom button tapped (immediate)');
                setTimeout(function () { fsZoomInspect('Zoom button tapped (+500ms)'); }, 500);
            });
            uiRefs.zoomBtn = zoomBtn;

            var fsBtn = controls.querySelector('[data-plyr="fullscreen"]');
            if (fsBtn && fsBtn.parentNode) fsBtn.parentNode.insertBefore(zoomBtn, fsBtn);
            else controls.appendChild(zoomBtn);

            // ---------- 3. Direct click listener on the Fullscreen button(s) ----------
            var fsBtns = controls.querySelectorAll('[data-plyr="fullscreen"]');
            for (var fb = 0; fb < fsBtns.length; fb++) {
                fsBtns[fb].addEventListener('click', onFsButtonClick);
            }

            syncFsUi();
            scheduleFit();
        }

        function waitForControlsUI(tries) {
            var c = document.querySelector('.plyr__controls');
            if (c) {
                mountLockAndZoomUI(c);
                return;
            }
            if (tries <= 0) return;
            setTimeout(function () { waitForControlsUI(tries - 1); }, 100);
        }
        waitForControlsUI(80);

        // ===============================================================
        // FFMPEG WORKER
        // ===============================================================
        function ffWorkerMain() {
            var core = null;
            var logBuf = [];
            var runs = 0;
            var chain = Promise.resolve();

            function reply(msg, transfer) { self.postMessage(msg, transfer || []); }

            function runFF(args) {
                var full = ['-nostdin', '-y'].concat(args);
                logBuf.length = 0;
                var rc = 0;
                if (typeof core.exec === 'function') {
                    try {
                        core.exec.apply(core, full);
                        rc = core.ret;
                    } finally {
                        try { if (typeof core.reset === 'function') core.reset(); } catch (er) {}
                    }
                } else if (typeof core.callMain === 'function') {
                    rc = core.callMain(full);
                } else {
                    throw new Error('ffmpeg core has neither exec nor callMain');
                }
                return rc | 0;
            }

            async function init(base) {
                importScripts(base + 'ffmpeg-core.js');
                if (typeof self.createFFmpegCore !== 'function') {
                    throw new Error('createFFmpegCore missing after importScripts');
                }
                var hash = btoa(JSON.stringify({ wasmURL: base + 'ffmpeg-core.wasm' }));
                core = await self.createFFmpegCore({
                    mainScriptUrlOrBlob: base + 'ffmpeg-core.js#' + hash,
                    locateFile: function (pth) { return base + pth; }
                });
                if (typeof core.setLogger === 'function') {
                    core.setLogger(function (e) {
                        logBuf.push(String(e && e.message !== undefined ? e.message : e));
                        if (logBuf.length > 400) logBuf.shift();
                    });
                }
                runFF(['-hide_banner', '-decoders']);
                var txt = logBuf.join('\n');
                // Best-effort warm-up so the first real decode is not the first ffmpeg run.
                try {
                    runFF(['-v', 'error', '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=5.1', '-t', '0.1', '-f', 'f32le', '-ac', '6', 'warm.pcm']);
                    try { core.FS.unlink('warm.pcm'); } catch (uw) {}
                } catch (ew) {}
                return {
                    chars: txt.length,
                    hasEac3: /\beac3\b/.test(txt),
                    hasAc3: /\bac3\b/.test(txt),
                    hasDca: /\bdca\b/.test(txt),
                    hasAac: /\baac\b/.test(txt),
                    hasMp3: /\bmp3(?:float)?\b/.test(txt),
                    hasFlac: /\bflac\b/.test(txt),
                    hasOpus: /\b(?:lib)?opus\b/.test(txt)
                };
            }

            function heapSize() {
                try { return core && core.HEAPU8 ? core.HEAPU8.length : 0; } catch (e) { return 0; }
            }

            function decode(m) {
                runs++;
                var inN = 'in' + runs + '.' + m.fmt;
                var outN = 'out' + runs + '.pcm';
                var ch = (m.ch | 0) || 6;
                var rc = 0;
                var pcm = null;
                try {
                    core.FS.writeFile(inN, m.data);
                    try {
                        rc = runFF(['-threads', '1', '-v', 'error', '-f', m.fmt, '-i', inN, '-vn', '-sn', '-dn', '-f', 'f32le', '-ac', String(ch), outN]);
                    } catch (ex) {
                        ex.fatal = true;
                        throw ex;
                    }
                    try {
                        pcm = core.FS.readFile(outN);
                    } catch (er2) {
                        throw new Error('no PCM output (rc=' + rc + ') ' + logBuf.slice(-3).join(' | '));
                    }
                } finally {
                    try { core.FS.unlink(inN); } catch (u1) {}
                    try { core.FS.unlink(outN); } catch (u2) {}
                }
                var f32 = new Float32Array(pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + (pcm.byteLength & ~3)));
                var len = Math.floor(f32.length / ch);
                var planes = [];
                var transfer = [];
                for (var c = 0; c < ch; c++) {
                    var pl = new Float32Array(len);
                    for (var s = 0; s < len; s++) pl[s] = f32[s * ch + c];
                    planes.push(pl.buffer);
                    transfer.push(pl.buffer);
                }
                return { msg: { id: m.id, planes: planes, len: len, heap: heapSize() }, transfer: transfer };
            }

            async function handle(m) {
                try {
                    if (m.op === 'init') {
                        var info = await init(m.base);
                        info.id = m.id;
                        reply(info);
                    } else if (m.op === 'decode') {
                        var out = decode(m);
                        reply(out.msg, out.transfer);
                    } else {
                        throw new Error('unknown op ' + m.op);
                    }
                } catch (e) {
                    reply({
                        id: m.id,
                        error: String(e && e.message ? e.message : e),
                        fatal: !!(e && e.fatal) || m.op === 'init'
                    });
                }
            }

            self.onmessage = function (ev) {
                var m = ev.data;
                chain = chain.then(function () { return handle(m); });
            };
        }

        var FF = (function () {
            // Where ffmpeg-core.js / .wasm come from. Same-origin /ffcore/ when the host serves it (test Worker),
            // otherwise the public CDN, so the player also works on pages whose Worker has no /ffcore/ route.
            // window.__TRM_FFCORE_BASE can force a base (must end with "/").
            var FFCORE_CANDIDATES = [
                window.location.origin + '/ffcore/',
                'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/umd/',
                'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.6/dist/umd/'
            ];
            var baseP = null;
            function resolveBase() {
                if (baseP) return baseP;
                if (window.__TRM_FFCORE_BASE) {
                    baseP = Promise.resolve(String(window.__TRM_FFCORE_BASE));
                    return baseP;
                }
                baseP = (async function () {
                    for (var ci = 0; ci < FFCORE_CANDIDATES.length; ci++) {
                        var cand = FFCORE_CANDIDATES[ci];
                        try {
                            var hr = await fetch(cand + 'ffmpeg-core.js', { method: 'HEAD' });
                            if (hr.ok && /javascript|ecmascript/i.test(hr.headers.get('Content-Type') || '')) {
                                trmReport('FFCORE LOAD', 'core source: ' + cand, false);
                                return cand;
                            }
                        } catch (eB) {}
                    }
                    trmReport('FFCORE LOAD', 'no core source answered the probe, trying ' + FFCORE_CANDIDATES[0], true);
                    return FFCORE_CANDIDATES[0];
                })();
                return baseP;
            }
            var HEAP_SOFT_LIMIT = 512 * 1024 * 1024;
            var worker = null, readyP = null, seq = 0, calls = {}, heapBytes = 0;

            function rawCall(w, op, data, timeoutMs) {
                return new Promise(function (resolve, reject) {
                    var id = ++seq;
                    var timer = null;
                    function clr() { if (timer) { clearTimeout(timer); timer = null; } }
                    calls[id] = {
                        resolve: function (v) { clr(); resolve(v); },
                        reject: function (e) { clr(); reject(e); },
                        w: w
                    };
                    var msg = { id: id, op: op };
                    for (var k in data) msg[k] = data[k];
                    try {
                        w.postMessage(msg);
                    } catch (e) {
                        delete calls[id];
                        clr();
                        reject(e);
                        return;
                    }
                    if (timeoutMs) {
                        timer = setTimeout(function () {
                            timer = null;
                            if (!calls[id]) return;
                            delete calls[id];
                            var er = new Error('ffmpeg worker "' + op + '" timed out after ' + timeoutMs + 'ms');
                            er.fatal = true;
                            er.timeout = true;
                            reject(er);
                        }, timeoutMs);
                    }
                });
            }

            function killWorker(reason) {
                var w = worker;
                worker = null;
                readyP = null;
                if (w) {
                    try { w.terminate(); } catch (e) {}
                    try { if (w._blobUrl) URL.revokeObjectURL(w._blobUrl); } catch (e2) {}
                }
                Object.keys(calls).forEach(function (id) {
                    var c = calls[id];
                    if (c.w === w) {
                        delete calls[id];
                        var er = new Error(reason);
                        er.fatal = true;
                        c.reject(er);
                    }
                });
            }

            function spawn() {
                var src = '(' + ffWorkerMain.toString() + ')();';
                var bUrl = URL.createObjectURL(new Blob([src], { type: 'application/javascript' }));
                var w = new Worker(bUrl);
                w._blobUrl = bUrl;
                w.onmessage = function (ev) {
                    var m = ev.data || {};
                    var c = calls[m.id];
                    if (!c) return;
                    delete calls[m.id];
                    if (m.error) {
                        var er = new Error(m.error);
                        er.fatal = !!m.fatal;
                        c.reject(er);
                    } else {
                        c.resolve(m);
                    }
                };
                w.onerror = function (ev) {
                    var msg = 'ffmpeg worker crashed: ' + (ev && ev.message ? ev.message : 'unknown');
                    if (ev && ev.preventDefault) ev.preventDefault();
                    if (worker === w) killWorker(msg);
                };
                return w;
            }

            function ensure() {
                if (readyP) return readyP;
                trmReport('FFCORE LOAD', 'Starting ffmpeg core in a dedicated Web Worker (about 30 MB, cached after first load)...', false);
                var w = spawn();
                worker = w;
                var p = resolveBase().then(function (base) {
                    return rawCall(w, 'init', { base: base }, 45000);
                }).then(function (r) {
                    var ok = !!(r.hasEac3 || r.hasAc3);
                    trmReport('PROBE FFCORE', 'decoders list chars=' + r.chars + ' eac3=' + r.hasEac3 + ' ac3=' + r.hasAc3 + ' dca=' + r.hasDca + ' aac=' + r.hasAac + ' mp3=' + r.hasMp3 + ' flac=' + r.hasFlac + ' opus=' + r.hasOpus, !ok);
                    if (!ok) throw new Error('ffmpeg core loaded but has no eac3/ac3 decoder');
                    try { if (w._blobUrl) URL.revokeObjectURL(w._blobUrl); } catch (e) {}
                    return w;
                });
                readyP = p;
                p.catch(function (e) {
                    if (worker === w) killWorker('init failed: ' + formatErr(e));
                });
                return p;
            }

            var DECODE_TIMEOUT_MS = 4000;

            async function decodeBatch(fmt, ch, bytes) {
                for (var attempt = 0; attempt < 2; attempt++) {
                    var w = await ensure();
                    if (attempt === 0 && heapBytes > HEAP_SOFT_LIMIT) {
                        trmReport('FFCORE HEAP', 'WASM heap above safety limit, terminating worker to reclaim memory', true);
                        heapBytes = 0;
                        killWorker('heap recycle');
                        w = await ensure();
                    }
                    try {
                        var r = await rawCall(w, 'decode', { fmt: fmt, ch: ch, data: bytes }, DECODE_TIMEOUT_MS);
                        heapBytes = r.heap || 0;
                        return r;
                    } catch (e) {
                        if (e && e.timeout) {
                            trmReport('FFCORE TIMEOUT', formatErr(e) + ' - terminating worker', true);
                            killWorker('decode timeout');
                        }
                        if (!e || !e.fatal || attempt === 1) throw e;
                        if (!(e && e.timeout)) {
                            trmReport('FFCORE RECOVER', 'Worker failed (' + formatErr(e) + '), terminating and retrying batch on a fresh worker', true);
                            killWorker('recover');
                        }
                    }
                }
                return null;
            }

            return {
                ensure: ensure,
                decodeBatch: decodeBatch,
                dispose: function () { killWorker('dispose'); }
            };
        })();

        var FIRST_BATCH = 4;
        var MID_BATCH = 12;
        var STEADY_BATCH = 45;

        var AAC_SR = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];

        function aacAdtsInfo(cp, sr, ch) {
            var aot = 2, idx = -1, cc = ch || 2;
            if (cp && cp.length >= 2) {
                var o = cp[0] >> 3;
                idx = ((cp[0] & 7) << 1) | (cp[1] >> 7);
                cc = (cp[1] >> 3) & 15;
                if (o >= 1 && o <= 4) aot = o;
            }
            if (idx < 0 || idx > 12) {
                idx = AAC_SR.indexOf(sr);
                if (idx < 0) idx = 3;
            }
            if (!cc) cc = ch || 2;
            if (cc > 7) cc = 7;
            return { profile: aot - 1, idx: idx, ch: cc };
        }

        function buildAdts(batch, a) {
            var i, total = 0;
            for (i = 0; i < batch.length; i++) total += batch[i].length + 7;
            var out = new Uint8Array(total), off = 0;
            for (i = 0; i < batch.length; i++) {
                var len = batch[i].length + 7;
                out[off] = 0xFF;
                out[off + 1] = 0xF1;
                out[off + 2] = ((a.profile & 3) << 6) | ((a.idx & 15) << 2) | ((a.ch >> 2) & 1);
                out[off + 3] = ((a.ch & 3) << 6) | ((len >> 11) & 3);
                out[off + 4] = (len >> 3) & 0xFF;
                out[off + 5] = ((len & 7) << 5) | 0x1F;
                out[off + 6] = 0xFC;
                out.set(batch[i], off + 7);
                off += len;
            }
            return out;
        }

        function flacInfo(cp) {
            var si = null;
            if (cp && cp.length >= 8 && cp[0] === 0x66 && cp[1] === 0x4C && cp[2] === 0x61 && cp[3] === 0x43) {
                var blen = (cp[5] << 16) | (cp[6] << 8) | cp[7];
                if ((cp[4] & 0x7F) === 0 && blen >= 34 && cp.length >= 8 + blen) si = cp.subarray(8, 8 + blen);
            } else if (cp && cp.length >= 34) {
                si = cp.subarray(0, 34);
            }
            if (!si) throw new Error('FLAC track has no usable STREAMINFO in CodecPrivate');
            var header = new Uint8Array(8 + si.length);
            header.set([0x66, 0x4C, 0x61, 0x43, 0x80, (si.length >> 16) & 255, (si.length >> 8) & 255, si.length & 255], 0);
            header.set(si, 8);
            return { header: header, bs: ((si[2] << 8) | si[3]) || 4096 };
        }

        var OGG_CRC = (function () {
            var tbl = new Uint32Array(256);
            for (var n = 0; n < 256; n++) {
                var r = n << 24;
                for (var k = 0; k < 8; k++) r = (r & 0x80000000) ? ((r << 1) ^ 0x04C11DB7) : (r << 1);
                tbl[n] = r >>> 0;
            }
            return tbl;
        })();

        function oggCrc(bytes) {
            var c = 0;
            for (var i = 0; i < bytes.length; i++) c = ((c << 8) ^ OGG_CRC[((c >>> 24) ^ bytes[i]) & 0xFF]) >>> 0;
            return c;
        }

        function oggPage(flags, granule, serial, seqNo, pkts) {
            var segs = [], payload = 0, i, k;
            for (i = 0; i < pkts.length; i++) {
                for (k = pkts[i].length; k >= 255; k -= 255) segs.push(255);
                segs.push(k);
                payload += pkts[i].length;
            }
            var out = new Uint8Array(27 + segs.length + payload);
            out[0] = 0x4F; out[1] = 0x67; out[2] = 0x67; out[3] = 0x53;
            out[5] = flags;
            var lo = granule % 4294967296, hi = Math.floor(granule / 4294967296);
            for (i = 0; i < 4; i++) {
                out[6 + i] = (lo >>> (8 * i)) & 0xFF;
                out[10 + i] = (hi >>> (8 * i)) & 0xFF;
                out[14 + i] = (serial >>> (8 * i)) & 0xFF;
                out[18 + i] = (seqNo >>> (8 * i)) & 0xFF;
            }
            out[26] = segs.length;
            for (i = 0; i < segs.length; i++) out[27 + i] = segs[i];
            var off = 27 + segs.length;
            for (i = 0; i < pkts.length; i++) { out.set(pkts[i], off); off += pkts[i].length; }
            var crc = oggCrc(out);
            for (i = 0; i < 4; i++) out[22 + i] = (crc >>> (8 * i)) & 0xFF;
            return out;
        }

        var OPUS_TAGS = new Uint8Array([0x4F, 0x70, 0x75, 0x73, 0x54, 0x61, 0x67, 0x73, 0, 0, 0, 0, 0, 0, 0, 0]);

        function opusHeadFrom(cp) {
            if (!cp || cp.length < 19 || String.fromCharCode.apply(null, cp.subarray(0, 8)) !== 'OpusHead') {
                throw new Error('Opus track has no valid OpusHead in CodecPrivate');
            }
            var h = new Uint8Array(cp);
            h[10] = 0; h[11] = 0;
            return h;
        }

        function opusPacketSamples(pk) {
            if (!pk.length) return 0;
            var toc = pk[0], c = toc & 3, cfg = toc >> 3, fs;
            if (cfg < 12) fs = [480, 960, 1920, 2880][cfg & 3];
            else if (cfg < 16) fs = (cfg & 1) ? 960 : 480;
            else fs = [120, 240, 480, 960][cfg & 3];
            var n = c === 0 ? 1 : (c === 3 ? (pk.length > 1 ? (pk[1] & 63) : 1) : 2);
            return fs * n;
        }

        function buildOggOpus(batch, head) {
            var SERIAL = 0x54524D31;
            var pages = [];
            pages.push(oggPage(0x02, 0, SERIAL, 0, [head]));
            pages.push(oggPage(0x00, 0, SERIAL, 1, [OPUS_TAGS]));
            var seqNo = 2, gran = 0, i = 0;
            while (i < batch.length) {
                var pk = [], segs = 0;
                while (i < batch.length) {
                    var need = Math.floor(batch[i].length / 255) + 1;
                    if (pk.length && segs + need > 255) break;
                    pk.push(batch[i]);
                    segs += need;
                    gran += opusPacketSamples(batch[i]);
                    i++;
                }
                pages.push(oggPage(i >= batch.length ? 0x04 : 0x00, gran, SERIAL, seqNo++, pk));
            }
            var total = 0, j;
            for (j = 0; j < pages.length; j++) total += pages[j].length;
            var out = new Uint8Array(total), off = 0;
            for (j = 0; j < pages.length; j++) { out.set(pages[j], off); off += pages[j].length; }
            return out;
        }

        function codecFrameSeconds(codec, sr, flacBs) {
            switch (codec) {
                case 'A_AAC': return 1024 / sr;
                case 'A_MPEG/L3': return (sr >= 32000 ? 1152 : 576) / sr;
                case 'A_FLAC': return (flacBs || 4096) / sr;
                case 'A_OPUS': return 0.02;
                default: return 1536 / sr;
            }
        }

        function batchSizesFor(codec, sr, flacBs) {
            if (codec === 'A_AC3' || codec === 'A_EAC3' || codec === 'A_DTS') {
                return { first: FIRST_BATCH, mid: MID_BATCH, steady: STEADY_BATCH };
            }
            var fs = codecFrameSeconds(codec, sr, flacBs);
            return { first: Math.max(1, Math.round(0.25 / fs)), mid: Math.max(2, Math.round(0.4 / fs)), steady: Math.max(3, Math.round(1.44 / fs)) };
        }

        window.AC3WasmDecoder = {
            _promise: null,
            _getEngine: function () {
                if (this._promise) return this._promise;
                var self = this;
                this._promise = FF.ensure().then(function () {
                    trmReport('ENGINE SELECTED', 'source=ffmpeg-core (Web Worker)', false);
                    return true;
                });
                this._promise.catch(function (err) {
                    trmReport('ENGINE LOAD FAILED', formatErr(err), true);
                    self._promise = null;
                });
                return this._promise;
            },
            warm: function () { this._getEngine().catch(function () {}); },
            dispose: function () { FF.dispose(); this._promise = null; },

            create: async function (opts) {
                var codec = opts.codec;
                var FMT = { A_EAC3: 'eac3', A_AC3: 'ac3', A_DTS: 'dts', A_AAC: 'aac', 'A_MPEG/L3': 'mp3', A_FLAC: 'flac', A_OPUS: 'ogg' };
                var fmt = FMT[codec];
                if (!fmt) {
                    throw new Error('ffmpeg fallback cannot decode ' + codec + ' (supported: AC3, E-AC3, DTS, AAC, MP3, FLAC, Opus)');
                }
                await this._getEngine();

                var dolbyDts = (codec === 'A_AC3' || codec === 'A_EAC3' || codec === 'A_DTS');
                var chN = opts.channels || (dolbyDts ? 6 : 2);
                var sr = opts.sampleRate || 48000;

                var aac = null, flacHdr = null, flacBs = 0, opusHead = null;
                if (codec === 'A_AAC') {
                    aac = aacAdtsInfo(opts.cp, sr, chN);
                } else if (codec === 'A_FLAC') {
                    var fi = flacInfo(opts.cp);
                    flacHdr = fi.header;
                    flacBs = fi.bs;
                } else if (codec === 'A_OPUS') {
                    opusHead = opusHeadFrom(opts.cp);
                }
                var sizes = batchSizesFor(codec, sr, flacBs);

                var q = [], qTs = 0, stage = 0;
                var epoch = 0, inflight = 0, consecFail = 0, badTotal = 0, staleSkipped = 0;
                var frameSec = codecFrameSeconds(codec, sr, flacBs);
                var chain = Promise.resolve();

                trmReport('STEP 4: DECODER OPEN', 'ffmpeg-core worker ' + fmt + ' ch=' + chN + ' batches ' + sizes.first + ' / ' + sizes.mid + ' / ' + sizes.steady + ' frames', false);

                function buildInput(batch) {
                    var i, total = 0, off = 0, out;
                    if (codec === 'A_AAC') return buildAdts(batch, aac);
                    if (codec === 'A_OPUS') return buildOggOpus(batch, opusHead);
                    if (codec === 'A_FLAC') {
                        for (i = 0; i < batch.length; i++) total += batch[i].length;
                        out = new Uint8Array(flacHdr.length + total);
                        out.set(flacHdr, 0);
                        off = flacHdr.length;
                        for (i = 0; i < batch.length; i++) { out.set(batch[i], off); off += batch[i].length; }
                        return out;
                    }
                    for (i = 0; i < batch.length; i++) total += batch[i].length;
                    out = new Uint8Array(total);
                    for (i = 0; i < batch.length; i++) { out.set(batch[i], off); off += batch[i].length; }
                    return out;
                }

                async function runBatch(batch, t0, ep) {
                    var r, i;
                    try {
                        r = await FF.decodeBatch(fmt, chN, buildInput(batch));
                        consecFail = 0;
                    } catch (e) {
                        consecFail++;
                        badTotal++;
                        if (badTotal <= 3) trmReport('DECODE SKIP', formatErr(e), true);
                        if (consecFail >= 5) throw e;
                        return null;
                    }
                    if (ep !== epoch || !r || !r.len) return null;
                    var planes = [];
                    for (i = 0; i < r.planes.length; i++) planes.push(new Float32Array(r.planes[i]));
                    return { planes: planes, sampleRate: sr, ts: t0 };
                }

                function dispatch() {
                    var batch = q, t0 = qTs, ep = epoch;
                    q = [];
                    inflight++;
                    var p = chain.then(function () {
                        if (ep !== epoch) return null;
                        // Never decode audio that is already behind the live video clock.
                        var vtNow = typeof opts.getVideoTime === 'function' ? opts.getVideoTime() : -1;
                        if (vtNow >= 0 && (t0 + batch.length * frameSec) < vtNow - 0.1) {
                            staleSkipped++;
                            if (staleSkipped <= 10) trmReport('DECODE STALE SKIP', 'batch ts=' + t0.toFixed(3) + ' dur=' + (batch.length * frameSec).toFixed(3) + 's is behind video=' + vtNow.toFixed(3) + ' (skipped ' + staleSkipped + ')', true);
                            return null;
                        }
                        return runBatch(batch, t0, ep);
                    });
                    chain = p.then(function () {}, function () {});
                    var released = false;
                    function release() { if (!released) { released = true; inflight--; } }
                    return p.then(function (r) { release(); return r; }, function (e) { release(); throw e; });
                }

                return {
                    decode: function (bytes, ts) {
                        var u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
                        if (!u8.length) return Promise.resolve(null);
                        if (!q.length) qTs = ts;
                        q.push(u8);
                        var need = stage === 0 ? sizes.first : (stage === 1 ? sizes.mid : sizes.steady);
                        if (q.length < need) return Promise.resolve(null);
                        if (stage < 2) stage++;
                        return dispatch();
                    },
                    flush: function () {
                        if (!q.length) return Promise.resolve(null);
                        if (stage < 2) stage++;
                        return dispatch();
                    },
                    reset: function () { epoch++; q = []; stage = 0; },
                    close: function () { epoch++; q = []; },
                    inflight: function () { return inflight; }
                };
            }
        };

        // =====================================================================
        // EBML Parser Helpers
        // =====================================================================
        function readId(buf, pos) {
            if (pos >= buf.length) return null;
            var b = buf[pos]; if (b === 0) return null;
            var len = 1, mask = 0x80;
            while (!(b & mask)) { len++; mask >>= 1; }
            if (len > 4 || pos + len > buf.length) return null;
            var v = 0;
            for (var i = 0; i < len; i++) v = v * 256 + buf[pos + i];
            return { len: len, value: v };
        }
        function readSize(buf, pos) {
            if (pos >= buf.length) return null;
            var b = buf[pos]; if (b === 0) return null;
            var len = 1, mask = 0x80;
            while (!(b & mask)) { len++; mask >>= 1; }
            if (pos + len > buf.length) return null;
            var v = b & (mask - 1), ones = (b & (mask - 1)) === (mask - 1);
            for (var i = 1; i < len; i++) { var x = buf[pos + i]; v = v * 256 + x; if (x !== 0xFF) ones = false; }
            return { len: len, value: ones ? -1 : v, unknown: ones };
        }
        function uint(buf, s, e) {
            e = Math.min(e, buf.length);
            var v = 0;
            for (var i = s; i < e; i++) v = v * 256 + buf[i];
            return v;
        }
        function floatVal(buf, s, e) {
            e = Math.min(e, buf.length);
            var len = e - s;
            if (len !== 4 && len !== 8) return 0;
            var dv = new DataView(buf.buffer, buf.byteOffset + s, len);
            return len === 4 ? dv.getFloat32(0) : dv.getFloat64(0);
        }
        function strVal(buf, s, e) {
            e = Math.min(e, buf.length);
            return new TextDecoder('utf-8').decode(buf.subarray(s, e)).replace(/\0+$/, '');
        }
        function bytesToB64(bytes) {
            var s = '';
            for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
            return btoa(s);
        }
        function* children(buf, start, end) {
            var pos = start;
            end = Math.min(end, buf.length);
            while (pos < end) {
                var id = readId(buf, pos); if (!id) return;
                var sz = readSize(buf, pos + id.len); if (!sz) return;
                var ds = pos + id.len + sz.len;
                var de = sz.unknown ? Infinity : ds + sz.value;
                yield { id: id.value, ds: ds, de: de, unknown: sz.unknown };
                if (sz.unknown) return;
                pos = de;
            }
        }

        var TEXT_SUB_RE = /^S_TEXT\/(UTF8|ASCII|ASS|SSA)$/;

        // Identify the container from the first bytes (never trust the extension or the forced video/mp4 Content-Type).
        function sniffContainer(b) {
            if (!b || b.length < 12) return 'unknown';
            if (b[0] === 0x1A && b[1] === 0x45 && b[2] === 0xDF && b[3] === 0xA3) {
                var head = '';
                for (var i = 0; i < Math.min(b.length, 64); i++) head += String.fromCharCode(b[i]);
                return /webm/.test(head) ? 'webm' : 'matroska';
            }
            var s4 = String.fromCharCode(b[4], b[5], b[6], b[7]);
            if (s4 === 'ftyp' || s4 === 'moov' || s4 === 'mdat' || s4 === 'free' || s4 === 'wide' || s4 === 'styp') return 'mp4';
            var s0 = String.fromCharCode(b[0], b[1], b[2], b[3]);
            if (s0 === 'RIFF' && String.fromCharCode(b[8], b[9], b[10], b[11]) === 'AVI ') return 'avi';
            if (s0 === 'OggS') return 'ogg';
            if (b[0] === 0x46 && b[1] === 0x4C && b[2] === 0x56) return 'flv';
            if (b[0] === 0x47 && b.length > 376 && b[188] === 0x47 && b[376] === 0x47) return 'mpegts';
            return 'unknown';
        }

        // Native route: the plain <video> element plays everything. No engine, no shield, no extra download pipe.
        function routeNative(why) {
            try { video.muted = false; video.volume = 1; } catch (eMu) {}
            trmReport('ROUTE', 'NATIVE <video> pipeline: ' + why + ' | no engine, no shield, no duplicate download', false);
        }

        // Returns Matroska/WebM track info, or null. null is a NORMAL outcome (not an error):
        // it means "nothing for our engine to do" and the caller falls open to native playback.
        async function clientSideProbeMkv() {
            trmReport('CONTAINER', 'sniffing container from the first bytes of the stream...', false);
            var fileSize = null;
            var buf = null;
            try {
                var res = await fetch(url, { headers: { 'Range': 'bytes=0-393215' } });
                if (!res.ok && res.status !== 206) {
                    // Real stream problems are reported by the <video> element itself.
                    trmReport('CONTAINER', 'could not sniff (HTTP ' + res.status + ') - leaving playback to the browser', false);
                    return null;
                }
                var cr0 = /\/(\d+)$/.exec(res.headers.get('Content-Range') || '');
                if (cr0) fileSize = Number(cr0[1]);
                buf = new Uint8Array(await res.arrayBuffer());
            } catch (eSniff) {
                trmReport('CONTAINER', 'could not sniff (' + formatErr(eSniff) + ') - leaving playback to the browser', false);
                return null;
            }

            var kind = sniffContainer(buf);
            window.__TRM_CONTAINER = kind;
            if (kind !== 'matroska' && kind !== 'webm') {
                trmReport('CONTAINER', kind + ' -> standard container, native browser pipeline', false);
                return null;
            }
            trmReport('CONTAINER', kind + ' (EBML) -> reading audio / subtitle tracks', false);

            try {
                var mRes = await fetch(window.__TRM_META_URL || '/meta');
                if (mRes.ok) {
                    var mj = await mRes.json();
                    if (mj && mj.meta && mj.meta.audio && mj.meta.audio.length) {
                        return mj.meta;
                    }
                    if (mj && (mj.error || mj.hint)) {
                        trmReport('STEP 1: META ERROR', (mj.error || '') + ' ' + (mj.hint || ''), true);
                    }
                }
            } catch (e) {}

            try {
                var segStart = null, ts = 1000000, dur = null, cuesPos = null, rawTracks = [], rawSubs = [];

                for (var top of children(buf, 0, buf.length)) {
                    if (top.id !== 0x18538067) continue;
                    segStart = top.ds;
                    var segEnd = top.unknown ? buf.length : Math.min(top.de, buf.length);
                    for (var el of children(buf, top.ds, segEnd)) {
                        if (el.id === 0x114D9B74) {
                            for (var sk of children(buf, el.ds, Math.min(el.de, buf.length))) {
                                if (sk.id !== 0x4DBB) continue;
                                var sId = null, sPos = null;
                                for (var f of children(buf, sk.ds, Math.min(sk.de, buf.length))) {
                                    if (f.id === 0x53AB) sId = uint(buf, f.ds, f.de);
                                    else if (f.id === 0x53AC) sPos = uint(buf, f.ds, f.de);
                                }
                                if (sId === 0x1C53BB6B && sPos !== null) cuesPos = sPos;
                            }
                        } else if (el.id === 0x1549A966 && el.de <= buf.length) {
                            var rDur = null;
                            for (var inf of children(buf, el.ds, el.de)) {
                                if (inf.id === 0x2AD7B1) ts = uint(buf, inf.ds, inf.de) || 1000000;
                                else if (inf.id === 0x4489) rDur = floatVal(buf, inf.ds, inf.de);
                            }
                            if (rDur !== null) dur = (rDur * ts) / 1e9;
                        } else if (el.id === 0x1654AE6B) {
                            for (var te of children(buf, el.ds, Math.min(el.de, buf.length))) {
                                if (te.id !== 0xAE) continue;
                                var t = { num: 0, type: 0, codec: '', lang: 'eng', bcp: '', name: '', def: 1, forced: 0, ch: 2, sr: 48000, cp: null };
                                var teEnd = Math.min(te.de, buf.length);
                                for (var c of children(buf, te.ds, teEnd)) {
                                    var ce = Math.min(c.de, teEnd);
                                    if (c.id === 0xD7) t.num = uint(buf, c.ds, ce);
                                    else if (c.id === 0x83) t.type = uint(buf, c.ds, ce);
                                    else if (c.id === 0x86) t.codec = strVal(buf, c.ds, ce);
                                    else if (c.id === 0x22B59C) t.lang = strVal(buf, c.ds, ce);
                                    else if (c.id === 0x22B59D) t.bcp = strVal(buf, c.ds, ce);
                                    else if (c.id === 0x536E) t.name = strVal(buf, c.ds, ce);
                                    else if (c.id === 0x88) t.def = uint(buf, c.ds, ce);
                                    else if (c.id === 0x55AA) t.forced = uint(buf, c.ds, ce);
                                    else if (c.id === 0x63A2 && (ce - c.ds) > 0 && (ce - c.ds) <= 4096) t.cp = bytesToB64(buf.subarray(c.ds, ce));
                                    else if (c.id === 0xE1) {
                                        for (var a of children(buf, c.ds, ce)) {
                                            var ae = Math.min(a.de, ce);
                                            if (a.id === 0x9F) t.ch = uint(buf, a.ds, ae);
                                            else if (a.id === 0xB5) t.sr = floatVal(buf, a.ds, ae);
                                        }
                                    }
                                }
                                if (t.type === 2) rawTracks.push(t);
                                else if (t.type === 17 && TEXT_SUB_RE.test(t.codec)) rawSubs.push(t);
                            }
                        } else if (el.id === 0x1F43B675) {
                            break;
                        }
                    }
                    break;
                }
                if (!rawTracks.length) {
                    trmReport('CONTAINER', kind + ' has no audio track (video only) - native pipeline', false);
                    return null;
                }
                var audio = rawTracks.map(function (t, idx) {
                    return { id: t.num, idx: idx, lang: t.bcp || t.lang || 'und', name: t.name || '', codec: t.codec, ch: t.ch || 2, sr: Math.round(t.sr) || 48000, def: t.def !== 0, cp: t.cp };
                });
                var subsOut = rawSubs.map(function (t, idx) {
                    return { id: t.num, idx: idx, lang: t.bcp || t.lang || 'und', name: t.name || '', codec: t.codec, def: t.def !== 0, forced: t.forced !== 0 };
                });
                return { v: 15, size: fileSize, seg: segStart, ts: ts, dur: dur, cues: cuesPos, audio: audio, subs: subsOut };
            } catch (e) {
                trmReport('CONTAINER', 'track probe failed (' + formatErr(e) + ') - falling back to native playback', false);
                return null;
            }
        }

        function startAudioEngineWithMeta(META) {
            if (!META || !META.audio || !META.audio.length) return;
            var tracks = META.audio;
            var subs = (META.subs || []).filter(function (s) { return s && s.id; });

            var MAX_AHEAD = 24;
            var PRE_AHEAD = 6;
            var SUB_AHEAD = 45;
            var LOOKAHEAD = 1.5;
            var DRIFT_MAX = 0.18;
            var SUB_FALLBACK_MS = 4000;

            function normCodec(c) {
                c = String(c || '');
                if (c.indexOf('A_AAC') === 0) return 'A_AAC';
                if (c.indexOf('A_DTS') === 0) return 'A_DTS';
                return c;
            }
            tracks.forEach(function (t) { t.codec = normCodec(t.codec); });

            var summaryList = tracks.map(function (t, idx) { return '#' + (idx + 1) + ':' + t.codec + '(' + t.ch + 'ch)'; }).join(', ');
            trmReport('STEP 1: META OK', 'Found ' + tracks.length + ' audio track(s): ' + summaryList + ' | text subtitle track(s): ' + subs.length, false);

            var CODEC_LABEL = { A_AC3: 'AC3', A_EAC3: 'EAC3', A_DTS: 'DTS', A_AAC: 'AAC', A_OPUS: 'Opus', A_VORBIS: 'Vorbis', A_FLAC: 'FLAC', 'A_MPEG/L3': 'MP3', A_TRUEHD: 'TrueHD' };
            var CH_LABEL = { 1: 'Mono', 2: 'Stereo', 6: '5.1', 8: '7.1' };
            var LANG_FALLBACK = { tam: 'Tamil', hin: 'Hindi', eng: 'English', tel: 'Telugu', mal: 'Malayalam', kan: 'Kannada', ben: 'Bengali', mar: 'Marathi', pan: 'Punjabi', urd: 'Urdu', jpn: 'Japanese', kor: 'Korean', fre: 'French', fra: 'French', ger: 'German', deu: 'German', spa: 'Spanish', chi: 'Chinese', zho: 'Chinese', rus: 'Russian', ara: 'Arabic', tha: 'Thai' };

            function langName(code, fallbackIdx, word) {
                code = String(code || '').toLowerCase();
                if (!code || code === 'und') return (word || 'Track') + ' ' + (fallbackIdx + 1);
                try {
                    if (window.Intl && Intl.DisplayNames) {
                        var n = new Intl.DisplayNames(['en'], { type: 'language' }).of(code);
                        if (n && n.toLowerCase() !== code) return n;
                    }
                } catch (e) {}
                return LANG_FALLBACK[code] || code.toUpperCase();
            }

            var LANGS = [
                ['Tamil', 'tam', 'ta'], ['Telugu', 'tel', 'te'], ['Hindi', 'hin', 'hi'], ['Malayalam', 'mal', 'ml'],
                ['Kannada', 'kan', 'kn'], ['English', 'eng', 'en'], ['Bengali', 'ben', 'bn'], ['Marathi', 'mar', 'mr'],
                ['Punjabi', 'pan', 'pa'], ['Gujarati', 'guj', 'gu'], ['Urdu', 'urd', 'ur'], ['Japanese', 'jpn', 'ja'],
                ['Korean', 'kor', 'ko'], ['French', 'fre', 'fr'], ['German', 'ger', 'de'], ['Spanish', 'spa', 'es'],
                ['Chinese', 'chi', 'zh'], ['Russian', 'rus', 'ru'], ['Arabic', 'ara', 'ar'], ['Thai', 'tha', 'th']
            ];
            var NAME_MAP = {}, CODE_MAP = {};
            LANGS.forEach(function (l) {
                NAME_MAP[l[0].toLowerCase()] = l[0];
                CODE_MAP[l[1]] = l[0];
                CODE_MAP[l[2]] = l[0];
            });
            CODE_MAP.fra = 'French'; CODE_MAP.deu = 'German'; CODE_MAP.zho = 'Chinese';

            function stripDomains(s) {
                return String(s)
                    .replace(/https?:\/\/\S+/gi, ' ')
                    .replace(/www\.[^\s\[\]()]+/gi, ' ')
                    .replace(/[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|net|org|info|biz|in|co|me|mv|tv|cc|io|xyz|club|vip|capital|cam|wiki|ws|bz|ink|lol|cx|fun|site|online|top|click|ltd|cool|run)\b[^\s\[\]()]*/gi, ' ');
            }
            function findLangs(text, allowCodes) {
                var found = [], re = /[A-Za-z]+/g, m;
                while ((m = re.exec(text))) {
                    var w = m[0].toLowerCase();
                    var prev = m.index > 0 ? text.charAt(m.index - 1) : '';
                    var next = text.charAt(m.index + w.length);
                    if (/[0-9]/.test(prev) || /[0-9]/.test(next)) continue;
                    var d = NAME_MAP[w] || (allowCodes ? CODE_MAP[w] : null);
                    if (d && found.indexOf(d) < 0) found.push(d);
                }
                return found;
            }
            function trackLabel(t, i, word) {
                var w = word || 'Track';
                var nm = String(t.name || '').trim();
                if (nm) {
                    var groups = [], gre = /[\[(]([^\])]*)[\])]/g, gm;
                    while ((gm = gre.exec(nm))) groups.push(gm[1]);
                    for (var g = groups.length - 1; g >= 0; g--) {
                        var inBr = findLangs(groups[g], true);
                        if (inBr.length) return inBr.join(' + ');
                    }
                    var cleaned = stripDomains(nm);
                    var anywhere = findLangs(cleaned, false);
                    if (anywhere.length) return anywhere[anywhere.length - 1];
                }
                var code = String(t.lang || '').toLowerCase();
                if (code && code !== 'und') return langName(code, i, w);
                if (nm) {
                    var rest = stripDomains(nm).replace(/[\[\]()]/g, ' ').replace(/^[\s\-_|:.]+|[\s\-_|:.]+$/g, '').replace(/\s+/g, ' ');
                    if (/[A-Za-z]{2,}/.test(rest)) return rest;
                }
                return w + ' ' + (i + 1);
            }
            function dedupeLabels(base, keys) {
                var total = {}, seen = {};
                keys.forEach(function (k) { total[k] = (total[k] || 0) + 1; });
                return base.map(function (l, i) {
                    var k = keys[i];
                    if (total[k] > 1) { seen[k] = (seen[k] || 0) + 1; return l + ' ' + seen[k]; }
                    return l;
                });
            }
            function uniqueLabels() {
                var base = tracks.map(function (t, i) { return trackLabel(t, i, 'Track'); });
                var keys = tracks.map(function (t, i) { return base[i] + '|' + badgeText(t); });
                return dedupeLabels(base, keys);
            }
            function subLabels() {
                var base = subs.map(function (t, i) { return trackLabel(t, i, 'Subtitle'); });
                return dedupeLabels(base, base.slice());
            }
            function nameFull(t) { return String(t.name || '').trim(); }
            function badgeText(t) {
                var c = CODEC_LABEL[t.codec] || String(t.codec).replace(/^A_/, '');
                return c + ' ' + (CH_LABEL[t.ch] || (t.ch + 'ch'));
            }

            var NATIVE_MIME = {
                A_AC3: 'audio/mp4; codecs="ac-3"', A_EAC3: 'audio/mp4; codecs="ec-3"', A_AAC: 'audio/mp4; codecs="mp4a.40.2"',
                A_OPUS: 'audio/webm; codecs="opus"', A_VORBIS: 'audio/webm; codecs="vorbis"', A_FLAC: 'audio/flac', 'A_MPEG/L3': 'audio/mpeg'
            };
            function isNative(t) {
                var m = NATIVE_MIME[t.codec];
                return !!m && video.canPlayType(m) !== '';
            }

            var baseIdx = 0;
            for (var bi = 0; bi < tracks.length; bi++) { if (tracks[bi].def) { baseIdx = bi; break; } }
            var current = baseIdx;

            // True when track idx can be played by the plain <video> element (no engine needed):
            //  - the browser exposes one audioTrack per MKV audio track (we can enable it), or
            //  - it is the default track (the only one <video> plays without audioTracks), stereo/mono, native codec.
            // Multi-channel (5.1) tracks always go through our engine so they get the downmix + boost.
            function isBrowserNativeTrack(idx) {
                var t = tracks[idx];
                if (!t) return false;
                if (!isNative(t) || (t.ch || 2) > 2) return false;
                var nat = video.audioTracks;
                if (nat && nat.length === tracks.length) return true;
                return idx === baseIdx;
            }

            // True when the currently selected track must be decoded by our own engine.
            function engineWanted() {
                if (!tracks[current]) return false;
                return !isBrowserNativeTrack(current);
            }

            function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
            function b64ToBytes(b64) {
                var s = atob(b64), a = new Uint8Array(s.length);
                for (var i = 0; i < s.length; i++) a[i] = s.charCodeAt(i);
                return a;
            }

            async function hwSupported(t) {
                var c = t.codec === 'A_EAC3' ? 'ec-3' : (t.codec === 'A_AC3' ? 'ac-3' : null);
                if (!c || !window.AudioDecoder || !window.EncodedAudioChunk) return false;
                try {
                    var s = await AudioDecoder.isConfigSupported({ codec: c, sampleRate: t.sr || 48000, numberOfChannels: t.ch || 6 });
                    return !!(s && s.supported);
                } catch (e) { return false; }
            }
            // Warm the ffmpeg worker immediately (before Play) when hardware decoding is not available.
            (function preloadIfNeeded() {
                var t0 = tracks[baseIdx];
                if (!t0 || !engineWanted()) return;
                hwSupported(t0).then(function (ok) {
                    if (!ok) window.AC3WasmDecoder.warm();
                });
            })();

            function extractBlockFrames(buf, payloadStart, blockEnd, lacingType) {
                if (lacingType === 0) return [buf.slice(payloadStart, blockEnd)];
                if (payloadStart >= blockEnd) return [];
                var numFrames = buf[payloadStart] + 1;
                var pos = payloadStart + 1;
                var sizes = [];

                if (lacingType === 2) {
                    var totalRemaining = blockEnd - pos;
                    var singleSize = Math.floor(totalRemaining / numFrames);
                    for (var i = 0; i < numFrames; i++) sizes.push(singleSize);
                } else if (lacingType === 1) {
                    var sum = 0;
                    for (var i2 = 0; i2 < numFrames - 1; i2++) {
                        var fSize = 0;
                        while (pos < blockEnd) {
                            var b = buf[pos++];
                            fSize += b;
                            if (b < 255) break;
                        }
                        sizes.push(fSize);
                        sum += fSize;
                    }
                    sizes.push(Math.max(0, (blockEnd - pos) - sum));
                } else if (lacingType === 3) {
                    var firstSz = readSize(buf, pos);
                    if (!firstSz) return [];
                    pos += firstSz.len;
                    var curSize = firstSz.value;
                    sizes.push(curSize);
                    var sum3 = curSize;

                    for (var i3 = 1; i3 < numFrames - 1; i3++) {
                        var v = readSize(buf, pos);
                        if (!v) return [];
                        pos += v.len;
                        var bias = Math.pow(2, 7 * v.len - 1) - 1;
                        var diff = v.value - bias;
                        curSize += diff;
                        sizes.push(curSize);
                        sum3 += curSize;
                    }
                    sizes.push(Math.max(0, (blockEnd - pos) - sum3));
                }

                var frames = [];
                for (var j = 0; j < sizes.length; j++) {
                    var sz = sizes[j];
                    if (sz > 0 && pos + sz <= blockEnd) {
                        frames.push(buf.slice(pos, pos + sz));
                        pos += sz;
                    }
                }
                return frames;
            }

            var ctx = null, extGain = null, compNode = null;
            var active = false, engineBusy = false, track = null, gen = 0, decoder = null;
            var pending = [], scheduled = [], expected = null, lastTs = 0;
            var timer = null, seekTimer = null, demuxCtrl = null, lastResync = 0, cues = null, cuesP = null;
            var savedVolume = 1, internalVolChange = false;
            var MASTER_BOOST = 1.65;
            var statusCb = function () {};
            var subStatusCb = function () {};
            var audioEnded = false;
            // audioFirstOut: true once the first decoded audio exists (or the engine failed / is not needed).
            // Subtitle scanning waits for it so it never competes with the audio demux for bandwidth.
            var audioFirstOut = false;
            var subFallbackSet = false;

            // ---------------- DEBUG INSPECTOR STATE ----------------
            var playEventAt = null, schedAfterPlayLogged = false, firstOutLogged = false;
            var seekingAt = null, restartStartAt = null, awaitingPostSeek = false, awaitingSchedSeek = false;
            var lastDbgAt = 0, droppedCount = 0, dropLogs = 0;

            function pendingSecs() {
                var s = 0;
                for (var i = 0; i < pending.length; i++) s += pending[i].buf.duration;
                return s;
            }

            function ensureCtx() {
                if (ctx) return;
                var AC = window.AudioContext || window.webkitAudioContext;
                if (!AC) throw new Error('Web Audio API is not supported in this browser');
                ctx = new AC();
                extGain = ctx.createGain();
                extGain.gain.value = MASTER_BOOST;
                if (typeof ctx.createDynamicsCompressor === 'function') {
                    compNode = ctx.createDynamicsCompressor();
                    compNode.threshold.value = -14;
                    compNode.knee.value = 12;
                    compNode.ratio.value = 3.5;
                    compNode.attack.value = 0.003;
                    compNode.release.value = 0.18;
                    extGain.connect(compNode);
                    compNode.connect(ctx.destination);
                } else {
                    extGain.connect(ctx.destination);
                }
            }

            // Create / resume the AudioContext as early as possible (first touch of the page).
            function unlockAudio() {
                try {
                    ensureCtx();
                    if (ctx.state !== 'running') {
                        var rp = ctx.resume();
                        if (rp && rp.catch) rp.catch(function () {});
                    }
                } catch (e) {}
            }
            ['pointerdown', 'touchstart', 'touchend', 'click', 'keydown'].forEach(function (evName) {
                document.addEventListener(evName, unlockAudio, { capture: true, passive: true });
            });

            function silenceNativeVideo(silence) {
                internalVolChange = true;
                if (silence) {
                    if (video.volume > 0) savedVolume = video.volume;
                    video.volume = 0;
                } else {
                    video.volume = savedVolume || 1;
                }
                setTimeout(function () { internalVolChange = false; }, 50);
            }

            async function rangeBytes(from, to) {
                var res = await fetch(url, { headers: { 'Range': 'bytes=' + from + '-' + to } });
                if (res.status !== 206) { try { res.body && res.body.cancel(); } catch (e) {} return null; }
                return new Uint8Array(await res.arrayBuffer());
            }

            async function loadCuesImpl() {
                cues = [];
                if (META.cues === null || META.cues === undefined || META.seg === null || META.seg === undefined) return;
                var start = META.seg + META.cues;
                var buf = await rangeBytes(start, start + 65535);
                if (!buf) return;
                var id = readId(buf, 0), sz = id && readSize(buf, id.len);
                if (!id || id.value !== 0x1C53BB6B || !sz || sz.unknown) return;
                var total = id.len + sz.len + sz.value;
                if (total > 4 * 1024 * 1024) return;
                if (total > buf.length) { buf = await rangeBytes(start, start + total - 1); if (!buf) return; }
                var scale = META.ts || 1000000;
                var list = [];
                for (var cp of children(buf, id.len + sz.len, id.len + sz.len + sz.value)) {
                    if (cp.id !== 0xBB) continue;
                    var time = null, pos = null;
                    for (var x of children(buf, cp.ds, cp.de)) {
                        if (x.id === 0xB3) time = uint(buf, x.ds, x.de);
                        else if (x.id === 0xB7 && pos === null) {
                            for (var y of children(buf, x.ds, x.de)) if (y.id === 0xF1) pos = uint(buf, y.ds, y.de);
                        }
                    }
                    if (time !== null && pos !== null) list.push({ t: time * scale / 1e9, pos: pos });
                }
                list.sort(function (a, b) { return a.t - b.t; });
                cues = list;
            }
            function loadCues() {
                if (!cuesP) cuesP = loadCuesImpl().catch(function () { cues = []; });
                return cuesP;
            }
            function cueFor(t) {
                var lo = 0, hi = cues.length - 1, r = -1;
                while (lo <= hi) {
                    var m = (lo + hi) >> 1;
                    if (cues[m].t <= t) { r = m; lo = m + 1; } else hi = m - 1;
                }
                return r < 0 ? cues[0] : cues[r];
            }
            function startPosFor(t) {
                if (t < 2) return { pos: META.seg || 0, synced: true };
                if (cues && cues.length) return { pos: META.seg + cueFor(t).pos, synced: true };
                if (t > 1 && META.size && META.dur) return { pos: Math.floor(META.size * (t / META.dur)), synced: false };
                return { pos: META.seg || 0, synced: true };
            }


            function toStereo(planes) {
                var c = planes.length;
                if (c === 1) return [planes[0], planes[0]];
                if (c === 2) return planes;
                var n = planes[0].length, L = new Float32Array(n), R = new Float32Array(n);
                var C = -1, LFE = -1, SL = -1, SR = -1, SL2 = -1, SR2 = -1;
                if (c >= 6) { C = 2; LFE = 3; SL = 4; SR = 5; if (c >= 8) { SL2 = 6; SR2 = 7; } }
                else if (c === 5) { C = 2; SL = 3; SR = 4; }
                else if (c === 4) { SL = 2; SR = 3; }
                else if (c === 3) { C = 2; }
                for (var i = 0; i < n; i++) {
                    var l = planes[0][i] * 1.05;
                    var r = planes[1][i] * 1.05;
                    if (C >= 0) {
                        var cc = planes[C][i] * 1.15;
                        l += cc;
                        r += cc;
                    }
                    if (LFE >= 0) {
                        var subBass = planes[LFE][i] * 0.55;
                        l += subBass;
                        r += subBass;
                    }
                    if (SL >= 0) {
                        l += planes[SL][i] * 0.85;
                        r += planes[SR][i] * 0.85;
                    }
                    if (SL2 >= 0) {
                        l += planes[SL2][i] * 0.75;
                        r += planes[SR2][i] * 0.75;
                    }
                    L[i] = l > 1 ? (1 - Math.exp(-l)) : (l < -1 ? -(1 - Math.exp(l)) : l);
                    R[i] = r > 1 ? (1 - Math.exp(-r)) : (r < -1 ? -(1 - Math.exp(r)) : r);
                }
                return [L, R];
            }

            function getAacAsc(t) {
                if (t.cp) return b64ToBytes(t.cp);
                var srMap = { 96000: 0, 88200: 1, 64000: 2, 48000: 3, 44100: 4, 32000: 5, 24000: 6, 22050: 7, 16000: 8, 12000: 9, 11025: 10, 8000: 11 };
                var srIdx = srMap[t.sr] !== undefined ? srMap[t.sr] : 3;
                var ch = t.ch || 2;
                var b0 = (2 << 3) | (srIdx >> 1);
                var b1 = ((srIdx & 1) << 7) | (ch << 3);
                return new Uint8Array([b0, b1]);
            }

            function webCodecsDecoder(cfg, onOut) {
                var dec = null;
                var decodedCount = 0;
                function open() {
                    dec = new AudioDecoder({
                        output: function (ad) {
                            var planes = [];
                            for (var i = 0; i < ad.numberOfChannels; i++) {
                                var a = new Float32Array(ad.numberOfFrames);
                                ad.copyTo(a, { planeIndex: i, format: 'f32-planar' });
                                planes.push(a);
                            }
                            var out = { planes: planes, sampleRate: ad.sampleRate, ts: ad.timestamp / 1e6 };
                            ad.close();
                            if (decodedCount === 0) {
                                statusCb('', false);
                                trmReport('STEP 6: PLAYING (HW)', 'WebCodecs Hardware 5.1 Audio Active!', false);
                            }
                            decodedCount++;
                            onOut(out);
                        },
                        error: function (e) { trmReport('STEP 6: HW DECODE ERR', formatErr(e), true); }
                    });
                    dec.configure(cfg);
                }
                open();
                return {
                    push: function (bytes, ts) {
                        if (!dec || dec.state === 'closed') return;
                        try {
                            dec.decode(new EncodedAudioChunk({ type: 'key', timestamp: Math.round(ts * 1e6), data: bytes }));
                        } catch (e) {}
                    },
                    flush: function () {
                        try { if (dec && dec.state === 'configured') dec.flush().catch(function () {}); } catch (e) {}
                    },
                    busy: function () { return dec && dec.decodeQueueSize > 45; },
                    reset: function () { try { dec.close(); } catch (e) {} open(); },
                    close: function () { try { dec.close(); } catch (e) {} }
                };
            }

            async function wasmDecoder(t, onOut) {
                var api = window.AC3WasmDecoder;
                if (!api || typeof api.create !== 'function') throw new Error('WASM Audio decoder not available');
                statusCb('Starting TRM 5.1 Engine...', false);
                var inst = await api.create({
                    getVideoTime: function () { return (video.paused || video.seeking) ? -1 : video.currentTime; },
                    codec: t.codec,
                    channels: t.ch,
                    sampleRate: t.sr,
                    cp: t.cp ? b64ToBytes(t.cp) : null
                });
                statusCb('Buffering Audio...', false);
                var firstOut = true;
                var firstErrShown = false;

                function handle(promise) {
                    Promise.resolve(promise).then(function (r) {
                        if (r && r.planes && r.planes.length) {
                            if (firstOut) {
                                firstOut = false;
                                statusCb('', false);
                                trmReport('STEP 6: PLAYING (ffmpeg)', 'Decoding ' + t.codec + ' (' + r.planes.length + 'ch @ ' + r.sampleRate + 'Hz) in worker', false);
                            }
                            onOut({ planes: r.planes, sampleRate: r.sampleRate, ts: r.ts });
                        }
                    }).catch(function (e) {
                        if (!firstErrShown) {
                            firstErrShown = true;
                            statusCb('Decode err: ' + formatErr(e), true);
                            trmReport('STEP 6: DECODE ERR', formatErr(e), true);
                        }
                    });
                }

                return {
                    push: function (bytes, ts) { handle(inst.decode(bytes, ts)); },
                    flush: function () { handle(inst.flush()); },
                    busy: function () { return inst.inflight() >= 3; },
                    reset: function () { inst.reset(); },
                    close: function () { inst.close(); }
                };
            }

            async function makeDecoder(t, onOut) {
                if (t.codec === 'A_AC3' || t.codec === 'A_EAC3' || t.codec === 'A_DTS') {
                    var hwCodec = t.codec === 'A_EAC3' ? 'ec-3' : (t.codec === 'A_AC3' ? 'ac-3' : null);
                    if (hwCodec && window.AudioDecoder && window.EncodedAudioChunk) {
                        try {
                            var hwCfg = { codec: hwCodec, sampleRate: t.sr || 48000, numberOfChannels: t.ch || 6 };
                            var sup = await AudioDecoder.isConfigSupported(hwCfg);
                            trmReport('WEBCODECS', 'AudioDecoder(' + hwCodec + ') supported=' + !!(sup && sup.supported), false);
                            if (sup && sup.supported) return webCodecsDecoder(hwCfg, onOut);
                        } catch (e2) {}
                    }
                    return wasmDecoder(t, onOut);
                }
                var map = { A_AAC: 'mp4a.40.2', A_OPUS: 'opus', A_VORBIS: 'vorbis', A_FLAC: 'flac', 'A_MPEG/L3': 'mp3' };
                var wc = map[t.codec];
                if (wc && window.AudioDecoder && window.EncodedAudioChunk) {
                    var cfg = { codec: wc, sampleRate: t.sr || 48000, numberOfChannels: t.ch || 2 };
                    if (t.codec === 'A_AAC') {
                        cfg.description = getAacAsc(t);
                    } else if (t.cp) {
                        cfg.description = b64ToBytes(t.cp);
                    }
                    try {
                        var s = await AudioDecoder.isConfigSupported(cfg);
                        if (s && s.supported) return webCodecsDecoder(cfg, onOut);
                    } catch (e) {}
                }
                return wasmDecoder(t, onOut);
            }

            function onOut(o) {
                if (!active || !ctx) return;
                if (!audioFirstOut) {
                    audioFirstOut = true;
                    trmReport('AUDIO FIRST OUT', 'first decoded audio ready, subtitle scan may start now', false);
                    setTimeout(autoStartSubs, 0);
                }
                var st = toStereo(o.planes), n = st[0].length;
                if (!n) return;
                var buf = ctx.createBuffer(2, n, o.sampleRate);
                buf.copyToChannel(st[0], 0);
                buf.copyToChannel(st[1], 1);
                var mt = o.ts;
                if (expected !== null && Math.abs(mt - expected) < 0.12) mt = expected;
                expected = mt + buf.duration;
                pending.push({ mt: mt, buf: buf });
                if (!engineReady && pending.length && (pendingSecs() >= holdMinSecs || audioEnded) && Math.abs(pending[0].mt - video.currentTime) < 3) {
                    setEngineReady('audio buffered at position');
                }
                if (!firstOutLogged) {
                    firstOutLogged = true;
                    trmReport('AUDIO STARTUP',
                        'first onOut() buffer at +' + nowMs() + 'ms since page load' +
                        (playEventAt !== null ? ' | +' + Math.round(performance.now() - playEventAt) + 'ms after play' : ' | pre-buffered before Play was pressed') +
                        ' | audioTs=' + mt.toFixed(2) + ' video=' + video.currentTime.toFixed(2) + ' dur=' + buf.duration.toFixed(3) + 's', false);
                }
                if (awaitingPostSeek) {
                    awaitingPostSeek = false;
                    trmReport('SEEK/RESTART',
                        'first post-seek audio decoded ' + Math.round(performance.now() - restartStartAt) + 'ms after restartAt (' +
                        (seekingAt !== null ? Math.round(performance.now() - seekingAt) + 'ms after seeking' : 'n/a') +
                        ') | audioTs=' + mt.toFixed(2) + ' video=' + video.currentTime.toFixed(2) +
                        ' lead=' + (mt - video.currentTime).toFixed(3) + 's', false);
                }
                // Schedule the new chunk right away instead of waiting for the next 40ms tick.
                pump();
            }

            function stopScheduled(requeue) {
                var back = [];
                for (var i = 0; i < scheduled.length; i++) {
                    var r = scheduled[i];
                    r.node.onended = null;
                    try { r.node.stop(); } catch (e) {}
                    try { r.node.disconnect(); } catch (e) {}
                    back.push(r.it);
                }
                scheduled = [];
                if (requeue) pending = back.concat(pending);
            }

            function pump() {
                if (!active || !ctx) return;
                if (ctx.state === 'suspended' && !video.paused) ctx.resume();
                var vt = video.currentTime, now = ctx.currentTime;
                var playing = !video.paused && !video.seeking && video.readyState >= 2 && ctx.state === 'running';
                if (!playing) { if (scheduled.length) stopScheduled(true); dryStart = 0; return; }

                // Underrun protection: if the audio buffer stays empty while playing, hold the video until audio catches up.
                if (engineReady && !audioEnded && !pending.length && !scheduled.length && vt > 0.5) {
                    if (!dryStart) dryStart = performance.now();
                    else if (performance.now() - dryStart > 1000) {
                        dryStart = 0;
                        beginAudioHold('audio underrun', 1.5);
                        return;
                    }
                } else {
                    dryStart = 0;
                }

                while (pending.length && pending[0].mt + pending[0].buf.duration < vt - 0.05) {
                    var dropped = pending.shift();
                    droppedCount++;
                    if (DEBUG && dropLogs++ < 30) {
                        trmReport('AUDIO DROP', 'late buffer dropped mt=' + dropped.mt.toFixed(3) + ' dur=' + dropped.buf.duration.toFixed(3) + ' video=' + vt.toFixed(3) + ' late_by=' + (vt - dropped.mt - dropped.buf.duration).toFixed(3) + 's', true);
                    }
                }

                var outLat = ctx.outputLatency || ctx.baseLatency || 0;

                if (performance.now() - lastResync > 1500) {
                    for (var i = 0; i < scheduled.length; i++) {
                        var r = scheduled[i];
                        if (r.when <= now && r.when + r.it.buf.duration - r.off > now) {
                            var audioPos = r.it.mt + r.off + (now - r.when);
                            if (Math.abs(audioPos - vt - outLat) > DRIFT_MAX) {
                                lastResync = performance.now();
                                stopScheduled(true);
                            }
                            break;
                        }
                    }
                }

                while (pending.length && pending[0].mt < vt + LOOKAHEAD) {
                    var it = pending.shift();
                    var startAt = now + (it.mt - vt) - outLat;
                    if (startAt + it.buf.duration <= now) continue;
                    var off = 0, when = startAt;
                    if (startAt < now) { off = now - startAt; when = now; }
                    var node = ctx.createBufferSource();
                    node.buffer = it.buf;
                    node.connect(extGain);
                    node.start(when, off);
                    var rec = { it: it, node: node, when: when, off: off };
                    node.onended = (function (rr) {
                        return function () {
                            var k = scheduled.indexOf(rr);
                            if (k >= 0) scheduled.splice(k, 1);
                        };
                    })(rec);
                    scheduled.push(rec);
                    if (playEventAt !== null && !schedAfterPlayLogged) {
                        schedAfterPlayLogged = true;
                        trmReport('AUDIO STARTUP', 'first audio scheduled ' + Math.round(performance.now() - playEventAt) + 'ms after play | audioTs=' + it.mt.toFixed(3) + ' video=' + vt.toFixed(3) + ' skippedIntoBuffer=' + off.toFixed(3) + 's', false);
                    }
                    if (awaitingSchedSeek) {
                        awaitingSchedSeek = false;
                        trmReport('SEEK/RESTART', 'first post-seek audio SCHEDULED ' + Math.round(performance.now() - restartStartAt) + 'ms after restartAt | audioTs=' + it.mt.toFixed(3) + ' video=' + vt.toFixed(3) + ' skippedIntoBuffer=' + off.toFixed(3) + 's', false);
                    }
                }
            }

            function guessSubDur(bytes) {
                return Math.max(2.0, Math.min(6.5, bytes.length * 0.06));
            }

            async function demuxCore(cfg) {
                var scale = META.ts || 1000000;
                var FIRST_CHUNK = 512 * 1024;
                var NEXT_CHUNK = 3 * 1024 * 1024;
                var CHUNK = FIRST_CHUNK;
                var firstReq = true;
                var MAX_FAILS = 8;
                var clusterTc = 0, skip = 0, fails = 0;
                var synced = cfg.synced;
                var pend = null;
                var groupDur = null;
                var stopNow = false;
                var buf = new Uint8Array(0), p = 0, abs = cfg.pos;

                function emitPending(dur) {
                    if (!pend) return;
                    var s = pend;
                    pend = null;
                    var finalDur = (dur !== null && dur > 0) ? dur : (s.dur !== null && s.dur > 0 ? s.dur : guessSubDur(s.data));
                    if (cfg.onSub) cfg.onSub(s.track, s.ts, finalDur, s.data);
                }
                function finishEof() {
                    emitPending(null);
                    if (cfg.onEnd) cfg.onEnd();
                }

                trmReport(cfg.tag, 'Streaming blocks (audio track ' + cfg.audioTrack() + ', subtitle track ' + cfg.subTrack() + ') from byte ' + cfg.pos + '...', false);

                for (;;) {
                    if (cfg.stale()) return;
                    while (!cfg.stale() && cfg.shouldWait()) await sleep(60);
                    if (cfg.stale()) return;

                    var resume = abs + p + (skip > 0 ? skip : 0);
                    buf = new Uint8Array(0); p = 0; abs = resume; skip = 0;
                    if (META.size && resume >= META.size) { finishEof(); return; }

                    CHUNK = firstReq ? FIRST_CHUNK : NEXT_CHUNK;
                    firstReq = false;
                    var ctrl = new AbortController();
                    cfg.setCtrl(ctrl);
                    var got = 0;
                    try {
                        var res = await fetch(url, { headers: { 'Range': 'bytes=' + resume + '-' + (resume + CHUNK - 1) }, signal: ctrl.signal });
                        if (res.status === 416) { finishEof(); return; }
                        if (!(res.status === 206 || (res.status === 200 && resume === 0))) {
                            try { res.body && res.body.cancel(); } catch (e0) {}
                            throw new Error('Server refused range request (HTTP ' + res.status + ')');
                        }
                        var reader = res.body.getReader();

                        for (;;) {
                            if (cfg.stale()) { try { ctrl.abort(); } catch (e1) {} return; }
                            var chunk = await reader.read();
                            if (chunk.done) break;
                            got += chunk.value.length;

                            abs += p;
                            var rest = buf.subarray(p);
                            var merged = new Uint8Array(rest.length + chunk.value.length);
                            merged.set(rest, 0);
                            merged.set(chunk.value, rest.length);
                            buf = merged; p = 0;

                            for (;;) {
                                if (skip > 0) {
                                    var n = Math.min(skip, buf.length - p);
                                    p += n; skip -= n;
                                    if (skip > 0) break;
                                }
                                if (!synced) {
                                    var found = -1;
                                    for (var q = p; q + 3 < buf.length; q++) {
                                        if (buf[q] === 0x1F && buf[q + 1] === 0x43 && buf[q + 2] === 0xB6 && buf[q + 3] === 0x75) { found = q; break; }
                                    }
                                    if (found < 0) { p = Math.max(p, buf.length - 3); break; }
                                    p = found; synced = true;
                                }
                                var id = readId(buf, p); if (!id) break;
                                var sz = readSize(buf, p + id.len); if (!sz) break;
                                var hdr = id.len + sz.len;

                                if (id.value === 0x1F43B675 || id.value === 0xA0) {
                                    emitPending(null);
                                    groupDur = null;
                                    p += hdr; continue;
                                }
                                if (id.value === 0xE7) {
                                    emitPending(null);
                                    groupDur = null;
                                    if (sz.unknown || buf.length - p < hdr + sz.value) break;
                                    clusterTc = uint(buf, p + hdr, p + hdr + sz.value);
                                    var ct = clusterTc * scale / 1e9;
                                    p += hdr + sz.value;
                                    if (cfg.onScan) cfg.onScan(ct);
                                    if (cfg.endTs !== null && cfg.endTs !== undefined && ct > cfg.endTs) { stopNow = true; break; }
                                    continue;
                                }
                                if (id.value === 0x9B) {
                                    if (sz.unknown || buf.length - p < hdr + sz.value) break;
                                    var bd = uint(buf, p + hdr, p + hdr + sz.value) * scale / 1e9;
                                    if (pend) emitPending(bd);
                                    else groupDur = bd;
                                    p += hdr + sz.value; continue;
                                }
                                if (id.value === 0xA3 || id.value === 0xA1) {
                                    emitPending(null);
                                    if (sz.unknown) { p += hdr; continue; }
                                    var total = hdr + sz.value;
                                    var peek = Math.min(total, hdr + 8);
                                    if (buf.length - p < peek) break;
                                    var tr = readSize(buf, p + hdr);
                                    if (!tr) { p += hdr; skip = sz.value; continue; }

                                    var wantA = cfg.audioTrack();
                                    var wantS = cfg.subTrack();
                                    var isA = tr.value === wantA;
                                    var isS = !isA && tr.value === wantS;
                                    if (!isA && !isS) { p += hdr; skip = sz.value; groupDur = null; continue; }
                                    if (buf.length - p < total) break;

                                    var h = p + hdr + tr.len;
                                    var rel = (buf[h] << 8) | buf[h + 1];
                                    if (rel & 0x8000) rel -= 0x10000;
                                    var flags = buf[h + 2];
                                    var lacingType = (flags >> 1) & 3;
                                    var baseTs = (clusterTc + rel) * scale / 1e9;

                                    var frames = extractBlockFrames(buf, h + 3, p + total, lacingType);
                                    if (isA) {
                                        if (cfg.onAudio) cfg.onAudio(frames, baseTs);
                                    } else if (frames.length && frames[0] && frames[0].length) {
                                        if (id.value === 0xA1) {
                                            if (groupDur !== null) {
                                                if (cfg.onSub) cfg.onSub(tr.value, baseTs, groupDur, frames[0]);
                                                groupDur = null;
                                            } else {
                                                pend = { track: tr.value, ts: baseTs, dur: null, data: frames[0] };
                                            }
                                        } else if (cfg.onSub) {
                                            cfg.onSub(tr.value, baseTs, guessSubDur(frames[0]), frames[0]);
                                        }
                                    }
                                    p += total; continue;
                                }
                                if (sz.unknown) { p += hdr; continue; }
                                p += hdr; skip = sz.value;
                            }

                            if (stopNow) break;
                            if (got >= CHUNK) { try { ctrl.abort(); } catch (e2) {} break; }
                        }
                        if (stopNow) { try { ctrl.abort(); } catch (e3) {} finishEof(); return; }
                        fails = 0;
                        if (got === 0) { finishEof(); return; }
                    } catch (e) {
                        if (cfg.stale()) return;
                        if (e && e.name === 'AbortError' && got >= CHUNK) { fails = 0; continue; }
                        fails++;
                        if (fails > MAX_FAILS) throw e;
                        trmReport(cfg.tag, formatErr(e) + ' - resuming at byte ' + (abs + p + (skip > 0 ? skip : 0)) + ' (try ' + fails + '/' + MAX_FAILS + ')', false);
                        await sleep(Math.min(4000, 400 * fails));
                    }
                }
            }

            function frameDurFor(t) {
                var sr = t.sr || 48000;
                switch (t.codec) {
                    case 'A_AAC': return 1024 / sr;
                    case 'A_AC3':
                    case 'A_EAC3': return 1536 / sr;
                    case 'A_MPEG/L3': return (sr >= 32000 ? 1152 : 576) / sr;
                    case 'A_FLAC': return 4096 / sr;
                    default: return 0.02;
                }
            }

            function subWantId() {
                return (sub.cur >= 0 && subs[sub.cur]) ? subs[sub.cur].id : -1;
            }

            async function runFrom(t, g) {
                if (t >= 2) {
                    try { await loadCues(); } catch (eC) {}
                    if (g !== gen) return;
                }
                var sp = startPosFor(t);
                var frameDur = frameDurFor(track);
                lastTs = t;
                audioEnded = false;
                subMainFrom = null;
                subMainTo = null;
                try {
                    await demuxCore({
                        tag: 'STEP 5: DEMUX STREAM',
                        audioTrack: function () { return track ? track.id : -1; },
                        subTrack: subWantId,
                        pos: sp.pos,
                        synced: sp.synced,
                        stale: function () { return g !== gen; },
                        // While the video is paused only a short head start is buffered (pre-buffer);
                        // once playing, the normal look-ahead applies.
                        shouldWait: function () {
                            return active && ((lastTs - video.currentTime) > (video.paused ? PRE_AHEAD : MAX_AHEAD) || decoder.busy());
                        },
                        setCtrl: function (c) { demuxCtrl = c; },
                        onAudio: function (frames, baseTs) {
                            for (var fi = 0; fi < frames.length; fi++) {
                                var fts = baseTs + (fi * frameDur);
                                lastTs = fts;
                                if (fts < t - 0.3) continue;
                                // Never queue frames that are already behind the live video clock.
                                if (!video.paused && fts < video.currentTime - 0.15) continue;
                                decoder.push(frames[fi], fts);
                            }
                        },
                        onScan: function (ts) {
                            if (g !== gen) return;
                            if (subMainFrom === null) subMainFrom = ts;
                            subMainTo = ts;
                        },
                        onSub: function (trId, ts, dur, bytes) { subAdd(trId, ts, dur, bytes); },
                        onEnd: function () {
                            if (g === gen) {
                                audioEnded = true;
                                if (decoder && typeof decoder.flush === 'function') decoder.flush();
                            }
                        }
                    });
                } catch (e) {
                    if (g === gen && !(e && e.name === 'AbortError')) {
                        statusCb('Stream err: ' + formatErr(e), true);
                        trmReport('STEP 5: STREAM ERR', formatErr(e), true);
                    }
                }
            }

            function abortDemux() { try { demuxCtrl && demuxCtrl.abort(); } catch (e) {} demuxCtrl = null; }

            function restartAt(t) {
                if (!active) return;
                restartStartAt = performance.now();
                awaitingPostSeek = true;
                awaitingSchedSeek = true;
                trmReport('SEEK/RESTART', 'restartAt(' + t.toFixed(2) + ') called at +' + nowMs() + 'ms' + (seekingAt !== null ? ' (' + Math.round(restartStartAt - seekingAt) + 'ms after seeking)' : ''), false);
                gen++;
                abortDemux();
                stopScheduled(false);
                pending = []; expected = null;
                try { decoder.reset(); } catch (e) {}
                runFrom(t, gen);
            }

            var restartedFor = null;
            function doSeekRestart() {
                clearTimeout(seekTimer);
                if (!active) return;
                var tNow = video.currentTime;
                if (restartedFor !== null && Math.abs(restartedFor - tNow) < 0.05) return;
                restartedFor = tNow;
                restartAt(tNow);
            }
            video.addEventListener('seeking', function () {
                seekingAt = performance.now();
                trmReport('SEEK/RESTART', 'seeking fired at +' + nowMs() + 'ms target=' + video.currentTime.toFixed(2) + ' engineActive=' + active, false);
                renderSubOverlay();
                if (!active) return;
                beginAudioHold('seek');
                // restartedFor is reset on 'seeked', not here: repeated 'seeking' events for the same target
                // must not restart (and abort) the audio stream again and again.
                stopScheduled(false);
                pending = []; expected = null;
                clearTimeout(seekTimer);
                seekTimer = setTimeout(doSeekRestart, 40);
            });
            video.addEventListener('seeked', function () {
                trmReport('SEEK/RESTART', 'seeked fired at +' + nowMs() + 'ms' + (seekingAt !== null ? ' (' + Math.round(performance.now() - seekingAt) + 'ms after seeking)' : '') + ' video=' + video.currentTime.toFixed(2), false);
                doSeekRestart();
                restartedFor = null;
                pump();
            });
            video.addEventListener('play', function () {
                playEventAt = performance.now();
                schedAfterPlayLogged = false;
                trmReport('AUDIO STARTUP', 'play pressed at +' + nowMs() + 'ms | pending=' + pending.length + ' (' + pendingSecs().toFixed(2) + 's ready) scheduled=' + scheduled.length + ' engineActive=' + active + ' engineBusy=' + engineBusy + ' ctx=' + (ctx ? ctx.state : 'none') + ' video=' + video.currentTime.toFixed(2), false);
                pump();
            });
            video.addEventListener('playing', function () {
                trmReport('AUDIO STARTUP', 'video "playing" event at +' + nowMs() + 'ms' + (playEventAt !== null ? ' (' + Math.round(performance.now() - playEventAt) + 'ms after play)' : ''), false);
                pump();
            });

            function engineStop(keepSubs) {
                gen++;
                abortDemux();
                clearInterval(timer); timer = null;
                clearTimeout(seekTimer);
                if (ctx) { stopScheduled(false); extGain.gain.value = 0; }
                if (active) silenceNativeVideo(false);
                pending = []; expected = null;
                if (decoder) { try { decoder.close(); } catch (e) {} decoder = null; }
                active = false; track = null;
                if (!keepSubs) subResume();
            }

            async function engineStart(t) {
                engineBusy = true;
                var engStartAt = performance.now();
                trmReport('AUDIO STARTUP', 'engineStart begin at +' + nowMs() + 'ms codec=' + t.codec, false);
                try {
                    ensureCtx();
                    // Never await resume(): before the first user gesture it can stay pending forever.
                    try {
                        var rp = ctx.resume();
                        if (rp && rp.catch) rp.catch(function () {});
                    } catch (eRes) {}
                    statusCb('Starting 5.1 Audio...', false);
                    // At the very start (t < 2) demux begins at META.seg, so the seek index is NOT awaited:
                    // it loads in the background once the decoder is ready (no contention with ffmpeg-core.wasm).
                    var startT = video.currentTime;
                    var dec;
                    if (startT >= 2) {
                        var parts = await Promise.all([makeDecoder(t, onOut), loadCues()]);
                        dec = parts[0];
                    } else {
                        dec = await makeDecoder(t, onOut);
                        loadCues();
                    }
                    engineStop(true);
                    decoder = dec; track = t; active = true;
                    trmReport('AUDIO STARTUP', 'engine ready (decoder' + (startT >= 2 ? ' + cues' : ', cues load in background') + ') in ' + Math.round(performance.now() - engStartAt) + 'ms, demux starting at video=' + video.currentTime.toFixed(2), false);
                    silenceNativeVideo(true);
                    extGain.gain.value = MASTER_BOOST;
                    subAbortScan();
                    // Subtitles ride on the SAME demux stream as the audio (no second parallel range stream).
                    if (!subAutoDone && subBaseIdx >= 0) {
                        subAutoDone = true;
                        sub.cur = subBaseIdx;
                        subWanted = subBaseIdx;
                        ensureSubOverlay();
                        trmReport('SUBS: ON', 'Track #' + (subBaseIdx + 1) + ' ' + subLabelList[subBaseIdx] + ' (shared with audio demux stream)', false);
                    }
                    timer = setInterval(pump, 40);
                    runFrom(video.currentTime, gen);
                } catch (err) {
                    if (!active) subResume();
                    throw err;
                } finally {
                    engineBusy = false;
                }
            }

            // ======================= SUBTITLES + TRANSPARENT OVERLAY =======================
            var sub = { cur: -1, gen: 0, ctrl: null, timer: null, scan: 0, covFrom: 0, alive: false, cuesByTrack: {}, seen: {}, overlayEl: null, spanEl: null };
            var subById = {};
            subs.forEach(function (s) { subById[s.id] = s; });
            var subLabelList = subLabels();
            var subAutoDone = false;
            // The subtitle track the user (or the auto start) chose. Only the menu may change it; a guard restores it if
            // anything else ever resets sub.cur.   -2 = nothing chosen yet, -1 = user chose Off, >= 0 = track index.
            var subWanted = -2;
            var subMenuApi = null;
            var subMainFrom = null, subMainTo = null;   // demux time range covered by the main (shared) stream since its last restart
            var subHealGen = -1, subWatchGen = -1, subWatchAt = 0;
            var subLastStart = 0, subLastAuto = 0, subLagSince = 0;   // standalone (native audio) scan supervisor

            var subBaseIdx = -1;
            if (subs.length) {
                subBaseIdx = 0;
                for (var sbi = 0; sbi < subs.length; sbi++) {
                    if (subs[sbi].def) { subBaseIdx = sbi; break; }
                }
            }

            // Crisp subtitle text. Injected from here so every page (test Worker and the Render dl.html) gets it.
            function injectSubStyle() {
                if (document.getElementById('trm-sub-style')) return;
                var st = document.createElement('style');
                st.id = 'trm-sub-style';
                st.textContent = [
                    '.trm-sub-overlay { position: absolute; z-index: 40; pointer-events: none; display: flex; justify-content: center; align-items: flex-end; transform: none !important; will-change: auto; opacity: 1; visibility: visible; }',
                    '.trm-sub-overlay[hidden] { display: none !important; }',
                    '.trm-sub-overlay span {',
                    '  background: transparent !important; color: #fff; font-weight: 700; line-height: 1.3; padding: 0 6px; text-align: center; white-space: pre-wrap; max-width: 94%;',
                    '  font-family: system-ui, -apple-system, "Segoe UI", Roboto, "Noto Sans", "Noto Sans Tamil", "Noto Sans Telugu", "Noto Sans Devanagari", Arial, sans-serif;',
                    '  -webkit-font-smoothing: antialiased; -moz-osx-font-smoothing: grayscale; text-rendering: geometricPrecision; font-kerning: normal;',
                    '  text-shadow: -1px 0 #000, 1px 0 #000, 0 -1px #000, 0 1px #000, -1px -1px #000, 1px -1px #000, -1px 1px #000, 1px 1px #000, 0 2px 2px rgba(0, 0, 0, 0.55);',
                    '}'
                ].join('\n');
                (document.head || document.documentElement).appendChild(st);
            }

            // Whole-pixel font size from the real player size (windowed, fullscreen, zoom), so glyphs are never rasterised at a fraction of a pixel.
            function fitSubFont() {
                if (!sub.spanEl) return;
                var host = sub.overlayEl && sub.overlayEl.parentNode;
                var w = (host && host.clientWidth) || window.innerWidth;
                var h = (host && host.clientHeight) || window.innerHeight;
                var px = Math.round(Math.max(13, Math.min(w * 0.045, h * 0.075, 34)));
                sub.spanEl.style.setProperty('font-size', px + 'px', 'important');
                sub.spanEl.style.setProperty('letter-spacing', '0', 'important');
                sub.overlayEl.style.setProperty('left', Math.round(w * 0.05) + 'px', 'important');
                sub.overlayEl.style.setProperty('right', Math.round(w * 0.05) + 'px', 'important');
            }

            // The overlay MUST live inside the .plyr element: only that element goes fullscreen / gets the zoom layout.
            // It can be created before Plyr has built its player, so it is (re)attached to .plyr whenever that exists.
            function ensureSubOverlay() {
                injectSubStyle();
                if (!sub.overlayEl) {
                    var div = document.createElement('div');
                    div.className = 'trm-sub-overlay';
                    div.hidden = true;
                    var sp = document.createElement('span');
                    div.appendChild(sp);
                    sub.overlayEl = div;
                    sub.spanEl = sp;
                }
                var host = video.closest('.plyr');
                if (host) {
                    if (sub.overlayEl.parentNode !== host) {
                        host.appendChild(sub.overlayEl);
                        fitSubFont();
                    }
                } else if (!sub.overlayEl.parentNode && video.parentElement) {
                    video.parentElement.appendChild(sub.overlayEl);
                    fitSubFont();
                }
            }

            function renderSubOverlay() {
                ensureSubOverlay();
                if (!sub.overlayEl) return;
                if (sub.cur < 0 || !subs[sub.cur]) {
                    sub.overlayEl.hidden = true;
                    return;
                }
                var trId = subs[sub.cur].id;
                var list = sub.cuesByTrack[trId];
                if (!list || !list.length) {
                    sub.overlayEl.hidden = true;
                    return;
                }
                var vt = video.currentTime;
                var activeLines = [];
                for (var i = 0; i < list.length; i++) {
                    var c = list[i];
                    if (vt >= c.s && vt <= c.e) activeLines.push(c.t);
                }
                if (!activeLines.length) {
                    sub.overlayEl.hidden = true;
                } else {
                    sub.spanEl.textContent = activeLines.join('\n');
                    sub.overlayEl.hidden = false;
                }
            }

            video.addEventListener('timeupdate', renderSubOverlay);

            // Keep the overlay attached, sized and visible through fullscreen, zoom modes, rotation and resizes.
            function relayoutSubs() {
                ensureSubOverlay();
                fitSubFont();
                renderSubOverlay();
            }
            ['fullscreenchange', 'webkitfullscreenchange'].forEach(function (evn) {
                document.addEventListener(evn, function () {
                    relayoutSubs();
                    setTimeout(relayoutSubs, 200);
                    setTimeout(relayoutSubs, 700);
                });
            });
            window.addEventListener('resize', relayoutSubs);
            window.addEventListener('orientationchange', function () { setTimeout(relayoutSubs, 250); });
            video.addEventListener('loadedmetadata', relayoutSubs);

            // Subtitle guard: the chosen track stays locked, and the cues around the playhead are kept in sync after seeks.
            function subGuardTick() {
                if (sub.cur >= 0 || subWanted >= 0) ensureSubOverlay();
                if (subWanted >= 0 && sub.cur !== subWanted) {
                    trmReport('SUBS: RESTORED', 'track #' + (subWanted + 1) + ' had been reset (cur=' + sub.cur + ') by something other than the menu - locked back on', true);
                    sub.cur = subWanted;
                    if (subMenuApi) subMenuApi.setChecked(subWanted + 1);
                    renderSubOverlay();
                    if (active) {
                        subHealGen = -1;
                    } else if (!engineBusy) {
                        subAbortScan();
                        var g0 = ++sub.gen;
                        subScan(video.currentTime - 10, null, g0, true);
                    }
                }
                // Native audio: keep the subtitle scan alive and near the playhead (it can fail, stall or fall behind).
                if (!active && !engineBusy && sub.cur >= 0 && !video.paused && !video.seeking) {
                    var nowT = performance.now();
                    var vtn = video.currentTime;
                    if (nowT - subLastStart > 5000 && nowT - subLastAuto > 4000) {
                        var behind = sub.alive && sub.scan < vtn - 4;
                        var outside = vtn < sub.covFrom - 1 || vtn > sub.scan + 2;
                        var nearEnd = !!(META.dur && vtn > META.dur - 20);
                        if (behind) { if (!subLagSince) subLagSince = nowT; } else { subLagSince = 0; }
                        if ((!sub.alive && outside && !nearEnd) || (behind && nowT - subLagSince > 4000)) {
                            subLastAuto = nowT;
                            subLagSince = 0;
                            subStandaloneRestart(sub.alive ? 'scan fell behind the video' : 'scan stopped before the playhead');
                        }
                    }
                }
                if (!active || sub.cur < 0 || video.paused || video.seeking || !engineReady) return;
                if (subWatchGen !== gen) { subWatchGen = gen; subWatchAt = performance.now(); }
                if (subHealGen === gen || performance.now() - subWatchAt < 2500) return;
                var vt = video.currentTime;
                var covered = subMainFrom !== null && vt >= subMainFrom - 1 && vt <= subMainTo + 2;
                if (!covered) {
                    subHealGen = gen;
                    trmReport('SUBS: RESYNC', 'main stream covers ' + (subMainFrom === null ? 'nothing yet' : subMainFrom.toFixed(1) + 's..' + subMainTo.toFixed(1) + 's') + ' but video=' + vt.toFixed(1) + 's - loading the missing subtitle lines', false);
                    subAbortScan();
                    var g1 = ++sub.gen;
                    subCatchUp(g1);
                }
            }
            video.addEventListener('seeked', function () { subGuardTick(); });

            function decodeSubText(codec, bytes) {
                var raw = new TextDecoder('utf-8').decode(bytes).replace(/\r/g, '').replace(/\0+$/g, '');
                var txt;
                if (codec === 'S_TEXT/ASS' || codec === 'S_TEXT/SSA') {
                    var commaTarget = /^Dialogue\s*:/i.test(raw) ? 9 : 8;
                    var idx = 0, n = 0;
                    while (n < commaTarget) {
                        var nextComma = raw.indexOf(',', idx);
                        if (nextComma < 0) break;
                        idx = nextComma + 1;
                        n++;
                    }
                    txt = n >= 6 ? raw.slice(idx) : raw;
                    if (/\\p[1-9]/.test(txt)) return '';
                    txt = txt.replace(/\{[^}]*\}/g, '').replace(/\\[Nn]/g, '\n').replace(/\\h/g, ' ');
                    txt = txt.replace(/<[^>]*>/g, '');
                } else {
                    txt = raw.replace(/\{[^}]*\}/g, '');
                    txt = txt.replace(/\\[Nn]/g, '\n');
                    txt = txt.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]*>/g, '');
                }
                return txt.trim();
            }

            function subAdd(trId, start, dur, bytes) {
                var tr = subById[trId];
                if (!tr) return;
                var txt = decodeSubText(tr.codec, bytes);
                if (!txt) return;
                var end = start + dur;
                if (!(end > start)) return;
                var key = trId + '|' + start.toFixed(2) + '|' + txt;
                if (sub.seen[key]) return;
                sub.seen[key] = 1;
                if (!sub.cuesByTrack[trId]) sub.cuesByTrack[trId] = [];
                sub.cuesByTrack[trId].push({ s: start, e: end, t: txt });
                renderSubOverlay();
            }

            function abortSub() { try { sub.ctrl && sub.ctrl.abort(); } catch (e) {} sub.ctrl = null; }

            function subAbortScan() {
                sub.gen++;
                abortSub();
                clearTimeout(sub.timer);
                sub.alive = false;
            }

            async function subScan(from, until, g, solo) {
                subLastStart = performance.now();
                try { await loadCues(); } catch (e) {}
                if (g !== sub.gen || sub.cur < 0) return;
                from = Math.max(0, from);
                var sp = startPosFor(from);
                sub.scan = from;
                sub.covFrom = from;
                sub.alive = true;
                try {
                    await demuxCore({
                        tag: solo ? 'SUBS: SCAN' : 'SUBS: CATCH-UP',
                        audioTrack: function () { return -1; },
                        subTrack: subWantId,
                        pos: sp.pos,
                        synced: sp.synced,
                        endTs: until,
                        stale: function () { return g !== sub.gen; },
                        shouldWait: function () { return solo && (sub.scan - video.currentTime) > SUB_AHEAD; },
                        setCtrl: function (c) { sub.ctrl = c; },
                        onScan: function (ts) { sub.scan = ts; },
                        onSub: function (trId, ts, dur, bytes) { subAdd(trId, ts, dur, bytes); }
                    });
                } catch (e) {
                    if (g === sub.gen && !(e && e.name === 'AbortError')) {
                        subStatusCb('Subtitle err: ' + formatErr(e), true);
                        trmReport('SUBS: ERR', formatErr(e), true);
                    }
                } finally {
                    if (g === sub.gen) sub.alive = false;
                }
            }

            function subResume() {
                if (sub.cur < 0) return;
                subAbortScan();
                var g = ++sub.gen;
                subScan(video.currentTime - 10, null, g, true);
            }

            function subStop() {
                subAbortScan();
                sub.cur = -1;
                renderSubOverlay();
            }

            // Native-audio mode: (re)start the subtitle-only scan at the playhead.
            function subStandaloneRestart(reason) {
                if (sub.cur < 0 || active || engineBusy) return;
                var t = video.currentTime;
                subAbortScan();
                var g = ++sub.gen;
                trmReport('SUBS: RESYNC', reason + ' -> scanning from ' + Math.max(0, t - 6).toFixed(1) + 's', false);
                subScan(t - 6, null, g, true);
            }

            function subCatchUp(g) {
                var vt = video.currentTime;
                var until = Math.max(vt + 12, lastTs + 2);
                subScan(vt - 10, until, g, false);
            }

            async function subSelect(i) {
                subAutoDone = true;
                subWanted = i;   // -1 = Off. Only an explicit menu choice (or the auto start) ever changes this.
                subStop();
                if (i < 0) {
                    trmReport('SUBS: OFF', 'Subtitles disabled', false);
                    return;
                }
                var tr = subs[i];
                if (!tr) return;
                ensureSubOverlay();
                sub.cur = i;
                renderSubOverlay();
                var g = ++sub.gen;
                trmReport('SUBS: ON', 'Track #' + (i + 1) + ' ' + subLabelList[i] + ' (' + tr.codec + ')', false);

                if (active) {
                    // The running audio demux already extracts the new track from here on;
                    // a short bounded scan fills the lines up to that point. Audio is never interrupted.
                    subCatchUp(g);
                } else if (!engineBusy) {
                    subScan(video.currentTime - 10, null, g, true);
                }
            }

            // Native audio: after a seek the old scan is stopped at once (so the <video> gets the bandwidth first),
            // and a new scan starts at the new position as soon as the video has finished seeking.
            function subSeekScan() {
                if (sub.cur < 0 || active || engineBusy) return;
                var t = video.currentTime;
                if (sub.alive && t >= sub.covFrom && t <= sub.scan + 1) return;
                subStandaloneRestart('seek');
            }
            video.addEventListener('seeking', function () {
                if (sub.cur < 0 || active || engineBusy) return;
                var t = video.currentTime;
                clearTimeout(sub.timer);
                if (sub.alive && t >= sub.covFrom && t <= sub.scan + 1) return;   // target already covered
                abortSub();
                sub.gen++;
                sub.alive = false;
                sub.timer = setTimeout(subSeekScan, 3000);   // fallback if 'seeked' never arrives
            });
            video.addEventListener('seeked', function () {
                if (sub.cur < 0 || active || engineBusy) return;
                if (sub.alive) return;
                clearTimeout(sub.timer);
                sub.timer = setTimeout(subSeekScan, 250);
            });

            // Starts the default subtitle track. When the audio engine is needed, this waits for the
            // first decoded audio (audioFirstOut) so the subtitle download never competes with it.
            function autoStartSubs() {
                if (subAutoDone || subBaseIdx < 0) return;
                if (!engineWanted()) {
                    // Native browser audio: <video> is the only download pipe. Subtitles stay Off until the user picks one.
                    subAutoDone = true;
                    trmReport('SUBS: OFF', 'native audio active - subtitles stay Off by default (single download pipe); pick one in the menu to load it', false);
                    return;
                }
                if (active || engineBusy) {
                    subAutoDone = true;
                    sub.cur = subBaseIdx;
                    subWanted = subBaseIdx;
                    ensureSubOverlay();
                    renderSubOverlay();
                    trmReport('SUBS: ON', 'Track #' + (subBaseIdx + 1) + ' ' + subLabelList[subBaseIdx] + ' (shared with audio demux stream)', false);
                    return;
                }
                if (engineWanted() && !audioFirstOut) return;
                subAutoDone = true;
                subSelect(subBaseIdx).catch(function (e) {
                    trmReport('SUBS: AUTO START FAILED', formatErr(e), true);
                });
            }

            setInterval(subGuardTick, 1000);

            window.addEventListener('pagehide', function () {
                abortDemux();
                subAbortScan();
                try { window.AC3WasmDecoder.dispose(); } catch (e) {}
            });

            async function switchTo(i) {
                var t = tracks[i];
                var prev = current;
                // engineWanted() must already describe the NEW track while the switch runs.
                current = i;
                if (isBrowserNativeTrack(i)) {
                    var nat = video.audioTracks;
                    if (nat && nat.length === tracks.length) {
                        for (var k = 0; k < nat.length; k++) nat[k].enabled = (k === i);
                    }
                    engineStop();
                    try { video.muted = false; } catch (eM) {}
                    silenceNativeVideo(false);
                    setEngineReady('native track');
                    statusCb('', false);
                    trmReport('NATIVE AUDIO', 'Playing native browser track #' + (i + 1), false);
                    return;
                }
                beginAudioHold('audio track switch', 0, true);
                try {
                    await engineStart(t);
                } catch (eSw) {
                    current = prev;
                    setEngineReady('track switch failed');
                    throw eSw;
                }
            }

            // ======================= ENGINE AUTO START (PRE-BUFFER) =======================
            // The engine starts as soon as the track info is known, not on Play.
            // Decoder, seek index and the first seconds of audio are ready before the user presses Play.
            // Play is never paused or delayed: the video starts immediately and pump() picks up the
            // already-decoded audio in pending[] on its very next run.
            // ======================= ENGINE READY GATE (blocks Play UI, never pauses video) =======================
            // The player is covered by a "Buffering Audio..." shield until the ffmpeg worker, decoder and the
            // first decoded audio are ready, so Play can only be pressed when no sound will be missed.
            var engineReady = !engineWanted();
            var engineShield = null, engineShieldTimer = null;
            var ENGINE_READY_MIN_SECS = 0.5;
            var ENGINE_READY_TIMEOUT_MS = 25000;
            var HOLD_TIMEOUT_MS = 12000;
            var holdResume = false;           // video was playing when the hold began: resume it when audio is ready
            var holdMinSecs = ENGINE_READY_MIN_SECS;
            var holdReason = 'startup';
            var holdSince = performance.now();
            var dryStart = 0;

            function setEngineReady(reason) {
                if (engineReady) return;
                engineReady = true;
                clearTimeout(engineShieldTimer);
                if (engineShield) engineShield.hidden = true;
                holdMinSecs = ENGINE_READY_MIN_SECS;
                dryStart = 0;
                var resume = holdResume;
                holdResume = false;
                trmReport('AUDIO HOLD', holdReason + ' released (' + reason + ') after ' + Math.round(performance.now() - holdSince) + 'ms at +' + nowMs() + 'ms | pending=' + pending.length + ' (' + pendingSecs().toFixed(2) + 's) video=' + video.currentTime.toFixed(2) + (resume ? ' | resuming video' : ''), false);
                if (resume) {
                    try {
                        var pr = video.play();
                        if (pr && pr.catch) pr.catch(function () {});
                    } catch (ePl) {}
                }
            }

            // Hold the video (pause + "Buffering Audio..." shield) until audio at the current position is buffered.
            // Used after a seek, an audio-track switch or an audio underrun, so no sound is ever cut off.
            // Play is NOT held: the first-play shield above already guarantees audio is ready before Play.
            function beginAudioHold(reason, minSecs, force) {
                if (!force && !engineWanted()) return;
                if (!video.paused) holdResume = true;
                holdMinSecs = minSecs || ENGINE_READY_MIN_SECS;
                if (engineReady) {
                    holdReason = reason;
                    holdSince = performance.now();
                    trmReport('AUDIO HOLD', reason + ' -> holding video at +' + nowMs() + 'ms video=' + video.currentTime.toFixed(2) + ' (will resume: ' + holdResume + ')', false);
                }
                engineReady = false;
                if (!engineShield) mountEngineShield(video.closest('.plyr'));
                if (engineShield) engineShield.hidden = false;
                clearTimeout(engineShieldTimer);
                engineShieldTimer = setTimeout(function () { setEngineReady('safety timeout'); }, HOLD_TIMEOUT_MS);
                if (!video.paused) {
                    try { video.pause(); } catch (ePa) {}
                }
            }

            function mountEngineShield(plyrEl) {
                if (engineShield || !plyrEl) return;
                var d = document.createElement('div');
                d.className = 'trm-engine-shield';
                d.innerHTML = '<div class="trm-engine-spin"></div><div>Buffering Audio...</div>';
                var swallow = function (e) { e.stopPropagation(); e.preventDefault(); };
                ['click', 'dblclick', 'pointerdown', 'pointerup', 'mousedown', 'mouseup'].forEach(function (n) { d.addEventListener(n, swallow); });
                ['touchstart', 'touchend'].forEach(function (n) { d.addEventListener(n, function (e) { e.stopPropagation(); }, { passive: true }); });
                d.hidden = engineReady;
                plyrEl.appendChild(d);
                engineShield = d;
                if (!engineReady) {
                    trmReport('AUDIO STARTUP', 'Play locked until audio engine is ready (shield mounted at +' + nowMs() + 'ms)', false);
                    engineShieldTimer = setTimeout(function () { setEngineReady('safety timeout'); }, ENGINE_READY_TIMEOUT_MS);
                }
            }

            var autoStarted = false;
            function tryAutoStart51() {
                if (autoStarted || active) return;
                if (!engineWanted()) return;
                var curTrack = tracks[current];
                autoStarted = true;
                engineStart(curTrack).then(function () {
                    // Subtitles start from onOut() once the first audio exists.
                }, function (e) {
                    autoStarted = false;
                    setEngineReady('engine failed, falling back');
                    statusCb('Init err: ' + formatErr(e), true);
                    trmReport('ENGINE START FAILED', formatErr(e), true);
                    // Engine failed: do not hold subtitles back any longer.
                    audioFirstOut = true;
                    autoStartSubs();
                });
            }

            function onPlayEvent() {
                unlockAudio();
                if (engineWanted()) {
                    tryAutoStart51();
                }
                autoStartSubs();
                // Fallback: if no audio ever arrives, subtitles still start after a few seconds.
                if (!subFallbackSet) {
                    subFallbackSet = true;
                    setTimeout(function () {
                        audioFirstOut = true;
                        autoStartSubs();
                    }, SUB_FALLBACK_MS);
                }
            }

            video.addEventListener('play', onPlayEvent);
            video.addEventListener('playing', function () {
                tryAutoStart51();
                autoStartSubs();
            });
            if (!video.paused) {
                setTimeout(onPlayEvent, 150);
            }

            // Native browser audio: no shield, no hold - make sure the <video> audio is audible right away.
            if (!engineWanted()) {
                try { video.muted = false; } catch (eMu) {}
                silenceNativeVideo(false);
                trmReport('ROUTE', 'NATIVE <video> audio: track #' + (current + 1) + ' (' + tracks[current].codec + ' ' + (tracks[current].ch || 2) + 'ch) | no engine, no shield, subtitles Off until picked' +
                    (tracks.length > 1 ? ' | other audio tracks use the engine when selected' : ''), false);
            } else {
                var ct = tracks[current];
                var why = !isNative(ct) ? (ct.codec + ' is not browser-native')
                    : ((ct.ch || 2) > 2 ? ((ct.ch) + 'ch needs the 5.1 downmix + boost')
                    : 'non-default track and the browser has no audioTracks support');
                trmReport('ROUTE', 'ENGINE: track #' + (current + 1) + ' (' + ct.codec + ' ' + (ct.ch || 2) + 'ch) - ' + why + ' | loading shield + demuxer, subtitles on the shared stream', false);
            }
            // Lock the Play UI until the engine is ready, then pre-buffer now (before Play).
            if (!engineReady) waitFor('.plyr', 100, mountEngineShield);
            tryAutoStart51();
            // Native-audio files have no engine, so their subtitles can start right away.
            autoStartSubs();

            function waitFor(sel, tries, cb) {
                var el = document.querySelector(sel);
                if (el) return cb(el);
                if (tries <= 0) return;
                setTimeout(function () { waitFor(sel, tries - 1, cb); }, 100);
            }

            // ============================ MENUS ============================
            function closeAllMenus(except) {
                var boxes = document.querySelectorAll('.adx-audio .plyr__menu__container');
                for (var i = 0; i < boxes.length; i++) {
                    if (boxes[i] !== except) boxes[i].hidden = true;
                }
            }

            function makeMenu(controls, cfg) {
                var wrap = document.createElement('div');
                wrap.className = 'plyr__controls__item plyr__menu adx-audio ' + cfg.cls;
                wrap.innerHTML =
                    '<button class="plyr__control" type="button" aria-haspopup="true" aria-expanded="false">' +
                    '<svg aria-hidden="true" focusable="false"><use href="#' + cfg.icon + '" xlink:href="#' + cfg.icon + '"></use></svg>' +
                    '<span class="plyr__sr-only">' + cfg.sr + '</span></button>' +
                    '<div class="plyr__menu__container" hidden><div><div role="menu">' +
                    '<div class="adx-title"></div><div class="adx-status" hidden></div>' +
                    '</div></div></div>';

                var btn = wrap.querySelector('button.plyr__control');
                var box = wrap.querySelector('.plyr__menu__container');
                var menu = wrap.querySelector('[role="menu"]');
                var statusEl = wrap.querySelector('.adx-status');
                wrap.querySelector('.adx-title').textContent = cfg.title;
                var items = [];
                var busy = false, statusTimer = null, cur = cfg.initial;

                function setStatus(text, autoClear) {
                    clearTimeout(statusTimer);
                    statusEl.textContent = text || '';
                    statusEl.hidden = !text;
                    if (text && autoClear) statusTimer = setTimeout(function () { setStatus(''); }, 8000);
                }
                function setChecked(idx) {
                    items.forEach(function (b, k) { b.setAttribute('aria-checked', k === idx ? 'true' : 'false'); });
                }
                function openMenu(open) {
                    if (open) closeAllMenus(box);
                    box.hidden = !open;
                    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
                }

                cfg.entries.forEach(function (en, i) {
                    var b = document.createElement('button');
                    b.type = 'button';
                    b.className = 'plyr__control';
                    b.setAttribute('role', 'menuitemradio');
                    b.setAttribute('aria-checked', i === cur ? 'true' : 'false');
                    var label = document.createElement('span');
                    label.textContent = en.label;
                    b.title = en.tip || en.label;
                    if (en.badge) {
                        var val = document.createElement('span');
                        val.className = 'plyr__menu__value';
                        var badge = document.createElement('span');
                        badge.className = 'plyr__badge';
                        badge.textContent = en.badge;
                        val.appendChild(badge);
                        label.appendChild(val);
                    }
                    b.appendChild(label);
                    b.addEventListener('click', function (e) {
                        e.stopPropagation();
                        pick(i);
                    });
                    menu.appendChild(b);
                    items.push(b);
                });

                async function pick(i) {
                    if (busy) return;
                    if (cfg.same ? cfg.same(i, cur) : i === cur) { openMenu(false); return; }
                    busy = true;
                    wrap.classList.add('adx-busy');
                    try {
                        await cfg.onPick(i);
                        cur = i;
                        setChecked(i);
                        openMenu(false);
                    } catch (e) {
                        setStatus('Err: ' + formatErr(e), true);
                        trmReport(cfg.title + ' MENU ERR', formatErr(e), true);
                    } finally {
                        busy = false;
                        wrap.classList.remove('adx-busy');
                    }
                }

                btn.addEventListener('click', function (e) {
                    e.stopPropagation();
                    openMenu(box.hidden);
                });
                box.addEventListener('click', function (e) { e.stopPropagation(); });
                document.addEventListener('click', function () { if (!box.hidden) openMenu(false); });
                document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !box.hidden) openMenu(false); });

                var fs = controls.querySelector('.trm-zoom-ctrl') || controls.querySelector('[data-plyr="fullscreen"]');
                if (fs && fs.parentNode) fs.parentNode.insertBefore(wrap, fs); else controls.appendChild(wrap);

                return {
                    setStatus: setStatus,
                    setChecked: function (idx) { cur = idx; setChecked(idx); }
                };
            }

            function buildMenus(controls) {
                mountLockAndZoomUI(controls);
                ensureSubOverlay();
                if (controls.querySelector('.adx-audio')) return;

                var aLabels = uniqueLabels();
                var audioMenu = makeMenu(controls, {
                    cls: 'adx-audio-menu',
                    icon: 'plyr-settings',
                    sr: 'Audio',
                    title: 'Audio',
                    initial: current,
                    entries: tracks.map(function (t, i) {
                        return { label: aLabels[i], badge: badgeText(t), tip: nameFull(t) || aLabels[i] };
                    }),
                    same: function (i) { return i === current && (active || isBrowserNativeTrack(i)); },
                    onPick: async function (i) {
                        await switchTo(i);
                        current = i;
                    }
                });
                statusCb = audioMenu.setStatus;

                if (subs.length) {
                    ensureSubOverlay();
                    var entries = [{ label: 'Off', badge: '', tip: 'Off' }];
                    subs.forEach(function (t, i) {
                        entries.push({ label: subLabelList[i], badge: '', tip: subLabelList[i] });
                    });
                    var subMenu = makeMenu(controls, {
                        cls: 'adx-subs-menu',
                        icon: 'plyr-captions-off',
                        sr: 'Subtitles',
                        title: 'Subtitles',
                        initial: sub.cur >= 0 ? sub.cur + 1 : (subAutoDone ? 0 : subBaseIdx + 1),
                        entries: entries,
                        onPick: async function (i) {
                            await subSelect(i - 1);
                        }
                    });
                    subStatusCb = subMenu.setStatus;
                    subMenuApi = subMenu;
                }
            }

            waitFor('.plyr', 100, function () { ensureSubOverlay(); });
            waitFor('.plyr__controls', 60, buildMenus);
        }

        // ---------- Container-agnostic startup routing ----------
        //  1. Server already probed an MKV/WebM (window.__AUDIO_META__): use its track list.
        //  2. Otherwise sniff the first bytes: Matroska/WebM -> read tracks; anything else -> native.
        //  3. The track rules (isBrowserNativeTrack) then pick native <video> audio or our engine.
        //  Anything unknown / failed / without audio fails OPEN to native playback (never an error, never muted).
        if (window.__AUDIO_META__ && window.__AUDIO_META__.audio && window.__AUDIO_META__.audio.length) {
            window.__TRM_CONTAINER = window.__TRM_CONTAINER || 'matroska';
            trmReport('CONTAINER', 'matroska/webm (track info from server probe) -> ' + window.__AUDIO_META__.audio.length + ' audio track(s)', false);
            startAudioEngineWithMeta(window.__AUDIO_META__);
        } else {
            clientSideProbeMkv().then(function (meta) {
                if (meta && meta.audio && meta.audio.length) {
                    window.__AUDIO_META__ = meta;
                    startAudioEngineWithMeta(meta);
                } else {
                    routeNative('no audio-engine work needed for this file');
                }
            }).catch(function (e) {
                routeNative('startup probe failed (' + formatErr(e) + ')');
            });
        }
    })();
