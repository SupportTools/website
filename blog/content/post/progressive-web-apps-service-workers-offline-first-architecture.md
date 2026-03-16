---
title: "Progressive Web Apps: Service Workers and Offline-First Architecture"
date: 2026-10-28T00:00:00-05:00
draft: false
tags: ["PWA", "Service Workers", "JavaScript", "Web Development", "Offline First", "Performance", "Security", "Mobile"]
categories:
- Frontend Development
- Web Performance
- Mobile Development
- Architecture
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to building Progressive Web Apps with service workers, implementing offline-first data synchronization, push notifications, and enterprise-grade security for production deployments"
more_link: "yes"
url: "/progressive-web-apps-service-workers-offline-first-architecture/"
keywords:
- Progressive Web Apps
- Service Workers
- Offline-first architecture
- Background sync
- Push notifications
- PWA deployment
- Web app manifest
- Cache strategies
---

Progressive Web Apps (PWAs) represent the convergence of web and native mobile applications, offering the best of both worlds. This comprehensive guide explores advanced PWA implementation strategies, focusing on service workers, offline-first architecture, and enterprise deployment considerations for production environments.

<!--more-->

# Progressive Web Apps: Service Workers and Offline-First Architecture

## Understanding Progressive Web Apps

Progressive Web Apps are web applications that use modern web capabilities to deliver app-like experiences to users. They combine the flexibility of the web with the experience of native applications, providing features like offline functionality, push notifications, and home screen installation.

### Core PWA Principles

1. **Progressive Enhancement**: Work for every user, regardless of browser choice
2. **Responsive Design**: Fit any form factor: desktop, mobile, tablet
3. **Offline-First**: Enhanced with service workers to work offline
4. **App-Like**: Feel like an app with app-style interactions and navigation
5. **Fresh**: Always up-to-date thanks to the service worker update process
6. **Secure**: Served via HTTPS to prevent tampering
7. **Re-engageable**: Make re-engagement easy through features like push notifications
8. **Installable**: Allow users to add apps to their home screen
9. **Linkable**: Easily shared via URL without complex installation

## Service Worker Implementation Strategies

Service workers are the backbone of PWAs, acting as a programmable network proxy that enables offline functionality, background sync, and push notifications.

### Advanced Service Worker Architecture

