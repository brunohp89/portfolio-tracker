// Service worker for Portfolio Tracker: keeps the app shell available offline.
// Only same-origin files are cached. Prices, the snapshot and every other cross-origin
// request go straight to the network, so nothing private or stale is served from here.
// Bump CACHE when shipping a change that must drop previously cached files.
const CACHE = "tracker-shell-v2";
const SHELL = ["./", "./index.html", "./lightweight-charts.js", "./tracker.js", "./loader.js", "./manifest.json", "./icon-192.png", "./icon-512.png", "./icon-maskable-512.png"];
const NETWORK_TIMEOUT_MS = 2500;

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

async function fetchAndCache(request) {
  const response = await fetch(request);
  if (response.ok) {
    const cache = await caches.open(CACHE);
    await cache.put(request, response.clone());
  }
  return response;
}

// Fresh copy when the network answers quickly, cached copy otherwise.
async function networkFirst(request) {
  const cached = await caches.match(request, { ignoreSearch: true });
  const network = fetchAndCache(request);
  if (!cached) return network;
  network.catch(() => {});
  const timeout = new Promise((resolve) => setTimeout(() => resolve(cached), NETWORK_TIMEOUT_MS));
  return Promise.race([network.catch(() => cached), timeout]);
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  if (new URL(request.url).origin !== self.location.origin) return;
  event.respondWith(networkFirst(request));
});
