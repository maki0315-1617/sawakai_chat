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
  try {
    if (count > 0) await self.navigator?.setAppBadge?.(count);
    else await self.navigator?.clearAppBadge?.();
  } catch {
    // ホーム画面に追加していないブラウザでは件数を付けられない
  }
}

function pushEventKey(tag) {
  return new URL(`__push-event/${encodeURIComponent(tag)}`, scopeUrl).href;
}

async function latestPushEventAt(tag) {
  const cache = await caches.open(BADGE_CACHE);
  const response = await cache.match(pushEventKey(tag));
  return response ? Number(await response.text()) || 0 : 0;
}

async function rememberPushEventAt(tag, eventAt) {
  const cache = await caches.open(BADGE_CACHE);
  await cache.put(pushEventKey(tag), new Response(String(eventAt)));
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

self.addEventListener("push", (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = {};
  }
  const title = payload.title || "茶話会・みんなで脳活";
  const tag = String(payload.tag || "sawakai-message");
  const options = {
    body: payload.body || "新しいメッセージが届きました。",
    tag,
    renotify: true,
    icon: new URL("pwa-icon-192.png", scopeUrl).href,
    badge: new URL("pwa-icon-192.png", scopeUrl).href,
    data: {
      url: payload.url || "./",
    },
  };
  event.waitUntil(
    (async () => {
      const eventAt = Number(payload.eventAt) || 0;
      if (eventAt && eventAt <= (await latestPushEventAt(tag))) return;
      await self.registration.showNotification(title, options);
      if (eventAt) await rememberPushEventAt(tag, eventAt);
      if (payload.appBadge) {
        const badgeCount = Number(payload.badgeCount);
        if (Number.isFinite(badgeCount)) {
          await writeBadgeCount(Math.max(0, Math.floor(badgeCount)));
        } else {
          const count = await readBadgeCount();
          await writeBadgeCount(count + 1);
        }
      }
      const clients = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });
      for (const client of clients) {
        client.postMessage({ type: "SAWAKAI_PUSH_RECEIVED" });
      }
    })(),
  );
});
