// 인생샷 코치 — 고쳐야 할 것 딱 하나를 쉬운 말과 그림으로 알려주는 카메라
// 얼굴/몸 인식(MediaPipe, 휴대폰 안에서만 실행) + 폰 기울기 센서

import { FilesetResolver, FaceLandmarker, PoseLandmarker } from "./vendor/vision_bundle.mjs";
import { createBeauty, faceShape, PRESETS } from "./beauty.js";

const $ = (s) => document.querySelector(s);
const video = $("#video"), overlay = $("#overlay"), ctx = overlay.getContext("2d");
const view = $("#view");
const engine = createBeauty(view);

// ---------- 설정 ----------
const DEF = { voice: false, auto: false, mirror: true, ratio: "3:4", seenHowto: false, preset: "natural", beauty: { ...PRESETS.natural } };
let opts = { ...DEF };
try { Object.assign(opts, JSON.parse(localStorage.getItem("isc-opts") || "{}")); } catch {}
const saveOpts = () => { try { localStorage.setItem("isc-opts", JSON.stringify(opts)); } catch {} };

// ---------- 상태 ----------
let mode = "selfie", facing = "user", stream = null;
let vision = null, faceLm = null, poseLm = null, aiFailed = false;
let lastDetect = 0, result = null, orient = null;
let needOrientPerm = typeof DeviceOrientationEvent !== "undefined" && typeof DeviceOrientationEvent.requestPermission === "function";
let box = { x: 0, y: 0, w: 0, h: 0 };
let shots = [], current = null;
let checks = [], readySince = 0, autoBusy = false;
let shown = "", cand = "", candAt = 0, lastSpoken = "", lastSpeakAt = 0;
const ema = {};
const sm = (k, v, a = 0.35) => (ema[k] = ema[k] == null ? v : ema[k] + a * (v - ema[k]));
const ratio = () => { const [a, b] = opts.ratio.split(":").map(Number); return a / b; };
const MODE_NAME = { selfie: "셀카", half: "상반신", full: "전신" };

// ---------- 아이콘 ----------
const ICON = {
  up: '<path d="M12 20V5M5 11l7-7 7 7"/>',
  down: '<path d="M12 4v15M5 13l7 7 7-7"/>',
  left: '<path d="M20 12H5M11 5l-7 7 7 7"/>',
  right: '<path d="M4 12h15M13 5l7 7-7 7"/>',
  far: '<path d="M9 9L4 4M4 9V4h5M15 15l5 5M20 15v5h-5M15 9l5-5M15 4h5v5M9 15l-5 5M4 15v5h5"/>',
  near: '<path d="M4 4l5 5M9 4v5H4M20 20l-5-5M15 20v-5h5M20 4l-5 5M20 9h-5V4M4 20l5-5M4 15h5v5"/>',
  phone: '<rect x="7" y="3" width="10" height="18" rx="2.5"/><path d="M11 18h2"/>',
  tiltBack: '<rect x="8" y="6" width="8" height="15" rx="2" transform="rotate(-18 12 13)"/><path d="M17 3c2 1 3 3 3 5M20 8l-2-1M20 8l1-2"/>',
  tiltFwd: '<rect x="8" y="3" width="8" height="15" rx="2" transform="rotate(18 12 10)"/><path d="M7 21c-2-1-3-3-3-5M4 16l2 1M4 16l-1 2"/>',
  level: '<path d="M3 12h18"/><path d="M6 8l12 8" opacity=".35"/>',
  person: '<circle cx="12" cy="7" r="3.5"/><path d="M5 21c0-5 3-8 7-8s7 3 7 8"/>',
  chinIn: '<circle cx="11" cy="11" r="7"/><path d="M9 10h.01M14 10h.01M10 14c1 .7 2 .7 3 0M19 18l-3-2"/>',
  chinUp: '<circle cx="11" cy="12" r="7"/><path d="M9 11h.01M14 11h.01M10 15c1 .7 2 .7 3 0M19 4l-3 3"/>',
  turn: '<circle cx="12" cy="12" r="7"/><path d="M15 10h.01M11 10h.01M12 15c1 .5 2 .5 3-.3"/><path d="M3 6c2-2 4-3 6-3" /><path d="M3 6V3M3 6h3"/>',
  head: '<circle cx="12" cy="12" r="7"/><path d="M9 11h.01M15 11h.01M10 15h4"/><path d="M12 2v3"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5L19 19M5 19l1.5-1.5M17.5 6.5L19 5"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7"/>',
  wait: '<circle cx="12" cy="12" r="8" opacity=".3"/><path d="M12 4a8 8 0 0 1 8 8"/>',
};
const NUDGE = { up: [0, -5], down: [0, 5], left: [-5, 0], right: [5, 0], far: [0, 0], near: [0, 0] };

