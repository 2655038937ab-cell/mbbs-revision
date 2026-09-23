/* Service worker: makes the app installable (PWA) and keeps what you have already
 * studied readable offline — on a plane, in a lecture hall with no wifi.
 *
 * Strategy, and why it is not simply "cache everything":
 *
 *   navigation (the HTML shell)   network-first with a short timeout. The app is
 *                                 updated often, and a stale index.html would load
 *                                 a stale app.js; when online this always gets the
 *                                 current build, and the cache only serves offline.
 *   /api/store/*  and config      stale-while-revalidate. This is the study content
 *                                 (lessons, cards, questions, key points — images
 *                                 travel inside these payloads as data URLs), so a
 *                                 lecture you opened before stays readable offline,
 *                                 and every online visit refreshes it in the
 *                                 background for the next load.
 *   static assets (js/css/vendor) cache-first + background revalidate: large, rarely
 *                                 changed, and the server already answers with an
 *                                 ETag, so the revalidate is a cheap 304.
 *   any non-GET request           never touched. Grading a card, saving a note or
 *                                 calling the AI still goes straight to the server;
 *                                 offline those fail exactly as they did before
 *                                 (the UI already reports it) instead of pretending
 *                                 to have saved something.
 *
 * Growth is bounded: the content cache keeps the newest ~200 responses and is
 * trimmed to roughly 250 MB, dropping the oldest entries first.
 */
// Shell/asset version: static JS and CSS are served cache-first, so a browser that
// has already installed this worker keeps running the previous bundle until its
// background revalidation succeeds — which can leave it on old code for days.
// Bump SHELL_VERSION whenever a file in SHELL below (or any CSS/JS asset) changes;
// the worker then installs anew and re-fetches the shell.
const SHELL_VERSION = "v2";
// The study-content cache has its own version on purpose: bumping it would throw
// away everything a student has downloaded for offline use, and cached lessons
// refresh themselves in the background anyway.
const DATA_VERSION = "v1";
const SHELL_CACHE = "mbbs-shell-" + SHELL_VERSION;
const DATA_CACHE = "mbbs-data-" + DATA_VERSION;
const ASSET_CACHE = "mbbs-assets-" + SHELL_VERSION;

const SHELL = [
  "./",
  "index.html",
  "css/style.css",
  "js/app.js",
  "js/db.js",
  "js/api.js",
  "js/sm2.js",
  "js/markdown.js",
  "js/pwa.js",
  "js/features/launcher.js",
  "vendor/katex/katex.min.css",
  "vendor/katex/katex.min.js",
  "manifest.webmanifest",
  "icon-192.png",
  "icon-512.png",
  "apple-touch-icon.png",
];

const DATA_MAX_ENTRIES = 200;
const DATA_MAX_BYTES = 250 * 1024 * 1024;

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    // Individually so one missing file (a vendor rename) cannot fail the install.
    await Promise.all(SHELL.map((url) => cache.add(new Request(url, { cache: "reload" })).catch(() => {})));
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names
      .filter((n) => n.startsWith("mbbs-") && ![SHELL_CACHE, DATA_CACHE, ASSET_CACHE].includes(n))
      .map((n) => caches.delete(n)));
    await self.clients.claim();
  })());
});

const isData = (url) => url.pathname.startsWith("/api/store/")
  || ["/api/config", "/api/classification", "/api/auth/me", "/api/health", "/api/folders"].includes(url.pathname);
const isAsset = (url) => /\.(?:js|css|png|jpg|jpeg|svg|ico|woff2?|webmanifest)$/.test(url.pathname);

