// 인생샷 코치 — 3단계 카메라
//  1. 각도: 오른쪽 위 공을 가운데 원에 넣는다 (폰 기울기)
//  2. 위치: 내 얼굴/몸(노란선)을 흰 점선 안에 넣는다
//  3. 찰칵: 둘 다 맞으면 초록색 — 셔터는 직접 누른다
// 얼굴·몸 인식(MediaPipe)은 휴대폰 안에서만 돌고 사진은 밖으로 나가지 않는다.

import { FilesetResolver, FaceLandmarker, PoseLandmarker } from "./vendor/vision_bundle.mjs";
import { createBeauty, faceShape, PRESETS } from "./beauty.js?v=7";

const $ = (s) => document.querySelector(s);
const video = $("#video"), view = $("#view"), overlay = $("#overlay"), ctx = overlay.getContext("2d");
const engine = createBeauty(view);

// ---------- 설정 ----------
const DEF = { voice: false, mirror: false, ratio: "3:4", seenHowto: false, preset: "natural", beauty: { ...PRESETS.natural } };
let opts = { ...DEF };
try { Object.assign(opts, JSON.parse(localStorage.getItem("isc2") || "{}")); } catch {}
const saveOpts = () => { try { localStorage.setItem("isc2", JSON.stringify(opts)); } catch {} };

// ---------- 모드별 목표 ----------
// angle: 각도 목표(가운데값, 허용폭) — 셀카는 '내려다보는 각도', 친구 사진은 '뒷카메라가 올려보는 각도'
const MODES = {
  selfie: { cam: "user", angle: [17, 9], roll: 7 },
  half: { cam: "environment", angle: [0, 6], roll: 3 },
  full: { cam: "environment", angle: [6, 7], roll: 3 },
};

// ---------- 상태 ----------
let mode = "selfie", facing = "user", stream = null;
let vision = null, faceLm = null, poseLm = null, aiFailed = false;
let result = null, lastDetect = 0, orient = null;
let needPerm = typeof DeviceOrientationEvent !== "undefined" && typeof DeviceOrientationEvent.requestPermission === "function";
let box = { x: 0, y: 0, w: 0, h: 0 };
let st = { angle: false, pos: false, tip: "" };
let shots = [], current = null;
let shownMain = "", cand = "", candAt = 0, lastSpoken = "", lastSpeakAt = 0;
let live = null, target = null; // 그릴 도형
const ema = {};
const sm = (k, v, a = 0.35) => (ema[k] = ema[k] == null ? v : ema[k] + a * (v - ema[k]));
const ratio = () => { const [a, b] = opts.ratio.split(":").map(Number); return a / b; };

// ---------- 시작 ----------
document.querySelectorAll(".pick-card").forEach((b) =>
  b.addEventListener("click", async () => {
    if (needPerm) { try { await DeviceOrientationEvent.requestPermission(); } catch {} needPerm = false; }
    unlockAudio();
    $("#start").hidden = true; $("#cam").hidden = false;
    setMode(b.dataset.mode);
    if (!opts.seenHowto) $("#howto").hidden = false;
  })
);
$("#howtoOk").onclick = () => { $("#howto").hidden = true; opts.seenHowto = true; saveOpts(); };
$("#backBtn").onclick = () => { stopCamera(); $("#cam").hidden = true; $("#start").hidden = false; };
$("#flipBtn").onclick = () => { facing = facing === "user" ? "environment" : "user"; startCamera(); };

function setMode(m) {
  mode = m; facing = MODES[m].cam;
  for (const k in ema) delete ema[k];
  result = null; shownMain = ""; cand = "";
  startCamera(); loadAI();
}

// ---------- 카메라 ----------
async function startCamera() {
  stopCamera();
  say("카메라 켜는 중…", "", false, true);
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: facing }, width: { ideal: 1920 }, height: { ideal: 1440 } } });
  } catch {
    say("카메라를 켤 수 없어요", "주소창 왼쪽 '가가' → 웹사이트 설정 → 카메라 '허용'", false, true);
    return;
  }
  video.srcObject = stream;
  await video.play().catch(() => {});
  layout();
}
function stopCamera() { if (stream) stream.getTracks().forEach((t) => t.stop()); stream = null; }