// ---------- 화면 전환 ----------
document.querySelectorAll(".pick-card").forEach((b) =>
  b.addEventListener("click", async () => {
    await askOrientPermission();
    $("#start").hidden = true; $("#cam").hidden = false;
    setMode(b.dataset.mode);
    if (!opts.seenHowto) $("#howto").hidden = false;
  })
);
$("#howtoOk").onclick = () => { $("#howto").hidden = true; opts.seenHowto = true; saveOpts(); };
$("#backBtn").onclick = () => { stopCamera(); $("#cam").hidden = true; $("#start").hidden = false; };
$("#flipBtn").onclick = () => { facing = facing === "user" ? "environment" : "user"; startCamera(); };

function setMode(m) {
  mode = m; $("#modeName").textContent = MODE_NAME[m];
  facing = m === "selfie" ? "user" : "environment";
  for (const k in ema) delete ema[k];
  result = null; shown = ""; cand = "";
  startCamera(); loadAI();
}

// ---------- 카메라 ----------
async function startCamera() {
  stopCamera();
  show("wait", "카메라 켜는 중…", "", false);
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: facing }, width: { ideal: 1920 }, height: { ideal: 1440 } } });
  } catch {
    show("phone", "카메라를 켤 수 없어요", "브라우저에서 카메라 '허용'을 눌러주세요", false);
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
  const maxH = H - 120;
  if (h > maxH) { h = maxH; w = h * r; }
  const y = Math.max(0, Math.min((H - h) / 2, 56));
  box = { x: (W - w) / 2, y, w, h };
  for (const el of [view, overlay, $("#frameGlow")]) Object.assign(el.style, { left: box.x + "px", top: y + "px", width: w + "px", height: h + "px" });
  const dpr = Math.min(devicePixelRatio || 1, 2);
  overlay.width = Math.round(w * dpr); overlay.height = Math.round(h * dpr);
  view.width = Math.round(w * dpr); view.height = Math.round(h * dpr);
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
const toC = (p, c) => ({ x: (p.x * c.vw - c.ox) / c.cw, y: (p.y * c.vh - c.oy) / c.ch });

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
  } catch (e) { console.warn(e); aiFailed = true; toast("얼굴 인식이 안 돼서 폰 각도만 알려드릴게요"); }
}

// ---------- 기울기 ----------
async function askOrientPermission() {
  if (!needOrientPerm) return;
  try { await DeviceOrientationEvent.requestPermission(); } catch {}
  needOrientPerm = false;
}
addEventListener("deviceorientation", (e) => {
  if (e.beta == null) return;
  const b = (e.beta * Math.PI) / 180, g = (e.gamma * Math.PI) / 180;
  const ux = -Math.cos(b) * Math.sin(g), uy = Math.sin(b), uz = Math.cos(b) * Math.cos(g);
  const up = (Math.asin(Math.max(-1, Math.min(1, uz))) * 180) / Math.PI; // 화면이 하늘을 향한 정도
  const roll = (Math.atan2(ux, uy) * 180) / Math.PI;                      // 좌우 기울기 (0 = 똑바로)
  orient = { up: sm("up", up, 0.25), roll: sm("roll", roll, 0.25), side: Math.abs(roll) > 55 && Math.abs(roll) < 125 };
});

