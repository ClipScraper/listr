import type {CollectedItem, BookmarkMedia} from '../../hooks/useCollections';

export function isPatreonUrl(value: string): boolean {
    try {
        const url = new URL(value);
        return url.protocol === 'https:' && /(^|\.)patreon\.com$/.test(url.hostname);
    } catch {
        return false;
    }
}

export function collectionId(url: URL): string | null {
    return url.pathname.match(/\/collections?\/([^/]+)/)?.[1] || url.searchParams.get('collection_id') || url.searchParams.get('collection');
}

const postPath = /\/posts\/(?:[^/]+-)?(\d+)\/?$/;

export function listingCollectionId(url: URL): string | null {
    return postPath.test(url.pathname) ? null : collectionId(url);
}

export function collectionLabel(id: string, title: string): string {
    const clean = title.replace(/\s+/gu, ' ').trim();
    if (!clean || clean === `Collection ${id}`) {
        return `Collection ${id}`;
    }
    const suffix = ` (${id})`;
    return clean.endsWith(suffix) ? clean : clean + suffix;
}

export function collectionCoverTitle(): string {
    if (!listingCollectionId(new URL(location.href))) {
        return '';
    }
    const cover = document.querySelector('h1 [elementtiming="Collection : Cover" i], h1 [elementtiming="Collection: Cover" i]');
    const heading = Array.from(document.querySelectorAll('main h1, [role="main"] h1')).find(el =>
        el.textContent?.trim() && !el.closest('nav, header, aside, article, [role="navigation"], a[href*="/posts/"], [data-tag="post-card"], [data-testid="post-card"], [data-tag="creator-sticky-nav"]')
    );
    const pageTitle = document.title.match(/^(.+?)\s+\|\s+Collection (?:from|by)\s+/i)?.[1];
    return (cover?.textContent?.trim() || heading?.textContent?.trim() || pageTitle || '').replace(/\s+/gu, ' ').trim();
}

export function patreonFilenameLabel(label: string, id?: string): string {
    const suffix = id && label.endsWith(` (${id})`) ? ` (${id})` : '';
    const title = label.slice(0, label.length - suffix.length).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_');
    const encoder = new TextEncoder();
    let remaining = 140 - encoder.encode(suffix).length;
    let prefix = '';
    for (const char of title) {
        remaining -= encoder.encode(char).length;
        if (remaining < 0) {
            break;
        }
        prefix += char;
    }
    return prefix + suffix;
}

