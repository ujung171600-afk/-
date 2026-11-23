// 한 번 열면 인터넷 없이도 실행되도록 앱 파일을 저장
const CACHE = "insaengshot-v1";
const FILES = ["./", "index.html", "style.css", "app.js", "manifest.webmanifest", "icons/icon.svg", "icons/icon-192.png", "icons/icon-512.png",
  "vendor/vision_bundle.mjs", "vendor/vision_wasm_internal.js", "vendor/vision_wasm_internal.wasm",
  "vendor/vision_wasm_nosimd_internal.js", "vendor/vision_wasm_nosimd_internal.wasm",
  "vendor/face_landmarker.task", "vendor/pose_landmarker_lite.task"];
self.addEventListener("install", (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES))); self.skipWaiting(); });
self.addEventListener("activate", (e) => { e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k))))); self.clients.claim(); });
self.addEventListener("fetch", (e) => { e.respondWith(caches.match(e.request, { ignoreSearch: true }).then((r) => r || fetch(e.request))); });