// ---------- 판단 ----------
// 하나의 확인 항목: ok 여부, 안 맞으면 보여줄 아이콘·말. order 작은 것부터 하나씩 안내.
const item = (key, ok, icon = "", main = "", sub = "", order = 5, soft = false) => ({ key, ok, icon, main, sub, order, soft });
const side = (dx) => (dx < 0 ? "left" : "right");
const sideKo = (dx) => (dx < 0 ? "왼쪽" : "오른쪽");

function lightItem(region) {
  const b = brightness(region);
  if (!b) return null;
  if (b.all < 45) return item("light", false, "sun", "조금 더 밝은 곳으로 가요", "창문이나 불빛 쪽을 바라보면 좋아요", 9);
  if (region && b.face < b.all - 30) return item("light", false, "sun", "빛을 등지고 있어요", "창문·해를 마주 보고 서요", 9, true);
  return item("light", true);
}

function selfieItems(c) {
  const list = [];
  if (orient) {
    if (orient.side) list.push(item("angle", false, "phone", "폰을 세워서 들어요", "", 1));
    else {
      const down = -orient.up; // 내려다보는 각도
      if (down < 6) list.push(item("angle", false, "up", "폰을 눈보다 조금 높이 들어요", "위에서 살짝 내려다보면 얼굴이 갸름해요", 2));
      else if (down > 32) list.push(item("angle", false, "down", "폰을 조금 내려요", "너무 위에서 찍으면 이마만 커 보여요", 2));
      else list.push(item("angle", true));
    }
  }
  const f = result && result.faceLandmarks && result.faceLandmarks[0];
  if (!f) { if (!aiFailed) list.push(item("face", false, "person", "얼굴이 화면에 나오게 해주세요", "", 0)); return list; }
  const P = (i) => toC(f[i], c);
  const L = P(234), R = P(454), nose = P(1), chin = P(152), eL = P(33), eR = P(263), top = P(10);
  const eyeMidY = (eL.y + eR.y) / 2;
  const fw = sm("fw", Math.hypot(R.x - L.x, R.y - L.y));
  const cx = sm("cx", (L.x + R.x) / 2);
  const ey = sm("ey", eyeMidY);
  const tilt = sm("tilt", (Math.atan2(eR.y - eL.y, eR.x - eL.x) * 180) / Math.PI);
  const pitch = sm("pitch", (nose.y - eyeMidY) / (chin.y - eyeMidY || 1e-6));
  const yaw = sm("yaw", (nose.x - L.x) / (R.x - L.x || 1e-6));

  list.push(fw > 0.5 ? item("dist", false, "far", "팔을 더 쭉 펴주세요", "가까이 찍으면 코가 커 보여요", 3)
          : fw < 0.2 ? item("dist", false, "near", "폰을 조금 더 가까이", "", 3)
          : item("dist", true));
  const dx = cx - 0.5, sdx = -dx; // 셀카는 거울처럼 보이니 방향을 뒤집어 안내
  list.push(Math.abs(dx) > 0.1 ? item("pos", false, side(sdx), `폰을 ${sideKo(sdx)}으로 조금 옮겨요`, "얼굴이 가운데 오게", 4) : item("pos", true));
  list.push(ey > 0.46 ? item("eye", false, "down", "폰을 조금 내려요", "눈이 화면 위쪽에 오게", 5)
          : ey < 0.24 ? item("eye", false, "up", "폰을 조금 올려요", "머리가 잘려요", 5)
          : item("eye", true));
  list.push(pitch < 0.26 ? item("chin", false, "chinIn", "턱을 살짝 당겨주세요", "턱을 들면 얼굴이 커 보여요", 6)
          : pitch > 0.55 ? item("chin", false, "chinUp", "턱을 살짝 들어주세요", "너무 숙이면 이중턱이 생겨요", 6)
          : item("chin", true));
  list.push(Math.abs(tilt) > 10 ? item("tilt", false, "head", "고개를 똑바로 세워요", "", 7) : item("tilt", true));
  list.push(Math.abs(yaw - 0.5) < 0.04 ? item("turn", false, "turn", "얼굴을 살짝만 옆으로 돌려요", "정면보다 얼굴선이 예뻐 보여요", 8, true)
          : Math.abs(yaw - 0.5) > 0.3 ? item("turn", false, "turn", "카메라 쪽을 봐주세요", "", 8)
          : item("turn", true));
  const li = lightItem({ x0: Math.min(L.x, R.x), x1: Math.max(L.x, R.x), y0: top.y, y1: chin.y });
  if (li) list.push(li);
  return list;
}

