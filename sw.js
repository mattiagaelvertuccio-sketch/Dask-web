/* Cache the app shell only. Never cache /d/ data files. */
const SHELL = "desk-shell-v1";
const SHELL_FILES = ["./","index.html","app.css","app.js","chart.js","manifest.json","apple-touch-icon.png","icons/icon-192.png","icons/icon-512.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(SHELL_FILES)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(self.clients.claim());
});
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (url.pathname.includes("/d/")) {
    e.respondWith(fetch(e.request, { cache: "no-store" }));
    return;
  }
  if (e.request.mode === "navigate" || SHELL_FILES.some((f) => url.pathname.endsWith(f.replace("./","")))) {
    e.respondWith(
      fetch(e.request).then((r) => {
        const copy = r.clone();
        caches.open(SHELL).then((c) => c.put(e.request, copy));
        return r;
      }).catch(() => caches.match(e.request).then((r) => r || caches.match("./index.html")))
    );
  }
});
