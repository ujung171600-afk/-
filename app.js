// 인생샷 코치 — 3단계 카메라
//  1. 각도: 화면 가운데 공을 원에 넣는다 (폰 기울기). 맞으면 공은 오른쪽 위로 작아진다
//  2. 위치: 내 얼굴/몸(노란선)을 흰 점선 안에 넣는다
//  3. 찰칵: 둘 다 맞으면 초록색 — 셔터는 직접 누른다
// 얼굴·몸 인식(MediaPipe)은 휴대폰 안에서만 돌고 사진은 밖으로 나가지 않는다.

import { FilesetResolver, FaceLandmarker, PoseLandmarker } from "./vendor/vision_bundle.mjs";
import { createBeauty, PRESETS } from "./beauty.js?v=10";

const $ = (s) => document.querySelector(s);
const video = $("#video"), view = $("#view"), overlay = $("#overlay"), ctx = overlay.getContext("2d");
const engine = createBeauty(view);
video.setAttribute("webkit-playsinline", "");

// ---------- 설정 ----------
const DEF = { voice: false, mirror: false, ratio: "3:4", seenHowto: false, preset: "natural" };
let opts = { ...DEF };
try { Object.assign(opts, JSON.parse(localStorage.getItem("isc2") || "{}")); } catch {}
const saveOpts = () => { try { localStorage.setItem("isc2", JSON.stringify(opts)); } catch {} };
if (!PRESETS[opts.preset]) opts.preset = "natural";
const beauty = () => PRESETS[opts.preset];

// ---------- 모드별 목표 ----------
// angle: [가운데값, 허용폭] — 셀카는 앞카메라가 내려다보는 각도, 친구 사진은 뒷카메라가 올려보는 각도
const MODES = {
  selfie: { cam: "user", angle: [15, 8], roll: 7, ai: "face" },
  half: { cam: "environment", angle: [0, 6], roll: 3, ai: "pose" },
  full: { cam: "environment", angle: [8, 6], roll: 3, ai: "pose" },
};

// ---------- 상태 ----------
let mode = "selfie", facing = "user", stream = null, camGen = 0;
let vision = null; const lm = {}, lmP = {}, lmFail = {}, lmErr = {};
let result = null, lastDetect = 0, orient = null;
let needPerm = typeof DeviceOrientationEvent !== "undefined" && typeof DeviceOrientationEvent.requestPermission === "function";
let box = { x: 0, y: 0, w: 0, h: 0 };
let st = { angle: false, pos: false, tip: "" }, wasReady = false;
let shots = [], current = null, saving = false;
let shownMain = "", cand = "", candAt = 0, lastSpoken = "", lastSpeakAt = 0;
let live = null, target = null;
let levelBig = true, angleBadAt = 0;   // 각도 단계 동안 공을 화면 가운데 크게
let hintPending = false, hintLeft = 0, lastT = 0; // 친구 모드: 카메라 켤 때마다 3초 한 줄 안내 (화면이 실제로 그려진 시간 기준)
let zoomLevels = [], zoomIdx = 0;
const ema = {};
const sm = (k, v, a = 0.35) => (ema[k] = ema[k] == null ? v : ema[k] + a * (v - ema[k]));
const ratio = () => { const [a, b] = opts.ratio.split(":").map(Number); return a / b; };
const mirrored = () => facing === "user";
const M = (x) => (mirrored() ? 1 - x : x); // 화면에 보이는 좌우

// ---------- 시작 ----------
document.querySelectorAll(".pick-card").forEach((b) =>
  b.addEventListener("click", async () => {
    unlockAudio();
    if (opts.voice) unlockVoice();
    if (needPerm) {
      needPerm = false;
      let r = "denied";
      try { r = await DeviceOrientationEvent.requestPermission(); } catch {}
      if (r !== "granted") toast("기울기 권한이 없어 각도 안내 없이 진행해요");
    }
    $("#start").hidden = true; $("#cam").hidden = false;
    setMode(b.dataset.mode);
    if (mode === "selfie" && !opts.seenHowto) $("#howto").hidden = false;
  })
);
$("#howtoOk").onclick = () => { $("#howto").hidden = true; opts.seenHowto = true; saveOpts(); };
$("#backBtn").onclick = () => { stopCamera(); hideHint(); $("#cam").hidden = true; $("#start").hidden = false; };
$("#retryBtn").onclick = () => startCamera();

function setMode(m) {
  mode = m; facing = MODES[m].cam;
  for (const k in ema) delete ema[k];
  result = null; shownMain = ""; cand = ""; wasReady = false;
  levelBig = true; angleBadAt = 0; st.angle = false; st.pos = false;
  $("#levelBox").classList.add("big", "instant");
  hideHint(); hintPending = m !== "selfie";
  relayout(); startCamera(); getLm(MODES[m].ai);
}

