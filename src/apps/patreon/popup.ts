import type {CollectedItem} from '../../hooks/useCollections';
import {useEffect, useRef, useState} from 'react';
import browser from 'webextension-polyfill';
import {patreonCollectionName} from './scan';
import {ScrollStatus} from '../../hooks/useScrolling';

type CaptureUpdate = {items?: CollectedItem[]; remaining?: number; complete?: boolean; count?: number; previewOnly?: boolean};
type SaveItems = (name: string, items: CollectedItem[]) => void;

type PatreonCapture = {
    start: () => Promise<void>;
    cancel: () => void;
    toggle: () => void;
    status: ScrollStatus;
    remaining: number;
    notice: string;
};

export function usePatreonCapture(url: string, wait: number, saveItems: SaveItems): PatreonCapture {
    const connection = useRef<browser.Runtime.Port | null>(null);
    const [status, setStatus] = useState<ScrollStatus>('idle');
    const [remaining, setRemaining] = useState(0);
    const [notice, setNotice] = useState('');

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
        const name = patreonCollectionName(url);
        const port = browser.tabs.connect(tab.id, {name: 'patreon-collection'});
        connection.current = port;
        port.onMessage.addListener(raw => {
            const message = raw as CaptureUpdate;
            if (message.items?.length) {
                saveItems(name, message.items);
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

    return {start, cancel, toggle, status, remaining, notice};
}
