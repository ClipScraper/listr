import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { Sun, Moon, Download, Ban, ListTodo, Play, Pause, Trash2, Plus, Settings, Lightbulb, MessageSquare } from 'lucide-react';
import browser from 'webextension-polyfill';
import { useActiveTab } from './hooks/useActiveTab';
import { useScrolling } from './hooks/useScrolling';
import { useSelectionMode } from './hooks/useSelectionMode';
import {useCollections} from './hooks/useCollections';
import type {CollectionMeta} from './hooks/useCollections';
import './styles/popup.css';
import {resolvePatreonAttachments} from './apps/patreon/attachments';
import {isPatreonUrl, patreonCollectionName, patreonFilenameLabel} from './apps/patreon/scan';
import {usePatreonCapture} from './apps/patreon/popup';
import {
  extractInstagramCollectionName,
  getInstagramPageTitle as igGetInstagramPageTitle,
  handleInstagramScrollAndCollect as iHandleInstagramScrollAndCollect,
  onInstagramScrollComplete as iOnInstagramScrollComplete,
} from './apps/instagram/popup';
import {
  getTiktokPageTitle as iGetTiktokPageTitle,
  collectTiktokFavoritesFlow,
  ActiveTikTokCollection,
  detectTiktokSectionOnActiveTab,
} from './apps/tiktok/popup';
import { getYouTubePageTitle } from './apps/youtube/popup';
import {
  getTwitterPageTitle,
  handleTwitterScrollAndCollect as handleTwitterScrollAndCollectFn,
  onTwitterScrollComplete as onTwitterScrollCompleteFn,
  isTwitterThreadPage,
  handleTwitterThreadDownload as handleTwitterThreadDownloadFn,
} from './apps/twitter/popup';

interface ContentScriptPingResponse {
  status: "pong";
}

// Helper: derive a Pinterest title just from the URL.
// We still ask the content script for the selected tab ONLY on the homepage.
function getPinterestPageTitleFromUrl(url: string): string {
  try {
    const u = new URL(url);
    if (!/pinterest\./.test(u.hostname)) return 'Pinterest';
    const segs = u.pathname.split('/').filter(Boolean);

    // Home
    if (segs.length === 0) return 'Pinterest';

    // Pin page
    if (segs[0] === 'pin' && segs[1]) {
      return `Pinterest pin - ${segs[1]}`;
    }

    // Search
    if (segs[0] === 'search' && segs[1] === 'pins') {
      const q = u.searchParams.get('q') || '';
      const query = q ? decodeURIComponent(q) : 'pins';
      return `Pinterest search - ${query}`;
    }

    // Board (also handles .../<board>/pins)
    if (segs.length >= 2) {
      const user = decodeURIComponent(segs[0]);
      const board = decodeURIComponent(segs[1]);
      return `Pinterest: ${user} - ${board}`;
    }

    // Profile
    if (segs.length === 1) {
      const user = decodeURIComponent(segs[0]);
      return `Pinterest profile - ${user}`;
    }

    return 'Pinterest';
  } catch {
    return 'Pinterest';
  }
}

// Function to ping the content script and check if it's active
async function pingContentScript(tabId: number): Promise<boolean> {
  try {
    const response = await browser.tabs.sendMessage(tabId, { action: "ping" }) as ContentScriptPingResponse;
    return response?.status === "pong";
  } catch (error) {
    console.warn("Content script not reachable (ping failed):", error);
    return false;
  }
}