// 친구 모드 한 줄 안내 (3초, 누르면 닫힘)
function showHint() { hintPending = false; hintLeft = 3000; $("#modeHint").hidden = false; }
function hideHint() { hintLeft = 0; $("#modeHint").hidden = true; }
$("#modeHint").onclick = hideHint;

// ---------- 카메라 ----------
async function startCamera() {
  stopCamera();
  const gen = camGen;
  $("#retryBtn").hidden = true;
  say("카메라 켜는 중…", "", false, true);
  let s;
  try {
    // 가능하면 고해상도(12MP), 안 되면 예전 해상도로
    try { s = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: facing }, width: { ideal: 4032 }, height: { ideal: 3024 } } }); }
    catch (e) {
      if (e && (e.name === "NotAllowedError" || e.name === "SecurityError")) throw e;
      s = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: facing }, width: { ideal: 1920 }, height: { ideal: 1440 } } });
    }
  } catch {
    if (gen === camGen) {
      say("카메라를 켤 수 없어요", "설정 앱 → Safari → 카메라를 '허용'으로 바꾼 뒤 아래 버튼을 눌러요", false, true);
      $("#retryBtn").hidden = false;
    }
    return;
  }
  if (gen !== camGen || $("#cam").hidden) { s.getTracks().forEach((t) => t.stop()); return; }
  stream = s; video.srcObject = s;
  s.getVideoTracks()[0].addEventListener("ended", () => { if (stream === s && !$("#cam").hidden) startCamera(); });
  await video.play().catch(() => {});
  $("#shutter").disabled = false;
  setupZoom(s.getVideoTracks()[0]);
  relayout();
  if (hintPending) showHint();
}
function stopCamera() {
  camGen++;
  if (stream) stream.getTracks().forEach((t) => t.stop());
  stream = null; video.srcObject = null; $("#shutter").disabled = true;
  zoomLevels = []; $("#zoomBtn").hidden = true;
}

// ---------- 배율 (폰이 지원할 때만) ----------
function setupZoom(track) {
  zoomLevels = []; zoomIdx = 0;
  let z = null;
  try { z = track && track.getCapabilities && track.getCapabilities().zoom; } catch {}
  if (z && typeof z.min === "number" && typeof z.max === "number") {
    if (z.min <= 0.5) zoomLevels.push(0.5);
    if (z.min <= 1 && z.max >= 1) zoomLevels.push(1);
    if (z.max >= 2) zoomLevels.push(2);
  }
  if (zoomLevels.length < 2) { zoomLevels = []; $("#zoomBtn").hidden = true; return; }
  zoomIdx = Math.max(0, zoomLevels.indexOf(1));
  showZoom();
  $("#zoomBtn").hidden = false;
}
function showZoom() {
  const t = zoomLevels[zoomIdx] + "x", b = $("#zoomBtn");
  b.textContent = t; b.setAttribute("aria-label", `배율 ${t}, 눌러서 바꾸기`);
}
$("#zoomBtn").onclick = async () => {
  const track = stream && stream.getVideoTracks()[0];
  if (!track || !zoomLevels.length) return;
  const prev = zoomIdx;
  zoomIdx = (zoomIdx + 1) % zoomLevels.length; showZoom();
  try { await track.applyConstraints({ advanced: [{ zoom: zoomLevels[zoomIdx] }] }); }
  catch { zoomIdx = prev; showZoom(); }
};

