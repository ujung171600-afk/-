// 앱 파일 저장: 화면 파일은 새 버전 먼저(3초 넘으면 저장본), AI 파일은 따로 오래 보관
const CACHE = "insaengshot-v10";
const AIC = "insaengshot-ai-0.10.14";
const CORE = ["./", "index.html", "style.css?v=10", "app.js?v=10", "beauty.js?v=10", "manifest.webmanifest", "icons/icon.svg", "icons/icon-192.png", "icons/icon-512.png"];
const AI = ["vendor/vision_bundle.mjs", "vendor/vision_wasm_internal.js", "vendor/vision_wasm_internal.wasm",
  "vendor/vision_wasm_nosimd_internal.js", "vendor/vision_wasm_nosimd_internal.wasm",
  "vendor/face_landmarker.task", "vendor/pose_landmarker_lite.task"];

self.addEventListener("install", (e) => {
  e.waitUntil(Promise.all([
    caches.open(CACHE).then((c) => Promise.all(CORE.map((u) => c.add(u).catch(() => {})))),
    caches.open(AIC).then((c) => Promise.all(AI.map((u) => c.match(u).then((h) => h || c.add(u).catch(() => {}))))),
  ]));
  self.skipWaiting();
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE && k !== AIC).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

const timeout = (ms) => new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), ms));
self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET" || new URL(req.url).origin !== location.origin) return;
  if (req.url.includes("/vendor/")) {
    e.respondWith(caches.match(req).then((r) => r || fetch(req).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(AIC).then((c) => c.put(req, copy)); }
      return res;
    })));
    return;
  }
  const net = fetch(req).then((res) => {
    if (res.ok && res.type === "basic") { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
    return res;
  });
  e.respondWith(Promise.race([net, timeout(3000)]).catch(() => caches.match(req, { ignoreSearch: true }).then((r) => r || net)));
});