const Popup: React.FC = () => {
  const { activeUrl } = useActiveTab();
  const { collectionStore, addBookmarksToCollection, deleteCollection, renameCollection, getAllCollections, ensureCollection, getCollectionMeta } = useCollections();
  const { isSelecting, startSelectionMode, validateSelection, cancelSelection } = useSelectionMode((urls) => addBookmarksToCollection('tiktok', 'selected_tiktok_links', urls));

  const [isDarkMode, setIsDarkMode] = React.useState(false);
  const toggleTheme = () => setIsDarkMode(prev => !prev);

  // TikTok section detection
  const [tiktokSectionState, setTiktokSectionState] = React.useState<{ username: string; section: string } | null>(null);
  const tiktokActiveCollectionRef = React.useRef<{ name: string; type: 'bookmarks' | 'favorites' | 'liked' | 'reposts' | 'profile'; handle: string } | null>(null);
  const youtubeCurrentCollection = React.useRef<string | null>(null);
  const tiktokPollIntervalRef = React.useRef<number | null>(null);

  /** NEW: Pinterest active collection ref */
  const pinterestActiveRef = React.useRef<{ name: string; type: 'bookmarks' | 'profile'; handle: string; mode: 'board' | 'moreIdeas' } | null>(null);

  /** Twitter active collection ref */
  const twitterActiveCollectionRef = React.useRef<{ name: string; handle: string; isThread?: boolean } | null>(null);

    const isPatreonDomain = isPatreonUrl(activeUrl);
  const isTikTokDomain = activeUrl.startsWith("https://www.tiktok.com");
  const isInstagramDomain = activeUrl.startsWith("https://www.instagram.com");
  const isYouTubeDomain = /^https:\/\/www\.youtube\./.test(activeUrl);
  const isPinterestDomain = /^https:\/\/(?:[^\/]+\.)?pinterest\./.test(activeUrl);
  const isTwitterDomain = /^https:\/\/(?:x\.com|twitter\.com|.*\.x\.com|.*\.twitter\.com)/.test(activeUrl);
  const isTwitterThread = React.useMemo(() => isTwitterThreadPage(activeUrl), [activeUrl]);

  // Detect homepage precisely
  const isPinterestRoot = React.useMemo(() => {
    try {
      const u = new URL(activeUrl);
      return isPinterestDomain && u.pathname === '/';
    } catch {
      return false;
    }
  }, [activeUrl, isPinterestDomain]);

  const pinterestBoardInfo = React.useMemo(() => {
    if (!isPinterestDomain) return null;
    try {
      const u = new URL(activeUrl);
      const segments = u.pathname.split('/').filter(Boolean);
      if (segments.length >= 2) {
        const [first, second] = segments;
        if (['pin', 'search', 'ideas', 'explore', 'topics'].includes(first)) {
          return null;
        }
        return {
          user: decodeURIComponent(first),
          board: decodeURIComponent(second),
        };
      }
      return null;
    } catch {
      return null;
    }
  }, [activeUrl, isPinterestDomain]);

  const isPinterestBoardPage = pinterestBoardInfo !== null;

  const isYouTubeVideoPage = isYouTubeDomain && activeUrl.includes('/watch?v=');
  const isYouTubePlaylistPage = isYouTubeDomain && activeUrl.includes('/playlist?list=');
  const isYouTubeChannelPage =
    isYouTubeDomain &&
    (activeUrl.includes('/videos') ||
      activeUrl.includes('/shorts') ||
      activeUrl.includes('/streams') ||
      /youtube\.com\/(user\/|@|channel\/)/.test(activeUrl));

  const [youTubeTitle, setYouTubeTitle] = React.useState<string>(() => getYouTubePageTitle(activeUrl));
  const [youTubeErrorMessage, setYouTubeErrorMessage] = React.useState<string>('');
  const [pinterestTitle, setPinterestTitle] = React.useState<string>('Pinterest');
  const [isSettingsOpen, setIsSettingsOpen] = React.useState<boolean>(false);
  const [editingCollection, setEditingCollection] = React.useState<{platform: string, collectionName: string} | null>(null);
  const [editingValue, setEditingValue] = React.useState<string>('');
  const [validateBeforeClear, setValidateBeforeClear] = React.useState<boolean>(true);
  const [scrollWaitTime, setScrollWaitTime] = React.useState<number>(3);
  const [downloadFormat, setDownloadFormat] = React.useState<'csv' | 'json'>('csv');
  const [twitterThreadAuthorOnly, setTwitterThreadAuthorOnly] = React.useState<boolean>(true);


  React.useEffect(() => {
    browser.storage.local.get(['validateBeforeClear', 'scrollWaitTime', 'downloadFormat', 'twitterThreadAuthorOnly']).then(result => {
      if (typeof result.validateBeforeClear === 'boolean') {
        setValidateBeforeClear(result.validateBeforeClear);
      }
      if (typeof result.scrollWaitTime === 'number') {
        setScrollWaitTime(result.scrollWaitTime);
      }
      if (result.downloadFormat === 'csv' || result.downloadFormat === 'json') {
        setDownloadFormat(result.downloadFormat);
      }
      if (typeof result.twitterThreadAuthorOnly === 'boolean') {
        setTwitterThreadAuthorOnly(result.twitterThreadAuthorOnly);
      }
    });
  }, []);

  const handleSetValidateBeforeClear = (value: boolean) => {
    setValidateBeforeClear(value);
    browser.storage.local.set({ validateBeforeClear: value });
  };

  const handleSetScrollWaitTime = (value: string) => {
    const num = parseInt(value, 10);
    if (!isNaN(num) && num >= 0) {
      setScrollWaitTime(num);
      browser.storage.local.set({ scrollWaitTime: num });
    }
  };

  const handleSetDownloadFormat = (value: string) => {
    if (value === 'csv' || value === 'json') {
      setDownloadFormat(value);
      browser.storage.local.set({ downloadFormat: value });
    }
  };

  const handleSetTwitterThreadAuthorOnly = (value: boolean) => {
    setTwitterThreadAuthorOnly(value);
    browser.storage.local.set({ twitterThreadAuthorOnly: value });
  };

  const onInstaCompleteCb = React.useCallback(() => iOnInstagramScrollComplete({
    activeUrl,
    isInstagramDomain,
    addBookmarksToCollection,
  }), [activeUrl, isInstagramDomain]);

  const onTwitterCompleteCb = React.useCallback(() => onTwitterScrollCompleteFn({
    activeUrl,
    isTwitterDomain,
    addBookmarksToCollection,
    activeCollectionName: twitterActiveCollectionRef.current?.name || null,
  }), [activeUrl, isTwitterDomain]);

  // Combined callback that handles both Instagram and Twitter
  const onScrollCompleteCb = React.useCallback(() => {
    if (isInstagramDomain) {
      onInstaCompleteCb();
    }
    if (isTwitterDomain && !twitterActiveCollectionRef.current?.isThread) {
      onTwitterCompleteCb();
    }
  }, [isInstagramDomain, isTwitterDomain, onInstaCompleteCb, onTwitterCompleteCb]);

    const scrolling = useScrolling(onScrollCompleteCb);
    const {startScrolling, startInstagramScrolling, startYouTubeScrolling, cancelScrolling} = scrolling;
    const savedPatreonLabel = isPatreonDomain ? getCollectionMeta('patreon', patreonCollectionName(activeUrl))?.handle : undefined;
    const patreon = usePatreonCapture(activeUrl, scrollWaitTime, savedPatreonLabel, ({key, label, id}, items) => {
        addBookmarksToCollection('patreon', key, items, {type: 'collection', handle: label, patreonCollectionId: id});
    });
    const scrollStatus = isPatreonDomain ? patreon.status : scrolling.scrollStatus;
    const timeRemaining = isPatreonDomain ? patreon.remaining : scrolling.timeRemaining;
    const stopResumeScrolling = isPatreonDomain ? patreon.toggle : scrolling.stopResumeScrolling;

  React.useEffect(() => {
    if (!isTikTokDomain) {
      setTiktokSectionState(null);
      return;
    }
    detectTiktokSectionOnActiveTab()
      .then(res => { if (res) setTiktokSectionState(res as any); })
      .catch(() => {});
  }, [activeUrl]);

  // Pinterest: compute a title on *all* pages, and only on "/" try to enrich with the selected tab label.
  React.useEffect(() => {
    if (!isPinterestDomain) {
      setPinterestTitle('Pinterest');
      return;
    }

    const base = getPinterestPageTitleFromUrl(activeUrl);

    if (!isPinterestRoot) {
      setPinterestTitle(base);
      return;
    }

    (async () => {
      try {
        const tabs = await browser.tabs.query({ active: true, currentWindow: true });
        const tabId = tabs[0]?.id;
        if (!tabId) {
          setPinterestTitle(base);
          return;
        }
        const res = await browser.tabs.sendMessage(tabId, { action: 'pinterestGetSection' }).catch(() => null) as any;
        const section = (res?.section || '').trim();
        if (section) {
          setPinterestTitle(`Pinterest - ${section}`);
        } else {
          setPinterestTitle(base);
        }
      } catch {
        setPinterestTitle(base);
      }
    })();
  }, [activeUrl, isPinterestDomain, isPinterestRoot]);

  // --- listen for pushes from the YouTube content script
  React.useEffect(() => {
    const onMsg = (message: any) => {
      if (message?.type === 'ytChannelInfoPush') {
        const info = message.payload || {};
        const name = (info.name || '').trim();
        const handle = (info.handle || '').trim();
        if (name) {
          setYouTubeTitle(`YouTube Channel: ${name}`);
        } else if (handle) {
          setYouTubeTitle(`YouTube Channel: ${handle}`);
        }
      }
    };
    browser.runtime.onMessage.addListener(onMsg);
    return () => browser.runtime.onMessage.removeListener(onMsg);
  }, []);

  // Request YouTube channel info whenever we open the popup on a YouTube page
  React.useEffect(() => {
    if (!isYouTubeDomain) return;

    (async () => {
      try {
        const tabs = await browser.tabs.query({ active: true, currentWindow: true });
        const tabId = tabs[0]?.id;
        if (tabId == null) {
          setYouTubeTitle(getYouTubePageTitle(activeUrl));
          return;
        }
        const res = await browser.tabs.sendMessage(tabId, { action: 'ytGetChannelInfo' })
          .catch(() => null) as any;

        const name = (res?.name || '').trim();
        const handle = (res?.handle || '').trim();

        if (name) {
          setYouTubeTitle(`YouTube Channel: ${name}`);
        } else if (handle) {
          setYouTubeTitle(`YouTube Channel: ${handle}`);
        } else {
          setYouTubeTitle(getYouTubePageTitle(activeUrl));
        }
      } catch {
        setYouTubeTitle(getYouTubePageTitle(activeUrl));
      }
    })();
  }, [activeUrl, isYouTubeDomain]);

  // While scrolling on TikTok, poll periodically for newly found links
  React.useEffect(() => {
    if (!isTikTokDomain || !tiktokActiveCollectionRef.current) {
      if (tiktokPollIntervalRef.current) {
        window.clearInterval(tiktokPollIntervalRef.current);
        tiktokPollIntervalRef.current = null;
      }
      return;
    }
    if (scrollStatus === 'idle') {
      if (tiktokPollIntervalRef.current) {
        window.clearInterval(tiktokPollIntervalRef.current);
        tiktokPollIntervalRef.current = null;
      }
      return;
    }
    if (tiktokPollIntervalRef.current) return;
    tiktokPollIntervalRef.current = window.setInterval(async () => {
      try {
        const tabs = await browser.tabs.query({ active: true, currentWindow: true });
        const tabId = tabs[0]?.id;
        if (tabId == null) return;
        const response = await browser.tabs.sendMessage(tabId, { action: 'collectTiktokFavoritesLinks' }).catch(() => null) as any;
        const links = (response?.links || []) as string[];
        const active = tiktokActiveCollectionRef.current;
        if (!active || !links || links.length === 0) return;
        ensureCollection('tiktok', active.name, { type: active.type, handle: active.handle });
        addBookmarksToCollection('tiktok', active.name, links);
      } catch {}
    }, 1500);
    return () => {
      if (tiktokPollIntervalRef.current) {
        window.clearInterval(tiktokPollIntervalRef.current);
        tiktokPollIntervalRef.current = null;
      }
    };
  }, [scrollStatus, isTikTokDomain]);

  // Clear YouTube error message when URL changes or collections exist
  React.useEffect(() => {
    if (youTubeErrorMessage && (Object.keys(getAllCollections()).length > 0 || !isYouTubeDomain)) {
      setYouTubeErrorMessage('');
    }
  }, [activeUrl, getAllCollections, isYouTubeDomain, youTubeErrorMessage]);

  React.useEffect(() => {
    const handler = (message: any) => {
      if (message.type === 'instaNewLinks') {
        if (!isInstagramDomain) return;
        let collectionName = extractInstagramCollectionName(activeUrl);
        if (activeUrl.includes('/saved/all-posts/')) {
          collectionName = 'all-posts';
        }
        const links: string[] = message.links || [];
        if (links.length > 0) {
          addBookmarksToCollection('instagram', collectionName, links);
        }
      }
      if (message.type === 'tiktokNewLinks') {
        if (!isTikTokDomain) return;
        const links: string[] = message.links || [];
        if (links.length === 0) return;
        const active = tiktokActiveCollectionRef.current;
        if (active) {
          ensureCollection('tiktok', active.name, { type: active.type, handle: active.handle });
          addBookmarksToCollection('tiktok', active.name, links);
          return;
        }
        const usernameMatch = activeUrl.match(/https:\/\/www\.tiktok\.com\/@([^/]+)/);
        const username = usernameMatch?.[1] || 'unsorted';
        const fallbackName = `${username}_profile`;
        ensureCollection('tiktok', fallbackName, { type: 'profile', handle: username });
        addBookmarksToCollection('tiktok', fallbackName, links);
      }
      if (message.type === 'youtubeNewLinks') {
        if (!isYouTubeDomain) return;
        const links: string[] = message.links || [];
        if (links.length > 0) {
          (async () => {
            try {
              if (isYouTubePlaylistPage) {
                const tabs = await browser.tabs.query({ active: true, currentWindow: true });
                const tabId = tabs[0]?.id;
                if (!tabId) return;

                const res = await browser.tabs.sendMessage(tabId, { action: 'ytGetPlaylistInfo' }) as { playlistName: string };
                const playlistName = res?.playlistName.trim();
                if (playlistName) {
                  const collectionName = `${playlistName}_playlist`;
                  addBookmarksToCollection('youtube', collectionName, links);
                }
              } else if (youtubeCurrentCollection.current) {
                addBookmarksToCollection('youtube', youtubeCurrentCollection.current, links);
              }
            } catch {}
          })();
        }
      }

      /** Pinterest incremental push */
      if (message.type === 'pinterestNewLinks') {
        if (!isPinterestDomain) return;
        const links: string[] = message.links || [];
        if (links.length === 0) return;

        const active = pinterestActiveRef.current;
        const mode: 'board' | 'moreIdeas' = message.mode === 'moreIdeas' ? 'moreIdeas' : 'board';
        if (active && active.mode === mode) {
          ensureCollection('pinterest', active.name, { type: active.type, handle: active.handle });
          addBookmarksToCollection('pinterest', active.name, links);
          return;
        }
        if (mode === 'moreIdeas') {
          const fallbackName = pinterestBoardInfo
            ? `${pinterestBoardInfo.user}_${pinterestBoardInfo.board}_more_ideas`
            : 'pinterest_more_ideas';
          const fallbackHandle = pinterestBoardInfo
            ? `${pinterestBoardInfo.user} - ${pinterestBoardInfo.board} (more ideas)`
            : 'Pinterest (more ideas)';
          ensureCollection('pinterest', fallbackName, { type: 'profile', handle: fallbackHandle });
          addBookmarksToCollection('pinterest', fallbackName, links);
          return;
        }
        ensureCollection('pinterest', 'pinterest_page', { type: 'profile', handle: 'Pinterest' });
        addBookmarksToCollection('pinterest', 'pinterest_page', links);
      }

      /** Twitter incremental push (regular scanner — skip when a thread collection is active) */
      if (message.type === 'twitterNewLinks') {
        if (!isTwitterDomain) return;
        const active = twitterActiveCollectionRef.current;
        if (active?.isThread) return; // thread collection uses twitterThreadNewLinks instead
        const items: Array<{ url: string; userHandle: string; userName: string; text: string }> = message.items || [];
        if (items.length === 0) return;
        const collectionName = active?.name || 'Bookmarks';
        const handle = active?.handle || 'Bookmarks';
        ensureCollection('twitter', collectionName, { type: 'bookmarks', handle });
        addBookmarksToCollection('twitter', collectionName, items.map(item => item.url));
      }

      /** Twitter thread incremental push */
      if (message.type === 'twitterThreadNewLinks') {
        if (!isTwitterDomain) return;
        const items: Array<{ url: string; userHandle: string; userName: string; text: string }> = message.items || [];
        if (items.length === 0) return;
        const active = twitterActiveCollectionRef.current;
        if (active) {
          addBookmarksToCollection('twitter', active.name, items.map(item => item.url));
        }
      }
    };
    browser.runtime.onMessage.addListener(handler);
    return () => browser.runtime.onMessage.removeListener(handler);
    }, [activeUrl, isPinterestDomain, isTikTokDomain, isInstagramDomain, isYouTubeDomain, isTwitterDomain, isTwitterThread, isYouTubePlaylistPage, pinterestBoardInfo]);

  const handleBookmarkAll = () => {
    browser.tabs.query({ active: true, currentWindow: true })
      .then(tabs => {
        const tabId = tabs[0]?.id;
        if (tabId != null) {
          return browser.tabs.sendMessage(tabId, { action: "collectAllVideoLinks" });
        }
      })
      .then(response => {
        if (!response) return;
        const res = response as { links: string[] };
        if (res.links) {
          addBookmarksToCollection('tiktok', 'all_tiktok_links', res.links);
        }
      })
      .catch(err => console.error("Error collecting video links:", err));
  };

  const handleCollectTiktokFavorites = React.useCallback(async () => {
    await collectTiktokFavoritesFlow({
      activeUrl,
      ensureCollection: (platform, name, meta) => ensureCollection(platform, name, meta as any),
      addBookmarksToCollection,
      setActiveCollection: (active: ActiveTikTokCollection | null) => { tiktokActiveCollectionRef.current = active; },
      pingContentScript,
      scrollStatus,
      startScrolling: () => startScrolling(scrollWaitTime),
    });
  }, [activeUrl, ensureCollection, addBookmarksToCollection, pingContentScript, scrollStatus, startScrolling, scrollWaitTime]);

  /** Pinterest list button handlers */
  const triggerPinterestCollection = React.useCallback(async (mode: 'board' | 'moreIdeas') => {
    try {
      const tabs = await browser.tabs.query({ active: true, currentWindow: true });
      const tabId = tabs[0]?.id ?? null;
      const u = new URL(activeUrl);
      let collectionName = 'pinterest_page';
      let handle = 'Pinterest';
      let type: 'bookmarks' | 'profile' = 'profile';
      let isBoardContext = pinterestBoardInfo != null;

      // 1) /search/pins?q=... (handle this BEFORE the generic 2-segment matcher)
      if (u.pathname.startsWith('/search/pins')) {
        if (mode === 'moreIdeas') {
          console.warn('Pinterest "Find more ideas" collection is only available on board pages.');
          return;
        }
        const q = (u.searchParams.get('q') || '').trim();
        if (q) {
          collectionName = `search_${q}`;
          handle = `Search - ${q}`;
        } else {
          collectionName = 'search_pins';
          handle = 'Search - pins';
        }
        type = 'profile';

      // 2) Single pin
      } else if (/^\/pin\/(\d+)/.test(u.pathname)) {
        if (mode === 'moreIdeas') {
          console.warn('Pinterest "Find more ideas" collection is only available on board pages.');
          return;
        }
        const id = (u.pathname.match(/^\/pin\/(\d+)/) || [, ''])[1];
        collectionName = `pin_${id}`;
        handle = `Pin ${id}`;
        type = 'bookmarks';

      // 3) Board: /{user}/{board} (runs after search so it won't swallow it)
      } else if (pinterestBoardInfo) {
        const { user, board } = pinterestBoardInfo;
        collectionName = `${user}_${board}`;
        handle = `${user} - ${board}`;
        type = 'profile';
        isBoardContext = true;

      // 4) Home: include selected section if available
      } else if (u.pathname === '/') {
        try {
          const res: any = tabId
            ? await browser.tabs.sendMessage(tabId, { action: 'pinterestGetSection' }).catch(() => null)
            : null;
          const section = (res && typeof res.section === 'string') ? res.section.trim() : '';
          if (section) {
            collectionName = `home_${section}`;
            handle = section;
          } else {
            collectionName = 'home';
            handle = 'Home';
          }
        } catch {
          collectionName = 'home';
          handle = 'Home';
        }
      } else {
        if (mode === 'moreIdeas') {
          console.warn('Pinterest "Find more ideas" collection is only available on board pages.');
          return;
        }
      }

      if (mode === 'moreIdeas') {
        if (!isBoardContext || !pinterestBoardInfo) {
          console.warn('Pinterest "Find more ideas" collection requires a board context.');
          return;
        }
        collectionName = `${collectionName}_more_ideas`;
        handle = `${handle} (more ideas)`;
      }

      // Ensure meta row and start incremental collection
      pinterestActiveRef.current = { name: collectionName, type, handle, mode };
      ensureCollection('pinterest', collectionName, { type, handle });

      if (tabId) {
        await browser.tabs.sendMessage(tabId, { action: 'setPinterestMode', mode }).catch(() => null);
        await browser.tabs.sendMessage(tabId, { action: 'resetPinterestState', scope: 'all' }).catch(() => null);
      }
      startScrolling(scrollWaitTime);
    } catch (e) {
      console.error('Error starting Pinterest collection:', e);
    }
  }, [activeUrl, ensureCollection, pinterestBoardInfo, startScrolling, scrollWaitTime]);

  const handleCollectPinterestPins = React.useCallback(() => {
    void triggerPinterestCollection('board');
  }, [triggerPinterestCollection]);

  const handleCollectPinterestMoreIdeas = React.useCallback(() => {
    void triggerPinterestCollection('moreIdeas');
  }, [triggerPinterestCollection]);

  const handleCancelListing = () => {
    if (isPatreonDomain) {
        patreon.cancel();
        return;
    }
    cancelScrolling();
    tiktokActiveCollectionRef.current = null;
    pinterestActiveRef.current = null;
    twitterActiveCollectionRef.current = null;
    if (isPinterestDomain) {
      browser.tabs.query({ active: true, currentWindow: true })
        .then(tabs => {
          const tabId = tabs[0]?.id;
          if (tabId == null) return;
          return browser.tabs.sendMessage(tabId, { action: 'setPinterestMode', mode: 'inactive' }).catch(() => null);
        })
        .catch(() => {});
    }
    if (tiktokPollIntervalRef.current) {
      window.clearInterval(tiktokPollIntervalRef.current);
      tiktokPollIntervalRef.current = null;
    }
  };

  const startEditingCollection = (platform: string, collectionName: string) => {
    setEditingCollection({ platform, collectionName });
    const meta = getCollectionMeta(platform, collectionName);
    setEditingValue(meta?.patreonCollectionId ? meta.handle : collectionName);
  };

  const saveCollectionEdit = () => {
    if (editingCollection && editingValue.trim()) {
      renameCollection(editingCollection.platform, editingCollection.collectionName, editingValue.trim());
    }
    setEditingCollection(null);
    setEditingValue('');
  };

  const cancelCollectionEdit = () => {
    setEditingCollection(null);
    setEditingValue('');
  };

  const handleEditKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      saveCollectionEdit();
    } else if (e.key === 'Escape') {
      cancelCollectionEdit();
    }
  };

  // CSV helpers
  const escapeCsv = (value: string) => {
    const needsQuotes = /[",\r\n]/.test(value);
    const escaped = value.replace(/"/g, '""');
    return needsQuotes ? `"${escaped}"` : escaped;
  };

  const inferMediaType = (platform: string, url: string): 'video' | 'pictures' | 'unknown' => {
    if (platform === 'instagram') {
      if (/\/reel\//.test(url)) return 'video';
      if (/\/p\//.test(url)) return 'pictures';
      return 'unknown';
    }
    if (platform === 'tiktok') {
      if(/\/photo\//.test(url)) return 'pictures';
      return 'video';
    }
    if (platform === 'youtube') {
      return 'video';
    }
    if (platform === 'pinterest') {
      return 'pictures';
    }
    if (platform === 'twitter') {
      return 'unknown';
    }
    return 'unknown';
  };

  const handleInstagramScrollAndCollect = React.useCallback(() => iHandleInstagramScrollAndCollect({
    activeUrl,
    ensureCollection,
    startInstagramScrolling: () => startInstagramScrolling(scrollWaitTime),
    pingContentScript,
  }), [activeUrl, ensureCollection, startInstagramScrolling, scrollWaitTime]);

  const handleTwitterScrollAndCollect = React.useCallback(() => handleTwitterScrollAndCollectFn({
    activeUrl,
    ensureCollection,
    addBookmarksToCollection,
    startScrolling: () => startScrolling(scrollWaitTime),
    pingContentScript,
    setActiveCollection: (info) => { twitterActiveCollectionRef.current = info ? { ...info, isThread: false } : null; },
  }), [activeUrl, ensureCollection, addBookmarksToCollection, startScrolling, scrollWaitTime]);

  const handleTwitterThreadDownload = React.useCallback(() => handleTwitterThreadDownloadFn({
    activeUrl,
    ensureCollection,
    addBookmarksToCollection,
    startScrolling: () => startScrolling(scrollWaitTime),
    pingContentScript,
    setActiveCollection: (info) => { twitterActiveCollectionRef.current = info ? { ...info, isThread: true } : null; },
    authorOnly: twitterThreadAuthorOnly,
  }), [activeUrl, ensureCollection, addBookmarksToCollection, startScrolling, scrollWaitTime, twitterThreadAuthorOnly]);

  const handleYouTubeAddVideo = async () => {
    try {
      const tabs = await browser.tabs.query({ active: true, currentWindow: true });
      const tabId = tabs[0]?.id;
      if (!tabId) return;

      const res = await browser.tabs.sendMessage(tabId, { action: 'ytGetChannelInfo' }) as { name: string; handle: string };
      const channelName = (res?.name || res?.handle || '').trim();

      if (!channelName) {
        setYouTubeErrorMessage("Could not determine the channel for this video.");
        return;
      }

      const collectionName = `${channelName}_videos`;
      ensureCollection('youtube', collectionName, { type: 'video', handle: channelName });
      addBookmarksToCollection('youtube', collectionName, [activeUrl]);

    } catch (err) {
      console.error("Error adding YouTube video:", err);
      setYouTubeErrorMessage("An error occurred while adding the video.");
    }
  };

  const handleYouTubeListVideos = async () => {
    setYouTubeErrorMessage('');

    if (isYouTubePlaylistPage) {
      try {
        const tabs = await browser.tabs.query({ active: true, currentWindow: true });
        const tabId = tabs[0]?.id;
        if (!tabId) return;

        const res = await browser.tabs.sendMessage(tabId, { action: 'ytGetPlaylistInfo' }) as { playlistName: string };
        const playlistName = res?.playlistName.trim();

        if (playlistName) {
          const collectionName = `${playlistName}_playlist`;
          ensureCollection('youtube', collectionName, { type: 'playlist', handle: playlistName });
        }
        startYouTubeScrolling(scrollWaitTime);
      } catch (err) {
        console.error("Error starting YouTube playlist scroll:", err);
      }
      return;
    }

    if (isYouTubeChannelPage) {
      try {
        const tabs = await browser.tabs.query({ active: true, currentWindow: true });
        const tabId = tabs[0]?.id;
        if (!tabId) return;
        
        const res = await browser.tabs.sendMessage(tabId, { action: 'ytGetChannelInfo' }) as { name: string; handle: string };
        const channelName = (res?.name || res?.handle || '').trim();

        if (channelName) {
          const collectionName = `${channelName}_videos`;
          ensureCollection('youtube', collectionName, { type: 'profile', handle: channelName });
          youtubeCurrentCollection.current = collectionName;
        }
        startYouTubeScrolling(scrollWaitTime);
      } catch (err) {
        console.error("Error starting YouTube channel scroll:", err);
      }
      return;
    }

    try {
      const tabs = await browser.tabs.query({ active: true, currentWindow: true });
      const tabId = tabs[0]?.id;
      if (tabId == null) {
        console.warn('Could not get active tab ID.');
        return;
      }

      const response: { videos: { url: string; title: string }[], channelName?: string } =
        await browser.tabs.sendMessage(tabId, { action: 'youtube_scrapeVideos' });

      if (response && response.videos) {
        const { videos, channelName } = response;
        if (videos.length === 0) {
          setYouTubeErrorMessage('No videos found on the page.');
          return;
        }

        setYouTubeErrorMessage('');
        const handle = channelName || 'profile';
        const collectionName = channelName ? `${handle}_videos` : 'youtube_recommendations';
        ensureCollection('youtube', collectionName, { type: 'recommendation', handle });
        addBookmarksToCollection('youtube', collectionName, videos.map(v => v.url));
      } else {
        setYouTubeErrorMessage('Could not retrieve videos from the page.');
      }
    } catch (err) {
      console.error('Error listing YouTube videos:', err);
      setYouTubeErrorMessage('An error occurred while listing videos.');
    }
  };

  const downloadCollection = async (platform: string, collectionName: string) => {
    const collectionsByPlatform = collectionStore.collections[platform];
    if (!collectionsByPlatform) return;

    const bookmarks = collectionsByPlatform[collectionName];
    if (!bookmarks || bookmarks.length === 0) {
      alert("No links to download for this collection.");
      return;
    }

    const resolved = await resolvePatreonAttachments(bookmarks);
    const meta: CollectionMeta = getCollectionMeta(platform, collectionName) || {type: 'profile', handle: collectionName};
    const exportName = meta.patreonCollectionId ? meta.handle : collectionName;
    const fileLabel = platform === 'patreon' ? patreonFilenameLabel(exportName, meta.patreonCollectionId) : collectionName;
    const filename = `${platform}.${fileLabel}.data.${downloadFormat}`;
    let blob: Blob;

    if (downloadFormat === 'json') {
      const jsonData = {
        platform,
        collectionName: exportName,
        meta,
        items: bookmarks.map(bm => ({
          url: bm.url,
          downloadUrl: resolved.get(bm.url),
          mediaType: bm.mediaType ?? inferMediaType(platform, bm.url),
        })),
      };
      blob = new Blob([JSON.stringify(jsonData, null, 2)], { type: "application/json;charset=utf-8;" });
    } else {
      const header = ["Platform", "Type", "Handle", "Media", "link"];
      const rows = bookmarks.map(bm => {
        const media = bm.mediaType ?? inferMediaType(platform, bm.url);
        return [platform, meta.type, meta.handle, media, resolved.get(bm.url) ?? bm.url];
      });
      const csvContent = [header, ...rows]
        .map(row => row.map(col => escapeCsv(String(col))).join(","))
        .join("\n");
      blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
    }
    
    const url = URL.createObjectURL(blob);
    browser.downloads.download({
      url: url,
      filename: filename,
      saveAs: true
    }).catch(err => console.error("Error downloading data:", err));
  };

  const downloadAllCollections = async () => {
    const all = collectionStore.collections;
    const platforms = Object.keys(all);
    if (platforms.length === 0) {
      alert("No links to download.");
      return;
    }

    const bookmarks = Object.values(all.patreon || {}).flat();
    const resolved = await resolvePatreonAttachments(bookmarks);
    const filename = `all-collections.data.${downloadFormat}`;
    let blob: Blob;

    if (downloadFormat === 'json') {
      const allData = [];
      for (const platform of platforms) {
        const platformCollections = all[platform];
        for (const collectionName of Object.keys(platformCollections)) {
          const bookmarks = platformCollections[collectionName] || [];
          const meta: CollectionMeta = getCollectionMeta(platform, collectionName) || {type: 'profile', handle: collectionName};
          allData.push({
            platform,
            collectionName: meta.patreonCollectionId ? meta.handle : collectionName,
            meta,
            items: bookmarks.map(bm => ({
              url: bm.url,
              downloadUrl: resolved.get(bm.url),
              mediaType: bm.mediaType ?? inferMediaType(platform, bm.url),
            })),
          });
        }
      }
      if (allData.length === 0) {
        alert("No links to download.");
        return;
      }
      blob = new Blob([JSON.stringify(allData, null, 2)], { type: "application/json;charset=utf-8;" });
    } else {
      const header = ["Platform", "Type", "Handle", "Media", "link"];
      const rows: string[][] = [];
      for (const platform of platforms) {
        const platformCollections = all[platform];
        for (const collectionName of Object.keys(platformCollections)) {
          const bookmarks = platformCollections[collectionName] || [];
          const meta: CollectionMeta = getCollectionMeta(platform, collectionName) || {type: 'profile', handle: collectionName};
          for (const bm of bookmarks) {
            const media = bm.mediaType ?? inferMediaType(platform, bm.url);
            rows.push([platform, String(meta.type), String(meta.handle), media, resolved.get(bm.url) ?? bm.url]);
          }
        }
      }
      if (rows.length === 0) {
        alert("No links to download.");
        return;
      }
      const csvContent = [header, ...rows]
        .map(row => row.map(col => escapeCsv(String(col))).join(","))
        .join("\n");
      blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
    }

    const url = URL.createObjectURL(blob);
    browser.downloads.download({
      url,
      filename,
      saveAs: true
    }).catch(err => console.error("Error downloading combined data:", err));
  };

  return (
    <div id="popup-theme" className={isDarkMode ? "dark" : ""}>
      <div id="popup-container" className="popup-container">
        <div id="popup-toolbar" className="top-row">
          {/* Platform indicator */}
          {isPatreonDomain ? (<img id="popup-current-patreon" src="assets/patreon.png" alt="Patreon" width={20} height={20} />
          ) : isInstagramDomain ? (<img id="popup-current-instagram" src="assets/instagram.webp" alt="Instagram" width={20} height={20} />
          ) : isTikTokDomain ? (<img id="popup-current-tiktok" src="assets/tiktok.webp" alt="TikTok" width={20} height={20} />
          ) : isYouTubeDomain ? (<img id="popup-current-youtube" src="assets/youtube.webp" alt="YouTube" width={20} height={20} />
          ) : isPinterestDomain ? (<img id="popup-current-pinterest" src="assets/pinterest.png" alt="Pinterest" width={20} height={20} />
          ) : isTwitterDomain ? (<img id="popup-current-twitter" src="assets/x.com.png" alt="Twitter/X" width={20} height={20} />
          ) : (<Ban size={20} />)}
          <button id="popup-toggle-theme" onClick={toggleTheme} className="theme-toggle-button">
            {isDarkMode ? <Sun /> : <Moon />}
          </button>
          <button id="popup-export-all" onClick={downloadAllCollections} className="theme-toggle-button"><Download /></button>
          <button id="popup-clear-all" onClick={() => {
            if (validateBeforeClear) {
              if (confirm("Are you sure you want to clear all saved collections?")) {
                Object.keys(getAllCollections()).forEach(platform => {Object.keys(getAllCollections()[platform]).forEach(collectionName => {deleteCollection(platform, collectionName);});});
              }
            } else {
              Object.keys(getAllCollections()).forEach(platform => {Object.keys(getAllCollections()[platform]).forEach(collectionName => {deleteCollection(platform, collectionName);});});
            }
          }} className="theme-toggle-button" aria-label="Clear all collections">
            <Trash2 size={20} />
          </button>
        <button id="popup-toggle-settings" onClick={() => setIsSettingsOpen(prev => !prev)} className="theme-toggle-button" aria-label="Open settings">
          <Settings size={20} />
        </button>

          {(isPatreonDomain || isInstagramDomain || isTikTokDomain || isYouTubeDomain || isPinterestDomain || isTwitterDomain) && (
            <div id="popup-page-controls" className="instagram-controls-section">
              <h4 id="popup-page-title">
                {isPatreonDomain ? patreon.label
                  : isInstagramDomain ? igGetInstagramPageTitle(activeUrl)
                  : isTikTokDomain ? iGetTiktokPageTitle(activeUrl, tiktokSectionState)
                  : isYouTubeDomain ? youTubeTitle
                  : isPinterestDomain ? pinterestTitle
                  : isTwitterDomain ? getTwitterPageTitle(activeUrl)
                  : ''}
              </h4>
              <div id="popup-capture-actions" className="instagram-buttons-row">
                {scrollStatus === 'idle' && isPatreonDomain && (
                    <button id="popup-collect-patreon" onClick={patreon.start} className="theme-toggle-button" title="Collect Patreon images, videos, and links"><ListTodo size={20} /></button>
                )}
                {isPatreonDomain && patreon.notice && <span id="popup-patreon-capture-status" role="status">{patreon.notice}</span>}
                {scrollStatus === 'idle' && isInstagramDomain && (<button id="popup-collect-instagram" onClick={handleInstagramScrollAndCollect} className="theme-toggle-button" style={{ transform: 'scaleX(-1)' }}><ListTodo size={20} /></button>)}
                {scrollStatus === 'idle' && isTikTokDomain && (<button id="popup-collect-tiktok" onClick={handleCollectTiktokFavorites} className="theme-toggle-button" title="Collect favorites"><ListTodo size={20} /></button>)}
                {scrollStatus === 'idle' && isPinterestDomain && (
                  <button id="popup-collect-pinterest" onClick={handleCollectPinterestPins} className="theme-toggle-button" title="List pins on this page">
                    <ListTodo size={20} />
                  </button>
                )}
                {scrollStatus === 'idle' && isPinterestBoardPage && (
                  <button id="popup-collect-pinterest-ideas" onClick={handleCollectPinterestMoreIdeas} className="theme-toggle-button" style={{ marginLeft: 'auto' }} title='List pins from "Find more ideas"'>
                    <Lightbulb size={20} />
                  </button>
                )}
                {scrollStatus === 'idle' && isYouTubeDomain && !isYouTubeVideoPage && !isYouTubeChannelPage && !isYouTubePlaylistPage && (
                  <button id="popup-collect-youtube-page" onClick={handleYouTubeListVideos} className="theme-toggle-button" title="List videos on this page">
                    <ListTodo size={20} />
                  </button>
                )}
                {scrollStatus === 'idle' && (isYouTubeChannelPage || isYouTubePlaylistPage) && (
                  <button id="popup-collect-youtube-channel" onClick={handleYouTubeListVideos} className="theme-toggle-button" title="List all videos">
                    <ListTodo size={20} />
                  </button>
                )}
                {scrollStatus === 'idle' && isYouTubeVideoPage && (
                  <button id="popup-add-youtube-video" onClick={handleYouTubeAddVideo} className="theme-toggle-button" title="Add this video to collections"><Plus size={20} /></button>)}
                {scrollStatus === 'idle' && isTwitterDomain && (
                  <>
                    <button id="popup-collect-twitter" onClick={handleTwitterScrollAndCollect} className="theme-toggle-button" title="Download tweets"><ListTodo size={20} /></button>
                    {isTwitterThread && (
                      <button id="popup-collect-thread" onClick={handleTwitterThreadDownload} className="theme-toggle-button" title="Download thread"><MessageSquare size={20} /></button>
                    )}
                  </>
                )}
                {scrollStatus !== 'idle' && (
                  <>
                    <button id="popup-toggle-capture" onClick={stopResumeScrolling} className="theme-toggle-button">{scrollStatus === 'scrolling' ? <Pause size={20} /> : <Play size={20} />}</button>
                    <div id="popup-scroll-countdown" className="scroll-timer" style={{ marginBottom: 0 }}>Time until next scroll: {timeRemaining} seconds</div>
                    <button id="popup-stop-capture" onClick={handleCancelListing} className="cancel-square-button" title="Cancel listing" style={{marginLeft: 'auto'}} aria-label="Cancel listing" />
                  </>
                )}
              </div>
            </div>
          )}

          {isSelecting && (
            <>
              <button id="popup-save-selection" onClick={validateSelection} className="btn">Validate</button>
              <button id="popup-cancel-selection" onClick={cancelSelection} className="btn">Cancel</button>
            </>
          )}
        </div>

        {/* Collections or Settings */}
        {isSettingsOpen ? (
          <div id="popup-settings" className="settings-section">
            <h3 id="popup-settings-title">Settings</h3>
            <div id="popup-validate-clear-setting" className="setting-row" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <label id="popup-validate-clear-label" htmlFor="validate-clear" style={{ flex: '0 0 75%', flexShrink: 0 }}>Validate before clearing list</label>
              <div id="popup-validate-clear-control" style={{ flex: '1 1 auto', display: 'flex', justifyContent: 'flex-end', paddingRight: '5px' }}>
                <input id="validate-clear" className="setting-checkbox" type="checkbox" checked={validateBeforeClear} onChange={(e) => handleSetValidateBeforeClear(e.target.checked)} />
              </div>
            </div>
            <div id="popup-scroll-wait-setting" className="setting-row" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <label id="popup-scroll-wait-label" htmlFor="scroll-wait" style={{ flex: '0 0 75%', flexShrink: 0 }}>Scroll interval time</label>
              <div id="popup-scroll-wait-control" style={{ flex: '1 1 auto', display: 'flex', justifyContent: 'flex-end', paddingRight: '5px' }}>
                <input id="scroll-wait" className="setting-input" type="number" value={scrollWaitTime} onChange={(e) => handleSetScrollWaitTime(e.target.value)} style={{ maxWidth: '70px' }} />
              </div>
            </div>
            <div id="popup-download-format-setting" className="setting-row" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <label id="popup-download-format-label" htmlFor="download-format" style={{ flex: '0 0 75%', flexShrink: 0 }}>Download format</label>
              <div id="popup-download-format-control" style={{ flex: '1 1 auto', display: 'flex', justifyContent: 'flex-end', paddingRight: '5px' }}>
                <select id="download-format" className="setting-input" value={downloadFormat} onChange={(e) => handleSetDownloadFormat(e.target.value)} style={{ maxWidth: '70px', width: '70px' }}>
                  <option id="popup-format-csv" value="csv">CSV</option>
                  <option id="popup-format-json" value="json">JSON</option>
                </select>
              </div>
            </div>
            {isTwitterDomain && (
              <div id="popup-twitter-author-only-setting" className="setting-row" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <label id="popup-twitter-author-only-label" htmlFor="twitter-author-only" style={{ flex: '0 0 75%', flexShrink: 0 }}>Thread: author's tweets only</label>
                <div id="popup-twitter-author-only-control" style={{ flex: '1 1 auto', display: 'flex', justifyContent: 'flex-end', paddingRight: '5px' }}>
                  <input id="twitter-author-only" className="setting-checkbox" type="checkbox" checked={twitterThreadAuthorOnly} onChange={(e) => handleSetTwitterThreadAuthorOnly(e.target.checked)} />
                </div>
              </div>
            )}
          </div>
        ) : (
          <div id="popup-collections" className="collections-table-section">
            <h3 id="popup-collections-title">Saved Collections</h3>
            <table id="popup-collections-table">
              <thead id="popup-collections-head">
                <tr id="popup-collections-columns">
                  <th id="popup-collections-platform-heading">Platform</th>
                  <th id="popup-collections-type-heading">Type</th>
                  <th id="popup-collections-handle-heading">Handle</th>
                  <th id="popup-collections-items-heading">Items</th>
                  <th id="popup-collections-action-heading">Action</th>
                </tr>
              </thead>
              <tbody id="popup-collections-body">
                {Object.keys(getAllCollections()).length === 0 && !youTubeErrorMessage && (
                  <tr id="popup-empty-collections-row">
                    <td id="popup-empty-collections-message" colSpan={5} style={{ textAlign: 'center', fontSize: '0.85rem', opacity: 0.7 }}>No collections yet</td>
                  </tr>
                )}
                {youTubeErrorMessage && (
                  <tr id="popup-youtube-error-row">
                    <td id="popup-youtube-error-message" colSpan={5} style={{ textAlign: 'center', fontSize: '0.85rem', color: '#ff6b6b', padding: '1rem' }}>
                      {youTubeErrorMessage}
                    </td>
                  </tr>
                )}
                {Object.entries(getAllCollections()).map(([platform, platformCollections]) => (
                  Object.entries(platformCollections).map(([colName, bookmarks]) => {
                    const nameId = Array.from(colName, ch => ch.codePointAt(0)!.toString(16)).join('-');
                    const rowId = `popup-collection-${platform}-${nameId}`;
                    return (
                        <tr id={`${rowId}-row`} key={`${platform}-${colName}`}>
                          <td id={`${rowId}-platform`}>
                            {platform === 'patreon' && <img id={`${rowId}-platform-icon`} src="assets/patreon.png" alt="Patreon" width={20} height={20} />}
                            {platform === 'instagram' && <img id={`${rowId}-platform-icon`} src="assets/instagram.webp" alt="Instagram" width={20} height={20} />}
                            {platform === 'tiktok'    && <img id={`${rowId}-platform-icon`} src="assets/tiktok.webp" alt="TikTok" width={20} height={20} />}
                            {platform === 'youtube'   && <img id={`${rowId}-platform-icon`} src="assets/youtube.webp" alt="YouTube" width={20} height={20} />}
                            {platform === 'pinterest' && <img id={`${rowId}-platform-icon`} src="assets/pinterest.png" alt="Pinterest" width={20} height={20} />}
                            {platform === 'twitter'   && <img id={`${rowId}-platform-icon`} src="assets/x.com.png" alt="Twitter/X" width={20} height={20} />}
                            {platform === 'other'     && <Ban size={20} />}
                          </td>
                          <td id={`${rowId}-type`}>{getCollectionMeta(platform, colName)?.type || 'profile'}</td>
                          <td id={`${rowId}-handle`}>
                            {editingCollection?.platform === platform && editingCollection?.collectionName === colName ? (
                              <input id={`${rowId}-rename`} type="text" value={editingValue} onChange={(e) => setEditingValue(e.target.value)} onKeyDown={handleEditKeyPress} onBlur={saveCollectionEdit} className="collection-edit-input" autoFocus style={{width: '100%', fontSize: '0.85rem'}} />
                            ) : (
                              <span id={`${rowId}-name`}
                                onClick={() => startEditingCollection(platform, colName)}
                                style={{cursor: 'pointer', userSelect: 'none', padding: '0.25rem', borderRadius: '4px', transition: 'background-color 0.2s'}}
                                title="Click to edit collection name"
                                onMouseEnter={(e) => {e.currentTarget.style.backgroundColor = isDarkMode ? '#4a5568' : '#f0f0f0'}}
                                onMouseLeave={(e) => {e.currentTarget.style.backgroundColor = 'transparent'}}>
                                {getCollectionMeta(platform, colName)?.handle || colName}
                              </span>
                            )}
                          </td>
                          <td id={`${rowId}-count`}>{bookmarks.length}</td>
                          <td id={`${rowId}-actions-cell`}>
                            <div id={`${rowId}-actions`} style={{ display: 'flex', gap: '0.25rem', alignItems: 'center', justifyContent: 'center' }}>
                              <button id={`${rowId}-delete`} onClick={() => deleteCollection(platform, colName)} className="theme-toggle-button" aria-label="Delete collection"><Trash2 size={18} /></button>
                              <button id={`${rowId}-export`} onClick={() => downloadCollection(platform, colName)} className="theme-toggle-button" aria-label="Download data CSV"><Download size={18} /></button>
                            </div>
                          </td>
                        </tr>
                    );
                  })
                ))}
              </tbody>
            </table>
          </div>
        )}

      </div>
    </div>
  );
};

export default Popup;
const container = document.getElementById('root');
if (container) {
  const root = createRoot(container);
  root.render(
    <React.StrictMode>
      <Popup />
    </React.StrictMode>
  );
}