// 위 막대 바로 아래부터 사진 영역 (빈 띠 없이). 아래 안내와는 겹치지 않게 (아이폰 노치·홈바 포함)
function layout() {
  const W = innerWidth, r = ratio();
  const topB = $(".top").getBoundingClientRect().bottom, botT = $(".bottom").getBoundingClientRect().top;
  const avail = Math.max(120, botT - topB - 6);
  let w = W, h = W / r;
  if (h > avail) { h = avail; w = h * r; }
  const y = topB;
  box = { x: (W - w) / 2, y, w, h };
  for (const el of [view, overlay, $("#glow")]) Object.assign(el.style, { left: box.x + "px", top: y + "px", width: w + "px", height: h + "px" });
  $("#modeHint").style.top = y + 12 + "px";
  placeLevel();
  const dpr = Math.min(devicePixelRatio || 1, 2);
  for (const c of [view, overlay]) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
const relayout = () => requestAnimationFrame(() => requestAnimationFrame(layout));
addEventListener("resize", relayout);
if (window.visualViewport) visualViewport.addEventListener("resize", relayout);

function crop() {
  const vw = video.videoWidth, vh = video.videoHeight, r = ratio();
  if (!vw) return null;
  let cw = vw, ch = vh;
  if (vw / vh > r) cw = vh * r; else ch = vw / r;
  return { vw, vh, cw, ch, ox: (vw - cw) / 2, oy: (vh - ch) / 2 };
}
const toC = (p, c) => ({ x: (p.x * c.vw - c.ox) / c.cw, y: (p.y * c.vh - c.oy) / c.ch, v: p.visibility ?? 1 });

// ---------- AI (얼굴 / 몸) ----------
function getLm(kind, cpuOnly = false) {
  if (lmP[kind]) return lmP[kind];
  lmP[kind] = (async () => {
    vision ||= await FilesetResolver.forVisionTasks(new URL("./vendor", location.href).href);
    const [Cls, path] = kind === "face" ? [FaceLandmarker, "./vendor/face_landmarker.task"] : [PoseLandmarker, "./vendor/pose_landmarker_lite.task"];
    for (const delegate of cpuOnly ? ["CPU"] : ["GPU", "CPU"]) {
      try { return await Cls.createFromOptions(vision, { baseOptions: { modelAssetPath: path, delegate }, runningMode: "VIDEO", numFaces: 1, numPoses: 1 }); }
      catch (e) { if (delegate === "CPU") throw e; }
    }
  })().then((l) => { lm[kind] = l; lmErr[kind] = 0; return l; })
    .catch((e) => { console.warn(e); lmFail[kind] = true; toast("인식이 안 돼서 각도만 알려드릴게요"); });
  return lmP[kind];
}
function detect(t) {
  const kind = MODES[mode].ai, l = lm[kind];
  if (!l || t - lastDetect < 70 || video.readyState < 2) return;
  lastDetect = t;
  try { result = l.detectForVideo(video, t); lmErr[kind] = 0; }
  catch (e) {
    // 아이폰에서 GPU 인식이 실행 중 실패하면 CPU로 다시 만든다
    if (++lmErr[kind] > 5) { try { l.close(); } catch {} lm[kind] = null; delete lmP[kind]; getLm(kind, true); }
  }
}

// ---------- 기울기 ----------
addEventListener("deviceorientation", (e) => {
  if (e.beta == null) return;
  const b = (e.beta * Math.PI) / 180, g = (e.gamma * Math.PI) / 180;
  const ux = -Math.cos(b) * Math.sin(g), uy = Math.sin(b), uz = Math.cos(b) * Math.cos(g);
  orient = {
    up: sm("up", (Math.asin(Math.max(-1, Math.min(1, uz))) * 180) / Math.PI, 0.25), // 화면이 하늘을 향한 각도
    roll: sm("roll", (Math.atan2(ux, uy) * 180) / Math.PI, 0.25),                   // 0 = 똑바로, + = 오른쪽이 높음
  };
});

// ---------- 1단계: 각도 ----------
// 각도가 안 맞는 동안은 사진 가운데에 크게, 맞으면 오른쪽 위 구석으로 작게
const SMALL = 76;
function placeLevel() {
  const lv = $("#levelBox");
  const x = levelBig ? box.x + box.w / 2 : box.x + box.w - 10 - SMALL / 2;
  const y = levelBig ? box.y + box.h / 2 : box.y + 10 + SMALL / 2;
  lv.style.left = x + "px"; lv.style.top = y + "px";
  lv.classList.toggle("big", levelBig);
  if (lv.classList.contains("instant")) requestAnimationFrame(() => requestAnimationFrame(() => lv.classList.remove("instant")));
}
function setLevelBig(big, t) {
  if (big) { if (!angleBadAt) angleBadAt = t; if (levelBig || t - angleBadAt < 700) return; }
  else angleBadAt = 0;
  if (big === levelBig) return;
  levelBig = big; placeLevel();
}
function checkAngle() {
  const lv = $("#levelBox");
  if (!orient) { lv.hidden = true; return { ok: true }; }
  if (lv.hidden) { lv.hidden = false; lv.classList.add("instant"); placeLevel(); }
  const k = st.angle ? 1.3 : 1; // 한 번 맞으면 조금 넉넉하게 (깜빡임 방지)
  const [center, tol] = MODES[mode].angle, rollTol = MODES[mode].roll;
  const v = -orient.up;
  const sideways = Math.abs(orient.roll) > 50 && Math.abs(orient.roll) < 130;
  const dy = (v - center) / (tol * k), dx = orient.roll / (rollTol * k);
  const ok = !sideways && Math.abs(dy) <= 1 && Math.abs(dx) <= 1;
  // 공은 구슬처럼 낮은 쪽으로 굴러간다
  const clamp = (n) => Math.max(-2.1, Math.min(2.1, n));
  // 이동 거리는 공 크기의 70% 단위 — 큰 원/작은 원 모두 같은 비율로 굴러간다
  $("#ball").style.transform = `translate(${-50 - clamp(dx) * 70}%, ${-50 + clamp(dy) * 70}%)`;
  lv.classList.toggle("ok", ok);
  if (ok) return { ok };
  if (sideways) return { ok, main: "폰을 세로로 세워요" };
  if (Math.abs(dx) > 1 && Math.abs(dx) >= Math.abs(dy))
    return { ok, main: orient.roll > 0 ? "폰 오른쪽을 살짝 내려요" : "폰 왼쪽을 살짝 내려요", sub: "옆으로 기울었어요" };
  if (mode === "selfie") return dy < 0
    ? { ok, main: "폰 윗부분을 내 쪽으로 살짝", sub: "눈보다 높이 들고 내려다보게" }
    : { ok, main: "폰을 조금 더 세워요", sub: "너무 위에서 내려다보고 있어요" };
  if (mode === "full") return dy < 0
    ? { ok, main: "폰 윗부분을 내 쪽으로 살짝", sub: "무릎 높이에서 살짝 올려 찍어요" }
    : { ok, main: "폰을 조금 더 세워요", sub: "너무 올려 찍고 있어요" };
  return dy < 0
    ? { ok, main: "폰 윗부분을 내 쪽으로 살짝", sub: "카메라가 아래를 보고 있어요" }
    : { ok, main: "폰 윗부분을 앞으로 살짝", sub: "카메라가 위를 보고 있어요" };
}

// ---------- 2단계: 위치 ----------
const side = (dx) => (dx < 0 ? "왼쪽" : "오른쪽");

function checkPos(c) {
  live = null;
  const kind = MODES[mode].ai;
  if (lmFail[kind]) { target = null; return { ok: true }; }
  if (!lm[kind]) { target = null; return { ok: false, main: "준비 중…", sub: "잠깐만 기다려요" }; }
  const k = st.pos ? 1.3 : 1;
  if (mode === "selfie") return selfiePos(c, k);
  return mode === "half" ? halfPos(c, k) : fullPos(c, k);
}

function selfiePos(c, k) {
  // 팔을 쭉 편 거리(50~60cm)에서 얼굴 폭이 영상 폭의 약 0.27
  const tw = 0.27 * c.vw / c.cw;
  target = { kind: "oval", cx: 0.5, cy: 0.4, w: tw };
  const f = result && result.faceLandmarks && result.faceLandmarks[0];
  if (!f) return { ok: false, main: "얼굴이 화면에 나오게 해요" };
  const P = (i) => toC(f[i], c);
  const L = P(234), R = P(454), top = P(10), chin = P(152), nose = P(1), eL = P(33), eR = P(263);
  const wRaw = sm("fwr", Math.abs(f[454].x - f[234].x));
  const w = sm("fw", Math.abs(R.x - L.x)), cx = sm("cx", M((L.x + R.x) / 2)), cy = sm("cy", (top.y + chin.y) / 2);
  live = { kind: "oval", cx, cy, w, h: sm("fh", chin.y - top.y) };
  // 다 맞은 뒤 보여줄 팁: 빛 → 턱 → 렌즈 보기
  const eyeY = (eL.y + eR.y) / 2, pitch = (nose.y - eyeY) / (chin.y - eyeY || 1e-6);
  st.tip = backlit({ x0: Math.min(L.x, R.x), x1: Math.max(L.x, R.x), y0: top.y, y1: chin.y }) ? "빛을 마주 보면 얼굴이 환해져요"
    : pitch < 0.26 ? "턱을 살짝 당기면 더 갸름해 보여요"
    : pitch > 0.6 ? "고개를 살짝 들어요"
    : "화면 말고 렌즈를 봐요";
  if (wRaw > 0.34 * (k > 1 ? 1.06 : 1)) return { ok: false, main: "팔을 더 쭉 뻗어요", sub: "가까우면 코가 커 보여요" };
  if (wRaw < 0.2 / (k > 1 ? 1.06 : 1)) return { ok: false, main: "폰을 얼굴에 조금 가까이 해요", sub: "노란 원이 점선만큼 커지게" };
  const dx = cx - 0.5;
  if (Math.abs(dx) > 0.08 * k) return { ok: false, main: `폰을 ${side(dx)}으로 조금 옮겨요`, sub: "노란 원을 점선 안으로" };
  if (cy - 0.4 > 0.06 * k) return { ok: false, main: "폰을 조금 내려요", sub: "노란 원을 점선 안으로" };
  if (0.4 - cy > 0.06 * k) return { ok: false, main: "폰을 조금 올려요", sub: "노란 원을 점선 안으로" };
  return { ok: true };
}

const PL = { nose: 0, earL: 7, earR: 8, shL: 11, shR: 12, footL: 31, footR: 32, heelL: 29, heelR: 30 };

function halfPos(c, k) {
  target = { kind: "bust", cx: 0.5, cy: 0.26, w: 0.2 };
  const p = result && result.landmarks && result.landmarks[0];
  if (!p) return { ok: false, main: "친구가 화면에 나오게 해요", sub: "머리부터 허리까지" };
  const P = (key) => toC(p[PL[key]], c);
  const shW = Math.abs(P("shL").x - P("shR").x), earW = Math.abs(P("earL").x - P("earR").x);
  const w = sm("hw", Math.max(earW * 1.25, shW * 0.42));
  const nose = P("nose");
  const cx = sm("hcx", M(nose.x)), cy = sm("hcy", nose.y - w * 0.15);
  live = { kind: "oval", cx, cy, w, h: w * 1.3 };
  st.tip = backlit({ x0: nose.x - w / 2, x1: nose.x + w / 2, y0: cy - w * 0.6, y1: cy + w * 0.6 }) ? "친구가 빛을 마주 보게 서요" : "어깨를 살짝 틀면 더 날씬해 보여요";
  if (w > 0.24 * (k > 1 ? 1.08 : 1)) return { ok: false, main: "한 걸음 뒤로 가요", sub: "노란 원이 점선만큼 작아지게" };
  if (w < 0.17 / (k > 1 ? 1.08 : 1)) return { ok: false, main: "한 걸음 앞으로 가요", sub: "노란 원이 점선만큼 커지게" };
  if (cy - w * 0.55 < 0.03) return { ok: false, main: "폰을 조금 올려요", sub: "머리가 잘려요" };
  if (Math.abs(cx - 0.5) > 0.09 * k) return { ok: false, main: `폰을 ${side(cx - 0.5)}으로 조금 옮겨요`, sub: "노란 원을 점선 안으로" };
  if (cy - 0.26 > 0.06 * k) return { ok: false, main: "폰을 조금 내려요", sub: "노란 원을 점선 안으로" };
  if (0.26 - cy > 0.06 * k) return { ok: false, main: "폰을 조금 올려요", sub: "노란 원을 점선 안으로" };
  return { ok: true };
}

function fullPos(c, k) {
  target = { kind: "body" };
  const p = result && result.landmarks && result.landmarks[0];
  if (!p) return { ok: false, main: "한 걸음 뒤로 가요", sub: "머리부터 발끝까지 나오게" };
  const P = (key) => toC(p[PL[key]], c);
  const feetSeen = ["footL", "footR", "heelL", "heelR"].some((key) => P(key).v > 0.5 && P(key).y < 1.0);
  const head = { x: sm("nx", M(P("nose").x)), y: sm("ny", P("nose").y) };
  const footY = sm("fy", Math.max(P("footL").y, P("footR").y, P("heelL").y, P("heelR").y));
  const foot = { x: M((P("footL").x + P("footR").x) / 2), y: footY };
  live = { kind: "body", head, foot, feetSeen };
  st.tip = "한쪽 다리를 앞으로 내밀면 더 길어 보여요";
  const headCut = head.y < 0.08 / k, sky = head.y > 0.16 * (k > 1 ? 1.1 : 1), feetOk = footY >= 0.92 / (k > 1 ? 1.01 : 1);
  if (!feetSeen) return sky ? { ok: false, main: "폰을 더 낮게 들어요", sub: "무릎 높이에서 찍어요" } : { ok: false, main: "한 걸음 뒤로 가요", sub: "발끝까지 나오게" };
  if (headCut) return feetOk ? { ok: false, main: "한 걸음 뒤로 가요", sub: "머리가 잘려요" } : { ok: false, main: "폰을 조금 높이 들어요", sub: "머리가 잘려요" };
  if (footY > 0.985) return { ok: false, main: "한 걸음 뒤로 가요", sub: "발끝이 잘려요" };
  if (!feetOk) return head.y > 0.12 ? { ok: false, main: "한 걸음 앞으로 가요", sub: "발이 아래 점선에 닿게" } : { ok: false, main: "폰을 조금 높이 들어요", sub: "발이 아래 점선에 닿게" };
  if (sky) return footY > 0.95 ? { ok: false, main: "폰을 조금 낮게 들어요", sub: "머리 위가 너무 비어요" } : { ok: false, main: "한 걸음 앞으로 가요", sub: "머리 위가 너무 비어요" };
  if (Math.abs(head.x - 0.5) > 0.12 * k) return { ok: false, main: `폰을 ${side(head.x - 0.5)}으로 조금 옮겨요`, sub: "친구가 가운데 오게" };
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
  // AI 준비 등으로 화면이 멈춘 시간은 빼고 센다
  const dt = Math.min(100, Math.max(0, t - lastT)); lastT = t;
  if (hintLeft > 0 && (hintLeft -= dt) <= 0) hideHint();
  if ($("#cam").hidden || !stream || !video.videoWidth) return;
  const c = crop();
  detect(t);
  engine.render(video, c, beauty(), mirrored());

  const a = checkAngle(), p = checkPos(c);
  st.angle = a.ok; st.pos = p.ok;
  if (orient) setLevelBig(!a.ok, t);
  const ready = a.ok && p.ok;
  draw();
  steps();

  let main, sub, go = false;
  if (!a.ok) { main = a.main; sub = a.sub || "노란 공을 가운데 원에 넣어요"; }
  else if (!p.ok) { main = p.main; sub = p.sub || ""; }
  else { main = "좋아요, 지금 찍어요"; sub = st.tip; go = true; }
  if (main !== cand) { cand = main; candAt = t; }
  if (main !== shownMain && (t - candAt > 450 || !shownMain || go || $("#say").classList.contains("go"))) { shownMain = main; say(main, sub, go); speak(main); }
  else if (main === shownMain && $("#saySub").textContent !== (sub || "")) $("#saySub").textContent = sub || "";

  if (ready && !wasReady) beep(1200, 0.06);
  wasReady = ready;
  $("#shutter").classList.toggle("go", ready);
  $("#glow").classList.toggle("on", ready);
}
requestAnimationFrame(loop);

function steps() {
  const s = { angle: st.angle, pos: st.angle && st.pos, shot: false };
  const now = !st.angle ? "angle" : !st.pos ? "pos" : "shot";
  document.querySelectorAll("#steps li").forEach((li) => {
    const key = li.dataset.s;
    li.classList.toggle("done", !!s[key]);
    li.classList.toggle("now", key === now && !s[key]);
  });
}

// ---------- 그리기: 흰 점선(목표) + 노란선(지금 나) ----------
const READY = "#4cc38a", ME = "#ffd23f";
function draw() {
  const W = box.w, H = box.h;
  ctx.clearRect(0, 0, W, H);
  if (!target) return;
  const posOk = st.pos;
  ctx.lineCap = "round"; ctx.lineJoin = "round";
  // 각도 단계 동안은 위치 안내를 아주 옅게 (공에 집중)
  ctx.globalAlpha = st.angle ? 1 : 0.15;

  ctx.setLineDash([12, 9]); ctx.lineWidth = 3; ctx.strokeStyle = posOk ? READY : "rgba(255,255,255,.95)";
  ctx.shadowColor = "rgba(0,0,0,.45)"; ctx.shadowBlur = 6;
  if (target.kind === "oval") {
    const rx = (target.w * W) / 2 * 1.12;
    ovalPath(target.cx * W, target.cy * H, rx, rx * 1.32); ctx.stroke();
  }
  if (target.kind === "bust") {
    const cx = target.cx * W, cy = target.cy * H, rx = (target.w * W) / 2 * 1.1, ry = rx * 1.3;
    ovalPath(cx, cy, rx, ry); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(cx - rx * 3.4, H * 0.98); ctx.bezierCurveTo(cx - rx * 3.2, cy + ry * 1.6, cx - rx * 1.3, cy + ry * 1.25, cx - rx * 0.55, cy + ry * 1.05);
    ctx.moveTo(cx + rx * 3.4, H * 0.98); ctx.bezierCurveTo(cx + rx * 3.2, cy + ry * 1.6, cx + rx * 1.3, cy + ry * 1.25, cx + rx * 0.55, cy + ry * 1.05); ctx.stroke();
  }
  if (target.kind === "body") {
    const hy = H * 0.12, hr = W * 0.07;
    ovalPath(W * 0.5, hy, hr, hr * 1.25); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(W * 0.2, H * 0.955); ctx.lineTo(W * 0.8, H * 0.955); ctx.stroke();
    ctx.setLineDash([]); ctx.shadowBlur = 0;
    label("머리", W * 0.5 - hr - 30, hy + 5); // 왼쪽: 오른쪽 위는 수평 공 자리
    label("발끝", W * 0.5, H * 0.955 - 10);
  }
  ctx.setLineDash([]); ctx.shadowBlur = 0;

  if (!live) { ctx.globalAlpha = 1; return; }
  const col = posOk ? READY : ME;
  ctx.strokeStyle = col; ctx.lineWidth = 4;
  if (live.kind === "oval") {
    const rx = (live.w * W) / 2 * 1.12, ry = mode === "selfie" ? (live.h * H) / 2 * 1.15 : rx * 1.3;
    ovalPath(live.cx * W, live.cy * H, rx, ry); ctx.stroke();
  }
  if (live.kind === "body") {
    ctx.fillStyle = col;
    dot(live.head.x * W, live.head.y * H, 9);
    if (live.feetSeen) dot(live.foot.x * W, Math.min(live.foot.y, 0.995) * H, 9);
    ctx.globalAlpha *= 0.6; ctx.beginPath(); ctx.moveTo(live.head.x * W, live.head.y * H);
    ctx.lineTo(live.foot.x * W, Math.min(live.foot.y, 1) * H); ctx.stroke();
  }
  ctx.globalAlpha = 1;
}
function ovalPath(cx, cy, rx, ry) { ctx.beginPath(); ctx.ellipse(cx, cy, Math.max(1, rx), Math.max(1, ry), 0, 0, Math.PI * 2); }
function dot(x, y, r) { ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill(); }
function label(t, x, y) {
  ctx.font = "500 13px -apple-system, sans-serif"; ctx.textAlign = "center";
  const w = ctx.measureText(t).width + 14;
  ctx.fillStyle = "rgba(0,0,0,.55)"; ctx.beginPath(); ctx.roundRect ? ctx.roundRect(x - w / 2, y - 15, w, 21, 6) : ctx.rect(x - w / 2, y - 15, w, 21); ctx.fill();
  ctx.fillStyle = "#fff"; ctx.fillText(t, x, y);
}

// ---------- 안내 문장 / 목소리 / 소리 ----------
function say(main, sub, go, force) {
  $("#sayMain").textContent = main; $("#saySub").textContent = sub || "";
  $("#say").classList.toggle("go", !!go);
  if (force) shownMain = main;
}
function unlockVoice() { try { speechSynthesis.speak(new SpeechSynthesisUtterance(" ")); } catch {} }
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
  if (!actx || actx.state !== "running") return;
  const o = actx.createOscillator(), g = actx.createGain();
  o.frequency.value = f; g.gain.setValueAtTime(0.12, actx.currentTime); g.gain.exponentialRampToValueAtTime(0.001, actx.currentTime + d);
  o.connect(g).connect(actx.destination); o.start(); o.stop(actx.currentTime + d);
}