function layout() {
  const W = innerWidth, H = innerHeight, r = ratio();
  let w = W, h = W / r;
  const maxH = H - 190;
  if (h > maxH) { h = maxH; w = h * r; }
  const y = Math.max(0, Math.min((H - h) / 2, 58));
  box = { x: (W - w) / 2, y, w, h };
  for (const el of [view, overlay, $("#glow")]) Object.assign(el.style, { left: box.x + "px", top: y + "px", width: w + "px", height: h + "px" });
  $("#levelBox").style.top = y + 12 + "px";
  const dpr = Math.min(devicePixelRatio || 1, 2);
  for (const c of [view, overlay]) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
addEventListener("resize", layout);

function crop() {
  const vw = video.videoWidth, vh = video.videoHeight, r = ratio();
  if (!vw) return null;
  let cw = vw, ch = vh;
  if (vw / vh > r) cw = vh * r; else ch = vw / r;
  return { vw, vh, cw, ch, ox: (vw - cw) / 2, oy: (vh - ch) / 2 };
}
const toC = (p, c) => ({ x: (p.x * c.vw - c.ox) / c.cw, y: (p.y * c.vh - c.oy) / c.ch, v: p.visibility ?? 1 });

// ---------- AI ----------
async function loadAI() {
  if (aiFailed) return;
  try {
    if (!vision) vision = await FilesetResolver.forVisionTasks(new URL("./vendor", location.href).href);
    const make = async (Cls, path) => {
      for (const delegate of ["GPU", "CPU"]) {
        try { return await Cls.createFromOptions(vision, { baseOptions: { modelAssetPath: path, delegate }, runningMode: "VIDEO", numFaces: 1, numPoses: 1 }); }
        catch (e) { if (delegate === "CPU") throw e; }
      }
    };
    if (mode === "selfie" && !faceLm) faceLm = await make(FaceLandmarker, "./vendor/face_landmarker.task");
    if (mode !== "selfie" && !poseLm) poseLm = await make(PoseLandmarker, "./vendor/pose_landmarker_lite.task");
  } catch (e) { console.warn(e); aiFailed = true; toast("얼굴 인식이 안 돼서 각도만 알려드릴게요"); }
}

// ---------- 기울기 ----------
addEventListener("deviceorientation", (e) => {
  if (e.beta == null) return;
  const b = (e.beta * Math.PI) / 180, g = (e.gamma * Math.PI) / 180;
  const ux = -Math.cos(b) * Math.sin(g), uy = Math.sin(b), uz = Math.cos(b) * Math.cos(g);
  orient = {
    up: sm("up", (Math.asin(Math.max(-1, Math.min(1, uz))) * 180) / Math.PI, 0.25), // 화면이 하늘을 향한 각도
    roll: sm("roll", (Math.atan2(ux, uy) * 180) / Math.PI, 0.25),                   // 0 = 똑바로
  };
});

// ---------- 1단계: 각도 ----------
function checkAngle() {
  const lv = $("#levelBox");
  if (!orient) { lv.hidden = true; return { ok: true }; }
  lv.hidden = false;
  const [center, tol] = MODES[mode].angle, rollTol = MODES[mode].roll;
  const v = -orient.up; // 셀카: 내려다봄(+), 친구: 뒷카메라 올려봄(+)
  const sideways = Math.abs(orient.roll) > 50 && Math.abs(orient.roll) < 130;
  const dy = (v - center) / tol, dx = orient.roll / rollTol;
  const ok = !sideways && Math.abs(dy) <= 1 && Math.abs(dx) <= 1;
  // 공 위치 (원 반지름 14px = 허용폭)
  const clamp = (n) => Math.max(-2.1, Math.min(2.1, n));
  $("#ball").style.transform = `translate(${clamp(dx) * 14}px, ${clamp(dy) * 14}px)`;
  lv.classList.toggle("ok", ok);
  if (ok) return { ok };
  if (sideways) return { ok, main: "폰을 세로로 세워요" };
  if (Math.abs(dx) > 1 && Math.abs(dx) >= Math.abs(dy)) return { ok, main: "폰을 똑바로 세워요", sub: "옆으로 기울었어요" };
  if (mode === "selfie") return dy < 0
    ? { ok, main: "폰을 얼굴보다 조금 높이", sub: "위에서 살짝 내려다보게 들어요" }
    : { ok, main: "폰을 조금 낮춰요", sub: "너무 위에서 찍고 있어요" };
  if (mode === "full") return dy < 0
    ? { ok, main: "폰 윗부분을 살짝 뒤로", sub: "무릎을 굽혀 낮은 곳에서 살짝 올려 찍어요" }
    : { ok, main: "폰을 조금 세워요", sub: "너무 올려 찍고 있어요" };
  return { ok, main: "폰을 똑바로 세워요", sub: dy < 0 ? "아래를 보고 있어요" : "위를 보고 있어요" };
}

// ---------- 2단계: 위치 ----------
function checkPos(c) {
  live = null;
  if (aiFailed) { target = null; return { ok: true }; }
  if (mode === "selfie") return selfiePos(c);
  return mode === "half" ? halfPos(c) : fullPos(c);
}

const moveWord = (dx) => (dx < 0 ? "왼쪽" : "오른쪽");

function selfiePos(c) {
  target = { kind: "oval", cx: 0.5, cy: 0.42, w: 0.42 };
  const f = result && result.faceLandmarks && result.faceLandmarks[0];
  if (!f) return { ok: false, main: "얼굴이 화면에 나오게 해요" };
  const P = (i) => toC(f[i], c);
  const L = P(234), R = P(454), top = P(10), chin = P(152), nose = P(1), eL = P(33), eR = P(263);
  const w = sm("fw", Math.abs(R.x - L.x)), cx = sm("cx", (L.x + R.x) / 2), cy = sm("cy", (top.y + chin.y) / 2);
  const hgt = sm("fh", chin.y - top.y);
  live = { kind: "oval", cx: 1 - cx, cy, w, h: hgt }; // 화면은 거울처럼 보임
  const dxScreen = (1 - cx) - 0.5;
  // 턱·빛은 막지 않고 팁으로만
  const eyeY = (eL.y + eR.y) / 2, pitch = (nose.y - eyeY) / (chin.y - eyeY || 1e-6);
  st.tip = pitch < 0.26 ? "턱을 살짝 당기면 더 갸름해 보여요" : pitch > 0.55 ? "턱을 살짝 앞으로 내밀어요" : backlit({ x0: Math.min(L.x, R.x), x1: Math.max(L.x, R.x), y0: top.y, y1: chin.y }) ? "빛을 마주 보면 얼굴이 환해져요" : "";
  if (w > 0.52) return { ok: false, main: "팔을 더 쭉 뻗어요", sub: "가까우면 코가 커 보여요" };
  if (w < 0.32) return { ok: false, main: "폰을 조금 가까이", sub: "노란 원이 점선만큼 커지게" };
  if (Math.abs(dxScreen) > 0.08) return { ok: false, main: `폰을 ${moveWord(dxScreen)}으로 조금`, sub: "노란 원을 점선 안으로" };
  if (cy - 0.42 > 0.07) return { ok: false, main: "폰을 조금 내려요", sub: "노란 원을 점선 안으로" };
  if (0.42 - cy > 0.07) return { ok: false, main: "폰을 조금 올려요", sub: "노란 원을 점선 안으로" };
  return { ok: true };
}

const PL = { nose: 0, earL: 7, earR: 8, shL: 11, shR: 12, footL: 31, footR: 32, heelL: 29, heelR: 30 };

function halfPos(c) {
  target = { kind: "bust", cx: 0.5, cy: 0.27, w: 0.2 };
  const p = result && result.landmarks && result.landmarks[0];
  if (!p) return { ok: false, main: "친구가 화면에 나오게 해요", sub: "머리부터 허리까지" };
  const P = (k) => toC(p[PL[k]], c);
  const shW = Math.abs(P("shL").x - P("shR").x);
  const earW = Math.abs(P("earL").x - P("earR").x);
  const w = sm("hw", Math.max(earW * 1.25, shW * 0.42));
  const cx = sm("hcx", P("nose").x), cy = sm("hcy", P("nose").y - w * 0.15);
  live = { kind: "oval", cx, cy, w, h: w * 1.3 };
  st.tip = "";
  if (cy < 0.08) return { ok: false, main: "한 걸음 뒤로 가요", sub: "머리가 잘려요" };
  if (w > 0.28) return { ok: false, main: "한 걸음 뒤로 가요", sub: "노란 원이 점선만큼 작아지게" };
  if (w < 0.14) return { ok: false, main: "한 걸음 앞으로 가요", sub: "노란 원이 점선만큼 커지게" };
  if (Math.abs(cx - 0.5) > 0.09) return { ok: false, main: `폰을 ${moveWord(cx - 0.5)}으로 살짝 돌려요`, sub: "노란 원을 점선 안으로" };
  if (cy - 0.27 > 0.07) return { ok: false, main: "폰을 조금 내려요", sub: "노란 원을 점선 안으로" };
  if (0.27 - cy > 0.07) return { ok: false, main: "폰을 조금 올려요", sub: "노란 원을 점선 안으로" };
  return { ok: true };
}

function fullPos(c) {
  target = { kind: "body" };
  const p = result && result.landmarks && result.landmarks[0];
  if (!p) return { ok: false, main: "친구가 다 나오게 뒤로 가요", sub: "머리부터 발끝까지" };
  const P = (k) => toC(p[PL[k]], c);
  const feetSeen = ["footL", "footR", "heelL", "heelR"].some((k) => P(k).v > 0.5 && P(k).y < 1.0);
  const head = { x: sm("nx", P("nose").x), y: sm("ny", P("nose").y) };
  const footY = sm("fy", Math.max(P("footL").y, P("footR").y, P("heelL").y, P("heelR").y));
  const footX = (P("footL").x + P("footR").x) / 2;
  live = { kind: "body", head, foot: { x: footX, y: footY }, feetSeen };
  st.tip = "한쪽 다리를 앞으로 내밀면 더 길어 보여요";
  if (!feetSeen) return { ok: false, main: "한 걸음 뒤로 가요", sub: "발끝까지 나오게" };
  if (head.y < 0.05) return { ok: false, main: "한 걸음 뒤로 가요", sub: "머리가 잘려요" };
  if (footY < 0.9) return { ok: false, main: "한 걸음 앞으로 가요", sub: "발이 아래 점선에 닿게" };
  if (Math.abs(head.x - 0.5) > 0.12) return { ok: false, main: `폰을 ${moveWord(head.x - 0.5)}으로 살짝 돌려요`, sub: "친구가 가운데 오게" };
  return { ok: true };
}

// 역광 여부 (얼굴이 주변보다 많이 어두움)
const sCv = Object.assign(document.createElement("canvas"), { width: 36, height: 48 });
const sCtx = sCv.getContext("2d", { willReadFrequently: true });
let blCache = false, blAt = 0;
function backlit(reg) {
  const now = performance.now();
  if (now - blAt < 800) return blCache;
  blAt = now;
  const c = crop(); if (!c) return false;
  sCtx.drawImage(video, c.ox, c.oy, c.cw, c.ch, 0, 0, 36, 48);
  const d = sCtx.getImageData(0, 0, 36, 48).data;
  let all = 0, face = 0, n = 0;
  for (let y = 0; y < 48; y++) for (let x = 0; x < 36; x++) {
    const i = (y * 36 + x) * 4, l = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    all += l;
    if (x / 36 >= reg.x0 && x / 36 <= reg.x1 && y / 48 >= reg.y0 && y / 48 <= reg.y1) { face += l; n++; }
  }
  blCache = n > 0 && face / n < all / 1728 - 30;
  return blCache;
}

// ---------- 매 프레임 ----------
function loop(t) {
  requestAnimationFrame(loop);
  if ($("#cam").hidden || !video.videoWidth) return;
  const c = crop();
  const lm = mode === "selfie" ? faceLm : poseLm;
  if (lm && t - lastDetect > 70 && video.readyState >= 2) {
    lastDetect = t;
    try { result = lm.detectForVideo(video, t); } catch (e) { console.warn(e); }
  }
  engine.render(video, c, opts.beauty, currentFace(c), facing === "user");

  const a = checkAngle(), p = checkPos(c);
  st.angle = a.ok; st.pos = p.ok;
  const ready = a.ok && p.ok;
  draw(ready);
  steps(ready);

  // 안내 문장: 1단계 → 2단계 순서로 하나만
  let main, sub, go = false;
  if (!a.ok) { main = a.main; sub = a.sub || "오른쪽 위 공을 가운데 원에 넣어요"; }
  else if (!p.ok) { main = p.main; sub = p.sub || ""; }
  else { main = "좋아요, 지금 누르세요"; sub = st.tip; go = true; }
  if (main !== cand) { cand = main; candAt = t; }
  if (main !== shownMain && (t - candAt > 450 || !shownMain || go)) { shownMain = main; say(main, sub, go); speak(main); }

  $("#shutter").classList.toggle("go", ready);
  $("#glow").classList.toggle("on", ready);
}
requestAnimationFrame(loop);

function steps(ready) {
  const s = { angle: st.angle, pos: st.angle && st.pos, shot: false };
  const now = !st.angle ? "angle" : !st.pos ? "pos" : "shot";
  document.querySelectorAll("#steps li").forEach((li) => {
    const k = li.dataset.s;
    li.classList.toggle("done", !!s[k]);
    li.classList.toggle("now", k === now && !s[k]);
  });
}

function currentFace(c) {
  const f = mode === "selfie" && result && result.faceLandmarks && result.faceLandmarks[0];
  return f ? faceShape((i) => toC(f[i], c), c.cw / c.ch) : null;
}

// ---------- 그리기: 흰 점선(목표) + 노란선(지금 나) ----------
function draw(ready) {
  const W = box.w, H = box.h;
  ctx.clearRect(0, 0, W, H);
  if (!target) return;
  const posOk = st.pos;
  const liveColor = posOk ? "#4cc38a" : "#ffd23f";
  ctx.lineCap = "round"; ctx.lineJoin = "round";

  // 목표 (흰 점선)
  ctx.setLineDash([12, 9]); ctx.lineWidth = 3; ctx.strokeStyle = posOk ? "rgba(76,195,138,.95)" : "rgba(255,255,255,.95)";
  ctx.shadowColor = "rgba(0,0,0,.45)"; ctx.shadowBlur = 6;
  if (target.kind === "oval") ovalPath(target.cx * W, target.cy * H, (target.w * W) / 2 * 1.12, (target.w * W) / 2 * 1.12 * 1.32), ctx.stroke();
  if (target.kind === "bust") {
    const cx = target.cx * W, cy = target.cy * H, rx = (target.w * W) / 2 * 1.1, ry = rx * 1.3;
    ovalPath(cx, cy, rx, ry); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(cx - rx * 3.4, H * 0.98); ctx.bezierCurveTo(cx - rx * 3.2, cy + ry * 1.6, cx - rx * 1.3, cy + ry * 1.25, cx - rx * 0.55, cy + ry * 1.05);
    ctx.moveTo(cx + rx * 3.4, H * 0.98); ctx.bezierCurveTo(cx + rx * 3.2, cy + ry * 1.6, cx + rx * 1.3, cy + ry * 1.25, cx + rx * 0.55, cy + ry * 1.05); ctx.stroke();
  }
  if (target.kind === "body") {
    // 머리 자리 + 발 자리
    ovalPath(W * 0.5, H * 0.1, W * 0.07, W * 0.09); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(W * 0.2, H * 0.955); ctx.lineTo(W * 0.8, H * 0.955); ctx.stroke();
    ctx.setLineDash([]); ctx.shadowBlur = 0;
    label("머리", W * 0.5, H * 0.1 - W * 0.09 - 8);
    label("발끝", W * 0.5, H * 0.955 - 10);
  }
  ctx.setLineDash([]); ctx.shadowBlur = 0;

  // 지금 나 (노란선 → 맞으면 초록)
  if (!live) return;
  ctx.strokeStyle = liveColor; ctx.lineWidth = 4;
  if (live.kind === "oval") {
    const isSelfie = mode === "selfie";
    const rx = (live.w * W) / 2 * 1.12, ry = isSelfie ? (live.h * H) / 2 * 1.15 : rx * 1.3;
    ovalPath(live.cx * W, live.cy * H, rx, ry); ctx.stroke();
  }
  if (live.kind === "body") {
    ctx.fillStyle = liveColor;
    dot(live.head.x * W, live.head.y * H, 9);
    if (live.feetSeen) dot(live.foot.x * W, Math.min(live.foot.y, 0.995) * H, 9);
    ctx.globalAlpha = 0.6; ctx.beginPath(); ctx.moveTo(live.head.x * W, live.head.y * H);
    ctx.lineTo(live.foot.x * W, Math.min(live.foot.y, 1) * H); ctx.stroke(); ctx.globalAlpha = 1;
  }
}
function ovalPath(cx, cy, rx, ry) { ctx.beginPath(); ctx.ellipse(cx, cy, Math.max(1, rx), Math.max(1, ry), 0, 0, Math.PI * 2); }
function dot(x, y, r) { ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill(); }
function label(t, x, y) {
  ctx.font = "500 13px -apple-system, sans-serif"; ctx.textAlign = "center";
  const w = ctx.measureText(t).width + 14;
  ctx.fillStyle = "rgba(0,0,0,.55)"; ctx.beginPath(); ctx.roundRect ? ctx.roundRect(x - w / 2, y - 15, w, 21, 8) : ctx.rect(x - w / 2, y - 15, w, 21); ctx.fill();
  ctx.fillStyle = "#fff"; ctx.fillText(t, x, y);
}

// ---------- 안내 문장 / 목소리 / 소리 ----------
function say(main, sub, go, force) {
  $("#sayMain").textContent = main; $("#saySub").textContent = sub || "";
  $("#say").classList.toggle("go", !!go);
  if (force) shownMain = main;
}
function speak(text) {
  if (!opts.voice || !("speechSynthesis" in window)) return;
  const now = performance.now();
  if ((text === lastSpoken && now - lastSpeakAt < 6000) || now - lastSpeakAt < 1600) return;
  lastSpoken = text; lastSpeakAt = now;
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text); u.lang = "ko-KR"; u.rate = 1.05; speechSynthesis.speak(u);
}
let actx = null;
function unlockAudio() { try { actx = actx || new (window.AudioContext || window.webkitAudioContext)(); actx.resume(); } catch {} }
function beep(f = 880, d = 0.08) {
  if (!actx) return;
  const o = actx.createOscillator(), g = actx.createGain();
  o.frequency.value = f; g.gain.setValueAtTime(0.15, actx.currentTime); g.gain.exponentialRampToValueAtTime(0.001, actx.currentTime + d);
  o.connect(g).connect(actx.destination); o.start(); o.stop(actx.currentTime + d);
}

