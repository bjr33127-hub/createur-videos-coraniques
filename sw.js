const CACHE_NAME = "quran-audio-cache-v5";

self.addEventListener("install", (event) => event.waitUntil(self.skipWaiting()));
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

function isCacheableResponse(res){
  return res && (res.ok || res.type === "opaque");
}

function looksLikeAudioUrl(urlObj){
  const p = (urlObj.pathname || "").toLowerCase();
  return (
    p.endsWith(".mp3") || p.endsWith(".m4a") || p.endsWith(".aac") ||
    p.endsWith(".ogg") || p.endsWith(".wav") || p.endsWith(".webm")
  );
}

// ==========================
// FETCH: cache audio safely
// ==========================
self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  // ✅ CRITIQUE: les requêtes Range doivent aller au réseau, sinon <audio> casse
  const range = req.headers.get("range");
  if (range) {
    event.respondWith(fetch(req));
    return;
  }

  const url = new URL(req.url);

  // Audio/video + fichiers audio + local_audio
  const isAudioDest = (req.destination === "audio" || req.destination === "video");
  const isLocalAudioPath = (url.origin === self.location.origin) && url.pathname.includes("/local_audio/");
  const isAudioFile = looksLikeAudioUrl(url);

  // On ne touche pas au reste du site
  if (!isAudioDest && !isLocalAudioPath && !isAudioFile) return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);

    // cache-first
    const cached = await cache.match(req);
    if (cached) return cached;

    const net = await fetch(req);
    if (isCacheableResponse(net)) {
      try { await cache.put(req, net.clone()); } catch(e) {}
    }
    return net;
  })());
});

// ==========================
// MESSAGE: PREDOWNLOAD / CLEAR
// ==========================
self.addEventListener("message", (event) => {
  const port = event.ports && event.ports[0];
  const msg = event.data || {};
  if (!port) return;

  if (msg.type === "PREDOWNLOAD") {
    const id = msg.id || ("job-" + Date.now());
    const urls = Array.isArray(msg.urls) ? msg.urls.filter(Boolean) : [];
    predownloadUrls({ id, urls, port }).catch((err) => {
      port.postMessage({
        type: "DONE",
        id,
        ok: 0,
        fail: urls.length,
        total: urls.length,
        error: String(err)
      });
    });
    return;
  }

  if (msg.type === "CLEAR_CACHE") {
    clearAllCaches(port).catch((err) => {
      // On répond quand même pour éviter un UI bloqué
      port.postMessage({ type: "CLEARED", error: String(err) });
    });
    return;
  }
});

async function predownloadUrls({ id, urls, port }) {
  const cache = await caches.open(CACHE_NAME);

  let ok = 0;
  let fail = 0;
  const total = urls.length;

  // ✅ lots pour éviter de saturer
  const BATCH_SIZE = 12;
  const PAUSE_MS = 80;

  port.postMessage({ type: "PROGRESS", id, ok, fail, total });

  for (let i = 0; i < urls.length; i += BATCH_SIZE) {
    const batch = urls.slice(i, i + BATCH_SIZE);

    const results = await Promise.allSettled(batch.map(async (url) => {
      try {
        const req = new Request(url, { method: "GET" });

        // déjà en cache ?
        const existing = await cache.match(req);
        if (existing) return true;

        // IMPORTANT: pas de Range ici, on veut un fichier complet en cache
        const res = await fetch(req);
        if (!isCacheableResponse(res)) throw new Error("Not cacheable");
        await cache.put(req, res.clone());
        return true;
      } catch (_) {
        return false;
      }
    }));

    for (const r of results) {
      if (r.status === "fulfilled" && r.value === true) ok++;
      else fail++;
    }

    port.postMessage({ type: "PROGRESS", id, ok, fail, total });
    if (PAUSE_MS) await new Promise(r => setTimeout(r, PAUSE_MS));
  }

  port.postMessage({ type: "DONE", id, ok, fail, total });
}

async function clearAllCaches(port) {
  const keys = await caches.keys();
  for (const k of keys) await caches.delete(k);
  port.postMessage({ type: "CLEARED" });
}