```javascript
// sw.js - Advanced Service Worker Implementation
const CACHE_VERSION = 'v1.0.0';
const CACHE_NAMES = {
  STATIC: `static-cache-${CACHE_VERSION}`,
  DYNAMIC: `dynamic-cache-${CACHE_VERSION}`,
  IMAGES: `image-cache-${CACHE_VERSION}`,
  API: `api-cache-${CACHE_VERSION}`,
};

// Assets to cache immediately
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/css/main.css',
  '/js/app.js',
  '/manifest.json',
  '/offline.html',
  '/icons/icon-192x192.png',
  '/icons/icon-512x512.png',
];

// Cache size limits
const CACHE_SIZE_LIMITS = {
  [CACHE_NAMES.IMAGES]: 50, // Max 50 images
  [CACHE_NAMES.API]: 100,    // Max 100 API responses
  [CACHE_NAMES.DYNAMIC]: 30, // Max 30 dynamic pages
};

class ServiceWorkerManager {
  constructor() {
    this.setupEventListeners();
  }

  setupEventListeners() {
    self.addEventListener('install', this.handleInstall.bind(this));
    self.addEventListener('activate', this.handleActivate.bind(this));
    self.addEventListener('fetch', this.handleFetch.bind(this));
    self.addEventListener('sync', this.handleSync.bind(this));
    self.addEventListener('push', this.handlePush.bind(this));
    self.addEventListener('message', this.handleMessage.bind(this));
  }

  async handleInstall(event) {
    console.log('[Service Worker] Installing...');
    
    event.waitUntil(
      (async () => {
        try {
          // Cache static assets
          const staticCache = await caches.open(CACHE_NAMES.STATIC);
          await staticCache.addAll(STATIC_ASSETS);
          
          // Skip waiting to activate immediately
          await self.skipWaiting();
          
          console.log('[Service Worker] Installation complete');
        } catch (error) {
          console.error('[Service Worker] Installation failed:', error);
        }
      })()
    );
  }

  async handleActivate(event) {
    console.log('[Service Worker] Activating...');
    
    event.waitUntil(
      (async () => {
        // Clean up old caches
        const cacheWhitelist = Object.values(CACHE_NAMES);
        const cacheNames = await caches.keys();
        
        await Promise.all(
          cacheNames.map(async (cacheName) => {
            if (!cacheWhitelist.includes(cacheName)) {
              console.log('[Service Worker] Deleting old cache:', cacheName);
              await caches.delete(cacheName);
            }
          })
        );
        
        // Take control of all clients
        await self.clients.claim();
        
        console.log('[Service Worker] Activation complete');
      })()
    );
  }

  async handleFetch(event) {
    const { request } = event;
    const url = new URL(request.url);
    
    // Skip non-HTTP(S) requests
    if (!url.protocol.startsWith('http')) {
      return;
    }
    
    event.respondWith(this.fetchWithStrategies(request));
  }

  async fetchWithStrategies(request) {
    const url = new URL(request.url);
    
    // API calls - Network first, fallback to cache
    if (url.pathname.startsWith('/api/')) {
      return this.networkFirstStrategy(request, CACHE_NAMES.API);
    }
    
    // Images - Cache first, fallback to network
    if (request.destination === 'image') {
      return this.cacheFirstStrategy(request, CACHE_NAMES.IMAGES);
    }
    
    // Static assets - Cache first
    if (this.isStaticAsset(url.pathname)) {
      return this.cacheFirstStrategy(request, CACHE_NAMES.STATIC);
    }
    
    // HTML pages - Network first with offline fallback
    if (request.mode === 'navigate') {
      return this.networkFirstWithOfflineFallback(request);
    }
    
    // Default - Stale while revalidate
    return this.staleWhileRevalidate(request, CACHE_NAMES.DYNAMIC);
  }

  async networkFirstStrategy(request, cacheName) {
    try {
      const networkResponse = await fetch(request);
      
      if (networkResponse.ok) {
        const cache = await caches.open(cacheName);
        await cache.put(request, networkResponse.clone());
        await this.trimCache(cacheName);
      }
      
      return networkResponse;
    } catch (error) {
      const cachedResponse = await caches.match(request);
      if (cachedResponse) {
        return cachedResponse;
      }
      
      // Return error response
      return new Response(
        JSON.stringify({ error: 'Network error and no cache available' }),
        {
          status: 503,
          headers: { 'Content-Type': 'application/json' }
        }
      );
    }
  }

  async cacheFirstStrategy(request, cacheName) {
    const cachedResponse = await caches.match(request);
    
    if (cachedResponse) {
      // Update cache in background
      this.updateCacheInBackground(request, cacheName);
      return cachedResponse;
    }
    
    try {
      const networkResponse = await fetch(request);
      const cache = await caches.open(cacheName);
      await cache.put(request, networkResponse.clone());
      await this.trimCache(cacheName);
      return networkResponse;
    } catch (error) {
      // Return placeholder for images
      if (request.destination === 'image') {
        return caches.match('/images/placeholder.png');
      }
      throw error;
    }
  }

  async staleWhileRevalidate(request, cacheName) {
    const cachedResponse = await caches.match(request);
    
    const fetchPromise = fetch(request).then(async (networkResponse) => {
      if (networkResponse.ok) {
        const cache = await caches.open(cacheName);
        await cache.put(request, networkResponse.clone());
        await this.trimCache(cacheName);
      }
      return networkResponse;
    });
    
    return cachedResponse || fetchPromise;
  }

  async networkFirstWithOfflineFallback(request) {
    try {
      const networkResponse = await fetch(request);
      
      if (networkResponse.ok) {
        const cache = await caches.open(CACHE_NAMES.DYNAMIC);
        await cache.put(request, networkResponse.clone());
        await this.trimCache(CACHE_NAMES.DYNAMIC);
      }
      
      return networkResponse;
    } catch (error) {
      const cachedResponse = await caches.match(request);
      if (cachedResponse) {
        return cachedResponse;
      }
      
      // Return offline page
      return caches.match('/offline.html');
    }
  }

  async updateCacheInBackground(request, cacheName) {
    try {
      const networkResponse = await fetch(request);
      if (networkResponse.ok) {
        const cache = await caches.open(cacheName);
        await cache.put(request, networkResponse);
        await this.trimCache(cacheName);
      }
    } catch (error) {
      // Silent fail - we already returned cached response
    }
  }

  async trimCache(cacheName) {
    const limit = CACHE_SIZE_LIMITS[cacheName];
    if (!limit) return;
    
    const cache = await caches.open(cacheName);
    const keys = await cache.keys();
    
    if (keys.length > limit) {
      // Remove oldest entries
      const keysToDelete = keys.slice(0, keys.length - limit);
      await Promise.all(keysToDelete.map(key => cache.delete(key)));
    }
  }

  isStaticAsset(pathname) {
    return pathname.match(/\.(css|js|woff2?|ttf|otf|eot|svg|png|jpg|jpeg|gif|webp)$/);
  }

  async handleSync(event) {
    console.log('[Service Worker] Background sync:', event.tag);
    
    if (event.tag === 'sync-posts') {
      event.waitUntil(this.syncPendingPosts());
    } else if (event.tag === 'sync-analytics') {
      event.waitUntil(this.syncAnalytics());
    }
  }

  async syncPendingPosts() {
    const db = await this.openIndexedDB();
    const tx = db.transaction('pending-posts', 'readwrite');
    const store = tx.objectStore('pending-posts');
    const posts = await store.getAll();
    
    for (const post of posts) {
      try {
        const response = await fetch('/api/posts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(post.data),
        });
        
        if (response.ok) {
          await store.delete(post.id);
          await this.notifyClients('post-synced', { id: post.id });
        }
      } catch (error) {
        console.error('[Service Worker] Sync failed for post:', post.id);
      }
    }
  }

  async syncAnalytics() {
    const db = await this.openIndexedDB();
    const tx = db.transaction('analytics', 'readwrite');
    const store = tx.objectStore('analytics');
    const events = await store.getAll();
    
    if (events.length > 0) {
      try {
        await fetch('/api/analytics/batch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ events }),
        });
        
        // Clear synced events
        await store.clear();
      } catch (error) {
        console.error('[Service Worker] Analytics sync failed');
      }
    }
  }

  async handlePush(event) {
    const options = {
      body: event.data ? event.data.text() : 'New notification',
      icon: '/icons/icon-192x192.png',
      badge: '/icons/badge-72x72.png',
      vibrate: [100, 50, 100],
      data: {
        dateOfArrival: Date.now(),
        primaryKey: 1,
      },
      actions: [
        {
          action: 'explore',
          title: 'Open App',
          icon: '/icons/checkmark.png',
        },
        {
          action: 'close',
          title: 'Close',
          icon: '/icons/xmark.png',
        },
      ],
    };
    
    event.waitUntil(
      self.registration.showNotification('PWA Notification', options)
    );
  }

  async handleMessage(event) {
    const { type, payload } = event.data;
    
    switch (type) {
      case 'SKIP_WAITING':
        await self.skipWaiting();
        break;
        
      case 'CACHE_URLS':
        await this.cacheUrls(payload.urls);
        break;
        
      case 'CLEAR_CACHE':
        await this.clearCache(payload.cacheName);
        break;
        
      case 'GET_CACHE_STATS':
        const stats = await this.getCacheStats();
        event.ports[0].postMessage({ type: 'CACHE_STATS', stats });
        break;
    }
  }

  async cacheUrls(urls) {
    const cache = await caches.open(CACHE_NAMES.DYNAMIC);
    await cache.addAll(urls);
  }

  async clearCache(cacheName) {
    if (cacheName) {
      await caches.delete(cacheName);
    } else {
      const cacheNames = await caches.keys();
      await Promise.all(cacheNames.map(name => caches.delete(name)));
    }
  }

  async getCacheStats() {
    const cacheNames = await caches.keys();
    const stats = {};
    
    for (const cacheName of cacheNames) {
      const cache = await caches.open(cacheName);
      const keys = await cache.keys();
      stats[cacheName] = {
        count: keys.length,
        urls: keys.map(req => req.url),
      };
    }
    
    return stats;
  }

  async notifyClients(type, data) {
    const clients = await self.clients.matchAll();
    clients.forEach(client => {
      client.postMessage({ type, data });
    });
  }

  async openIndexedDB() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open('pwa-db', 1);
      
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
      
      request.onupgradeneeded = (event) => {
        const db = event.target.result;
        
        if (!db.objectStoreNames.contains('pending-posts')) {
          db.createObjectStore('pending-posts', { keyPath: 'id' });
        }
        
        if (!db.objectStoreNames.contains('analytics')) {
          db.createObjectStore('analytics', { keyPath: 'id', autoIncrement: true });
        }
      };
    });
  }
}

// Initialize service worker
new ServiceWorkerManager();
```

## Offline-First Data Synchronization

Implementing robust offline-first data synchronization ensures your PWA provides a seamless experience regardless of network conditions.

### IndexedDB Wrapper for Offline Storage