// ---------- 촬영 ----------
$("#shutter").onclick = () => { unlockAudio(); capture(); };
async function capture() {
  const c = crop(); if (!c) return;
  const keepW = view.width, keepH = view.height;
  view.width = Math.round(c.cw); view.height = Math.round(c.ch);
  engine.render(video, c, opts.beauty, currentFace(c), facing === "user" && opts.mirror);
  const blob = await new Promise((r) => view.toBlob(r, "image/jpeg", 0.95));
  view.width = keepW; view.height = keepH;
  if (!blob) return;
  const shot = { blob, url: URL.createObjectURL(blob), at: Date.now() };
  shots.push(shot);
  $("#thumbImg").src = shot.url;
  const fl = $("#flash"); fl.classList.add("on"); setTimeout(() => fl.classList.remove("on"), 60);
  beep(1400, 0.05);
  openReview(shot);
}
function openReview(s) { current = s; $("#reviewImg").src = s.url; $("#review").hidden = false; }
$("#retake").onclick = () => ($("#review").hidden = true);
$("#saveBtn").onclick = async () => { if (!current) return; await save(current); $("#review").hidden = true; };

async function save(s) {
  const name = `insaengshot_${new Date(s.at).toISOString().replace(/[-:T]/g, "").slice(0, 14)}.jpg`;
  const file = new File([s.blob], name, { type: "image/jpeg" });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file] }); toast("'이미지 저장'을 눌렀다면 사진첩에 들어갔어요"); return; }
    catch (e) { if (e.name === "AbortError") return; }
  }
  const a = Object.assign(document.createElement("a"), { href: s.url, download: name });
  document.body.appendChild(a); a.click(); a.remove(); toast("저장했어요");
}

