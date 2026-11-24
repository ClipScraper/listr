import type {CollectedItem, BookmarkMedia} from '../../hooks/useCollections';

export function isPatreonUrl(value: string): boolean {
    try {
        const url = new URL(value);
        return url.protocol === 'https:' && /(^|\.)patreon\.com$/.test(url.hostname);
    } catch {
        return false;
    }
}

export function patreonCollectionName(value: string): string {
    const url = new URL(value);
    const collection = url.pathname.match(/\/collections?\/([^/]+)/)?.[1] || url.searchParams.get('collection_id') || url.searchParams.get('collection');
    if (collection) {
        return `Collection ${collection}`;
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

const cards = 'article, [data-tag="post-card"], [data-testid="post-card"], [data-tag="post"]';
const bodies = '[data-tag^="post-content"], [data-testid="post-content"], [data-tag="post-body"], [data-tag="post-attachments"]';
const chrome = 'nav, aside, header, footer, [role="navigation"], [data-tag*="comment" i], [data-testid*="comment" i], [data-tag*="avatar" i], [data-tag*="post-header" i], [data-tag*="post-footer" i], [data-tag*="recommend" i]';
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

export function visiblePostIds(): Set<string> {
    const ids = new Set<string>();
    const current = location.pathname.match(/\/posts\/(?:[^/]+-)?(\d+)\/?$/)?.[1];
    if (current) {
        return new Set([current]);
    }
    const candidates: string[] = [];
    document.querySelectorAll<HTMLAnchorElement>(permalink).forEach(anchor => {
        if (!anchor.closest(chrome) && !anchor.closest(bodies)) {
            candidates.push(anchor.href);
        }
    });
    for (const candidate of candidates) {
        if (isPatreonUrl(candidate)) {
            const id = new URL(candidate).pathname.match(/\/posts\/(?:[^/]+-)?(\d+)\/?$/)?.[1];
            if (id) {
                ids.add(id);
            }
        }
    }
    return ids;
}

export function scanPatreonPosts(): CollectedItem[] {
    const found = new Map<string, BookmarkMedia>();
    function add(url: URL | undefined, media: BookmarkMedia) {
        if (url && (!found.has(url.href) || found.get(url.href) === 'link')) {
            found.set(url.href, media);
        }
    }

    const roots = new Set(document.querySelectorAll<Element>(`${cards}, ${bodies}`));
    if (!roots.size && /\/posts\/[^/]+/.test(location.pathname)) {
        const main = document.querySelector('main, [role="main"]');
        if (main) {
            roots.add(main);
        }
    }

    // Compact collection tiles sometimes expose only a linked cover and post permalink.
    if (/\/collections?\//.test(location.pathname) || /[?&]collection(?:_id)?=/.test(location.search)) {
        document.querySelectorAll<HTMLAnchorElement>(permalink).forEach(anchor => {
            if (!anchor.closest(chrome) && !anchor.closest(cards)) {
                roots.add(anchor);
                const url = networkUrl(anchor.href);
                if (url && isPatreonUrl(url.href)) {
                    add(url, 'link');
                }
            }
        });
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
    return Array.from(found, ([url, mediaType]) => ({url, mediaType}));
}