const PL = { nose: 0, eyeL: 2, eyeR: 5, shL: 11, shR: 12, elL: 13, elR: 14, kneeL: 25, kneeR: 26, ankL: 27, ankR: 28, heelL: 29, heelR: 30, footL: 31, footR: 32 };

function personItems(c, full) {
  const list = [];
  if (orient) {
    if (orient.side) list.push(item("angle", false, "phone", "폰을 세워서 들어요", "사람 사진은 세로가 예뻐요", 1));
    else {
      const camUp = -orient.up; // 뒷카메라가 위를 보는 각도
      if (full) {
        if (camUp < -3) list.push(item("angle", false, "down", "무릎을 굽혀 폰을 낮춰주세요", "허리~무릎 높이에서 찍으면 다리가 길어 보여요", 2));
        else if (camUp > 20) list.push(item("angle", false, "tiltFwd", "폰을 조금 세워요", "너무 올려 찍으면 얼굴이 작아져요", 2));
        else list.push(item("angle", true));
      } else {
        if (camUp < -8) list.push(item("angle", false, "tiltBack", "폰을 똑바로 세워요", "내려 찍으면 비율이 짧아 보여요", 2));
        else if (camUp > 12) list.push(item("angle", false, "tiltFwd", "폰을 똑바로 세워요", "올려 찍으면 턱이 커 보여요", 2));
        else list.push(item("angle", true));
      }
      const r = orient.roll;
      list.push(Math.abs(r) > 3 ? item("level", false, "level", "폰을 똑바로 맞춰요", `${r > 0 ? "왼쪽" : "오른쪽"}으로 기울었어요`, 4) : item("level", true));
    }
  }
  const p = result && result.landmarks && result.landmarks[0];
  if (!p) { if (!aiFailed) list.push(item("body", false, "person", "찍을 사람이 화면에 나오게 해주세요", full ? "머리부터 발끝까지" : "머리부터 허리까지", 0)); return list; }
  const P = (k) => toC(p[PL[k]], c);
  const vis = (k) => (p[PL[k]].visibility ?? 1) > 0.5;
  const eyeY = (P("eyeL").y + P("eyeR").y) / 2;
  const shW = Math.abs(P("shL").x - P("shR").x);
  const headTop = sm("ht", eyeY - shW * 0.55);
  const cx = sm("pcx", (P("shL").x + P("shR").x) / 2);

  if (full) {
    const footY = sm("fy", Math.max(P("footL").y, P("footR").y, P("heelL").y, P("heelR").y));
    const feetIn = (vis("footL") || vis("footR") || vis("heelL") || vis("heelR")) && footY < 1.01;
    if (!feetIn) list.push(item("feet", false, "far", "한 걸음 뒤로 가주세요", "발끝까지 다 나오게", 3));
    else if (footY < 0.9) list.push(item("feet", false, "down", "폰을 더 낮춰주세요", "발끝이 화면 맨 아래에 닿게", 3));
    else list.push(item("feet", true));
    if (headTop < 0.01) list.push(item("head", false, "far", "한 걸음 뒤로 가주세요", "머리가 잘려요", 3));
    else if (feetIn && footY - headTop < 0.65) list.push(item("size", false, "near", "한 걸음 앞으로 가주세요", "사람이 너무 작게 나와요", 5));
    else list.push(item("head", true));
  } else {
    const ey = sm("pey", eyeY);
    list.push(headTop < 0.01 ? item("head", false, "far", "한 걸음 뒤로 가주세요", "머리가 잘려요", 3)
            : ey > 0.45 ? item("eye", false, "near", "한 걸음 앞으로 가주세요", "얼굴이 화면 위쪽에 오게", 5)
            : item("eye", true));
    const elbowY = Math.max(P("elL").y, P("elR").y);
    list.push(Math.abs(1 - elbowY) < 0.04 ? item("cut", false, "near", "반 걸음 앞으로 가주세요", "팔꿈치에서 잘리지 않게", 6, true) : item("cut", true));
  }
  const dx = cx - 0.5;
  list.push(Math.abs(dx) > 0.15 ? item("pos", false, side(dx), `폰을 ${sideKo(dx)}으로 살짝 돌려요`, "사람이 가운데 오게", 4) : item("pos", true));
  const nose = P("nose"), hw = shW * 0.4;
  const li = lightItem({ x0: nose.x - hw, x1: nose.x + hw, y0: eyeY - hw, y1: eyeY + hw * 1.4 });
  if (li) list.push(li);
  return list;
}

