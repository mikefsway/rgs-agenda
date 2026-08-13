/* Agenda Navigator service worker.
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

// v2: bumped for the embedding-backend fixes of 16 Jul 2026, and because a
// version bump is the only way to guarantee every cached file comes from the
// same deploy — v1 refreshed each file on its own schedule, so a stale
// embeddings.bin could sit beside a fresh facets.json indefinitely.
// v3: the final programme (11 Aug 2026) changed all four data files at once —
// exactly the case stale-while-revalidate gets wrong on its own.
// v4: rooms for the 164 RGS-IBG sessions, which arrive on virtual_stage rather
// than virtual_venue. Mandatory rather than cosmetic: sessions.json was
// reordered, so a cached embeddings.bin beside the new sessions.json now trips
// the order_sig check and refuses to load at all.
// v5: the redesign. index.html, style.css and app.js changed together — the
// markup and the stylesheet have to arrive from the same deploy or the route
// renders unstyled against a grid that no longer exists.
// v6: the email redaction of 12 Aug 2026. All four data files changed together
// (normalize.py rewrote descriptions, so embed.py had to re-run), which is the
// case stale-while-revalidate cannot get right on its own — and here a stale
// copy is not merely inconsistent, it is the unredacted one still sitting in a
// visitor's cache. build.html and build.js landed in the same deploy but are
// deliberately NOT in SHELL: the point of the cache is a route that opens in a
// seminar room with no signal, and nobody needs the porting page offline.
// v11: the HTML-entity fix of 14 Aug 2026. Same programme, same 593 sessions,
// same row order — but 183 strings changed, so sessions.json, facets.json,
// embeddings.bin and meta.json are again only meaningful as a set. A visitor
// left holding the old matrix beside the new facets.json fails the order check
// and gets no route at all, which is the loud version and still not one anybody
// should have to see.
const CACHE = "traverse-v11";
const SHELL = [
  "./", "index.html", "style.css", "app.js", "scholar.js",
  "data/meta.json", "data/sessions.json", "data/facets.json", "data/embeddings.bin",
];

self.addEventListener("install", (e) => {
  // cache: "reload" skips the browser's HTTP cache, so the shell is one
  // coherent snapshot of the deploy, not a mix of whatever was lying around.
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => Promise.all(SHELL.map((u) => c.add(new Request(u, { cache: "reload" })))))
      .then(() => self.skipWaiting())
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
