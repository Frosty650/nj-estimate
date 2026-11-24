/* Keeps the app working without a connection. Bump VERSION with every release so phones pick up the update. */
const VERSION = "ae-phone-1.1.0";
const FILES = ["./", "index.html", "app.css", "config.js", "manifest.webmanifest", "js/app.js", "js/core.js", "js/names.js",
  "js/dropbox.js", "js/xlsx.mini.min.js", "icons/icon-180.png", "icons/icon-192.png", "icons/icon-512.png",
  "icons/stopwatch.png", "icons/favicon-64.png"];

self.addEventListener("install", (ev) => {
  ev.waitUntil(caches.open(VERSION).then((c) => c.addAll(FILES.map((f) => new Request(f, { cache: "reload" })))));
});
self.addEventListener("activate", (ev) => {
  ev.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener("message", (ev) => { if (ev.data === "skipWaiting") self.skipWaiting(); });
self.addEventListener("fetch", (ev) => {
  const req = ev.request;
  const url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== location.origin) return;     // Dropbox calls go straight out
  if (req.mode === "navigate") {
    ev.respondWith(caches.match("index.html").then((r) => r || fetch(req)));   // also when returning from sign-in (?code=)
    return;
  }
  ev.respondWith(caches.match(req, { ignoreSearch: true }).then((r) => r || fetch(req)));
});
