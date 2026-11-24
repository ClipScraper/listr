import { useEffect, useState } from 'react';
import browser from 'webextension-polyfill';
import {collectionLabel} from '../apps/patreon/scan';

export type BookmarkMedia = 'pictures' | 'video' | 'link';
export type CollectedItem = {url: string; mediaType: BookmarkMedia};

export type Platform = 'tiktok' | 'instagram' | 'youtube' | 'pinterest' | 'twitter' | 'other' | 'patreon';

export interface Bookmark {
  uuid: string;
  mediaType?: BookmarkMedia;
  platform: Platform;
  url: string;
  collection: string;
}

export interface CollectionMeta {
  type: 'bookmarks' | 'profile' | 'favorites' | 'liked' | 'reposts' | 'recommendation' | 'video' | 'playlist' | 'thread' | 'collection';
  patreonCollectionId?: string;
  customLabel?: boolean;
  handle: string; // collection name for bookmarks, username for profile
}

export interface CollectionStore {
  collections: { 
    [platform: string]: {
      [collectionName: string]: Bookmark[];
    };
  };
  meta?: {
    [platform: string]: {
      [collectionName: string]: CollectionMeta;
    };
  };
}

export function useCollections() {
  const [collectionStore, setCollectionStore] = useState<CollectionStore>({collections: {}, meta: {}});

  useEffect(() => {
    browser.storage.local.get('allCollections')
      .then(data => {
        if (data.allCollections) {
          const loaded = data.allCollections as CollectionStore;
          if (!loaded.meta) loaded.meta = {};
          setCollectionStore(loaded);
        }
      })
      .catch(err => console.error('Error loading collections:', err));
  }, []);

  const saveCollections = (updatedStore: CollectionStore) => {
    browser.storage.local.set({ allCollections: updatedStore })
      .catch(err => console.error('Error saving collections:', err));
  };

  // Insert a key at the *front* of an object (preserving order of the rest)
  function insertKeyFirst<T extends Record<string, any>>(obj: T, key: string, val: any): T {
    const out: Record<string, any> = { [key]: val };
    for (const k of Object.keys(obj)) out[k] = obj[k];
    return out as T;
  }

    const addBookmarksToCollection = (platform: Platform, collectionName: string, items: (string | CollectedItem)[], meta?: CollectionMeta) => {
        if (!items.length && !meta?.patreonCollectionId) {
            return;
        }
        setCollectionStore(prevStore => {
            const platformMap = prevStore.collections[platform] || {};
            const current = Object.prototype.hasOwnProperty.call(platformMap, collectionName) ? platformMap[collectionName] : [];
            const bookmarks = new Map(current.map(bookmark => [bookmark.url, bookmark]));
            let changed = false;
            for (const item of items) {
                const url = typeof item === 'string' ? item : item.url;
                const mediaType = typeof item === 'string' ? undefined : item.mediaType;
                const existing = bookmarks.get(url);
                if (!existing) {
                    bookmarks.set(url, {uuid: crypto.randomUUID(), platform, url, collection: collectionName, mediaType});
                    changed = true;
                } else if (mediaType && (!existing.mediaType || (existing.mediaType === 'link' && mediaType !== 'link'))) {
                    bookmarks.set(url, {...existing, mediaType});
                    changed = true;
                }
            }
            const existingMeta = prevStore.meta?.[platform]?.[collectionName];
            // The ID-only storage key survives title changes. A missing cover title
            // must not erase a name already learned on a previous capture.
            const keepLabel = meta?.patreonCollectionId && existingMeta && (existingMeta.customLabel || meta.handle === collectionName);
            const savedMeta = keepLabel ? {...meta, handle: existingMeta.handle, customLabel: existingMeta.customLabel} : meta;
            const metadataChanged = savedMeta?.patreonCollectionId && current.length > 0 &&
                (existingMeta?.handle !== savedMeta.handle || existingMeta?.patreonCollectionId !== savedMeta.patreonCollectionId);
            if (!changed && !metadataChanged) {
                return prevStore;
            }
            const next = Array.from(bookmarks.values());
            const updatedPlatform = Object.prototype.hasOwnProperty.call(platformMap, collectionName)
                ? {...platformMap, [collectionName]: next}
                : {[collectionName]: next, ...platformMap};
            const collections = {...prevStore.collections, [platform]: updatedPlatform};
            const nextMeta = savedMeta ? {...prevStore.meta, [platform]: {...prevStore.meta?.[platform], [collectionName]: savedMeta}} : prevStore.meta;
            const updatedStore = {collections, meta: nextMeta};
            saveCollections(updatedStore);
            return updatedStore;
        });
    };

  const ensureCollection = (platform: Platform, collectionName: string, meta?: CollectionMeta) => {
    setCollectionStore(prevStore => {
      const platformCollections = prevStore.collections[platform] || {};
      const already = !!platformCollections[collectionName];

      // Put new collections at the front
      const nextPlatformCollections = already
        ? platformCollections
        : insertKeyFirst(platformCollections, collectionName, []);

      // Meta handling (also keep new meta at the front for consistency)
      const updatedMeta = { ...(prevStore.meta || {}) } as NonNullable<CollectionStore['meta']>;
      if (!updatedMeta[platform]) updatedMeta[platform] = {};
      if (!already) {
        updatedMeta[platform] = insertKeyFirst(
          updatedMeta[platform],
          collectionName,
          meta || { type: 'profile', handle: collectionName }
        );
      } else if (meta) {
        updatedMeta[platform] = { ...updatedMeta[platform], [collectionName]: meta };
      }

      const updatedCollections = { ...prevStore.collections, [platform]: nextPlatformCollections };
      const updatedStore: CollectionStore = { collections: updatedCollections, meta: updatedMeta };
      saveCollections(updatedStore);
      return updatedStore;
    });
  };

  const deleteCollection = (platform: string, collectionName: string) => {
    setCollectionStore(prevStore => {
      const updatedPlatforms = { ...prevStore.collections };
      if (updatedPlatforms[platform]) {
        const updatedPlatformCollections = { ...updatedPlatforms[platform] };
        delete updatedPlatformCollections[collectionName];
        if (Object.keys(updatedPlatformCollections).length === 0) {
          delete updatedPlatforms[platform];
        } else {
          updatedPlatforms[platform] = updatedPlatformCollections;
        }
      }
      const updatedMeta = { ...(prevStore.meta || {}) } as NonNullable<CollectionStore['meta']>;
      if (updatedMeta[platform]) {
        const m = { ...updatedMeta[platform] };
        delete m[collectionName];
        updatedMeta[platform] = m;
      }
      const updatedStore: CollectionStore = { collections: updatedPlatforms, meta: updatedMeta };
      saveCollections(updatedStore);
      return updatedStore;
    });
  };

  const renameCollection = (platform: string, oldCollectionName: string, newCollectionName: string) => {
    setCollectionStore(prevStore => {
      const updatedCollections = { ...prevStore.collections };
      const updatedMeta = { ...(prevStore.meta || {}) } as NonNullable<CollectionStore['meta']>;

      const existing = updatedMeta[platform]?.[oldCollectionName];
      if (platform === 'patreon' && existing?.patreonCollectionId) {
          const handle = collectionLabel(existing.patreonCollectionId, newCollectionName);
          if (existing.handle === handle) {
              return prevStore;
          }
          updatedMeta[platform] = {...updatedMeta[platform], [oldCollectionName]: {...existing, handle, customLabel: true}};
          const store = {...prevStore, meta: updatedMeta};
          saveCollections(store);
          return store;
      }

      if (oldCollectionName === newCollectionName) {
          return prevStore;
      }

      // Move bookmarks to new collection name (keep it at same relative position)
      if (updatedCollections[platform]?.[oldCollectionName]) {
        const bookmarks = updatedCollections[platform][oldCollectionName];
        const updatedBookmarks = bookmarks.map(bookmark => ({
          ...bookmark,
          collection: newCollectionName
        }));

        const platformCollections = { ...updatedCollections[platform] };
        delete platformCollections[oldCollectionName];
        // Put the renamed collection at the *front* as a “new” row feeling
        updatedCollections[platform] = insertKeyFirst(platformCollections, newCollectionName, updatedBookmarks);
      }

      // Move metadata
      if (updatedMeta[platform]?.[oldCollectionName]) {
        const meta = updatedMeta[platform][oldCollectionName];
        const platformMeta = { ...updatedMeta[platform] };
        delete platformMeta[oldCollectionName];
        updatedMeta[platform] = insertKeyFirst(platformMeta, newCollectionName, platform === 'patreon' ? {...meta, handle: newCollectionName} : meta);
      }

      const updatedStore: CollectionStore = { collections: updatedCollections, meta: updatedMeta };
      saveCollections(updatedStore);
      return updatedStore;
    });
  };

  const getAllCollections = () => collectionStore.collections;
  const getCollectionMeta = (platform: string, collectionName: string): CollectionMeta | undefined => {
    return collectionStore.meta?.[platform]?.[collectionName];
  };

  const getCollectionsByPlatform = (platform: Platform) => {
    return collectionStore.collections[platform] || {};
  };

  return {collectionStore, addBookmarksToCollection, ensureCollection, deleteCollection, renameCollection, getAllCollections, getCollectionsByPlatform, getCollectionMeta};
}