// ---------- 촬영 ----------
const cap = document.createElement("canvas");
const capEngine = createBeauty(cap);
$("#shutter").onclick = () => { unlockAudio(); capture(); };
async function capture() {
  const c = crop(); if (!c) return;
  const s = Math.min(1, 4096 / Math.max(c.cw, c.ch));
  cap.width = Math.round(c.cw * s); cap.height = Math.round(c.ch * s);
  const mir = mirrored() && opts.mirror;
  // 뽀샵본과 원본(비교용)을 같은 프레임에서 바로 이어서 만든다
  capEngine.render(video, c, beauty(), mir);
  const pBlob = new Promise((r) => cap.toBlob(r, "image/jpeg", 0.95));
  let pOrig = null;
  if (opts.preset !== "none" && capEngine.gl) {
    capEngine.render(video, c, PRESETS.none, mir);
    pOrig = new Promise((r) => cap.toBlob(r, "image/jpeg", 0.92));
  }
  const [blob, orig] = await Promise.all([pBlob, pOrig]);
  if (!blob) return;
  const shot = { blob, url: URL.createObjectURL(blob), orig: orig ? URL.createObjectURL(orig) : null, thumb: null, at: Date.now(), saved: false };
  makeThumb(shot);
  shots.push(shot);
  // 비교용 원본은 최근 3장만 보관 (메모리 절약)
  shots.slice(0, -3).forEach((o) => { if (o.orig) { URL.revokeObjectURL(o.orig); o.orig = null; } });
  if (shots.length > 30) { const old = shots.shift(); URL.revokeObjectURL(old.url); if (old.thumb) URL.revokeObjectURL(old.thumb); }
  $("#thumbImg").src = shot.thumb || shot.url;
  const fl = $("#flash"); fl.classList.add("on"); setTimeout(() => fl.classList.remove("on"), 60);
  beep(1400, 0.05);
  openReview(shot);
}
// 목록용 작은 사진은 확인 화면을 띄운 뒤 천천히 만든다 (메모리 절약)
function makeThumb(shot) {
  const img = new Image();
  img.onload = () => {
    const tc = Object.assign(document.createElement("canvas"), { width: 360, height: Math.round(360 * img.naturalHeight / img.naturalWidth) });
    tc.getContext("2d").drawImage(img, 0, 0, tc.width, tc.height);
    tc.toBlob((tb) => { if (!tb) return; shot.thumb = URL.createObjectURL(tb); if (shots[shots.length - 1] === shot) $("#thumbImg").src = shot.thumb; }, "image/jpeg", 0.8);
  };
  setTimeout(() => (img.src = shot.url), 300);
}
let holdSave = false; // 공유가 안 되는 폰: 길게 눌러 저장해야 하니 비교 끔
function openReview(s) {
  current = s; holdSave = false; showOrig(false);
  $("#reviewImg").src = s.url; $("#reviewHint").textContent = "";
  $("#compareHint").hidden = !s.orig;
  $(".review-photo").classList.toggle("compare", !!s.orig);
  $("#review").hidden = false;
}
// 사진을 누르고 있는 동안 뽀샵 전 원본
function showOrig(on) {
  const img = $("#reviewImg");
  on = on && current && current.orig && !holdSave;
  img.src = on ? current.orig : current ? current.url : "";
  $("#origTag").hidden = !on;
}
{
  const ph = $(".review-photo");
  const down = (e) => { if (!current || !current.orig || holdSave) return; if (e.cancelable && e.type === "touchstart") e.preventDefault(); showOrig(true); };
  const up = () => { if (!$("#origTag").hidden) showOrig(false); };
  ph.addEventListener("pointerdown", down);
  ph.addEventListener("touchstart", down, { passive: false });
  for (const ev of ["pointerup", "pointercancel", "pointerleave", "touchend", "touchcancel"]) ph.addEventListener(ev, up);
  ph.addEventListener("contextmenu", (e) => { if (!holdSave) e.preventDefault(); });
}
$("#retake").onclick = () => { showOrig(false); $("#review").hidden = true; };
$("#saveBtn").onclick = async () => {
  if (!current || saving) return;
  saving = true;
  try { if (await save(current)) { current.saved = true; $("#review").hidden = true; } }
  finally { saving = false; }
};