```typescript
// src/utils/offlineDb.ts
interface DBConfig {
  name: string;
  version: number;
  stores: StoreConfig[];
}

interface StoreConfig {
  name: string;
  keyPath: string;
  autoIncrement?: boolean;
  indexes?: IndexConfig[];
}

interface IndexConfig {
  name: string;
  keyPath: string | string[];
  unique?: boolean;
  multiEntry?: boolean;
}

class OfflineDatabase {
  private dbName: string;
  private version: number;
  private stores: StoreConfig[];
  private db: IDBDatabase | null = null;

  constructor(config: DBConfig) {
    this.dbName = config.name;
    this.version = config.version;
    this.stores = config.stores;
  }

  async open(): Promise<void> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.dbName, this.version);

      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        this.db = request.result;
        resolve();
      };

      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;
        
        this.stores.forEach(storeConfig => {
          if (!db.objectStoreNames.contains(storeConfig.name)) {
            const store = db.createObjectStore(storeConfig.name, {
              keyPath: storeConfig.keyPath,
              autoIncrement: storeConfig.autoIncrement,
            });

            storeConfig.indexes?.forEach(index => {
              store.createIndex(index.name, index.keyPath, {
                unique: index.unique,
                multiEntry: index.multiEntry,
              });
            });
          }
        });
      };
    });
  }

  async transaction<T>(
    storeNames: string | string[],
    mode: IDBTransactionMode,
    callback: (tx: IDBTransaction) => Promise<T>
  ): Promise<T> {
    if (!this.db) {
      await this.open();
    }

    const tx = this.db!.transaction(storeNames, mode);
    
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error);
      
      let result: T;
      callback(tx).then(r => result = r).catch(reject);
    });
  }

  async get<T>(storeName: string, key: IDBValidKey): Promise<T | undefined> {
    return this.transaction([storeName], 'readonly', async (tx) => {
      const store = tx.objectStore(storeName);
      return new Promise((resolve, reject) => {
        const request = store.get(key);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    });
  }

  async getAll<T>(storeName: string, query?: IDBValidKey | IDBKeyRange): Promise<T[]> {
    return this.transaction([storeName], 'readonly', async (tx) => {
      const store = tx.objectStore(storeName);
      return new Promise((resolve, reject) => {
        const request = query ? store.getAll(query) : store.getAll();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    });
  }

  async put<T>(storeName: string, value: T): Promise<IDBValidKey> {
    return this.transaction([storeName], 'readwrite', async (tx) => {
      const store = tx.objectStore(storeName);
      return new Promise((resolve, reject) => {
        const request = store.put(value);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    });
  }

  async delete(storeName: string, key: IDBValidKey): Promise<void> {
    return this.transaction([storeName], 'readwrite', async (tx) => {
      const store = tx.objectStore(storeName);
      return new Promise((resolve, reject) => {
        const request = store.delete(key);
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
      });
    });
  }

  async clear(storeName: string): Promise<void> {
    return this.transaction([storeName], 'readwrite', async (tx) => {
      const store = tx.objectStore(storeName);
      return new Promise((resolve, reject) => {
        const request = store.clear();
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
      });
    });
  }
}

// Database configuration for a typical PWA
export const appDb = new OfflineDatabase({
  name: 'pwa-app-db',
  version: 1,
  stores: [
    {
      name: 'users',
      keyPath: 'id',
      indexes: [
        { name: 'email', keyPath: 'email', unique: true },
        { name: 'created', keyPath: 'createdAt' },
      ],
    },
    {
      name: 'posts',
      keyPath: 'id',
      indexes: [
        { name: 'author', keyPath: 'authorId' },
        { name: 'created', keyPath: 'createdAt' },
        { name: 'tags', keyPath: 'tags', multiEntry: true },
      ],
    },
    {
      name: 'sync-queue',
      keyPath: 'id',
      autoIncrement: true,
      indexes: [
        { name: 'timestamp', keyPath: 'timestamp' },
        { name: 'status', keyPath: 'status' },
      ],
    },
    {
      name: 'cache-metadata',
      keyPath: 'url',
      indexes: [
        { name: 'expires', keyPath: 'expiresAt' },
      ],
    },
  ],
});
```

### Sync Manager for Offline Operations

```typescript
// src/utils/syncManager.ts
interface SyncOperation {
  id?: number;
  type: 'CREATE' | 'UPDATE' | 'DELETE';
  resource: string;
  data: any;
  timestamp: number;
  retries: number;
  status: 'pending' | 'syncing' | 'success' | 'failed';
}

class SyncManager {
  private db: OfflineDatabase;
  private syncInProgress = false;
  private syncInterval: number | null = null;
  private onlineListener: (() => void) | null = null;

  constructor(db: OfflineDatabase) {
    this.db = db;
    this.setupEventListeners();
    this.startPeriodicSync();
  }

  private setupEventListeners(): void {
    // Listen for online/offline events
    this.onlineListener = () => this.sync();
    window.addEventListener('online', this.onlineListener);

    // Listen for visibility change
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && navigator.onLine) {
        this.sync();
      }
    });

    // Listen for sync messages from service worker
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.addEventListener('message', (event) => {
        if (event.data.type === 'sync-complete') {
          this.handleSyncComplete(event.data.operations);
        }
      });
    }
  }

  private startPeriodicSync(): void {
    // Sync every 5 minutes when online
    this.syncInterval = window.setInterval(() => {
      if (navigator.onLine) {
        this.sync();
      }
    }, 5 * 60 * 1000);
  }

  async addOperation(operation: Omit<SyncOperation, 'id' | 'timestamp' | 'retries' | 'status'>): Promise<void> {
    const syncOp: SyncOperation = {
      ...operation,
      timestamp: Date.now(),
      retries: 0,
      status: 'pending',
    };

    await this.db.put('sync-queue', syncOp);

    // Attempt immediate sync if online
    if (navigator.onLine) {
      this.sync();
    }
  }

  async sync(): Promise<void> {
    if (this.syncInProgress || !navigator.onLine) {
      return;
    }

    this.syncInProgress = true;

    try {
      const pendingOps = await this.db.getAll<SyncOperation>('sync-queue');
      const pendingOperations = pendingOps.filter(op => op.status === 'pending' || op.status === 'failed');

      for (const operation of pendingOperations) {
        await this.syncOperation(operation);
      }

      // Clean up successful operations
      await this.cleanupSyncQueue();
    } catch (error) {
      console.error('[SyncManager] Sync failed:', error);
    } finally {
      this.syncInProgress = false;
    }
  }

  private async syncOperation(operation: SyncOperation): Promise<void> {
    try {
      // Update status to syncing
      operation.status = 'syncing';
      await this.db.put('sync-queue', operation);

      // Perform the sync
      const response = await this.performSync(operation);

      if (response.ok) {
        operation.status = 'success';
        await this.db.put('sync-queue', operation);

        // Update local data with server response
        await this.updateLocalData(operation, await response.json());
      } else {
        throw new Error(`Sync failed: ${response.status}`);
      }
    } catch (error) {
      console.error(`[SyncManager] Operation ${operation.id} failed:`, error);
      
      operation.retries++;
      operation.status = operation.retries >= 3 ? 'failed' : 'pending';
      await this.db.put('sync-queue', operation);

      // Exponential backoff for retries
      if (operation.retries < 3) {
        setTimeout(() => this.sync(), Math.pow(2, operation.retries) * 1000);
      }
    }
  }

  private async performSync(operation: SyncOperation): Promise<Response> {
    const url = `/api/${operation.resource}`;
    const method = operation.type === 'DELETE' ? 'DELETE' : operation.type === 'CREATE' ? 'POST' : 'PUT';

    return fetch(url, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'X-Sync-Operation': operation.id?.toString() || '',
      },
      body: method !== 'DELETE' ? JSON.stringify(operation.data) : undefined,
    });
  }

  private async updateLocalData(operation: SyncOperation, serverData: any): Promise<void> {
    // Update local database with server response
    switch (operation.type) {
      case 'CREATE':
      case 'UPDATE':
        await this.db.put(operation.resource, serverData);
        break;
      case 'DELETE':
        await this.db.delete(operation.resource, operation.data.id);
        break;
    }
  }

  private async cleanupSyncQueue(): Promise<void> {
    const allOps = await this.db.getAll<SyncOperation>('sync-queue');
    const successfulOps = allOps.filter(op => op.status === 'success');

    // Keep only last 100 successful operations for debugging
    if (successfulOps.length > 100) {
      const opsToDelete = successfulOps
        .sort((a, b) => a.timestamp - b.timestamp)
        .slice(0, successfulOps.length - 100);

      for (const op of opsToDelete) {
        await this.db.delete('sync-queue', op.id!);
      }
    }
  }

  private handleSyncComplete(operations: number[]): void {
    // Handle sync completion from service worker
    console.log('[SyncManager] Service worker completed sync for operations:', operations);
  }

  destroy(): void {
    if (this.syncInterval) {
      clearInterval(this.syncInterval);
    }

    if (this.onlineListener) {
      window.removeEventListener('online', this.onlineListener);
    }
  }
}

// Initialize sync manager
export const syncManager = new SyncManager(appDb);
```

