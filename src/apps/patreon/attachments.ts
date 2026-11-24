import type {Bookmark} from '../../hooks/useCollections';

// Patreon file endpoints can redirect through the member's browser session to a
// signed CDN URL. Resolve those redirects at export time, while keeping the
// original bookmark in storage so a later export can refresh the signature.
export async function resolvePatreonAttachments(bookmarks: Bookmark[]): Promise<Map<string, string>> {
    const urls = new Set(bookmarks.filter(bookmark => bookmark.platform === 'patreon').map(bookmark => bookmark.url));
    const pending = Array.from(urls).filter(raw => {
        const url = new URL(raw);
        return url.protocol === 'https:' && /^(www\.)?patreon\.com$/.test(url.hostname) && url.pathname === '/file' && url.searchParams.has('h');
    });
    const resolved = new Map<string, string>();
    async function resolveNext() {
        for (let raw = pending.pop(); raw; raw = pending.pop()) {
            const controller = new AbortController();
            const timeout = window.setTimeout(() => controller.abort(), 10000);
            try {
                const result = await fetch(raw, {method: 'HEAD', credentials: 'include', signal: controller.signal});
                if (result.ok && result.redirected && result.url.startsWith('https://') && !result.headers.get('content-type')?.includes('text/html')) {
                    resolved.set(raw, result.url);
                }
            } catch {
                // Keep the posted address when the server does not support HEAD.
            } finally {
                window.clearTimeout(timeout);
            }
        }
    }
    await Promise.all(Array.from({length: Math.min(4, pending.length)}, resolveNext));
    return resolved;
}
