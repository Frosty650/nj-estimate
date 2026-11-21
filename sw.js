/* Support Calculator - keeps the app working without a connection. Bump VERSION with every release.
   Network first: online, the files always come fresh from the web site (and the saved copy is refreshed); only
   offline is the saved copy used. So a stale or incomplete saved copy can't be served while online.
   Shares its web address (yourname.github.io) with Activity Entry: it removes only its own old caches. */
const PREFIX = "nj-estimate-";
const VERSION = PREFIX + "1.2.0";
const FILES = ["./", "index.html", "app.css", "manifest.webmanifest", "js/app.js", "js/engine.js", "js/engine-ny.js", "js/tables.js",
  "icons/icon-180.png", "icons/icon-192.png", "icons/icon-512.png", "icons/favicon-64.png", "icons/logo.png"];

self.addEventListener("install", (ev) => {
  // Save what can be saved; one missing file doesn't stop the rest (addAll would fail them all).
  ev.waitUntil(caches.open(VERSION)
    .then((c) => Promise.all(FILES.map((f) => c.add(new Request(f, { cache: "reload" })).catch(() => {}))))
    .then(() => self.skipWaiting()));
});
self.addEventListener("activate", (ev) => {
  ev.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k.startsWith(PREFIX) && k !== VERSION).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});
function networkFirst(req, key) {
  // revalidate with the site (GitHub Pages lets browsers keep files 10 minutes); a page load can't take options
  const got = req.mode === "navigate" ? fetch(req) : fetch(req, { cache: "no-cache" });
  return got.then((res) => {
    if (res && res.ok) {
      const copy = res.clone();
      caches.open(VERSION).then((c) => c.put(key || req, copy)).catch(() => {});
    }
    return res;
  }).catch(() => caches.open(VERSION)
    .then((c) => c.match(key || req, { ignoreSearch: true }))
    .then((r) => r || Response.error()));
}
self.addEventListener("fetch", (ev) => {
  const req = ev.request;
  if (req.method !== "GET" || new URL(req.url).origin !== location.origin) return;
  ev.respondWith(networkFirst(req, req.mode === "navigate" ? "index.html" : null));
});
