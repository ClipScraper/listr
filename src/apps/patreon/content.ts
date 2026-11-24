import type {CollectedItem, BookmarkMedia} from '../../hooks/useCollections';
import browser from 'webextension-polyfill';
import {collectionCoverCreator, collectionCoverTitle, listingCollectionId, isPatreonUrl, nextPostsButton, scanPatreonPosts} from './scan';
import {PostRateLimitError, readPost} from './post';

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
        const collection = listingCollectionId(new URL(location.href));
        const page = location.pathname + location.search;
        const seen = new Map<string, BookmarkMedia>();
        let timer: number | undefined;
        let wait = 3;
        let remaining = 0;
        let bottomSince = 0;
        let pagedAtCount = -1;
        let lastTitle = '';
        let lastCreator = '';

        const visited = new Set<string>();
        const pending = new Set<string>();
        let request: AbortController | undefined;
        let reading = false;
        let missingDetails = false;
        let rateLimited = false;

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
            if (reading || rateLimited || !pending.size) {
                return;
            }
            const id = pending.values().next().value as string;
            pending.delete(id);
            reading = true;
            request = new AbortController();
            const deadline = window.setTimeout(() => request?.abort(), 15000);
            try {
                const items = await readPost(id, request.signal);
                if (!request.signal.aborted && location.pathname + location.search === page) {
                    publish(items);
                }
            } catch (error) {
                missingDetails = true;
                if (error instanceof PostRateLimitError) {
                    rateLimited = true;
                    pending.clear();
                }
            } finally {
                window.clearTimeout(deadline);
                request = undefined;
                reading = false;
            }
        }

        function tick(resetPosition = false) {
            if (location.pathname + location.search !== page) {
                window.clearInterval(timer);
                request?.abort();
                port.disconnect();
                return;
            }
            const {items, postIds, scrollTarget} = scanPatreonPosts();
            if (collection) {
                const title = collectionCoverTitle();
                const creator = collectionCoverCreator();
                if ((title && title !== lastTitle) || (creator && creator !== lastCreator)) {
                    lastTitle = title || lastTitle;
                    lastCreator = creator || lastCreator;
                    port.postMessage({collectionTitle: lastTitle, collectionCreator: lastCreator});
                }
            }
            publish(items);
            for (const id of postIds) {
                if (!visited.has(id)) {
                    visited.add(id);
                    bottomSince = 0;
                    if (!collection && !rateLimited) {
                        pending.add(id);
                    }
                }
            }
            void readNextPost();
            if (resetPosition) {
                scrollTarget.scrollTo(0, 0);
            }
            if (remaining === 0 && !resetPosition) {
                const atBottom = scrollTarget.scrollTop + scrollTarget.clientHeight >= scrollTarget.scrollHeight - 2;
                if (visited.size && visited.size !== pagedAtCount) {
                    const next = nextPostsButton(scrollTarget, atBottom);
                    if (next) {
                        pagedAtCount = visited.size;
                        bottomSince = 0;
                        next.click();
                    }
                }
                if (atBottom && !reading && !pending.size && bottomSince && Date.now() - bottomSince >= Math.max(8000, wait * 1000)) {
                    port.postMessage({complete: true, count: seen.size, previewOnly: missingDetails});
                    window.clearInterval(timer);
                    return;
                }
                bottomSince = atBottom ? bottomSince || Date.now() : 0;
                scrollTarget.scrollBy(0, Math.max(1, Math.floor(scrollTarget.clientHeight * 0.9)));
                remaining = wait;
            } else if (remaining > 0) {
                remaining--;
            }
            port.postMessage({remaining});
        }

        port.onMessage.addListener(raw => {
            const message = raw as CaptureCommand;
            window.clearInterval(timer);
            if (message.action === 'start' || message.action === 'resume') {
                wait = message.wait ?? wait;
                bottomSince = 0;
                remaining = 0;
                timer = window.setInterval(tick, 1000);
                tick(message.action === 'start');
            }
        });
        port.onDisconnect.addListener(() => {
            window.clearInterval(timer);
            request?.abort();
        });
    });
}
