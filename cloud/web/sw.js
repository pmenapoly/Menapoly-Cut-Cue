// Offline shell only. API calls (/v1/*), review pages and media (storage URLs) are never cached: they are private
// and short-lived, and stale data would show a wrong status.
const VERSION = "cue-shell-2026.10.0";
const SHELL = ["/", "/index.html", "/styles.css", "/app.js", "/api.js", "/upload.js", "/sha256.js", "/hash-worker.js",
  "/manifest.webmanifest", "/icon.svg", "/icon-192.png", "/icon-180.png"];

self.addEventListener("install", (e) => e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())));
self.addEventListener("activate", (e) => e.waitUntil(caches.keys()
  .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim())));
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin || url.pathname.startsWith("/v1/") ||
      url.pathname.startsWith("/review")) return;
  // Network first (fresh code after deploys); fall back to the cached shell when offline.
  e.respondWith(fetch(e.request).then((res) => {
    if (res.ok && res.type === "basic") { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(e.request, copy)); }
    return res;
  }).catch(() => caches.match(e.request).then((hit) => hit || caches.match("/index.html"))));
});