// ---------- 밝기 ----------
const sCv = Object.assign(document.createElement("canvas"), { width: 48, height: 64 });
const sCtx = sCv.getContext("2d", { willReadFrequently: true });
let bCache = null, bAt = 0;
function brightness(reg) {
  const now = performance.now();
  if (bCache && now - bAt < 600) return bCache;
  const c = crop(); if (!c) return null;
  sCtx.drawImage(video, c.ox, c.oy, c.cw, c.ch, 0, 0, 48, 64);
  const d = sCtx.getImageData(0, 0, 48, 64).data;
  let all = 0, face = 0, n = 0;
  for (let y = 0; y < 64; y++) for (let x = 0; x < 48; x++) {
    const i = (y * 48 + x) * 4, l = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    all += l;
    if (reg && x / 48 >= reg.x0 && x / 48 <= reg.x1 && y / 64 >= reg.y0 && y / 64 <= reg.y1) { face += l; n++; }
  }
  bCache = { all: all / 3072, face: n ? face / n : all / 3072 }; bAt = now;
  return bCache;
}

// ---------- 루프 ----------
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
  checks = mode === "selfie" ? selfieItems(c) : personItems(c, mode === "full");
  guide(t);
  draw();
}
requestAnimationFrame(loop);

function guide(t) {
  const hard = checks.filter((k) => !k.ok && !k.soft).sort((a, b) => a.order - b.order);
  const softs = checks.filter((k) => !k.ok && k.soft).sort((a, b) => a.order - b.order);
  const ready = checks.length > 0 && hard.length === 0;

  // 진행 점: 맞춘 항목 수
  const dots = $("#dots");
  const html = checks.map((k) => `<i class="${k.ok || k.soft ? "ok" : ""}"></i>`).join("");
  if (dots._h !== html) { dots.innerHTML = html; dots._h = html; }

  let icon, main, sub;
  if (ready) { icon = "check"; main = "좋아요! 지금 찍으세요"; sub = softs[0] ? `더 예쁘게: ${softs[0].main}` : ""; }
  else { const k = hard[0]; icon = k.icon; main = k.main; sub = k.sub; }

  // 글자가 깜빡이지 않게 0.5초 유지될 때만 바꿈
  if (main !== cand) { cand = main; candAt = t; }
  if (main !== shown && (t - candAt > 500 || !shown)) { shown = main; show(icon, main, sub, ready); say(main); }

  $("#shutter").classList.toggle("go", ready);
  $("#frameGlow").classList.toggle("on", ready);

  if (opts.auto && ready) {
    if (!readySince) readySince = t;
    if (t - readySince > 1200 && !autoBusy) { autoBusy = true; capture().finally(() => { autoBusy = false; readySince = 0; }); }
  } else readySince = 0;
}