## Push Notifications and Background Sync

Implementing push notifications and background sync enhances user engagement and ensures data consistency.

### Push Notification Manager

```typescript
// src/utils/pushNotifications.ts
interface NotificationOptions {
  title: string;
  body: string;
  icon?: string;
  badge?: string;
  tag?: string;
  requireInteraction?: boolean;
  actions?: NotificationAction[];
  data?: any;
}

class PushNotificationManager {
  private registration: ServiceWorkerRegistration | null = null;
  private subscription: PushSubscription | null = null;

  async initialize(): Promise<void> {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
      throw new Error('Push notifications are not supported');
    }

    // Wait for service worker registration
    this.registration = await navigator.serviceWorker.ready;

    // Check existing subscription
    this.subscription = await this.registration.pushManager.getSubscription();
  }

  async requestPermission(): Promise<NotificationPermission> {
    const permission = await Notification.requestPermission();
    
    if (permission === 'granted') {
      await this.subscribe();
    }
    
    return permission;
  }

  private async subscribe(): Promise<void> {
    if (!this.registration) {
      throw new Error('Service worker not registered');
    }

    try {
      // Get public key from server
      const response = await fetch('/api/push/vapid-public-key');
      const { publicKey } = await response.json();

      const subscribeOptions: PushSubscriptionOptionsInit = {
        userVisibleOnly: true,
        applicationServerKey: this.urlBase64ToUint8Array(publicKey),
      };

      this.subscription = await this.registration.pushManager.subscribe(subscribeOptions);

      // Send subscription to server
      await this.sendSubscriptionToServer(this.subscription);
    } catch (error) {
      console.error('[Push] Subscription failed:', error);
      throw error;
    }
  }

  private async sendSubscriptionToServer(subscription: PushSubscription): Promise<void> {
    const response = await fetch('/api/push/subscribe', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        endpoint: subscription.endpoint,
        keys: {
          p256dh: this.arrayBufferToBase64(subscription.getKey('p256dh')),
          auth: this.arrayBufferToBase64(subscription.getKey('auth')),
        },
      }),
    });

    if (!response.ok) {
      throw new Error('Failed to save subscription on server');
    }
  }

  async unsubscribe(): Promise<void> {
    if (!this.subscription) {
      return;
    }

    try {
      // Unsubscribe from push service
      await this.subscription.unsubscribe();

      // Remove subscription from server
      await fetch('/api/push/unsubscribe', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          endpoint: this.subscription.endpoint,
        }),
      });

      this.subscription = null;
    } catch (error) {
      console.error('[Push] Unsubscribe failed:', error);
      throw error;
    }
  }

  async showLocalNotification(options: NotificationOptions): Promise<void> {
    if (!this.registration) {
      throw new Error('Service worker not registered');
    }

    if (Notification.permission !== 'granted') {
      throw new Error('Notification permission not granted');
    }

    await this.registration.showNotification(options.title, {
      body: options.body,
      icon: options.icon || '/icons/icon-192x192.png',
      badge: options.badge || '/icons/badge-72x72.png',
      tag: options.tag,
      requireInteraction: options.requireInteraction,
      actions: options.actions,
      data: options.data,
      vibrate: [200, 100, 200],
    });
  }

  isSubscribed(): boolean {
    return this.subscription !== null;
  }

  getSubscription(): PushSubscription | null {
    return this.subscription;
  }

  private urlBase64ToUint8Array(base64String: string): Uint8Array {
    const padding = '='.repeat((4 - base64String.length % 4) % 4);
    const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    const rawData = window.atob(base64);
    const outputArray = new Uint8Array(rawData.length);

    for (let i = 0; i < rawData.length; ++i) {
      outputArray[i] = rawData.charCodeAt(i);
    }

    return outputArray;
  }

  private arrayBufferToBase64(buffer: ArrayBuffer | null): string {
    if (!buffer) return '';
    
    const bytes = new Uint8Array(buffer);
    let binary = '';
    
    for (let i = 0; i < bytes.byteLength; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    
    return window.btoa(binary);
  }
}

export const pushManager = new PushNotificationManager();
```

### Background Sync Implementation

```typescript
// src/utils/backgroundSync.ts
interface BackgroundSyncOptions {
  tag: string;
  minInterval?: number; // Minimum interval between syncs in ms
}

class BackgroundSyncManager {
  private registration: ServiceWorkerRegistration | null = null;
  private syncTags: Map<string, BackgroundSyncOptions> = new Map();

  async initialize(): Promise<void> {
    if (!('serviceWorker' in navigator) || !('sync' in ServiceWorkerRegistration.prototype)) {
      console.warn('[BackgroundSync] Not supported');
      return;
    }

    this.registration = await navigator.serviceWorker.ready;

    // Check for periodic sync support
    if ('periodicSync' in ServiceWorkerRegistration.prototype) {
      await this.setupPeriodicSync();
    }
  }

  async register(options: BackgroundSyncOptions): Promise<void> {
    if (!this.registration) {
      throw new Error('Service worker not registered');
    }

    this.syncTags.set(options.tag, options);

    try {
      await this.registration.sync.register(options.tag);
      console.log(`[BackgroundSync] Registered sync: ${options.tag}`);
    } catch (error) {
      console.error(`[BackgroundSync] Registration failed for ${options.tag}:`, error);
      
      // Fallback to manual sync
      this.fallbackSync(options);
    }
  }

  private async setupPeriodicSync(): Promise<void> {
    if (!this.registration || !('periodicSync' in this.registration)) {
      return;
    }

    const status = await (navigator as any).permissions.query({
      name: 'periodic-background-sync',
    });

    if (status.state === 'granted') {
      // Register periodic syncs
      const periodicSyncs = [
        { tag: 'content-sync', minInterval: 12 * 60 * 60 * 1000 }, // 12 hours
        { tag: 'analytics-sync', minInterval: 60 * 60 * 1000 },   // 1 hour
      ];

      for (const sync of periodicSyncs) {
        try {
          await (this.registration as any).periodicSync.register(sync.tag, {
            minInterval: sync.minInterval,
          });
          console.log(`[BackgroundSync] Registered periodic sync: ${sync.tag}`);
        } catch (error) {
          console.error(`[BackgroundSync] Periodic sync registration failed:`, error);
        }
      }
    }
  }

  private fallbackSync(options: BackgroundSyncOptions): void {
    // Implement fallback sync mechanism
    const syncData = localStorage.getItem(`sync_${options.tag}_lastRun`);
    const lastRun = syncData ? parseInt(syncData, 10) : 0;
    const now = Date.now();

    if (!options.minInterval || now - lastRun >= options.minInterval) {
      // Trigger sync manually
      this.triggerManualSync(options.tag);
      localStorage.setItem(`sync_${options.tag}_lastRun`, now.toString());
    }

    // Schedule next sync
    if (options.minInterval) {
      setTimeout(() => this.fallbackSync(options), options.minInterval);
    }
  }

  private async triggerManualSync(tag: string): Promise<void> {
    // Send message to service worker to trigger sync
    if (this.registration && this.registration.active) {
      this.registration.active.postMessage({
        type: 'MANUAL_SYNC',
        tag,
      });
    }
  }

  async getTags(): Promise<string[]> {
    if (!this.registration) {
      return [];
    }

    try {
      return await this.registration.sync.getTags();
    } catch (error) {
      console.error('[BackgroundSync] Failed to get tags:', error);
      return Array.from(this.syncTags.keys());
    }
  }
}

export const backgroundSync = new BackgroundSyncManager();
```