// 사진첩 저장: 공유 화면에서 '이미지 저장'을 누르게 안내. 안 되면 길게 눌러 저장.
async function save(s) {
  const name = `insaengshot_${new Date(s.at).toISOString().replace(/[-:T]/g, "").slice(0, 14)}.jpg`;
  const file = new File([s.blob], name, { type: "image/jpeg" });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file] }); toast("사진첩을 확인해 보세요"); return true; }
    catch (e) { if (e.name === "AbortError") return false; }
  }
  holdSave = true; showOrig(false);
  $(".review-photo").classList.remove("compare"); $("#compareHint").hidden = true;
  $("#reviewHint").textContent = "사진을 길게 눌러 '사진 앱에 저장'을 눌러요";
  return false;
}

$("#galleryBtn").onclick = () => {
  const g = $("#galleryGrid");
  g.innerHTML = shots.length ? "" : '<p class="empty">아직 찍은 사진이 없어요</p>';
  [...shots].reverse().forEach((s) => {
    const b = document.createElement("button");
    b.innerHTML = '<img alt="찍은 사진">' + (s.saved ? "" : '<span class="unsaved">저장 안 함</span>');
    b.querySelector("img").src = s.thumb || s.url;
    b.onclick = () => { $("#gallery").hidden = true; openReview(s); }; g.appendChild(b);
  });
  $("#gallery").hidden = false;
};
$("#closeGallery").onclick = () => ($("#gallery").hidden = true);

