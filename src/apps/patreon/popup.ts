import type {CollectedItem} from '../../hooks/useCollections';
import {useEffect, useRef, useState} from 'react';
import browser from 'webextension-polyfill';
import {collectionId, isPatreonUrl, listingCollectionId, patreonCollectionName} from './scan';
import {ScrollStatus} from '../../hooks/useScrolling';

type CaptureUpdate = {collectionTitle?: string; collectionCreator?: string; items?: CollectedItem[]; remaining?: number; complete?: boolean; count?: number; previewOnly?: boolean};
type CaptureCollection = {key: string; label: string; id?: string; creator?: string};
type SaveItems = (collection: CaptureCollection, items: CollectedItem[]) => void;

type PatreonCapture = {
    start: () => Promise<void>;
    cancel: () => void;
    toggle: () => void;
    status: ScrollStatus;
    remaining: number;
    label: string;
    notice: string;
};

export function usePatreonCapture(url: string, wait: number, savedLabel: string | undefined, saveItems: SaveItems): PatreonCapture {
    const connection = useRef<browser.Runtime.Port | null>(null);
    const [status, setStatus] = useState<ScrollStatus>('idle');
    const [remaining, setRemaining] = useState(0);
    const [notice, setNotice] = useState('');
    const [coverTitle, setCoverTitle] = useState('');
    const label = isPatreonUrl(url) ? (coverTitle ? patreonCollectionName(url, coverTitle) : savedLabel || patreonCollectionName(url)) : '';

    useEffect(() => {
        let active = true;
        setCoverTitle('');
        if (isPatreonUrl(url) && listingCollectionId(new URL(url))) {
            browser.tabs.query({active: true, currentWindow: true}).then(async ([tab]) => {
                if (tab?.id != null && tab.url === url) {
                    const title = await browser.tabs.sendMessage(tab.id, {action: 'patreonCollectionTitle', url});
                    if (active && typeof title === 'string' && title) {
                        setCoverTitle(title);
                    }
                }
            }).catch(() => {});
        }
        return () => { active = false; };
    }, [url]);

    function cancel() {
        connection.current?.disconnect();
        connection.current = null;
        setStatus('idle');
    }

    useEffect(() => () => connection.current?.disconnect(), [url]);

    async function start() {
        const [tab] = await browser.tabs.query({active: true, currentWindow: true});
        if (tab?.id == null || tab.url !== url || connection.current) {
            return;
        }
        const collection: CaptureCollection = {key: patreonCollectionName(url), label, id: collectionId(new URL(url)) ?? undefined};
        const port = browser.tabs.connect(tab.id, {name: 'patreon-collection'});
        connection.current = port;
        port.onMessage.addListener(raw => {
            const message = raw as CaptureUpdate;
            if (message.collectionTitle) {
                setCoverTitle(message.collectionTitle);
                collection.label = patreonCollectionName(url, message.collectionTitle);
            }
            if (message.collectionCreator) {
                collection.creator = message.collectionCreator;
            }
            if (message.items?.length || message.collectionTitle || message.collectionCreator) {
                saveItems(collection, message.items ?? []);
            }
            if (message.remaining !== undefined) {
                setRemaining(message.remaining);
            }
            if (message.complete) {
                const notice = message.count ? '' : 'No images, videos, or links found in the posts on this page.';
                setNotice(message.previewOnly ? 'Some post details were unavailable. Visible items were saved.' : notice);
                cancel();
            }
        });
        port.onDisconnect.addListener(() => {
            if (connection.current === port) {
                connection.current = null;
                setStatus('idle');
                setNotice('Capture stopped. Reopen the popup on the Patreon page to try again.');
            }
        });
        setStatus('scrolling');
        setNotice('');
        port.postMessage({action: 'start', wait});
    }

    function toggle() {
        const pause = status === 'scrolling';
        connection.current?.postMessage({action: pause ? 'pause' : 'resume'});
        setStatus(pause ? 'paused' : 'scrolling');
    }

    return {start, cancel, toggle, status, remaining, label, notice};
}