## Performance Optimization Techniques

Optimizing PWA performance is crucial for providing a native-like experience.

### Advanced Caching Strategies

```typescript
// src/utils/cacheStrategies.ts
interface CacheStrategy {
  cacheName: string;
  maxAge?: number;
  maxEntries?: number;
  networkTimeoutSeconds?: number;
}

class CacheStrategyManager {
  private strategies: Map<string, CacheStrategy> = new Map();

  constructor() {
    this.initializeStrategies();
  }

  private initializeStrategies(): void {
    // Define cache strategies for different resource types
    this.strategies.set('images', {
      cacheName: 'image-cache-v1',
      maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
      maxEntries: 60,
    });

    this.strategies.set('api-get', {
      cacheName: 'api-cache-v1',
      maxAge: 5 * 60 * 1000, // 5 minutes
      maxEntries: 50,
      networkTimeoutSeconds: 3,
    });

    this.strategies.set('static-assets', {
      cacheName: 'static-cache-v1',
      maxAge: 365 * 24 * 60 * 60 * 1000, // 1 year
    });

    this.strategies.set('documents', {
      cacheName: 'document-cache-v1',
      maxAge: 24 * 60 * 60 * 1000, // 1 day
      maxEntries: 20,
    });
  }

  async applyCacheFirst(request: Request, strategyName: string): Promise<Response> {
    const strategy = this.strategies.get(strategyName);
    if (!strategy) {
      throw new Error(`Unknown strategy: ${strategyName}`);
    }

    const cache = await caches.open(strategy.cacheName);
    const cachedResponse = await cache.match(request);

    if (cachedResponse) {
      const cacheAge = this.getCacheAge(cachedResponse);
      
      if (!strategy.maxAge || cacheAge < strategy.maxAge) {
        // Return cached response and refresh in background
        this.refreshCache(request, cache);
        return cachedResponse;
      }
    }

    // Fetch from network
    const networkResponse = await fetch(request);
    
    if (networkResponse.ok) {
      await this.updateCache(cache, request, networkResponse.clone(), strategy);
    }

    return networkResponse;
  }

  async applyNetworkFirst(request: Request, strategyName: string): Promise<Response> {
    const strategy = this.strategies.get(strategyName);
    if (!strategy) {
      throw new Error(`Unknown strategy: ${strategyName}`);
    }

    const cache = await caches.open(strategy.cacheName);

    try {
      const networkPromise = fetch(request);
      
      if (strategy.networkTimeoutSeconds) {
        // Race between network and timeout
        const timeoutPromise = new Promise<Response>((_, reject) => 
          setTimeout(() => reject(new Error('Network timeout')), 
            strategy.networkTimeoutSeconds! * 1000)
        );

        const networkResponse = await Promise.race([networkPromise, timeoutPromise]);
        
        if (networkResponse.ok) {
          await this.updateCache(cache, request, networkResponse.clone(), strategy);
        }
        
        return networkResponse;
      } else {
        const networkResponse = await networkPromise;
        
        if (networkResponse.ok) {
          await this.updateCache(cache, request, networkResponse.clone(), strategy);
        }
        
        return networkResponse;
      }
    } catch (error) {
      // Fallback to cache
      const cachedResponse = await cache.match(request);
      
      if (cachedResponse) {
        return cachedResponse;
      }
      
      throw error;
    }
  }

  async applyStaleWhileRevalidate(request: Request, strategyName: string): Promise<Response> {
    const strategy = this.strategies.get(strategyName);
    if (!strategy) {
      throw new Error(`Unknown strategy: ${strategyName}`);
    }

    const cache = await caches.open(strategy.cacheName);
    const cachedResponse = await cache.match(request);

    const fetchPromise = fetch(request).then(async (networkResponse) => {
      if (networkResponse.ok) {
        await this.updateCache(cache, request, networkResponse.clone(), strategy);
      }
      return networkResponse;
    });

    return cachedResponse || fetchPromise;
  }

  private async updateCache(
    cache: Cache, 
    request: Request, 
    response: Response, 
    strategy: CacheStrategy
  ): Promise<void> {
    // Add cache metadata
    const headers = new Headers(response.headers);
    headers.set('sw-cache-date', new Date().toISOString());

    const responseWithMetadata = new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });

    await cache.put(request, responseWithMetadata);

    // Trim cache if needed
    if (strategy.maxEntries) {
      await this.trimCache(cache, strategy.maxEntries);
    }
  }

  private async trimCache(cache: Cache, maxEntries: number): Promise<void> {
    const keys = await cache.keys();
    
    if (keys.length > maxEntries) {
      const entriesToDelete = keys.length - maxEntries;
      const keysToDelete = keys.slice(0, entriesToDelete);
      
      await Promise.all(keysToDelete.map(key => cache.delete(key)));
    }
  }

  private async refreshCache(request: Request, cache: Cache): Promise<void> {
    try {
      const freshResponse = await fetch(request);
      if (freshResponse.ok) {
        await cache.put(request, freshResponse);
      }
    } catch (error) {
      // Silent fail - we already returned cached response
    }
  }

  private getCacheAge(response: Response): number {
    const cacheDate = response.headers.get('sw-cache-date');
    if (!cacheDate) {
      return Infinity;
    }
    
    return Date.now() - new Date(cacheDate).getTime();
  }
}

export const cacheManager = new CacheStrategyManager();
```

### Resource Loading Optimization

