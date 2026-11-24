import type {CollectedItem, BookmarkMedia} from '../../hooks/useCollections';
import browser from 'webextension-polyfill';
import {isPatreonUrl, scanPatreonPosts, visiblePostIds} from './scan';
import {readPost} from './post';

// The port ties the capture to the requesting popup and tab, including pause and cancellation.
type CaptureCommand = {action: 'pause' | 'resume' | 'start'; wait?: number};

export function initPatreonContent() {
    if (!isPatreonUrl(location.href)) {
        return;
    }
    browser.runtime.onConnect.addListener(port => {
        if (port.name !== 'patreon-collection') {
            return;
        }
        const page = location.href;
        const seen = new Map<string, BookmarkMedia>();
        let timer: number | undefined;
        let wait = 3;
        let remaining = 0;
        let bottomSince = 0;

        const visited = new Set<string>();
        const pending = new Set<string>();
        let request: AbortController | undefined;
        let reading = false;
        let unavailable = false;

        function publish(batch: CollectedItem[]) {
            const items = batch.filter(item => {
                const previous = seen.get(item.url);
                if (previous === item.mediaType || (previous && item.mediaType === 'link')) {
                    return false;
                }
                seen.set(item.url, item.mediaType);
                return true;
            });
            if (items.length) {
                port.postMessage({items});
                bottomSince = 0;
            }
        }

        async function readNextPost() {
            if (reading || unavailable || !pending.size) {
                return;
            }
            const id = pending.values().next().value as string;
            pending.delete(id);
            reading = true;
            request = new AbortController();
            const deadline = window.setTimeout(() => request?.abort(), 15000);
            try {
                const items = await readPost(id, request.signal);
                if (!request.signal.aborted && location.href === page) {
                    publish(items);
                }
            } catch {
                // Keep collecting the rendered page if the post endpoint is unavailable.
                unavailable = true;
                pending.clear();
            } finally {
                window.clearTimeout(deadline);
                request = undefined;
                reading = false;
            }
        }

        function tick() {
            if (location.href !== page) {
                window.clearInterval(timer);
                request?.abort();
                port.disconnect();
                return;
            }
            publish(scanPatreonPosts());
            if (!unavailable) {
                for (const id of visiblePostIds()) {
                    if (!visited.has(id)) {
                        visited.add(id);
                        pending.add(id);
                    }
                }
                void readNextPost();
            }
            if (remaining === 0) {
                const atBottom = window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 2;
                if (atBottom && !reading && !pending.size && bottomSince && Date.now() - bottomSince >= Math.max(3000, wait * 1000)) {
                    port.postMessage({complete: true, count: seen.size, previewOnly: unavailable});
                    window.clearInterval(timer);
                    return;
                }
                bottomSince = atBottom ? bottomSince || Date.now() : 0;
                window.scrollBy(0, Math.max(1, Math.floor(window.innerHeight * 0.9)));
                remaining = wait;
            } else {
                remaining--;
            }
            port.postMessage({remaining});
        }

        port.onMessage.addListener(raw => {
            const message = raw as CaptureCommand;
            window.clearInterval(timer);
            if (message.action === 'start' || message.action === 'resume') {
                if (message.action === 'start') {
                    publish(scanPatreonPosts());
                    window.scrollTo(0, 0);
                }
                wait = message.wait ?? wait;
                bottomSince = 0;
                remaining = 0;
                timer = window.setInterval(tick, 1000);
                tick();
            }
        });
        port.onDisconnect.addListener(() => {
            window.clearInterval(timer);
            request?.abort();
        });
    });
}
