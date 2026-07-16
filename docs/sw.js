/* Traverse service worker.
 *
 * The whole point of a client-side agenda is that it still opens in a basement
 * seminar room with no signal: cache the shell and the programme data. The
 * language model is NOT handled here — transformers.js keeps its own Cache
 * Storage for the ONNX files — but the CDN-hosted library itself is, since
 * without it a cached model can't run.
 *
 * Same-origin requests are served stale-while-revalidate: an update deploys on
 * the visit after next, which is the right trade for a page whose data changes
 * a handful of times before the conference. jsdelivr URLs are versioned, so
 * cache-first is safe there.
 */

const CACHE = "traverse-v1";
const SHELL = [
  "./", "index.html", "style.css", "app.js", "scholar.js",
  "data/meta.json", "data/sessions.json", "data/facets.json", "data/embeddings.bin",
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET") return;
  const url = new URL(e.request.url);
  if (url.origin === location.origin) {
    e.respondWith(staleWhileRevalidate(e.request));
  } else if (url.hostname === "cdn.jsdelivr.net") {
    e.respondWith(cacheFirst(e.request));
  }
  // Everything else (fonts, HF model files) goes straight to the network.
});

async function staleWhileRevalidate(req) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(req);
  const refresh = fetch(req)
    .then((res) => {
      if (res.ok) cache.put(req, res.clone());
      return res;
    })
    .catch(() => hit);
  return hit || refresh;
}

async function cacheFirst(req) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok) cache.put(req, res.clone());
  return res;
}
