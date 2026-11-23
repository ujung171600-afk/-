// 앱 파일 저장: 화면 파일은 항상 새 버전 먼저, AI 파일은 저장본 사용 (오프라인에서도 실행)
const CACHE = "insaengshot-v3";
const CORE = ["./", "index.html", "style.css", "app.js", "beauty.js", "manifest.webmanifest", "icons/icon.svg", "icons/icon-192.png", "icons/icon-512.png"];
const AI = ["vendor/vision_bundle.mjs", "vendor/vision_wasm_internal.js", "vendor/vision_wasm_internal.wasm",
  "vendor/vision_wasm_nosimd_internal.js", "vendor/vision_wasm_nosimd_internal.wasm",
  "vendor/face_landmarker.task", "vendor/pose_landmarker_lite.task"];
self.addEventListener("install", (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll([...CORE, ...AI]))); self.skipWaiting(); });
self.addEventListener("activate", (e) => { e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET") return;
  const isAI = e.request.url.includes("/vendor/");
  if (isAI) { e.respondWith(caches.match(e.request).then((r) => r || fetch(e.request))); return; }
  e.respondWith(fetch(e.request).then((r) => { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); return r; })
    .catch(() => caches.match(e.request, { ignoreSearch: true })));
});