export function patreonCollectionName(value: string, title = ''): string {
    const url = new URL(value);
    const collection = collectionId(url);
    if (collection) {
        return collectionLabel(collection, title);
    }
    return url.pathname.replace(/^\/c\//, '/').split('/').filter(Boolean).join(' - ') || 'Patreon feed';
}

export function networkUrl(raw: string | null): URL | undefined {
    if (!raw?.trim() || raw.startsWith('#')) {
        return;
    }
    try {
        const url = new URL(raw, document.baseURI);
        if (['https:', 'http:'].includes(url.protocol) && !url.username && !url.password) {
            return url;
        }
    } catch {
        // Placeholders and malformed URLs are common while cards are loading.
    }
}

export function linkedMedia(url: URL, filename = ''): BookmarkMedia {
    const names = [filename, url.pathname];
    if (names.some(name => /\.(avif|bmp|gif|heic|jpe?g|png|svg|tiff?|webp)$/i.test(name))) {
        return 'pictures';
    }
    if (names.some(name => /\.(m3u8|mpd|m4v|mov|mp4|mkv|ogv|webm)$/i.test(name))) {
        return 'video';
    }
    const host = url.hostname.toLowerCase();
    if ((/(^|\.)youtube\.com$/.test(host) && (url.pathname === '/watch' && url.searchParams.has('v') || /^\/(shorts|embed)\/[^/]+/.test(url.pathname)))
        || (host === 'youtu.be' && url.pathname.length > 1)
        || (/(^|\.)vimeo\.com$/.test(host) && /\/\d+\/?$/.test(url.pathname))) {
        return 'video';
    }
    return 'link';
}

const cards = 'article, [role="article"], [data-post-id], [data-tag="post-card"], [data-testid="post-card"], [data-tag="post"]';
const bodies = '[data-tag^="post-content"], [data-testid="post-content"], [data-tag="post-body"], [data-tag="post-attachments"]';
const outsidePosts = 'nav, aside, footer, [role="navigation"], [role="complementary"], [data-tag^="sticky-sidebar-section-"], [role="banner"], [data-tag*="comment" i], [data-testid*="comment" i], [data-tag*="avatar" i], [data-tag*="post-footer" i], [data-tag*="recommend" i]';
const chrome = `${outsidePosts}, header, [data-tag*="post-header" i]`;
const permalink = 'a[href*="/posts/"]';

export function textLinks(root: Node): CollectedItem[] {
    const items: CollectedItem[] = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (node.parentElement?.closest(`a, script, style, ${chrome}`)) {
            continue;
        }
        for (const match of (node.textContent || '').match(/https?:\/\/[^\s<>"`]+/gi) || []) {
            let raw = match.replace(/[.,;!]+$/, '');
            if (raw.endsWith(')') && !raw.includes('(')) {
                raw = raw.slice(0, -1);
            }
            const url = networkUrl(raw);
            if (url) {
                items.push({url: url.href, mediaType: linkedMedia(url)});
            }
        }
    }
    return items;
}

type PatreonScan = {
    items: CollectedItem[];
    postIds: Set<string>;
    scrollTarget: Element;
};

function scrollContainer(content: Element | null): Element {
    for (let el = content; el; el = el.parentElement) {
        if (el.clientHeight && el.scrollHeight > el.clientHeight && /^(auto|scroll|overlay)$/.test(getComputedStyle(el).overflowY)) {
            return el;
        }
    }
    return document.scrollingElement || document.documentElement;
}

export function nextPostsButton(scrollTarget: Element, atBottom: boolean): HTMLButtonElement | undefined {
    const collection = listingCollectionId(new URL(location.href));
    const feed = document.querySelector('[data-tag="cw-post-stream-container"]') || (collection && document.querySelector('main, [role="main"]'));
    if (!feed) {
        return;
    }

    const viewport = scrollTarget === document.scrollingElement ? {top: 0, bottom: window.innerHeight} : scrollTarget.getBoundingClientRect();
    for (const button of Array.from(feed.querySelectorAll<HTMLButtonElement>('button:not(:disabled):not([aria-disabled="true"])'))) {
        if (button.closest(`${outsidePosts}, ${cards}, ${bodies}, [role="dialog"]`)) {
            continue;
        }
        const label = (button.getAttribute('aria-label') || button.textContent || '').trim();
        if (!/^(load more(?: posts)?|show more posts|charger plus(?: de publications)?)$/i.test(label)) {
            continue;
        }
        const bounds = button.getBoundingClientRect();
        if (bounds.width && bounds.height && (bounds.bottom > viewport.top || atBottom) && bounds.top < viewport.bottom) {
            return button;
        }
    }
}

export function scanPatreonPosts(): PatreonScan {
    const found = new Map<string, BookmarkMedia>();
    function add(url: URL | undefined, media: BookmarkMedia) {
        if (url && (!found.has(url.href) || found.get(url.href) === 'link')) {
            found.set(url.href, media);
        }
    }

    const main = document.querySelector('main, [role="main"]');
    const roots = new Set(Array.from(document.querySelectorAll(`${cards}, ${bodies}`)).filter(root => !root.closest(outsidePosts)));
    const current = location.pathname.match(postPath)?.[1];
    const postIds = new Set<string>();
    if (current) {
        postIds.add(current);
        if (!roots.size && main) {
            roots.add(main);
        }
    } else {
        for (const root of roots) {
            const id = root.getAttribute('data-post-id');
            if (id && /^\d+$/.test(id)) {
                postIds.add(id);
            }
        }
        // Creator feeds and collections both use compact tiles. Their title or
        // timestamp may be the only post identity and often sits in the card header.
        document.querySelectorAll<HTMLAnchorElement>(permalink).forEach(anchor => {
            if (anchor.closest(outsidePosts) || anchor.closest(bodies)) {
                return;
            }
            const url = networkUrl(anchor.getAttribute('href'));
            const id = url && isPatreonUrl(url.href) && url.pathname.match(postPath)?.[1];
            if (!url || !id) {
                return;
            }
            postIds.add(id);
            add(url, 'link');
            if (!anchor.closest(cards)) {
                roots.add(anchor.closest('li, [role="listitem"]') || anchor);
            }
        });
    }

    const firstPost = Array.from(roots).find(root => root.getClientRects().length);
    const scrollTarget = scrollContainer(firstPost || main);
    const page = new URL(location.href);
    const collection = listingCollectionId(page);
    if (collection) {
        const items = Array.from(postIds, id => {
            const post = new URL(`/posts/${id}`, page.origin);
            post.searchParams.set('collection', collection);
            return {url: post.href, mediaType: 'link' as const};
        });
        return {items, postIds, scrollTarget};
    }

    for (const root of roots) {
        if (root.matches(bodies) || !root.querySelector(bodies)) {
            for (const item of textLinks(root)) {
                add(networkUrl(item.url), item.mediaType);
            }
        }
        for (const el of Array.from(root.querySelectorAll('a[href], img, video, iframe'))) {
            if (el.closest(chrome)) {
                continue;
            }
            if (el instanceof HTMLImageElement) {
                if (/profile picture|avatar/i.test(el.alt)) {
                    continue;
                }
                const lazySet = el.getAttribute('data-srcset') || el.getAttribute('srcset') || '';
                const candidate = lazySet.split(',').pop()?.trim().split(/\s+/)[0];
                const url = networkUrl(el.getAttribute('data-src')) || networkUrl(el.currentSrc) || networkUrl(candidate || null) || networkUrl(el.getAttribute('src'));
                add(url, 'pictures');
            } else if (el instanceof HTMLVideoElement) {
                const sources = [el.currentSrc, el.getAttribute('src'), ...Array.from(el.querySelectorAll('source'), source => source.getAttribute('src'))];
                const playable = sources.map(networkUrl).find(Boolean);
                const post = el.closest(cards)?.querySelector<HTMLAnchorElement>(permalink);
                add(playable || networkUrl(post?.href || (/\/posts\/[^/]+/.test(location.pathname) ? location.href : null)), 'video');
            } else if (el instanceof HTMLIFrameElement) {
                const url = networkUrl(el.getAttribute('src') || el.getAttribute('data-src'));
                if (url) {
                    const player = /(^|\.)(youtube(?:-nocookie)?\.com|youtu\.be|vimeo\.com|mux\.com|sproutvideo\.com|dailymotion\.com)$/.test(url.hostname);
                    add(url, player ? 'video' : 'link');
                }
            } else if (el instanceof HTMLAnchorElement) {
                const url = networkUrl(el.getAttribute('href'));
                if (!url || (!el.closest(bodies) && (el.matches('[rel="author"]') || el.closest('[data-tag*="author" i], [data-tag*="creator" i]')))) {
                    continue;
                }
                add(url, linkedMedia(url, el.download));
            }
        }
    }
    const items = Array.from(found, ([url, mediaType]) => ({url, mediaType}));
    return {items, postIds, scrollTarget};
}
