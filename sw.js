/* ============================================================================
   Got Bus Anot? — service worker.

   Makes the app installable and usable offline. Caching strategy mirrors how
   the data is versioned (see scripts/fetch_data.py):

     * App shell (html/css/js/icon)  — cache-first, refreshed on SW update.
     * data/services.json + holidays  — network-first (must stay fresh), with a
                                         cached fallback when offline.
     * data/svc/<SERVICE>.json?v=…    — cache-first; the ?v= is the dataset
                                         version, so a refresh is a new URL and
                                         old shards simply fall out of use.

   Bump CACHE_VERSION when the shell files change to roll the cache over.
   ========================================================================= */

"use strict";

const CACHE_VERSION = "gba-v2";

// App shell — everything needed to boot offline. Kept relative so it works
// under a GitHub Pages project subpath.
const SHELL = [
  ".",
  "index.html",
  "style.css",
  "script.js",
  "logic.js",
  "manifest.webmanifest",
  "fonts/jetbrains-mono-latin.woff2",
  "fonts/jetbrains-mono-latin-ext.woff2",
  "fonts/space-grotesk-latin.woff2",
  "fonts/space-grotesk-latin-ext.woff2",
  "icon.svg",
  "icon-192.png",
  "icon-512.png",
  "apple-touch-icon.png",
  "data/services.json",
  "data/holidays.json",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // only manage same-origin requests

  // Freshness-sensitive index/holidays: network-first, fall back to cache.
  if (url.pathname.endsWith("/data/services.json") ||
      url.pathname.endsWith("/data/holidays.json")) {
    event.respondWith(networkFirst(req));
    return;
  }

  // Navigations: serve the cached shell when offline.
  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req).catch(() => caches.match("index.html", { ignoreSearch: true }))
    );
    return;
  }

  // Everything else (shell assets + versioned shards): cache-first.
  event.respondWith(cacheFirst(req));
});

/** Return the cached response if present, otherwise fetch and cache it. */
async function cacheFirst(req) {
  const cached = await caches.match(req);
  if (cached) return cached;
  const res = await fetch(req);
  if (res && res.ok) {
    const cache = await caches.open(CACHE_VERSION);
    cache.put(req, res.clone());
  }
  return res;
}

/** Try the network (and refresh the cache); fall back to the cache offline. */
async function networkFirst(req) {
  try {
    const res = await fetch(req);
    if (res && res.ok) {
      const cache = await caches.open(CACHE_VERSION);
      cache.put(req, res.clone());
    }
    return res;
  } catch (err) {
    const cached = await caches.match(req, { ignoreSearch: true });
    if (cached) return cached;
    throw err;
  }
}
