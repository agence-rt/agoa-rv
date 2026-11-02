"use strict";
/* AGOA PV — service worker (fonctionnement hors connexion et mises à jour).
   VERSION est réécrite par `npm run deploy` : un nouveau déploiement = un nouveau cache = une mise à jour proposée à l'utilisateur. */
const VERSION = "agoa-pv-n35";
const EXT = "agoa-pv-ext";                     // ressources externes (polices, pdf.js) : conservées d'une version à l'autre
const CORE = ["./", "index.html", "manifest.webmanifest", "icons/icon-192.png", "icons/icon-512.png", "icons/icon-maskable-512.png", "icons/apple-touch-icon.png"];
const PRE_EXT = [
  "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js",
  "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js",
  "https://fonts.googleapis.com/css2?family=Archivo:wdth,wght@75..125,400..800&display=swap"
];

self.addEventListener("install", e => {
  // Pas de skipWaiting automatique : l'utilisateur choisit le moment de la mise à jour (bannière dans l'application).
  e.waitUntil((async () => {
    const c = await caches.open(VERSION);
    await c.addAll(CORE.map(u => new Request(u, { cache: "reload" })));
    const x = await caches.open(EXT);
    await Promise.allSettled(PRE_EXT.map(async u => { if (!(await x.match(u))) { const r = await fetch(u); if (r.ok) await x.put(u, r); } }));
  })());
});

self.addEventListener("activate", e => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== VERSION && k !== EXT) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener("message", e => { if (e.data === "SKIP_WAITING") self.skipWaiting(); });

self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin === location.origin) {
    // Application : cache d'abord (version figée jusqu'à la mise à jour), réseau en secours
    e.respondWith((async () => {
      const hit = await caches.match(req, { ignoreSearch: true, cacheName: VERSION });
      if (hit) return hit;
      if (req.mode === "navigate") { const idx = await caches.match("index.html", { cacheName: VERSION }); if (idx) return idx; }
      return fetch(req);
    })());
    return;
  }
  // Ressources externes (polices, pdf.js) : cache d'abord, rafraîchi en arrière-plan
  if (/(^|\.)(googleapis|gstatic|cloudflare)\.com$/.test(url.hostname)) {
    e.respondWith((async () => {
      const c = await caches.open(EXT);
      const hit = await c.match(req);
      const net = fetch(req).then(r => { if (r && (r.ok || r.type === "opaque")) c.put(req, r.clone()); return r; }).catch(() => null);
      return hit || (await net) || Response.error();
    })());
  }
});
