const CACHE_NAME = "sawakai-shell-v6";
const scopeUrl = new URL("./", self.registration.scope);
const shellFiles = [
  scopeUrl.href,
  new URL("manifest.webmanifest", scopeUrl).href,
  new URL("pwa-icon-192.png", scopeUrl).href,
  new URL("pwa-icon-512.png", scopeUrl).href,
  new URL("assets/9cbab.svg", scopeUrl).href,
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(shellFiles))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key !== CACHE_NAME)
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin) return;

  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          void caches.open(CACHE_NAME).then((cache) => cache.put(scopeUrl, copy));
          return response;
        })
        .catch(() => caches.match(scopeUrl)),
    );
    return;
  }

  event.respondWith(
    caches.match(request).then(
      (cached) =>
        cached ??
        fetch(request).then((response) => {
          if (response.ok) {
            const copy = response.clone();
            void caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
          }
          return response;
        }),
    ),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(Promise.resolve(self.navigator?.clearAppBadge?.()));
  event.waitUntil(
    self.clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((clients) => {
        const existing = clients.find((client) =>
          client.url.startsWith(scopeUrl.href),
        );
        return existing ? existing.focus() : self.clients.openWindow(scopeUrl);
      }),
  );
});

self.addEventListener("push", (event) => {
  const payload = event.data?.json?.() ?? {};
  const title = payload.title || "茶話会・みんなで脳活";
  const options = {
    body: payload.body || "新しいメッセージが届きました。",
    tag: payload.tag || "sawakai-message",
    renotify: true,
    icon: new URL("pwa-icon-192.png", scopeUrl).href,
    badge: new URL("pwa-icon-192.png", scopeUrl).href,
    data: {
      url: payload.url || "./",
    },
  };
  event.waitUntil(
    Promise.all([
      self.registration.showNotification(title, options),
      payload.appBadge
        ? self.navigator?.setAppBadge?.()
        : Promise.resolve(),
      self.clients
        .matchAll({ type: "window", includeUncontrolled: true })
        .then((clients) => {
          for (const client of clients) {
            client.postMessage({ type: "SAWAKAI_PUSH_RECEIVED" });
          }
        }),
    ]),
  );
});