```typescript
// src/utils/resourceLoader.ts
interface ResourceHint {
  url: string;
  as?: string;
  type?: string;
  crossOrigin?: string;
}

class ResourceLoader {
  private loadedResources: Set<string> = new Set();
  private resourceObserver: IntersectionObserver | null = null;

  constructor() {
    this.initializeObserver();
  }

  private initializeObserver(): void {
    if ('IntersectionObserver' in window) {
      this.resourceObserver = new IntersectionObserver(
        (entries) => {
          entries.forEach(entry => {
            if (entry.isIntersecting) {
              this.loadLazyResource(entry.target as HTMLElement);
            }
          });
        },
        {
          rootMargin: '50px',
        }
      );
    }
  }

  preloadResource(hint: ResourceHint): void {
    if (this.loadedResources.has(hint.url)) {
      return;
    }

    const link = document.createElement('link');
    link.rel = 'preload';
    link.href = hint.url;
    
    if (hint.as) {
      link.as = hint.as;
    }
    
    if (hint.type) {
      link.type = hint.type;
    }
    
    if (hint.crossOrigin) {
      link.crossOrigin = hint.crossOrigin;
    }

    document.head.appendChild(link);
    this.loadedResources.add(hint.url);
  }

  prefetchResource(url: string): void {
    if (this.loadedResources.has(url)) {
      return;
    }

    const link = document.createElement('link');
    link.rel = 'prefetch';
    link.href = url;
    
    document.head.appendChild(link);
    this.loadedResources.add(url);
  }

  preconnect(origin: string): void {
    const link = document.createElement('link');
    link.rel = 'preconnect';
    link.href = origin;
    link.crossOrigin = 'anonymous';
    
    document.head.appendChild(link);
  }

  dnsPrefetch(hostname: string): void {
    const link = document.createElement('link');
    link.rel = 'dns-prefetch';
    link.href = `//${hostname}`;
    
    document.head.appendChild(link);
  }

  lazyLoadImages(container: HTMLElement = document.body): void {
    const images = container.querySelectorAll('img[data-src]');
    
    images.forEach(img => {
      if (this.resourceObserver) {
        this.resourceObserver.observe(img);
      } else {
        // Fallback for browsers without IntersectionObserver
        this.loadLazyResource(img as HTMLElement);
      }
    });
  }

  private loadLazyResource(element: HTMLElement): void {
    if (element.tagName === 'IMG') {
      const img = element as HTMLImageElement;
      const src = img.dataset.src;
      
      if (src) {
        // Preload image
        const tempImg = new Image();
        
        tempImg.onload = () => {
          img.src = src;
          img.classList.add('loaded');
          delete img.dataset.src;
          
          if (this.resourceObserver) {
            this.resourceObserver.unobserve(element);
          }
        };
        
        tempImg.src = src;
      }
    }
  }

  async loadScript(url: string, options?: {
    async?: boolean;
    defer?: boolean;
    module?: boolean;
  }): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.loadedResources.has(url)) {
        resolve();
        return;
      }

      const script = document.createElement('script');
      script.src = url;
      
      if (options?.async) {
        script.async = true;
      }
      
      if (options?.defer) {
        script.defer = true;
      }
      
      if (options?.module) {
        script.type = 'module';
      }

      script.onload = () => {
        this.loadedResources.add(url);
        resolve();
      };
      
      script.onerror = () => {
        reject(new Error(`Failed to load script: ${url}`));
      };

      document.head.appendChild(script);
    });
  }

  async loadCSS(url: string, options?: {
    media?: string;
    preload?: boolean;
  }): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.loadedResources.has(url)) {
        resolve();
        return;
      }

      if (options?.preload) {
        // Preload CSS and apply when ready
        const link = document.createElement('link');
        link.rel = 'preload';
        link.as = 'style';
        link.href = url;
        
        link.onload = () => {
          link.onload = null;
          link.rel = 'stylesheet';
          
          if (options.media) {
            link.media = options.media;
          }
          
          this.loadedResources.add(url);
          resolve();
        };
        
        link.onerror = () => {
          reject(new Error(`Failed to load CSS: ${url}`));
        };

        document.head.appendChild(link);
      } else {
        // Load CSS normally
        const link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = url;
        
        if (options?.media) {
          link.media = options.media;
        }

        link.onload = () => {
          this.loadedResources.add(url);
          resolve();
        };
        
        link.onerror = () => {
          reject(new Error(`Failed to load CSS: ${url}`));
        };

        document.head.appendChild(link);
      }
    });
  }
}

export const resourceLoader = new ResourceLoader();
```

## PWA Deployment to App Stores

PWAs can be deployed to various app stores, extending their reach beyond web browsers.

### App Store Deployment Configuration

```javascript
// build/app-store-config.js
const fs = require('fs');
const path = require('path');

// Google Play Store - TWA (Trusted Web Activity) configuration
const twaConfig = {
  packageId: 'com.example.pwa',
  name: 'My PWA App',
  launcherName: 'My PWA',
  display: 'standalone',
  themeColor: '#2196F3',
  navigationColor: '#000000',
  backgroundColor: '#FFFFFF',
  enableNotifications: true,
  startUrl: '/',
  iconUrl: 'https://example.com/icon-512x512.png',
  splashScreenFadeOutDuration: 300,
  fallbackType: 'customtabs',
  enableSiteSettingsShortcut: true,
  orientation: 'default',
};

// Microsoft Store - PWA configuration
const msStoreConfig = {
  packageIdentityName: 'CompanyName.AppName',
  packageDisplayName: 'My PWA App',
  publisherIdentity: 'CN=Publisher',
  publisherDisplayName: 'Company Name',
  applicationId: 'App',
  displayName: 'My PWA App',
  startPage: 'https://example.com',
  description: 'My Progressive Web App',
  visualElements: {
    displayName: 'My PWA App',
    description: 'My Progressive Web App',
    backgroundColor: '#FFFFFF',
    foregroundText: 'light',
    showNameOnSquare150x150Logo: 'on',
  },
};

// iOS - Web App Manifest additions
const iosConfig = {
  'apple-mobile-web-app-capable': 'yes',
  'apple-mobile-web-app-status-bar-style': 'black-translucent',
  'apple-mobile-web-app-title': 'My PWA',
  'apple-touch-icon': '/icons/apple-touch-icon.png',
  'apple-touch-startup-image': [
    {
      href: '/splash/launch-640x1136.png',
      media: '(device-width: 320px) and (device-height: 568px) and (-webkit-device-pixel-ratio: 2)',
    },
    {
      href: '/splash/launch-750x1334.png',
      media: '(device-width: 375px) and (device-height: 667px) and (-webkit-device-pixel-ratio: 2)',
    },
    {
      href: '/splash/launch-1242x2208.png',
      media: '(device-width: 414px) and (device-height: 736px) and (-webkit-device-pixel-ratio: 3)',
    },
    {
      href: '/splash/launch-1125x2436.png',
      media: '(device-width: 375px) and (device-height: 812px) and (-webkit-device-pixel-ratio: 3)',
    },
    {
      href: '/splash/launch-1536x2048.png',
      media: '(device-width: 768px) and (device-height: 1024px) and (-webkit-device-pixel-ratio: 2)',
    },
    {
      href: '/splash/launch-2048x2732.png',
      media: '(device-width: 1024px) and (device-height: 1366px) and (-webkit-device-pixel-ratio: 2)',
    },
  ],
};

// Generate platform-specific configurations
function generateAppStoreConfigs() {
  // TWA asset links for Android
  const assetLinks = [{
    relation: ['delegate_permission/common.handle_all_urls'],
    target: {
      namespace: 'android_app',
      package_name: twaConfig.packageId,
      sha256_cert_fingerprints: [process.env.TWA_CERT_FINGERPRINT],
    },
  }];

  fs.writeFileSync(
    path.join(__dirname, '../public/.well-known/assetlinks.json'),
    JSON.stringify(assetLinks, null, 2)
  );

  // Generate iOS meta tags
  const iosMetaTags = Object.entries(iosConfig)
    .filter(([key]) => !key.includes('startup-image'))
    .map(([key, value]) => `<meta name="${key}" content="${value}">`)
    .join('\n');

  const iosStartupImages = iosConfig['apple-touch-startup-image']
    .map(img => `<link rel="apple-touch-startup-image" href="${img.href}" media="${img.media}">`)
    .join('\n');

  // Update index.html with iOS tags
  const indexPath = path.join(__dirname, '../public/index.html');
  let indexContent = fs.readFileSync(indexPath, 'utf8');
  
  indexContent = indexContent.replace(
    '<!-- iOS META TAGS -->',
    `${iosMetaTags}\n${iosStartupImages}`
  );
  
  fs.writeFileSync(indexPath, indexContent);

  console.log('App store configurations generated successfully');
}