// ---------- 뽀샵: 셔터 위 3칸 (바로 적용) ----------
if (!engine.gl) opts.preset = "none";
function syncBeauty() {
  document.querySelectorAll("#presets button").forEach((b) => {
    const on = b.dataset.p === opts.preset;
    b.classList.toggle("on", on); b.setAttribute("aria-checked", on ? "true" : "false"); b.tabIndex = on ? 0 : -1;
  });
}
document.querySelectorAll("#presets button").forEach((b) => (b.onclick = () => {
  if (!engine.gl && b.dataset.p !== "none") { toast("이 폰에서는 뽀샵을 쓸 수 없어요"); return; }
  opts.preset = b.dataset.p; saveOpts(); syncBeauty();
}));
syncBeauty();

// ---------- 설정 ----------
const bind = (id, key) => {
  const el = $(id);
  if (el.type === "checkbox") el.checked = opts[key]; else el.value = opts[key];
  el.onchange = () => {
    opts[key] = el.type === "checkbox" ? el.checked : el.value; saveOpts();
    if (key === "ratio") relayout();
    if (key === "voice") { if (opts.voice) unlockVoice(); else if (window.speechSynthesis) speechSynthesis.cancel(); }
  };
};
bind("#optVoice", "voice"); bind("#optMirror", "mirror"); bind("#optRatio", "ratio");
$("#settingsBtn").onclick = () => ($("#settings").hidden = false);
$("#closeSettings").onclick = () => ($("#settings").hidden = true);
$("#showHowto").onclick = () => { $("#settings").hidden = true; $("#howto").hidden = false; };
document.querySelectorAll(".sheet").forEach((s) => s.addEventListener("click", (e) => { if (e.target === s && s.id !== "howto" && s.id !== "review") s.hidden = true; }));

let toastT;
function toast(msg) { const t = $("#toast"); t.textContent = msg; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => (t.hidden = true), 2800); }

// ---------- 다른 앱 갔다 돌아왔을 때 ----------
async function wake() { try { if ("wakeLock" in navigator) await navigator.wakeLock.request("screen"); } catch {} }
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible" || $("#cam").hidden) return;
  wake();
  const t = stream && stream.getVideoTracks()[0];
  if (!t || t.readyState === "ended" || t.muted) startCamera(); else video.play().catch(() => {});
});
document.addEventListener("click", wake, { once: true });

if ("serviceWorker" in navigator && location.protocol === "https:") navigator.serviceWorker.register("sw.js").catch(() => {});
