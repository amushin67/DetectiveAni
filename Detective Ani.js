// ==UserScript==
// @name         Detective Ani 🔎
// @namespace    http://tampermonkey.net/
// @version      1.0
// @description  Detects titlex$ in videos and UUID in image EXIF Artist + grok/_generated_ + pure UUID (videos only) + F4 toggle + Detects UUID (grok_post_id) from Twitter/X media via React Fiber. Disabled on grok.com. Completely ignores redgifs.com (iframes + media).
// @author       Amu & Grok
// @match        *://*/*
// @grant        GM_xmlhttpRequest
// @grant        GM_addStyle
// @connect      *
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    // ─── Disable on grok.com and derivatives ─────────────────────────────────
    const host = location.hostname.toLowerCase();
    if (
        host === 'grok.com' ||
        host.endsWith('.grok.com') ||
        host.includes('grok.com')
    ) {
        return;
    }

    // ─── Also fully disable on redgifs.com itself ────────────────────────────
    if (
        host === 'redgifs.com' ||
        host.endsWith('.redgifs.com') ||
        host.includes('redgifs.com')
    ) {
        return;
    }

    // ─── Constants ───────────────────────────────────────────────────────────
    const MAKE_IMAGINE_LINK = (uuid) => `https://grok.com/imagine/post/${uuid}`;
    const BYTES_TO_FETCH = 65536;
    const MARKER = 'titlex$';
    const UUID_REGEX = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
    const HOVER_HINT = 'Press F4 to hide/show';
    const ICON_CLASS = 'titlex-ani';
    const ICON_CLASS_X = 'grok-uuid-icon';

    // ─── Shared state ────────────────────────────────────────────────────────
    const checkedUrls = new Set();
    const mediaState = new WeakMap();
    let iconsVisible = true;

    // ─── Styles (injected once) ──────────────────────────────────────────────
    GM_addStyle(`
        .${ICON_CLASS}, .${ICON_CLASS_X} {
            position: absolute !important;
            bottom: 4px !important;
            right: 4px !important;
            z-index: 2147483647 !important;
            width: 8px !important;
            height: 8px !important;
            font-size: 8px !important;
            line-height: 8px !important;
            cursor: pointer !important;
            transition: transform 0.15s ease, opacity 0.15s ease !important;
            user-select: none !important;
            pointer-events: auto !important;
            opacity: 0.9 !important;
            filter: drop-shadow(0 0 2px rgba(0,0,0,0.85));
        }
        .${ICON_CLASS}:hover, .${ICON_CLASS_X}:hover {
            transform: scale(1.8) !important;
            opacity: 1 !important;
        }
        .${ICON_CLASS}.hidden, .${ICON_CLASS_X}.hidden {
            display: none !important;
        }
    `);

    // ─── Toggle (F4) ─────────────────────────────────────────────────────────
    function toggleIcons() {
        iconsVisible = !iconsVisible;
        document.querySelectorAll(`.${ICON_CLASS}, .${ICON_CLASS_X}`).forEach(icon => {
            icon.classList.toggle('hidden', !iconsVisible);
        });
        console.log(
            `%c[TitleX] Icons ${iconsVisible ? 'SHOWN' : 'HIDDEN'} (F4)`,
            iconsVisible ? 'color:lime;font-weight:bold' : 'color:orange;font-weight:bold'
        );
    }

    document.addEventListener('keydown', (e) => {
        if (e.key === 'F4' && !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey) {
            e.preventDefault();
            e.stopPropagation();
            toggleIcons();
        }
    }, true);

    // ─── Icon creation helper ────────────────────────────────────────────────
    function createIcon(uuid, className = ICON_CLASS) {
        const icon = document.createElement('span');
        icon.className = className;
        if (!iconsVisible) icon.classList.add('hidden');
        icon.textContent = '🟢';
        icon.title = `UUID: ${uuid}\nClick to open in Imagine\n${HOVER_HINT}`;
        icon.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();
            window.open(MAKE_IMAGINE_LINK(uuid), '_blank');
            navigator.clipboard?.writeText(uuid).catch(() => {});
        }, true);
        return icon;
    }

    function ensureRelativeContainer(el) {
        if (!el) return null;
        const style = getComputedStyle(el);
        if (style.position === 'static') {
            if (el.parentElement) {
                const wrapper = document.createElement('span');
                wrapper.style.cssText = 'position:relative;display:inline-block;max-width:100%;line-height:0;';
                el.parentElement.insertBefore(wrapper, el);
                wrapper.appendChild(el);
                return wrapper;
            }
            el.style.position = 'relative';
        }
        return el;
    }

    function addAniToMedia(media, uuid) {
        if (!uuid || media.dataset.titlexUuid === uuid) return;
        media.dataset.titlexUuid = uuid;

        media.parentElement?.querySelectorAll(`.${ICON_CLASS}`).forEach(el => el.remove());

        const container = ensureRelativeContainer(media.parentElement) || media.parentElement;
        if (!container) return;

        container.appendChild(createIcon(uuid));
        console.log('%c[TitleX] 🟢 added →', 'color:lime', uuid);
    }

    // ─── Helper: detect redgifs ───────────────────────────────────────────────
    function isRedgifsUrl(url) {
        if (!url) return false;
        return /redgifs\.com/i.test(String(url));
    }

    function isInsideRedgifsIframe(el) {
        // Walk up looking for an iframe ancestor that points to redgifs
        let node = el;
        while (node) {
            if (node.tagName === 'IFRAME') {
                const src = node.src || node.getAttribute('src') || node.getAttribute('data-src') || '';
                if (isRedgifsUrl(src)) return true;
            }
            // Also check common embed wrappers
            if (node.tagName === 'SHREDDIT-EMBED' || node.classList?.contains('redgifs') || node.id?.includes('redgifs')) {
                return true;
            }
            node = node.parentElement;
        }
        return false;
    }

    // ─── UUID extractors ─────────────────────────────────────────────────────
    function extractUuidFromExifArtist(buffer) {
        try {
            const view = new DataView(buffer);
            if (view.byteLength < 4 || view.getUint16(0) !== 0xFFD8) return null;

            let offset = 2;
            while (offset < view.byteLength - 4) {
                if (view.getUint8(offset) !== 0xFF) break;
                const marker = view.getUint8(offset + 1);
                if (marker === 0xDA) break;

                const size = view.getUint16(offset + 2);
                if (marker === 0xE1) {
                    if (view.getUint32(offset + 4) === 0x45786966 && view.getUint16(offset + 8) === 0x0000) {
                        const tiffStart = offset + 10;
                        const little = view.getUint16(tiffStart) === 0x4949;

                        const read16 = (o) => view.getUint16(o, little);
                        const read32 = (o) => view.getUint32(o, little);

                        const ifd0Offset = tiffStart + read32(tiffStart + 4);
                        if (ifd0Offset >= view.byteLength) return null;

                        const numEntries = read16(ifd0Offset);
                        for (let i = 0; i < numEntries; i++) {
                            const entry = ifd0Offset + 2 + i * 12;
                            if (entry + 12 > view.byteLength) break;

                            if (read16(entry) === 0x013B) {
                                const count = read32(entry + 4);
                                let valueOffset = entry + 8;
                                if (count > 4) valueOffset = tiffStart + read32(entry + 8);
                                if (valueOffset + count > view.byteLength) return null;

                                let str = '';
                                for (let j = 0; j < count; j++) {
                                    const c = view.getUint8(valueOffset + j);
                                    if (c === 0) break;
                                    str += String.fromCharCode(c);
                                }
                                const match = str.match(UUID_REGEX);
                                if (match) return match[0];
                            }
                        }
                    }
                }
                offset += 2 + size;
            }
        } catch (_) {}
        return null;
    }

    function extractUuidFromFilename(url, isVideo = false) {
        if (!url) return null;

        let filename = '';
        let fnValue = null;

        try {
            const u = new URL(url);
            filename = decodeURIComponent(u.pathname.split('/').pop() || '');
            fnValue = u.searchParams.get('fn');
            if (fnValue) {
                fnValue = decodeURIComponent(fnValue);
                filename += ' ' + fnValue;
            }
        } catch {
            filename = url;
        }

        // 1. _generated_UUID (valid for both image & video)
        const genMatch = filename.match(/_generated_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
        if (genMatch) return genMatch[1];

        // 2. Pure UUID or UUID + extension → videos only
        if (isVideo) {
            if (fnValue) {
                const fnMatch = fnValue.match(
                    /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\.[a-z0-9]+)?$/i
                );
                if (fnMatch) return fnMatch[1];
            }

            const pureOrExtMatch = filename.match(
                /(?:^|[\s\/])([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\.[a-z0-9]+)?(?:$|[\s?&#])/i
            );
            if (pureOrExtMatch) return pureOrExtMatch[1];
        }

        // 3. Any UUID when filename contains "grok"
        if (/grok/i.test(filename)) {
            const match = filename.match(UUID_REGEX);
            if (match) return match[0];
        }

        return null;
    }

    function findUUIDInBuffer(buffer) {
        try {
            const text = new TextDecoder('latin1').decode(buffer);
            const idx = text.indexOf(MARKER);
            if (idx === -1) return null;
            const after = text.slice(idx + MARKER.length, idx + MARKER.length + 60);
            const match = after.match(UUID_REGEX);
            return match ? match[0] : null;
        } catch {
            return null;
        }
    }

    // ─── Media processing (generic sites) ────────────────────────────────────
    function checkUrl(url, media) {
        if (!url) return;

        // ── Strong redgifs protection ────────────────────────────────────────
        if (isRedgifsUrl(url)) return;
        if (media && isInsideRedgifsIframe(media)) return;

        const clean = url.split(/["'\s<>]/)[0];
        if (isRedgifsUrl(clean)) return;

        const isImage = media?.tagName === 'IMG' || /\.(jpe?g|png|webp|gif)(\?|$)/i.test(clean);
        const isVideo = media?.tagName === 'VIDEO' || /\.(mp4|webm|mov|m4v)(\?|$)/i.test(clean);
        if (!isImage && !isVideo) return;

        const uuidFromName = extractUuidFromFilename(clean, isVideo);
        if (uuidFromName && media) addAniToMedia(media, uuidFromName);

        if (checkedUrls.has(clean)) return;
        checkedUrls.add(clean);

        GM_xmlhttpRequest({
            method: 'GET',
            url: clean,
            headers: { Range: `bytes=0-${BYTES_TO_FETCH - 1}` },
            responseType: 'arraybuffer',
            timeout: 10000,
            onload(res) {
                if (res.status !== 200 && res.status !== 206) return;

                let uuid = null;
                if (isVideo) uuid = findUUIDInBuffer(res.response);
                else if (isImage) uuid = extractUuidFromExifArtist(res.response);

                if (uuid && media) addAniToMedia(media, uuid);
            }
        });
    }

    function processMedia(media) {
        if (!media || media.dataset.titlexUuid) return;

        // ── Strong redgifs protection ────────────────────────────────────────
        if (isInsideRedgifsIframe(media)) return;
        if (isRedgifsUrl(media.src) || isRedgifsUrl(media.currentSrc)) return;

        const state = mediaState.get(media) || { tries: 0, lastSrc: '' };
        const currentSrc = media.currentSrc || media.src || media.getAttribute('src') || '';

        if (currentSrc && currentSrc !== state.lastSrc) {
            state.tries = 0;
            state.lastSrc = currentSrc;
        }

        state.tries++;
        mediaState.set(media, state);
        if (state.tries > 10) return;

        const urls = new Set();
        if (media.src) urls.add(media.src);
        if (media.currentSrc) urls.add(media.currentSrc);

        if (media.tagName === 'VIDEO') {
            media.querySelectorAll('source').forEach(s => s.src && urls.add(s.src));
        }

        ['data-src', 'data-original', 'data-lazy-src', 'data-url'].forEach(attr => {
            const val = media.getAttribute(attr);
            if (val) urls.add(val);
        });

        if (media.tagName === 'IMG' && media.srcset) {
            media.srcset.split(',').forEach(part => {
                const u = part.trim().split(/\s+/)[0];
                if (u) urls.add(u);
            });
        }

        urls.forEach(url => checkUrl(url, media));
    }

    function scan() {
        document.querySelectorAll('video, img').forEach(processMedia);

        // Completely ignore redgifs iframes – do not even try contentDocument
        document.querySelectorAll('iframe').forEach(iframe => {
            try {
                const src = (iframe.src || iframe.getAttribute('src') || iframe.getAttribute('data-src') || '').toLowerCase();
                if (src.includes('redgifs.com')) return; // ← hard skip

                // Also skip common embed wrappers
                if (iframe.closest('shreddit-embed') || iframe.closest('[class*="redgifs"]')) return;

                const doc = iframe.contentDocument;
                if (doc) doc.querySelectorAll('video, img').forEach(processMedia);
            } catch (_) {}
        });
    }

    // ─── Twitter / X specific logic ──────────────────────────────────────────
    const isTwitterOrX =
        location.hostname === 'x.com' ||
        location.hostname === 'twitter.com' ||
        location.hostname.endsWith('.x.com') ||
        location.hostname.endsWith('.twitter.com');

    if (isTwitterOrX) {
        const processed = new WeakSet();
        let scanning = false;
        let scanTimeout = null;

        function extractMediaObjects(article) {
            const results = [];
            const seen = new Set();

            const selectors = [
                '[data-testid="tweetPhoto"]',
                '[data-testid="videoComponent"]',
                '[data-testid="tweetText"]',
                'div[style*="position"]'
            ].join(',');

            const candidates = [article, ...article.querySelectorAll(selectors)];

            for (const el of candidates) {
                const fiberKey = Object.keys(el).find(
                    k => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$')
                );
                if (!fiberKey) continue;

                let fiber = el[fiberKey];
                let depth = 0;

                while (fiber && depth < 35) {
                    try {
                        if (fiber.memoizedProps) {
                            const str = JSON.stringify(fiber.memoizedProps);
                            const regex = /"grok_post_id"\s*:\s*"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"/gi;
                            let match;

                            while ((match = regex.exec(str)) !== null) {
                                const uuid = match[1];
                                if (seen.has(uuid)) continue;

                                const start = Math.max(0, match.index - 250);
                                const end = Math.min(str.length, match.index + 420);
                                const chunk = str.slice(start, end);

                                const mediaKey = (chunk.match(/"media_key"\s*:\s*"([^"]+)"/) || [])[1];
                                const type = (chunk.match(/"type"\s*:\s*"([^"]+)"/) || [])[1];
                                const expanded = (chunk.match(/"expanded_url"\s*:\s*"([^"]+)"/) || [])[1];
                                const idStr = (chunk.match(/"id_str"\s*:\s*"(\d+)"/) || [])[1];

                                const isVideo =
                                    type === 'video' ||
                                    (mediaKey && mediaKey.startsWith('13_')) ||
                                    (expanded && expanded.includes('/video/')) ||
                                    (idStr && chunk.includes('amplify_video'));

                                results.push({ uuid, isVideo, mediaKey, idStr });
                                seen.add(uuid);
                            }
                        }
                    } catch (_) {}

                    fiber = fiber.return;
                    depth++;
                }
            }

            return results;
        }

        function addIconX(mediaEl, uuid) {
            if (!uuid) return;
            if (mediaEl.parentElement?.querySelector(`.${ICON_CLASS_X}`)) return;

            const container =
                mediaEl.closest('[data-testid="tweetPhoto"]') ||
                mediaEl.closest('[data-testid="videoComponent"]') ||
                mediaEl.parentElement;

            if (!container) return;

            if (getComputedStyle(container).position === 'static') {
                container.style.position = 'relative';
            }

            const icon = createIcon(uuid, ICON_CLASS_X);
            icon.style.bottom = '6px';
            icon.style.right = '6px';
            container.appendChild(icon);
        }

        function processTweet(article) {
            const mediaEls = article.querySelectorAll(
                '[data-testid="tweetPhoto"] img, [data-testid="videoComponent"] video'
            );
            const mediaCount = mediaEls.length;
            const hasIcons = article.querySelectorAll(`.${ICON_CLASS_X}`).length;

            if (processed.has(article) && hasIcons >= mediaCount && mediaCount > 0) return;

            const mediaObjects = extractMediaObjects(article);
            if (mediaObjects.length === 0) return;

            processed.add(article);

            const photoUUIDs = mediaObjects.filter(m => !m.isVideo).map(m => m.uuid);
            const videoUUIDs = mediaObjects.filter(m => m.isVideo).map(m => m.uuid);

            // Photos
            const photos = [...article.querySelectorAll('[data-testid="tweetPhoto"] img')]
                .filter(img => img.offsetWidth > 40);

            const uniquePhotos = [];
            const seenP = new Set();
            for (const img of photos) {
                const key = img.src.split('?')[0];
                if (!seenP.has(key)) {
                    seenP.add(key);
                    uniquePhotos.push(img);
                }
            }

            uniquePhotos.forEach((img, i) => {
                const uuid = photoUUIDs[i] || photoUUIDs[0];
                if (uuid) addIconX(img, uuid);
            });

            // Videos
            const videos = [...article.querySelectorAll('[data-testid="videoComponent"] video')]
                .filter(v => v.offsetWidth > 40);

            const uniqueVideos = [];
            const seenV = new Set();
            for (const v of videos) {
                const key = v.poster || v.src || v.currentSrc;
                if (!seenV.has(key)) {
                    seenV.add(key);
                    uniqueVideos.push(v);
                }
            }

            uniqueVideos.forEach((video, i) => {
                const uuid = videoUUIDs[i] || videoUUIDs[0] || mediaObjects.find(m => m.isVideo)?.uuid;
                if (uuid) addIconX(video, uuid);
            });
        }

        function scanTwitter() {
            if (scanning) return;
            scanning = true;

            requestAnimationFrame(() => {
                document.querySelectorAll('article[data-testid="tweet"]').forEach(processTweet);
                scanning = false;
            });
        }

        function scheduleScan() {
            if (scanTimeout) return;
            scanTimeout = setTimeout(() => {
                scanTimeout = null;
                scanTwitter();
            }, 140);
        }

        const observer = new MutationObserver(scheduleScan);
        observer.observe(document.body, { childList: true, subtree: true });

        window.addEventListener('scroll', scheduleScan, { passive: true });

        setInterval(scanTwitter, 1800);

        setTimeout(scanTwitter, 500);
        setTimeout(scanTwitter, 1500);
        setTimeout(scanTwitter, 3000);

        console.log(
            '%c[TitleX] Twitter/X mode active – F4 toggles icons',
            'color:#00ff88;font-weight:bold'
        );
    } else {
        // ─── Generic sites ───────────────────────────────────────────────────
        const observer = new MutationObserver((mutations) => {
            let needsScan = false;
            for (const m of mutations) {
                if (m.type === 'childList') {
                    // Ignore mutations that only involve redgifs iframes
                    let onlyRedgifs = true;
                    for (const node of m.addedNodes) {
                        if (node.nodeType !== 1) continue;
                        if (node.tagName === 'IFRAME' && isRedgifsUrl(node.src || node.getAttribute('src'))) continue;
                        if (node.querySelector?.('iframe[src*="redgifs"]')) continue;
                        onlyRedgifs = false;
                        break;
                    }
                    if (!onlyRedgifs) needsScan = true;
                } else if (
                    m.type === 'attributes' &&
                    (m.target.tagName === 'VIDEO' || m.target.tagName === 'IMG')
                ) {
                    if (!isInsideRedgifsIframe(m.target) && !isRedgifsUrl(m.target.src)) {
                        processMedia(m.target);
                    }
                }
            }
            if (needsScan) scan();
        });

        observer.observe(document.documentElement, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['src', 'srcset', 'data-src', 'data-original']
        });

        ['loadstart', 'loadedmetadata', 'load', 'canplay'].forEach(evt => {
            document.addEventListener(evt, e => {
                if (e.target.tagName === 'VIDEO' || e.target.tagName === 'IMG') {
                    if (!isInsideRedgifsIframe(e.target) && !isRedgifsUrl(e.target.src || e.target.currentSrc)) {
                        processMedia(e.target);
                    }
                }
            }, true);
        });

        scan();
        [600, 1500, 3000, 6000, 10000].forEach(t => setTimeout(scan, t));

        let ticks = 0;
        const keepAlive = setInterval(() => {
            scan();
            if (++ticks > 5) clearInterval(keepAlive);
        }, 5000);

        console.log(
            '%c[TitleX] v3.8 active – pure UUID only on videos | 🟢 8×8px | F4 = toggle | redgifs fully ignored | grok.com disabled',
            'color:cyan;font-weight:bold'
        );
    }
})();