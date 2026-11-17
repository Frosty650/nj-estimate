/* Keeps the app working without a connection. Bump VERSION with every release so phones pick up the update.
   Shares its web address (yourname.github.io) with Activity Entry: it removes only its own old caches, and it refills
   its cache from any online visit, in case another app on the same address has removed it. */
const PREFIX = "nj-estimate-";
const VERSION = PREFIX + "1.0.0";
const FILES = ["./", "index.html", "app.css", "manifest.webmanifest", "js/app.js", "js/engine.js", "js/tables.js",
  "icons/icon-180.png", "icons/icon-192.png", "icons/icon-512.png", "icons/favicon-64.png", "icons/logo.png"];

self.addEventListener("install", (ev) => {
  ev.waitUntil(caches.open(VERSION).then((c) => c.addAll(FILES.map((f) => new Request(f, { cache: "reload" }))))
    .then(() => self.skipWaiting()));
});
self.addEventListener("activate", (ev) => {
  ev.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k.startsWith(PREFIX) && k !== VERSION).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});
function fromNetwork(req, key) {
  return fetch(req).then((res) => {
    if (res && res.ok) {
      const copy = res.clone();
      caches.open(VERSION).then((c) => c.put(key || req, copy)).catch(() => {});
    }
    return res;
  });
}
self.addEventListener("fetch", (ev) => {
  const req = ev.request;
  if (req.method !== "GET" || new URL(req.url).origin !== location.origin) return;
  if (req.mode === "navigate") {
    ev.respondWith(caches.open(VERSION).then((c) => c.match("index.html"))
      .then((r) => r || fromNetwork(req, "index.html")));
    return;
  }
  ev.respondWith(caches.open(VERSION).then((c) => c.match(req, { ignoreSearch: true }))
    .then((r) => r || fromNetwork(req)));
});
