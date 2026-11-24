import type {CollectedItem, BookmarkMedia} from '../../hooks/useCollections';
import {linkedMedia, networkUrl, textLinks} from './scan';

type ResourceRef = {id: string; type: string};
type Relationship = {data?: ResourceRef | ResourceRef[] | null};
type PostAttributes = {
    current_user_can_view?: boolean;
    content?: string;
    post_type?: string;
    post_file?: {url?: string; name?: string};
    embed?: {url?: string};
};
type MediaResource = ResourceRef & {
    attributes: {
        download_url?: string;
        image_urls?: {original?: string; default?: string};
        file_name?: string;
        mimetype?: string;
        url?: string;
        name?: string;
    };
};
type PostResponse = {
    data: {id: string; attributes: PostAttributes; relationships?: Record<string, Relationship>};
    included?: MediaResource[];
};

export class PostRateLimitError extends Error {}

// Compact cards can omit most of a gallery and truncate the post body. Ask for
// that post in the current tab's session before treating its preview as complete.
export async function readPost(id: string, signal: AbortSignal): Promise<CollectedItem[]> {
    const endpoint = new URL(`/api/posts/${id}`, location.origin);
    endpoint.searchParams.set('include', 'images,attachments,attachments_media');
    endpoint.searchParams.set('fields[post]', 'current_user_can_view,content,embed,post_type,post_file');
    endpoint.searchParams.set('json-api-version', '1.0');
    const response = await fetch(endpoint, {signal, credentials: 'same-origin'});
    if ([403, 404].includes(response.status)) {
        return [];
    }
    if (response.status === 429) {
        throw new PostRateLimitError();
    }
    if (!response.ok) {
        throw new Error(`Post request returned ${response.status}`);
    }
    const {data, included = []} = await response.json() as PostResponse;
    if (data?.id !== id || !data.attributes?.current_user_can_view) {
        return [];
    }

    const items: CollectedItem[] = [];
    function add(raw: string | undefined | null, mediaType?: BookmarkMedia, filename?: string) {
        const url = networkUrl(raw ?? null);
        if (url) {
            items.push({url: url.href, mediaType: mediaType ?? linkedMedia(url, filename)});
        }
    }

    const {content, embed, post_file, post_type} = data.attributes;
    const resources = new Map(included.map(resource => [`${resource.type}/${resource.id}`, resource]));
    for (const name of ['images', 'attachments', 'attachments_media']) {
        const refs = data.relationships?.[name]?.data;
        for (const ref of Array.isArray(refs) ? refs : refs ? [refs] : []) {
            const media = resources.get(`${ref.type}/${ref.id}`)?.attributes;
            if (media) {
                const isImage = name === 'images' || media.mimetype?.startsWith('image/');
                const type = isImage ? 'pictures' : media.mimetype?.startsWith('video/') ? 'video' : undefined;
                add(media.image_urls?.original || media.download_url || media.url || media.image_urls?.default, type, media.file_name || media.name);
            }
        }
    }
    add(post_file?.url, post_type === 'video_external_file' || post_type === 'video' ? 'video' : undefined, post_file?.name);
    add(embed?.url, post_type?.includes('video') ? 'video' : undefined);
    if (!post_file?.url && !embed?.url && post_type?.includes('video')) {
        add(new URL(`/posts/${id}`, location.origin).href, 'video');
    }
    if (content) {
        const template = document.createElement('template');
        template.innerHTML = content;
        items.push(...textLinks(template.content));
        template.content.querySelectorAll('a[href], img[src], video[src], video source[src]').forEach(element => {
            if (element.tagName === 'A') {
                add(element.getAttribute('href'));
            } else {
                add(element.getAttribute('src'), element.tagName === 'IMG' ? 'pictures' : 'video');
            }
        });
    }
    return items;
}