async function trimDataCache(cache) {
  const keys = await cache.keys();
  if (keys.length > DATA_MAX_ENTRIES) {
    for (const key of keys.slice(0, keys.length - DATA_MAX_ENTRIES)) await cache.delete(key);
  }
  // Byte budget: Content-Length is enough of an estimate for JSON payloads.
  let total = 0;
  const sizes = [];
  for (const req of await cache.keys()) {
    const res = await cache.match(req);
    const len = Number(res?.headers.get("content-length") || 0);
    sizes.push([req, len]);
    total += len;
  }
  if (total > DATA_MAX_BYTES) {
    for (const [req, len] of sizes) {
      if (total <= DATA_MAX_BYTES) break;
      await cache.delete(req);
      total -= len;
    }
  }
}

/* Serve from cache immediately, refresh in the background. */
async function staleWhileRevalidate(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  const network = fetch(request).then(async (res) => {
    if (res && res.ok) {
      await cache.put(request, res.clone());
      if (cacheName === DATA_CACHE) trimDataCache(cache);
    }
    return res;
  }).catch(() => null);
  return cached || (await network) || Response.error();
}

/* Try the network, fall back to the cache (used for the HTML shell and API GETs
   that are not study content). */
async function networkFirst(request, cacheName, timeoutMs = 3500) {
  const cache = await caches.open(cacheName);
  try {
    const res = await Promise.race([
      fetch(request),
      new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), timeoutMs)),
    ]);
    if (res && res.ok) cache.put(request, res.clone()).catch(() => {});
    return res;
  } catch (err) {
    const cached = await cache.match(request);
    if (cached) return cached;
    throw err;
  }
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;                 // writes always go to the server
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;  // never touch third parties
  if (url.pathname.startsWith("/api/llm") || url.pathname.startsWith("/api/vision")) return;

  if (req.mode === "navigate") {
    event.respondWith((async () => {
      try {
        return await networkFirst(req, SHELL_CACHE);
      } catch (err) {
        const cache = await caches.open(SHELL_CACHE);
        return (await cache.match("index.html")) || (await cache.match("./")) || new Response(
          "<!doctype html><meta charset=utf-8><title>离线</title><body style='font-family:system-ui;padding:40px;text-align:center'>"
          + "<h2>📴 现在没有网络</h2><p>这一页还没有被缓存。联网后再打开一次，它就会离线可用。</p></body>",
          { headers: { "Content-Type": "text/html; charset=utf-8" } });
      }
    })());
    return;
  }

  if (isData(url)) { event.respondWith(staleWhileRevalidate(req, DATA_CACHE)); return; }
  if (url.pathname.startsWith("/api/")) { event.respondWith(networkFirst(req, DATA_CACHE, 6000)); return; }
  if (isAsset(url)) { event.respondWith(staleWhileRevalidate(req, ASSET_CACHE)); return; }
});

/* A saved record must not keep being served from the offline copy of an older
   response: drop every cached answer that could contain it. The record itself and
   the list it belongs to are both affected. */
async function invalidateStore(store, id) {
  if (!store) return;
  const cache = await caches.open(DATA_CACHE);
  const base = `/api/store/${store}`;
  for (const req of await cache.keys()) {
    const path = new URL(req.url).pathname;
    if (path === base || path.startsWith(base + "/")) {
      if (id && path !== base && !path.endsWith("/" + id)) continue;
      await cache.delete(req);
    }
  }
}

self.addEventListener("message", (event) => {
  const msg = event.data || {};
  if (msg.type === "store-changed") {
    event.waitUntil(invalidateStore(String(msg.store || ""), String(msg.id || "")));
    return;
  }
  if (msg.type === "clear-offline") {
    event.waitUntil(Promise.all([caches.delete(DATA_CACHE), caches.delete(ASSET_CACHE)])
      .then(() => event.source && event.source.postMessage({ type: "offline-cleared" })));
  }
  if (msg.type === "offline-info") {
    event.waitUntil((async () => {
      const cache = await caches.open(DATA_CACHE);
      const keys = await cache.keys();
      let bytes = 0;
      for (const req of keys) {
        const res = await cache.match(req);
        bytes += Number(res?.headers.get("content-length") || 0);
      }
      event.source && event.source.postMessage({ type: "offline-info", lessons: keys.length, bytes });
    })());
  }
});