generateAppStoreConfigs();
```

### Web App Manifest for Maximum Compatibility

```json
{
  "name": "My Progressive Web App",
  "short_name": "My PWA",
  "description": "A powerful Progressive Web App with offline capabilities",
  "start_url": "/?utm_source=pwa",
  "display": "standalone",
  "orientation": "any",
  "theme_color": "#2196F3",
  "background_color": "#FFFFFF",
  "scope": "/",
  "lang": "en-US",
  "dir": "ltr",
  "categories": ["productivity", "utilities"],
  "iarc_rating_id": "e84b072d-71b3-4d3e-86ae-31a8ce4e53b7",
  "prefer_related_applications": false,
  "icons": [
    {
      "src": "/icons/icon-72x72.png",
      "sizes": "72x72",
      "type": "image/png",
      "purpose": "any"
    },
    {
      "src": "/icons/icon-96x96.png",
      "sizes": "96x96",
      "type": "image/png",
      "purpose": "any"
    },
    {
      "src": "/icons/icon-128x128.png",
      "sizes": "128x128",
      "type": "image/png",
      "purpose": "any"
    },
    {
      "src": "/icons/icon-144x144.png",
      "sizes": "144x144",
      "type": "image/png",
      "purpose": "any"
    },
    {
      "src": "/icons/icon-152x152.png",
      "sizes": "152x152",
      "type": "image/png",
      "purpose": "any"
    },
    {
      "src": "/icons/icon-192x192.png",
      "sizes": "192x192",
      "type": "image/png",
      "purpose": "any"
    },
    {
      "src": "/icons/icon-384x384.png",
      "sizes": "384x384",
      "type": "image/png",
      "purpose": "any"
    },
    {
      "src": "/icons/icon-512x512.png",
      "sizes": "512x512",
      "type": "image/png",
      "purpose": "any"
    },
    {
      "src": "/icons/icon-maskable-192x192.png",
      "sizes": "192x192",
      "type": "image/png",
      "purpose": "maskable"
    },
    {
      "src": "/icons/icon-maskable-512x512.png",
      "sizes": "512x512",
      "type": "image/png",
      "purpose": "maskable"
    }
  ],
  "screenshots": [
    {
      "src": "/screenshots/mobile-home.png",
      "sizes": "412x915",
      "type": "image/png",
      "form_factor": "narrow",
      "label": "Home screen on mobile"
    },
    {
      "src": "/screenshots/mobile-offline.png",
      "sizes": "412x915",
      "type": "image/png",
      "form_factor": "narrow",
      "label": "Offline functionality"
    },
    {
      "src": "/screenshots/desktop-home.png",
      "sizes": "1920x1080",
      "type": "image/png",
      "form_factor": "wide",
      "label": "Home screen on desktop"
    }
  ],
  "shortcuts": [
    {
      "name": "New Post",
      "short_name": "Post",
      "description": "Create a new post",
      "url": "/new-post?utm_source=shortcut",
      "icons": [
        {
          "src": "/icons/new-post-96x96.png",
          "sizes": "96x96",
          "type": "image/png"
        }
      ]
    },
    {
      "name": "Messages",
      "short_name": "Messages",
      "description": "View messages",
      "url": "/messages?utm_source=shortcut",
      "icons": [
        {
          "src": "/icons/messages-96x96.png",
          "sizes": "96x96",
          "type": "image/png"
        }
      ]
    }
  ],
  "share_target": {
    "action": "/share",
    "method": "POST",
    "enctype": "multipart/form-data",
    "params": {
      "title": "title",
      "text": "text",
      "url": "url",
      "files": [
        {
          "name": "media",
          "accept": ["image/*", "video/*"]
        }
      ]
    }
  },
  "protocol_handlers": [
    {
      "protocol": "web+mypwa",
      "url": "/protocol?type=%s"
    }
  ],
  "related_applications": [
    {
      "platform": "play",
      "url": "https://play.google.com/store/apps/details?id=com.example.pwa",
      "id": "com.example.pwa"
    },
    {
      "platform": "windows",
      "url": "https://www.microsoft.com/store/apps/ABCDEF123456"
    }
  ],
  "display_override": ["window-controls-overlay", "standalone", "browser"],
  "edge_side_panel": {
    "preferred_width": 400
  }
}
```

## Enterprise Security Considerations

Security is paramount when deploying PWAs in enterprise environments.

### Security Headers Implementation

```typescript
// src/security/headers.ts
export const securityHeaders = {
  'Content-Security-Policy': [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://trusted-cdn.com",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "img-src 'self' data: https: blob:",
    "font-src 'self' https://fonts.gstatic.com",
    "connect-src 'self' https://api.example.com wss://ws.example.com",
    "media-src 'self'",
    "object-src 'none'",
    "frame-src 'self'",
    "worker-src 'self'",
    "manifest-src 'self'",
    "form-action 'self'",
    "base-uri 'self'",
    "upgrade-insecure-requests",
  ].join('; '),
  
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains; preload',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'X-XSS-Protection': '1; mode=block',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': [
    'accelerometer=()',
    'camera=()',
    'geolocation=(self)',
    'gyroscope=()',
    'magnetometer=()',
    'microphone=()',
    'payment=()',
    'usb=()',
  ].join(', '),
  
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

// Express middleware
export function applySecurityHeaders(req: Request, res: Response, next: NextFunction) {
  Object.entries(securityHeaders).forEach(([header, value]) => {
    res.setHeader(header, value);
  });
  
  // Remove sensitive headers
  res.removeHeader('X-Powered-By');
  res.removeHeader('Server');
  
  next();
}
```

### Service Worker Security

```javascript
// sw-security.js
// Implement request validation in service worker
self.addEventListener('fetch', (event) => {
  const { request } = event;
  
  // Validate request origin
  if (!isValidOrigin(request.url)) {
    event.respondWith(new Response('Forbidden', { status: 403 }));
    return;
  }
  
  // Implement request filtering
  if (shouldBlockRequest(request)) {
    event.respondWith(new Response('Blocked', { status: 403 }));
    return;
  }
  
  // Continue with normal fetch handling
  event.respondWith(handleFetch(request));
});

function isValidOrigin(url) {
  const allowedOrigins = [
    'https://example.com',
    'https://api.example.com',
    'https://cdn.example.com',
  ];
  
  const origin = new URL(url).origin;
  return allowedOrigins.includes(origin);
}

function shouldBlockRequest(request) {
  // Block requests with suspicious patterns
  const blockedPatterns = [
    /\.\.\//,  // Path traversal
    /<script/i, // Script injection
    /javascript:/i, // JavaScript protocol
  ];
  
  const url = request.url;
  return blockedPatterns.some(pattern => pattern.test(url));
}

// Implement SubResource Integrity for critical resources
const resourceIntegrity = new Map([
  ['/js/app.js', 'sha384-oqVuAfXRKap7fdgcCY5uykM6+R9GqQ8K/uxy9rx7HNQlGYl1kPzQho1wx4JwY8wC'],
  ['/css/main.css', 'sha384-9aIt2nRpC12Uk9gS9baDl411NQApFmC26EwAOH8WgZl5MYYxFfc+NcPb1dKGj7Sk'],
]);

async function verifyResourceIntegrity(request, response) {
  const expectedIntegrity = resourceIntegrity.get(new URL(request.url).pathname);
  
  if (!expectedIntegrity) {
    return response;
  }
  
  const buffer = await response.arrayBuffer();
  const hash = await crypto.subtle.digest('SHA-384', buffer);
  const hashBase64 = btoa(String.fromCharCode(...new Uint8Array(hash)));
  
  if (`sha384-${hashBase64}` !== expectedIntegrity) {
    throw new Error('Resource integrity check failed');
  }
  
  return new Response(buffer, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}
```

## Performance Monitoring and Analytics

Implementing comprehensive monitoring ensures optimal PWA performance in production.

```typescript
// src/monitoring/performance.ts
class PWAPerformanceMonitor {
  private metrics: Map<string, any> = new Map();
  private observer: PerformanceObserver | null = null;

  constructor() {
    this.initializeMonitoring();
  }

  private initializeMonitoring(): void {
    // Web Vitals
    this.measureWebVitals();
    
    // PWA-specific metrics
    this.measurePWAMetrics();
    
    // Service Worker metrics
    this.measureServiceWorkerMetrics();
    
    // Cache performance
    this.measureCachePerformance();
  }

  private measureWebVitals(): void {
    // Largest Contentful Paint (LCP)
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        this.recordMetric('lcp', entry.startTime);
      }
    }).observe({ entryTypes: ['largest-contentful-paint'] });

    // First Input Delay (FID)
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        const fid = entry.processingStart - entry.startTime;
        this.recordMetric('fid', fid);
      }
    }).observe({ entryTypes: ['first-input'] });

    // Cumulative Layout Shift (CLS)
    let clsValue = 0;
    let clsEntries: PerformanceEntry[] = [];

    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (!(entry as any).hadRecentInput) {
          clsValue += (entry as any).value;
          clsEntries.push(entry);
        }
      }
      this.recordMetric('cls', clsValue);
    }).observe({ entryTypes: ['layout-shift'] });
  }

  private measurePWAMetrics(): void {
    // Time to interactive
    if ('PerformanceObserver' in window) {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (entry.name === 'time-to-interactive') {
            this.recordMetric('tti', entry.startTime);
          }
        }
      }).observe({ entryTypes: ['measure'] });
    }

    // App install metrics
    window.addEventListener('appinstalled', () => {
      this.recordEvent('app_installed', {
        timestamp: Date.now(),
      });
    });

    // Offline usage
    window.addEventListener('online', () => {
      const offlineDuration = this.metrics.get('offline_start') 
        ? Date.now() - this.metrics.get('offline_start')
        : 0;
      
      this.recordMetric('offline_duration', offlineDuration);
      this.metrics.delete('offline_start');
    });

    window.addEventListener('offline', () => {
      this.metrics.set('offline_start', Date.now());
    });
  }

  private measureServiceWorkerMetrics(): void {
    if ('serviceWorker' in navigator) {
      // Service Worker registration time
      const swStart = performance.now();
      
      navigator.serviceWorker.ready.then(() => {
        this.recordMetric('sw_registration_time', performance.now() - swStart);
      });

      // Listen for SW messages
      navigator.serviceWorker.addEventListener('message', (event) => {
        if (event.data.type === 'CACHE_HIT_RATIO') {
          this.recordMetric('cache_hit_ratio', event.data.ratio);
        }
      });
    }
  }

  private measureCachePerformance(): void {
    // Override fetch to measure cache performance
    const originalFetch = window.fetch;
    
    window.fetch = async (...args) => {
      const start = performance.now();
      const request = args[0] instanceof Request ? args[0] : new Request(args[0]);
      
      try {
        const response = await originalFetch(...args);
        const duration = performance.now() - start;
        
        // Check if response was from cache
        const fromCache = response.headers.get('sw-cache-status') === 'HIT';
        
        this.recordFetchMetric({
          url: request.url,
          method: request.method,
          duration,
          fromCache,
          status: response.status,
        });
        
        return response;
      } catch (error) {
        const duration = performance.now() - start;
        
        this.recordFetchMetric({
          url: request.url,
          method: request.method,
          duration,
          fromCache: false,
          status: 0,
          error: true,
        });
        
        throw error;
      }
    };
  }

  private recordMetric(name: string, value: number): void {
    this.metrics.set(name, value);
    
    // Send to analytics
    this.sendToAnalytics({
      type: 'metric',
      name,
      value,
      timestamp: Date.now(),
    });
  }

  private recordEvent(name: string, data: any): void {
    this.sendToAnalytics({
      type: 'event',
      name,
      data,
      timestamp: Date.now(),
    });
  }

  private recordFetchMetric(data: any): void {
    // Aggregate fetch metrics
    const fetchMetrics = this.metrics.get('fetch_metrics') || {
      total: 0,
      cached: 0,
      failed: 0,
      totalDuration: 0,
    };
    
    fetchMetrics.total++;
    if (data.fromCache) fetchMetrics.cached++;
    if (data.error) fetchMetrics.failed++;
    fetchMetrics.totalDuration += data.duration;
    
    this.metrics.set('fetch_metrics', fetchMetrics);
  }

  private sendToAnalytics(data: any): void {
    // Use sendBeacon for reliability
    if ('sendBeacon' in navigator) {
      navigator.sendBeacon('/api/analytics', JSON.stringify(data));
    } else {
      // Fallback to fetch
      fetch('/api/analytics', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      }).catch(() => {
        // Store in IndexedDB for later sync
        this.storeForLaterSync(data);
      });
    }
  }

  private async storeForLaterSync(data: any): Promise<void> {
    // Store analytics data in IndexedDB for background sync
    const db = await appDb.open();
    await appDb.put('analytics', data);
  }

  public getMetrics(): Record<string, any> {
    return Object.fromEntries(this.metrics);
  }
}

export const performanceMonitor = new PWAPerformanceMonitor();
```

## Conclusion

Progressive Web Apps represent the future of web development, bridging the gap between web and native applications. Key takeaways from this comprehensive guide include:

1. **Service Workers** are the foundation of PWA functionality, enabling offline capabilities, background sync, and push notifications
2. **Offline-First Architecture** ensures reliable performance regardless of network conditions
3. **Performance Optimization** through intelligent caching strategies and resource loading is crucial for user experience
4. **Security** must be built-in from the ground up with proper CSP, HTTPS, and validation
5. **App Store Deployment** extends PWA reach to traditional app distribution channels
6. **Monitoring and Analytics** provide insights for continuous improvement

By implementing these advanced techniques and best practices, you can build PWAs that deliver exceptional user experiences while maintaining the flexibility and reach of web technologies. The future of web applications is progressive, and with these tools and strategies, you're well-equipped to build the next generation of web experiences.