$("#galleryBtn").onclick = () => {
  const g = $("#galleryGrid");
  g.innerHTML = shots.length ? "" : '<p class="empty">아직 찍은 사진이 없어요</p>';
  [...shots].reverse().forEach((s) => {
    const b = document.createElement("button"); b.innerHTML = '<img alt="찍은 사진">'; b.firstChild.src = s.url;
    b.onclick = () => { $("#gallery").hidden = true; openReview(s); }; g.appendChild(b);
  });
  $("#gallery").hidden = false;
};
$("#closeGallery").onclick = () => ($("#gallery").hidden = true);

// ---------- 뽀샵 ----------
// 예전 버전의 강한 설정(갸름·눈·밝기)이 남아 있으면 피부결 정돈으로 되돌림
if (!PRESETS[opts.preset]) opts.preset = "natural";
{ const { name, ...v } = PRESETS[opts.preset]; opts.beauty = v; }
function syncBeauty() {
  $("#beautyName").textContent = PRESETS[opts.preset].name;
  document.querySelectorAll("#presets button").forEach((b) => b.classList.toggle("on", b.dataset.p === opts.preset));
}
document.querySelectorAll("#presets button").forEach((b) => (b.onclick = () => {
  opts.preset = b.dataset.p; const { name, ...v } = PRESETS[b.dataset.p]; opts.beauty = v; saveOpts(); syncBeauty();
}));
$("#beautyBtn").onclick = () => { if (!engine.gl) { toast("이 폰에서는 뽀샵을 쓸 수 없어요"); return; } $("#beauty").hidden = false; };
$("#closeBeauty").onclick = () => ($("#beauty").hidden = true);
syncBeauty();

