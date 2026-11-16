const CACHE_NAME = "sawakai-shell-v11";
const BADGE_CACHE = "sawakai-badge";
const scopeUrl = new URL("./", self.registration.scope);
const badgeKey = new URL("__badge-count", scopeUrl).href;

async function readBadgeCount() {
  const cache = await caches.open(BADGE_CACHE);
  const response = await cache.match(badgeKey);
  return response ? Number(await response.text()) || 0 : 0;
}

async function writeBadgeCount(count) {
  const cache = await caches.open(BADGE_CACHE);
  await cache.put(badgeKey, new Response(String(count)));
  if (count > 0) await self.navigator?.setAppBadge?.(count);
  else await self.navigator?.clearAppBadge?.();
}

self.addEventListener("message", (event) => {
  if (event.data?.type === "SAWAKAI_BADGE_SYNC") {
    event.waitUntil(writeBadgeCount(Math.max(0, Number(event.data.count) || 0)));
  }
});
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
      .then((cache) =>
        Promise.allSettled(shellFiles.map((file) => cache.add(file))),
      )
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
            .filter((key) => key !== CACHE_NAME && key !== BADGE_CACHE)
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
  // 配布資料（PDF）はキャッシュや画面のHTMLに置き換えず、そのまま取得する
  if (url.pathname.includes("/docs/") || url.pathname.endsWith(".pdf")) return;

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

  // SPAのフォールバックHTMLを画像などとして保存・再利用しない
  const isHtml = (response) =>
    (response.headers.get("content-type") || "").includes("text/html");

  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached && !isHtml(cached)) return cached;
      return fetch(request).then((response) => {
        if (response.ok && !isHtml(response)) {
          const copy = response.clone();
          void caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
        }
        return response;
      });
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
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

async function bumpDirectCallBadge(tag) {
  const cache = await caches.open(BADGE_CACHE);
  const seenKey = new URL("__badge-tags", scopeUrl).href;
  const response = await cache.match(seenKey);
  const seen = response ? await response.json() : [];
  const tags = Array.isArray(seen)
    ? seen.filter((item) => typeof item === "string")
    : [];
  if (tags.includes(tag)) return;
  tags.push(tag);
  await cache.put(
    seenKey,
    new Response(JSON.stringify(tags.slice(-40)), {
      headers: { "content-type": "application/json" },
    }),
  );
  const count = await readBadgeCount();
  await writeBadgeCount(count + 1);
}

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
    (async () => {
      const clients = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });
      const tag = String(payload.tag || "");
      const isDirectCall = tag.startsWith("dm-");
      const appVisible = clients.some(
        (client) => client.visibilityState === "visible",
      );
      await self.registration.showNotification(title, options);
      if (payload.appBadge) {
        if (isDirectCall) {
          if (!appVisible) await bumpDirectCallBadge(tag);
        } else {
          const count = await readBadgeCount();
          await writeBadgeCount(count + 1);
        }
      }
      for (const client of clients) {
        client.postMessage({ type: "SAWAKAI_PUSH_RECEIVED" });
      }
    })(),
  );
});
