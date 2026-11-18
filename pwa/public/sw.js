/* Service worker: offline shell for iOS/Android PWA. API (/chat, /files, /api) never cached. */
const CACHE = "claw2-pwa-v5";
const PRECACHE = ["/pwa/", "/pwa/index.html", "/pwa/manifest.json", "/pwa/apple-touch-icon.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(PRECACHE).catch(() => {}))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET") return;
  let url;
  try {
    url = new URL(e.request.url);
  } catch {
    return;
  }
  // Only app-shell routes are SW business; cross-origin goes to the browser untouched.
  if (url.origin !== self.location.origin) return;
  // Pathname checks, not substring matches on the full URL: a query string
  // like "?next=/chat" must not opt a shell route out of the cache.
  const p = url.pathname;
  if (p.startsWith("/api/") || p.includes("/files/") || p === "/chat" || p.startsWith("/chat/")) return;
  const cacheable = p.startsWith("/pwa/") || e.request.mode === "navigate";
  e.respondWith(
    fetch(e.request)
      .then((r) => {
        if (r.ok && cacheable) {
          const clone = r.clone();
          caches.open(CACHE).then((cache) => cache.put(e.request, clone)).catch(() => {});
        }
        return r;
      })
      .catch(() => caches.match(e.request).then((hit) => hit || caches.match("/pwa/index.html")))
  );
});