// ---------- 설정 ----------
const bind = (id, key) => {
  const el = $(id);
  if (el.type === "checkbox") el.checked = opts[key]; else el.value = opts[key];
  el.onchange = () => { opts[key] = el.type === "checkbox" ? el.checked : el.value; saveOpts(); if (key === "ratio") layout(); if (key === "voice" && !opts.voice && window.speechSynthesis) speechSynthesis.cancel(); };
};
bind("#optVoice", "voice"); bind("#optMirror", "mirror"); bind("#optRatio", "ratio");
$("#settingsBtn").onclick = () => ($("#settings").hidden = false);
$("#closeSettings").onclick = () => ($("#settings").hidden = true);
$("#showHowto").onclick = () => { $("#settings").hidden = true; $("#howto").hidden = false; };
document.querySelectorAll(".sheet").forEach((s) => s.addEventListener("click", (e) => { if (e.target === s && s.id !== "howto" && s.id !== "review") s.hidden = true; }));

let toastT;
function toast(msg) { const t = $("#toast"); t.textContent = msg; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => (t.hidden = true), 2500); }

async function wake() { try { if ("wakeLock" in navigator) await navigator.wakeLock.request("screen"); } catch {} }
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && !$("#cam").hidden) wake(); });
document.addEventListener("click", wake, { once: true });

if ("serviceWorker" in navigator && location.protocol === "https:") navigator.serviceWorker.register("sw.js").catch(() => {});