function show(icon, main, sub, go) {
  const ic = $("#cardIcon");
  ic.innerHTML = `<svg viewBox="0 0 24 24">${ICON[icon] || ICON.wait}</svg>`;
  const n = NUDGE[icon];
  ic.classList.toggle("move", !!n);
  if (n) { ic.style.setProperty("--nx", n[0] + "px"); ic.style.setProperty("--ny", n[1] + "px"); }
  $("#cardMain").textContent = main;
  $("#cardSub").textContent = sub || "";
  $("#card").classList.toggle("go", !!go);
}

function say(text) {
  if (!opts.voice || !("speechSynthesis" in window)) return;
  const now = performance.now();
  if ((text === lastSpoken && now - lastSpeakAt < 6000) || now - lastSpeakAt < 1800) return;
  lastSpoken = text; lastSpeakAt = now;
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text); u.lang = "ko-KR"; u.rate = 1.05;
  speechSynthesis.speak(u);
}

// 지금 안내 중인 항목에 필요한 선 하나만 그림
function draw() {
  const w = box.w, h = box.h;
  ctx.clearRect(0, 0, w, h);
  const now = checks.find((k) => !k.ok && !k.soft && k.main === shown);
  if (!now) return;
  ctx.lineWidth = 3; ctx.setLineDash([10, 8]); ctx.strokeStyle = "rgba(255,255,255,.9)";
  const hline = (y) => { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke(); };
  if (now.key === "eye" && mode === "selfie") hline(h * 0.35);
  if (now.key === "feet") hline(h * 0.96);
  ctx.setLineDash([]);
  if (now.key === "level" && orient) {
    const a = (orient.roll * Math.PI) / 180, L = w * 0.3, cx = w / 2, cy = h / 2;
    ctx.strokeStyle = "rgba(255,255,255,.5)"; hline(cy);
    ctx.strokeStyle = "#ffcc4d"; ctx.lineWidth = 4;
    ctx.beginPath(); ctx.moveTo(cx - L * Math.cos(a), cy - L * Math.sin(a)); ctx.lineTo(cx + L * Math.cos(a), cy + L * Math.sin(a)); ctx.stroke();
  }
}

function currentFace(c) {
  const f = mode === "selfie" && result && result.faceLandmarks && result.faceLandmarks[0];
  if (!f) return null;
  return faceShape((i) => toC(f[i], c), c.cw / c.ch);
}

// ---------- 촬영 ----------
$("#shutter").onclick = () => capture(true);
async function capture(showReview = false) {
  const c = crop(); if (!c) return;
  const good = checks.length > 0 && !checks.some((k) => !k.ok && !k.soft);
  // 뽀샵이 들어간 원본 크기 사진을 한 번 그려서 저장
  const keepW = view.width, keepH = view.height;
  view.width = Math.round(c.cw); view.height = Math.round(c.ch);
  engine.render(video, c, opts.beauty, currentFace(c), facing === "user" && opts.mirror);
  const blob = await new Promise((r) => view.toBlob(r, "image/jpeg", 0.95));
  view.width = keepW; view.height = keepH;
  if (!blob) return;
  const shot = { blob, url: URL.createObjectURL(blob), good, at: Date.now() };
  shots.push(shot);
  $("#thumbImg").src = shot.url;
  const fl = $("#flash"); fl.classList.add("on"); setTimeout(() => fl.classList.remove("on"), 60);
  if (navigator.vibrate) navigator.vibrate(30);
  if (showReview || opts.auto) openReview(shot);
}

function openReview(shot) {
  current = shot;
  $("#reviewImg").src = shot.url;
  $("#reviewMsg").textContent = shot.good ? "잘 나왔어요!" : "안내대로 맞추면 더 예쁘게 나와요";
  $("#review").hidden = false;
}
$("#retake").onclick = () => ($("#review").hidden = true);
$("#saveBtn").onclick = async () => { if (current) { await save(current); $("#review").hidden = true; } };

async function save(s) {
  const name = `insaengshot_${new Date(s.at).toISOString().replace(/[-:T]/g, "").slice(0, 14)}.jpg`;
  const file = new File([s.blob], name, { type: "image/jpeg" });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file] }); toast("'이미지 저장'을 누르면 사진첩에 들어가요"); return; }
    catch (e) { if (e.name === "AbortError") return; }
  }
  const a = Object.assign(document.createElement("a"), { href: s.url, download: name });
  document.body.appendChild(a); a.click(); a.remove();
  toast("저장했어요");
}

$("#galleryBtn").onclick = () => {
  const g = $("#galleryGrid");
  g.innerHTML = shots.length ? "" : '<p class="empty">아직 찍은 사진이 없어요</p>';
  [...shots].reverse().forEach((s) => {
    const b = document.createElement("button");
    b.innerHTML = '<img alt="찍은 사진">'; b.firstChild.src = s.url;
    b.onclick = () => { $("#gallery").hidden = true; openReview(s); };
    g.appendChild(b);
  });
  $("#gallery").hidden = false;
};
$("#closeGallery").onclick = () => ($("#gallery").hidden = true);

// ---------- 뽀샵 ----------
const SL = { bSmooth: "smooth", bBright: "bright", bWarm: "warm", bSlim: "slim", bEye: "eye" };
function syncBeauty() {
  $("#beautyName").textContent = PRESETS[opts.preset] ? PRESETS[opts.preset].name : "직접 조절";
  document.querySelectorAll("#presets button").forEach((b) => b.classList.toggle("on", b.dataset.p === opts.preset));
  for (const id in SL) $("#" + id).value = opts.beauty[SL[id]];
}
document.querySelectorAll("#presets button").forEach((b) => (b.onclick = () => {
  opts.preset = b.dataset.p; const { name, ...v } = PRESETS[b.dataset.p]; opts.beauty = v; saveOpts(); syncBeauty();
}));
for (const id in SL) $("#" + id).oninput = (e) => { opts.beauty[SL[id]] = +e.target.value; opts.preset = "custom"; saveOpts(); syncBeauty(); };
$("#beautyBtn").onclick = () => { if (!engine.gl) { toast("이 폰에서는 뽀샵을 쓸 수 없어요"); return; } $("#beauty").hidden = false; };
$("#closeBeauty").onclick = () => ($("#beauty").hidden = true);
syncBeauty();

// ---------- 설정 ----------
const bind = (id, key) => {
  const el = $(id);
  if (el.type === "checkbox") el.checked = opts[key]; else el.value = opts[key];
  el.onchange = () => { opts[key] = el.type === "checkbox" ? el.checked : el.value; saveOpts(); if (key === "ratio") layout(); if (key === "voice" && !opts.voice && window.speechSynthesis) speechSynthesis.cancel(); };
};
bind("#optVoice", "voice"); bind("#optAuto", "auto"); bind("#optMirror", "mirror"); bind("#optRatio", "ratio");
$("#settingsBtn").onclick = () => ($("#settings").hidden = false);
$("#closeSettings").onclick = () => ($("#settings").hidden = true);
$("#showHowto").onclick = () => { $("#settings").hidden = true; $("#howto").hidden = false; };
document.querySelectorAll(".sheet").forEach((s) => s.addEventListener("click", (e) => { if (e.target === s && s.id !== "howto") s.hidden = true; }));

let toastT;
function toast(msg) { const t = $("#toast"); t.textContent = msg; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => (t.hidden = true), 2500); }

// 화면 꺼짐 방지
async function wake() { try { if ("wakeLock" in navigator) await navigator.wakeLock.request("screen"); } catch {} }
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && !$("#cam").hidden) wake(); });
document.addEventListener("click", wake, { once: true });

if ("serviceWorker" in navigator && location.protocol === "https:") navigator.serviceWorker.register("sw.js").catch(() => {});
