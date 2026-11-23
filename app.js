// 인생샷 코치 — 실시간 촬영 코칭 카메라
// 얼굴/자세 인식(MediaPipe, 기기 안에서 실행) + 폰 기울기 센서로 각도·높이·구도·거리·빛을 판단하고
// 가장 먼저 고쳐야 할 것 한 가지를 말로 알려준다.

import { FilesetResolver, FaceLandmarker, PoseLandmarker } from "./vendor/vision_bundle.mjs";

const $ = (s) => document.querySelector(s);
const video = $("#video");
const overlay = $("#overlay");
const ctx = overlay.getContext("2d");

// ---------- 설정 (기기에 저장) ----------
const DEFAULTS = { voice: false, auto: false, grid: true, dots: false, mirror: true, ratio: "3:4", turn: true };
let opts = { ...DEFAULTS };
try { Object.assign(opts, JSON.parse(localStorage.getItem("isc-opts") || "{}")); } catch {}
const saveOpts = () => { try { localStorage.setItem("isc-opts", JSON.stringify(opts)); } catch {} };

// ---------- 상태 ----------
let mode = "selfie";            // selfie | half | full
let facing = "user";            // user | environment
let stream = null;
let vision = null, faceLm = null, poseLm = null, aiFailed = false;
let lastDetect = 0, lastResult = null;
let orient = null;              // { up: 앞면이 위를 향한 각도(°), roll: 좌우 기울기(°) }
let needOrientPerm = typeof DeviceOrientationEvent !== "undefined" && typeof DeviceOrientationEvent.requestPermission === "function";
let frameBox = { x: 0, y: 0, w: 0, h: 0 };  // 화면에서 사진 영역
let shots = [];
let goodSince = 0, autoBusy = false;
let shownMsg = "", candMsg = "", candSince = 0;
let lastSpoken = "", lastSpeakAt = 0;
const ema = {};                 // 지표 부드럽게
const smooth = (k, v, a = 0.35) => (v == null ? (delete ema[k], null) : (ema[k] = ema[k] == null ? v : ema[k] + a * (v - ema[k])));

const ratioNum = () => { const [a, b] = opts.ratio.split(":").map(Number); return a / b; };

// ---------- 화면 전환 ----------
document.querySelectorAll("[data-mode]").forEach((b) =>
  b.addEventListener("click", async () => {
    const m = b.dataset.mode;
    await askOrientPermission();
    if ($("#cam").hidden) { $("#start").hidden = true; $("#cam").hidden = false; }
    setMode(m);
  })
);
$("#backBtn").onclick = () => { stopCamera(); $("#cam").hidden = true; $("#start").hidden = false; };
$("#flipBtn").onclick = () => { facing = facing === "user" ? "environment" : "user"; startCamera(); };

function setMode(m) {
  mode = m;
  document.querySelectorAll(".mode-tabs button").forEach((b) => b.classList.toggle("on", b.dataset.mode === m));
  facing = m === "selfie" ? "user" : "environment";
  Object.keys(ema).forEach((k) => delete ema[k]);
  lastResult = null; shownMsg = ""; candMsg = "";
  startCamera();
  ensureModels();
}

// ---------- 카메라 ----------
async function startCamera() {
  stopCamera();
  setCoach("카메라 켜는 중…", "", false);
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: facing }, width: { ideal: 1920 }, height: { ideal: 1440 } },
    });
  } catch (e) {
    const insecure = !window.isSecureContext;
    setCoach("카메라를 켤 수 없어요",
      insecure ? "https:// 주소로 열어야 카메라가 켜져요. 설치 안내를 봐주세요." : "브라우저 설정에서 이 사이트의 카메라를 허용해 주세요.", false);
    return;
  }
  video.srcObject = stream;
  video.classList.toggle("mirror", facing === "user");
  await video.play().catch(() => {});
  setupZoom();
  layout();
}
function stopCamera() { if (stream) stream.getTracks().forEach((t) => t.stop()); stream = null; }

function setupZoom() {
  const track = stream && stream.getVideoTracks()[0];
  const caps = track && track.getCapabilities ? track.getCapabilities() : {};
  const wrap = $("#zoomWrap"), zr = $("#zoom");
  if (caps.zoom && caps.zoom.max > caps.zoom.min) {
    zr.min = caps.zoom.min; zr.max = Math.min(caps.zoom.max, 5); zr.step = caps.zoom.step || 0.1;
    const start = mode === "selfie" ? caps.zoom.min : Math.min(Math.max(1, caps.zoom.min), caps.zoom.max);
    zr.value = start; $("#zoomVal").textContent = (+start).toFixed(1) + "x";
    wrap.hidden = false;
    zr.oninput = () => { $("#zoomVal").textContent = (+zr.value).toFixed(1) + "x"; track.applyConstraints({ advanced: [{ zoom: +zr.value }] }).catch(() => {}); };
  } else wrap.hidden = true;
}

// 사진 비율 영역을 화면에 맞춰 배치 (보이는 그대로 저장)
function layout() {
  const W = innerWidth, H = innerHeight, r = ratioNum();
  let w = W, h = W / r;
  if (h > H) { h = H; w = H * r; }
  frameBox = { x: (W - w) / 2, y: (H - h) / 2, w, h };
  for (const el of [video, overlay]) { el.style.width = w + "px"; el.style.height = h + "px"; }
  const dpr = Math.min(devicePixelRatio || 1, 2);
  overlay.width = Math.round(w * dpr); overlay.height = Math.round(h * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
addEventListener("resize", layout);

// 영상 좌표(0~1) → 사진 영역 좌표(0~1). 셀카 미러는 그릴 때만 반영.
function cropInfo() {
  const vw = video.videoWidth, vh = video.videoHeight, r = ratioNum();
  if (!vw) return null;
  let cw = vw, ch = vh;
  if (vw / vh > r) cw = vh * r; else ch = vw / r;
  return { vw, vh, cw, ch, ox: (vw - cw) / 2, oy: (vh - ch) / 2 };
}
function toCrop(p, c) { return { x: (p.x * c.vw - c.ox) / c.cw, y: (p.y * c.vh - c.oy) / c.ch, v: p.visibility ?? 1 }; }

// ---------- AI 모델 ----------
async function ensureModels() {
  if (aiFailed) return;
  try {
    if (!vision) vision = await FilesetResolver.forVisionTasks(new URL("./vendor", location.href).href.replace(/\/$/, ""));
    const make = async (Cls, path, extra) => {
      for (const delegate of ["GPU", "CPU"]) {
        try { return await Cls.createFromOptions(vision, { baseOptions: { modelAssetPath: path, delegate }, runningMode: "VIDEO", ...extra }); }
        catch (e) { if (delegate === "CPU") throw e; }
      }
    };
    if (mode === "selfie" && !faceLm) faceLm = await make(FaceLandmarker, "./vendor/face_landmarker.task", { numFaces: 1 });
    if (mode !== "selfie" && !poseLm) poseLm = await make(PoseLandmarker, "./vendor/pose_landmarker_lite.task", { numPoses: 1 });
  } catch (e) {
    console.warn(e); aiFailed = true;
    toast("얼굴 인식을 못 켰어요. 기울기 안내만 할게요.");
  }
}

// ---------- 기울기 센서 ----------
async function askOrientPermission() {
  if (!needOrientPerm) return;
  try { const r = await DeviceOrientationEvent.requestPermission(); needOrientPerm = false; if (r !== "granted") toast("기울기 센서가 꺼져 있어 각도 안내는 빠져요."); }
  catch {}
}
addEventListener("deviceorientation", (e) => {
  if (e.beta == null) return;
  const b = (e.beta * Math.PI) / 180, g = (e.gamma * Math.PI) / 180;
  // 기기 좌표계에서 '하늘 방향' 벡터 (W3C Z-X'-Y'' 회전 기준)
  const ux = -Math.cos(b) * Math.sin(g), uy = Math.sin(b), uz = Math.cos(b) * Math.cos(g);
  const up = (Math.asin(Math.max(-1, Math.min(1, uz))) * 180) / Math.PI; // 화면(=전면카메라)이 위로 향한 각도
  let roll = (Math.atan2(ux, uy) * 180) / Math.PI;                        // 0 = 똑바로 세로
  const ang = (screen.orientation && screen.orientation.angle) || window.orientation || 0;
  orient = { up: smooth("up", up, 0.25), roll: smooth("roll", roll, 0.25), landscape: Math.abs(ang) === 90 || (Math.abs(roll) > 60 && Math.abs(roll) < 120) };
});

// ---------- 판단 규칙 ----------
// 각 항목: { key, label, s: good|warn|bad|na, msg, sub, pr(우선순위: 작을수록 먼저), w(점수 비중) }
const C = (key, label, s, msg = "", sub = "", pr = 5, w = 1) => ({ key, label, s, msg, sub, pr, w });
const dirPhone = (dx) => (dx < 0 ? "왼쪽" : "오른쪽");

function brightnessCheck(region) {
  const b = sampleBrightness(region);
  if (!b) return C("light", "빛", "na");
  const { face, all } = b;
  if (all < 45) return C("light", "빛", "bad", "너무 어두워요", "밝은 곳이나 창문 쪽을 바라보고 찍어요", 3, 0.8);
  if (region && face < all - 28) return C("light", "빛", "warn", "역광이에요", "빛(창문·해)을 등지지 말고 마주 보세요", 6, 0.8);
  if (region && face > 235) return C("light", "빛", "warn", "얼굴이 하얗게 날아가요", "직사광선을 피해 그늘이나 반그늘로", 7, 0.6);
  return C("light", "빛", "good");
}

function selfieChecks(r, c) {
  const out = [];
  const o = orient;
  // 폰 각도: 전면카메라가 10~25° 내려다보는 게 기본
  if (o) {
    if (o.landscape) out.push(C("angle", "각도", "bad", "폰을 세로로 들어요", "셀카는 세로가 얼굴 비율이 좋아요", 1, 1.4));
    else {
      const down = -o.up;
      if (down < 3) out.push(C("angle", "각도", "bad", "폰을 눈보다 조금 위로", "카메라가 살짝 내려다보게(10~25°) 들어요", 2, 1.4));
      else if (down < 9) out.push(C("angle", "각도", "warn", "폰을 살짝만 더 위로", `지금 ${down.toFixed(0)}° · 목표 10~25°`, 4, 1.4));
      else if (down <= 27) out.push(C("angle", "각도", "good"));
      else if (down <= 38) out.push(C("angle", "각도", "warn", "너무 위에서 찍어요", `지금 ${down.toFixed(0)}° · 이마만 커 보여요. 폰을 조금 내려요`, 4, 1.4));
      else out.push(C("angle", "각도", "bad", "폰을 내려요", "너무 높아서 얼굴이 눌려 보여요", 2, 1.4));
    }
  } else out.push(C("angle", "각도", "na"));

  const f = r && r.faceLandmarks && r.faceLandmarks[0];
  if (!f) {
    out.push(C("face", "얼굴", "bad", aiFailed ? "" : "얼굴이 보이게 해주세요", "", 0, 0));
    out.push(brightnessCheck(null));
    return out;
  }
  const P = (i) => toCrop(f[i], c);
  const L = P(234), R = P(454), nose = P(1), chin = P(152), eL = P(33), eR = P(263), top = P(10);
  const faceW = smooth("fw", Math.hypot(R.x - L.x, R.y - L.y));
  const cx = smooth("cx", (L.x + R.x) / 2);
  const eyeY = smooth("ey", (eL.y + eR.y) / 2);
  const rollDeg = smooth("hr", (Math.atan2(eR.y - eL.y, eR.x - eL.x) * 180) / Math.PI);
  const yawR = smooth("yaw", (nose.x - L.x) / (R.x - L.x || 1e-6));
  const pitchR = smooth("pr", (nose.y - (eL.y + eR.y) / 2) / (chin.y - (eL.y + eR.y) / 2 || 1e-6));

  // 거리 (광각 왜곡)
  if (faceW > 0.56) out.push(C("dist", "거리", "bad", "팔을 쭉 펴요", "너무 가까우면 코가 커 보여요(광각 왜곡)", 1, 1.2));
  else if (faceW > 0.47) out.push(C("dist", "거리", "warn", "조금만 더 멀리", "팔을 끝까지 펴면 얼굴이 자연스러워요", 3, 1.2));
  else if (faceW < 0.2) out.push(C("dist", "거리", "warn", "조금 더 가까이", "얼굴이 너무 작게 나와요", 6, 1.2));
  else out.push(C("dist", "거리", "good"));

  // 가로 위치: 가운데 (가장자리는 늘어남)
  const dx = cx - 0.5;
  if (Math.abs(dx) > 0.14) out.push(C("pos", "위치", "bad", `폰을 ${dirPhone(facing === "user" ? -dx : dx)}으로`, "얼굴을 화면 가운데에 두세요. 가장자리는 얼굴이 늘어나요", 3, 1));
  else if (Math.abs(dx) > 0.07) out.push(C("pos", "위치", "warn", "얼굴을 가운데로", "", 7, 1));
  else out.push(C("pos", "위치", "good"));

  // 눈높이: 위쪽 1/3 선
  if (eyeY > 0.5) out.push(C("eye", "눈높이", "bad", "폰을 조금 내려요", "눈이 위쪽 1/3 선에 오게", 4, 1));
  else if (eyeY > 0.43) out.push(C("eye", "눈높이", "warn", "폰을 살짝 내려요", "눈을 위쪽 점선에 맞춰요", 6, 1));
  else if (eyeY < 0.2) out.push(C("eye", "눈높이", "bad", "폰을 조금 올려요", "머리가 잘려요", 4, 1));
  else if (eyeY < 0.27) out.push(C("eye", "눈높이", "warn", "폰을 살짝 올려요", "눈을 위쪽 점선에 맞춰요", 6, 1));
  else out.push(C("eye", "눈높이", "good"));

  // 턱 (얼굴 상하 각도)
  if (pitchR < 0.22) out.push(C("chin", "턱", "bad", "턱을 당겨요", "턱을 들면 콧구멍과 턱선이 커 보여요", 2, 1.2));
  else if (pitchR < 0.29) out.push(C("chin", "턱", "warn", "턱을 살짝 당겨요", "", 5, 1.2));
  else if (pitchR > 0.55) out.push(C("chin", "턱", "warn", "턱을 조금 앞으로", "너무 숙이면 이중턱이 생겨요", 5, 1.2));
  else out.push(C("chin", "턱", "good"));

  // 고개 기울기
  const rd = Math.abs(rollDeg);
  if (rd > 14) out.push(C("tilt", "고개", "bad", "고개를 똑바로", "얼굴이 많이 기울었어요", 4, 0.8));
  else if (rd > 7) out.push(C("tilt", "고개", "warn", "고개를 살짝 세워요", "", 8, 0.8));
  else out.push(C("tilt", "고개", "good"));

  // 얼짱각도 (좌우 회전)
  const off = Math.abs(yawR - 0.5);
  if (off > 0.3) out.push(C("turn", "얼굴방향", "bad", "얼굴을 카메라 쪽으로", "너무 옆으로 돌렸어요", 4, 0.8));
  else if (opts.turn && off < 0.05) out.push(C("turn", "얼굴방향", "warn", "얼굴을 살짝 옆으로 돌려요", "10~20°만. 자신 있는 쪽 얼굴로", 9, 0.8));
  else if (!opts.turn && off > 0.15) out.push(C("turn", "얼굴방향", "warn", "정면을 봐요", "", 8, 0.8));
  else out.push(C("turn", "얼굴방향", "good"));

  const xs = [L.x, R.x], ys = [top.y, chin.y];
  out.push(brightnessCheck({ x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) }));
  return out;
}

// 자세 랜드마크 번호
const PL = { nose: 0, eyeL: 2, eyeR: 5, shL: 11, shR: 12, elL: 13, elR: 14, hipL: 23, hipR: 24, kneeL: 25, kneeR: 26, ankL: 27, ankR: 28, heelL: 29, heelR: 30, footL: 31, footR: 32 };

function personChecks(r, c, full) {
  const out = [];
  const o = orient;
  if (o) {
    const rearUp = -o.up;   // 후면카메라가 위로 향한 각도
    const roll = o.roll;
    if (o.landscape) out.push(C("vert", "세로", "warn", "폰을 세로로", "인물 사진은 세로가 비율이 좋아요", 2, 0.8));
    else {
      out.push(C("vert", "세로", "good", "", "", 9, 0.4));
      if (Math.abs(roll) > 5) out.push(C("level", "수평", "bad", `폰이 ${roll > 0 ? "왼쪽" : "오른쪽"}으로 기울었어요`, "화면 가운데 수평선을 초록으로 맞춰요", 1, 1.2));
      else if (Math.abs(roll) > 1.8) out.push(C("level", "수평", "warn", "수평을 맞춰요", `${Math.abs(roll).toFixed(1)}° 기울었어요`, 5, 1.2));
      else out.push(C("level", "수평", "good"));
    }
    if (full) {
      if (rearUp < -6) out.push(C("angle", "각도", "bad", "폰을 낮추고 살짝 위로", "내려 찍으면 다리가 짧아져요. 무릎을 굽혀 허리~무릎 높이에서", 0, 1.6));
      else if (rearUp < -1) out.push(C("angle", "각도", "warn", "폰 윗부분을 살짝 뒤로", "카메라가 조금 위를 보게(0~12°)", 3, 1.6));
      else if (rearUp <= 13) out.push(C("angle", "각도", "good"));
      else if (rearUp <= 22) out.push(C("angle", "각도", "warn", "너무 올려 찍어요", "얼굴이 작아지고 턱이 커 보여요. 조금만 세워요", 3, 1.6));
      else out.push(C("angle", "각도", "bad", "폰을 더 세워요", "하늘을 찍고 있어요", 1, 1.6));
    } else {
      if (rearUp < -10) out.push(C("angle", "각도", "bad", "폰을 세워요", "위에서 내려 찍으면 비율이 무너져요. 가슴 높이에서 수평으로", 1, 1.4));
      else if (rearUp < -4) out.push(C("angle", "각도", "warn", "폰을 조금 더 세워요", "가슴~눈 높이에서 수평", 4, 1.4));
      else if (rearUp <= 6) out.push(C("angle", "각도", "good"));
      else if (rearUp <= 14) out.push(C("angle", "각도", "warn", "폰을 조금 숙여요", "올려 찍으면 턱이 커 보여요", 4, 1.4));
      else out.push(C("angle", "각도", "bad", "폰을 수평으로", "너무 아래에서 찍고 있어요", 1, 1.4));
    }
  } else out.push(C("angle", "각도", "na"));

  const p = r && r.landmarks && r.landmarks[0];
  if (!p) {
    out.push(C("body", "사람", "bad", aiFailed ? "" : "사람이 화면에 들어오게", full ? "머리부터 발끝까지" : "머리부터 허리까지", 0, 0));
    out.push(brightnessCheck(null));
    return out;
  }
  const P = (k) => toCrop(p[PL[k]], c);
  const vis = (k) => (p[PL[k]].visibility ?? 1) > 0.5;
  const nose = P("nose"), eyeL = P("eyeL"), eyeR = P("eyeR"), shL = P("shL"), shR = P("shR");
  const eyeY = (eyeL.y + eyeR.y) / 2;
  const headTop = smooth("ht", eyeY - Math.abs(shL.x - shR.x) * 0.55); // 정수리 추정
  const cx = smooth("pcx", (shL.x + shR.x) / 2);

  // 가로 위치
  const dx = cx - 0.5;
  if (Math.abs(dx) > 0.2) out.push(C("pos", "위치", "bad", `폰을 ${dirPhone(dx)}으로 살짝 돌려요`, "사람을 가운데나 세로 3분할 선에", 3, 0.8));
  else if (Math.abs(dx) > 0.12 && Math.abs(Math.abs(dx) - 0.167) > 0.05) out.push(C("pos", "위치", "warn", "사람을 가운데로", "", 7, 0.8));
  else out.push(C("pos", "위치", "good"));

  // 머리 위 여백
  if (headTop < 0.015) out.push(C("head", "머리여백", "bad", "머리가 잘려요", full ? "한 걸음 뒤로 가요" : "폰을 살짝 올려요", 2, 1));
  else if (headTop > (full ? 0.14 : 0.16)) out.push(C("head", "머리여백", "warn", full ? "머리 위가 너무 비어요" : "머리 위 여백을 줄여요", full ? "한 걸음 앞으로, 또는 줌을 살짝" : "폰을 살짝 내리거나 한 걸음 앞으로", 5, 1));
  else out.push(C("head", "머리여백", "good"));

  if (full) {
    const footY = smooth("fy", Math.max(P("footL").y, P("footR").y, P("heelL").y, P("heelR").y));
    const feetVis = vis("footL") || vis("footR") || vis("heelL") || vis("heelR");
    const ankY = Math.max(P("ankL").y, P("ankR").y), kneeY = Math.max(P("kneeL").y, P("kneeR").y);
    if (!feetVis || footY > 1.01) {
      if (Math.abs(1 - ankY) < 0.05 || Math.abs(1 - kneeY) < 0.05) out.push(C("feet", "발끝", "bad", "발목·무릎에서 잘렸어요", "한 걸음 뒤로 가서 발끝까지 넣어요", 1, 1.6));
      else out.push(C("feet", "발끝", "bad", "발끝이 안 보여요", "한 걸음 뒤로, 또는 폰을 낮춰요", 1, 1.6));
    } else if (footY < 0.86) out.push(C("feet", "발끝", "bad", "발끝을 화면 맨 아래로", "폰을 더 낮추면 발끝이 내려가고 다리가 길어 보여요", 1, 1.6));
    else if (footY < 0.93) out.push(C("feet", "발끝", "warn", "발끝을 조금 더 아래로", "아래 초록선에 발끝을 붙여요", 4, 1.6));
    else out.push(C("feet", "발끝", "good"));

    // 사람 크기 (화면 세로를 채우는 정도)
    const bodyH = (ema.fy ?? footY) - headTop;
    if (bodyH < 0.62) out.push(C("size", "크기", "warn", "한두 걸음 앞으로", "사람이 작게 나와요. 화면 세로를 꽉 채워요", 6, 1));
    else out.push(C("size", "크기", "good"));
  } else {
    // 상반신: 프레임 아래 가장자리가 관절(팔꿈치·손목)에 걸리지 않게, 눈은 위 1/3
    const ey = smooth("pey", eyeY);
    if (ey > 0.45) out.push(C("eye", "눈높이", "warn", "폰을 살짝 내려요", "눈이 위쪽 1/3 선에 오게", 5, 1));
    else if (ey < 0.18) out.push(C("eye", "눈높이", "bad", "폰을 살짝 올려요", "", 3, 1));
    else out.push(C("eye", "눈높이", "good"));
    const elbowY = Math.max(P("elL").y, P("elR").y);
    const hipY = Math.min(P("hipL").y, P("hipR").y);
    if (Math.abs(1 - elbowY) < 0.04) out.push(C("cut", "자르는곳", "warn", "팔꿈치에서 잘려요", "조금 앞으로(가슴 아래) 또는 뒤로(허리) 가요", 5, 0.8));
    else if (hipY < 0.98 && hipY > 0.85) out.push(C("cut", "자르는곳", "good"));
    else out.push(C("cut", "자르는곳", "good"));
  }

  const xs = [shL.x, shR.x];
  const fw = Math.abs(shL.x - shR.x) * 0.45;
  out.push(brightnessCheck({ x0: nose.x - fw, x1: nose.x + fw, y0: eyeY - fw * 1.2, y1: eyeY + fw * 1.5 }));
  return out;
}

// ---------- 밝기 샘플 ----------
const sampleCv = document.createElement("canvas");
sampleCv.width = 48; sampleCv.height = 64;
const sctx = sampleCv.getContext("2d", { willReadFrequently: true });
let lastBright = null, lastBrightAt = 0;
function sampleBrightness(region) {
  const now = performance.now();
  if (now - lastBrightAt < 500 && lastBright && !region === !lastBright.region) return lastBright;
  const c = cropInfo(); if (!c) return null;
  sctx.drawImage(video, c.ox, c.oy, c.cw, c.ch, 0, 0, 48, 64);
  const d = sctx.getImageData(0, 0, 48, 64).data;
  let all = 0, face = 0, fn = 0;
  for (let y = 0; y < 64; y++) for (let x = 0; x < 48; x++) {
    const i = (y * 48 + x) * 4, l = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    all += l;
    if (region && x / 48 >= region.x0 && x / 48 <= region.x1 && y / 64 >= region.y0 && y / 64 <= region.y1) { face += l; fn++; }
  }
  lastBright = { all: all / (48 * 64), face: fn ? face / fn : all / (48 * 64), region: !!region };
  lastBrightAt = now;
  return lastBright;
}

// ---------- 메인 루프 ----------
let checks = [];
function loop(t) {
  requestAnimationFrame(loop);
  if ($("#cam").hidden || !video.videoWidth) return;
  const c = cropInfo();
  const lm = mode === "selfie" ? faceLm : poseLm;
  if (lm && t - lastDetect > 66 && video.readyState >= 2) {
    lastDetect = t;
    try { lastResult = mode === "selfie" ? lm.detectForVideo(video, t) : lm.detectForVideo(video, t); } catch (e) { console.warn(e); }
  }
  checks = mode === "selfie" ? selfieChecks(lastResult, c) : personChecks(lastResult, c, mode === "full");
  draw(c);
  coach(t);
}
requestAnimationFrame(loop);

function scoreOf(list) {
  let s = 0, w = 0;
  for (const k of list) { if (k.s === "na" || !k.w) continue; w += k.w; s += k.w * (k.s === "good" ? 1 : k.s === "warn" ? 0.55 : 0); }
  const missing = list.find((k) => (k.key === "face" || k.key === "body") && k.s === "bad");
  return missing ? 0 : w ? Math.round((s / w) * 100) : 0;
}

function coach(t) {
  const score = scoreOf(checks);
  // 체크 목록
  const box = $("#checks");
  const html = checks.filter((k) => k.label && k.key !== "face" && k.key !== "body" && k.key !== "vert")
    .map((k) => `<div class="chk ${k.s}"><i></i>${k.label}</div>`).join("");
  if (box._h !== html) { box.innerHTML = html; box._h = html; }
  // 점수 링
  const ring = $("#scoreRing");
  ring.style.strokeDashoffset = 289 * (1 - score / 100);
  ring.style.stroke = score >= 85 ? "var(--good)" : score >= 60 ? "var(--warn)" : "var(--bad)";
  $("#scoreNum").textContent = score;

  const issues = checks.filter((k) => (k.s === "bad" || k.s === "warn") && k.msg).sort((a, b) => (a.s === b.s ? a.pr - b.pr : a.s === "bad" ? -1 : 1));
  const allGood = !issues.some((k) => k.s === "bad") && score >= 85;
  let main, sub;
  if (allGood) {
    main = "지금 찍으세요!";
    sub = issues[0] ? `더 좋게: ${issues[0].msg}` : poseTip();
  } else if (issues[0]) { main = issues[0].msg; sub = issues[0].sub; }
  else { main = "잠깐만요…"; sub = ""; }

  // 메시지가 깜빡이지 않게 0.45초 유지될 때만 바꿈
  if (main !== candMsg) { candMsg = main; candSince = t; }
  if (main !== shownMsg && (t - candSince > 450 || !shownMsg)) {
    shownMsg = main;
    setCoach(main, sub, allGood);
    speak(main);
  } else if (main === shownMsg) $("#coachSub").textContent = sub;

  // 자동 촬영
  if (opts.auto && allGood) {
    if (!goodSince) goodSince = t;
    if (t - goodSince > 1000 && !autoBusy) { autoBusy = true; burst().finally(() => { autoBusy = false; goodSince = 0; }); }
  } else goodSince = 0;
}

let tipIdx = 0, tipAt = 0;
function poseTip() {
  const tips = {
    selfie: ["눈에 살짝 힘 빼고 입꼬리만 올려요", "턱을 앞으로 살짝 내밀면 턱선이 살아요", "화면 말고 렌즈를 봐요"],
    half: ["어깨를 카메라에서 살짝 비스듬히", "팔을 몸에서 조금 떼면 팔이 얇아 보여요", "턱은 살짝 앞으로, 눈은 렌즈"],
    full: ["한쪽 다리를 앞으로 내밀고 발끝은 카메라 쪽", "몸은 살짝 사선, 무게는 뒷다리에", "걷는 척 한 발 내딛는 순간에 찍어요"],
  }[mode];
  const now = performance.now();
  if (now - tipAt > 4000) { tipIdx = (tipIdx + 1) % tips.length; tipAt = now; }
  return "포즈 팁: " + tips[tipIdx];
}

function setCoach(main, sub, good) {
  $("#coachMain").textContent = main;
  $("#coachSub").textContent = sub || "";
  $("#coach").classList.toggle("good", !!good);
}

function speak(text) {
  if (!opts.voice || !("speechSynthesis" in window) || !text) return;
  const now = performance.now();
  if (text === lastSpoken && now - lastSpeakAt < 6000) return;
  if (now - lastSpeakAt < 1800) return;
  lastSpoken = text; lastSpeakAt = now;
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text.replace("!", ""));
  u.lang = "ko-KR"; u.rate = 1.1;
  speechSynthesis.speak(u);
}

// ---------- 오버레이 그리기 ----------
function draw(c) {
  const w = frameBox.w, h = frameBox.h;
  ctx.clearRect(0, 0, w, h);
  const mirror = facing === "user";
  const X = (x) => (mirror ? 1 - x : x) * w, Y = (y) => y * h;

  if (opts.grid) {
    ctx.strokeStyle = "rgba(255,255,255,.28)"; ctx.lineWidth = 1;
    ctx.beginPath();
    for (const f of [1 / 3, 2 / 3]) { ctx.moveTo(w * f, 0); ctx.lineTo(w * f, h); ctx.moveTo(0, h * f); ctx.lineTo(w, h * f); }
    ctx.stroke();
  }

  const st = (k) => (checks.find((x) => x.key === k) || {}).s;
  const col = (s) => (s === "good" ? "#5ee6a0" : s === "warn" ? "#ffd166" : s === "bad" ? "#ff6b6b" : "rgba(255,255,255,.5)");

  // 목표 가이드선
  ctx.setLineDash([8, 6]); ctx.lineWidth = 2;
  if (mode === "selfie") {
    ctx.strokeStyle = col(st("eye"));
    line(0.27 * h); line(0.43 * h);
    label("눈은 이 사이", 0.27 * h - 6, col(st("eye")));
  } else if (mode === "full") {
    ctx.strokeStyle = col(st("feet"));
    line(0.965 * h);
    label("발끝을 여기에", 0.965 * h - 8, col(st("feet")));
    ctx.strokeStyle = col(st("head"));
    line(0.06 * h);
  } else {
    ctx.strokeStyle = col(st("eye"));
    line(h / 3);
    label("눈높이", h / 3 - 6, col(st("eye")));
  }
  ctx.setLineDash([]);

  // 수평계 (후면 촬영)
  if (orient && mode !== "selfie" && !orient.landscape) {
    const a = (orient.roll * Math.PI) / 180, L = w * 0.22, cx = w / 2, cy = h / 2;
    ctx.strokeStyle = "rgba(255,255,255,.5)"; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(cx - L - 14, cy); ctx.lineTo(cx - L, cy); ctx.moveTo(cx + L, cy); ctx.lineTo(cx + L + 14, cy); ctx.stroke();
    ctx.strokeStyle = col(st("level")); ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(cx - L * Math.cos(a), cy - L * Math.sin(a)); ctx.lineTo(cx + L * Math.cos(a), cy + L * Math.sin(a)); ctx.stroke();
  }

  // 각도 게이지 (오른쪽)
  if (orient && !orient.landscape) {
    const v = -orient.up; // 셀카: 내려다보는 각도, 후면: 올려보는 각도
    const [lo, hi] = mode === "selfie" ? [9, 27] : mode === "full" ? [-1, 13] : [-4, 6];
    const gx = w - 22, gy0 = h * 0.3, gh = h * 0.4, range = 40;
    const toY = (deg) => gy0 + gh / 2 - (deg / range) * (gh / 2) * (mode === "selfie" ? -1 : 1);
    ctx.fillStyle = "rgba(0,0,0,.4)"; roundRect(gx - 6, gy0, 12, gh, 6); ctx.fill();
    ctx.fillStyle = "rgba(94,230,160,.45)";
    const ya = toY(lo), yb = toY(hi); ctx.fillRect(gx - 6, Math.min(ya, yb), 12, Math.abs(yb - ya));
    const yv = Math.max(gy0, Math.min(gy0 + gh, toY(Math.max(-range, Math.min(range, v)))));
    ctx.fillStyle = col(st("angle")); ctx.beginPath(); ctx.arc(gx, yv, 8, 0, Math.PI * 2); ctx.fill();
    ctx.font = "600 11px system-ui"; ctx.textAlign = "right"; ctx.fillStyle = "rgba(255,255,255,.85)";
    ctx.fillText("각도", gx + 8, gy0 - 8);
  }

  // 인식 점
  if (opts.dots && lastResult && c) {
    ctx.fillStyle = "rgba(255,179,138,.9)";
    const pts = mode === "selfie" ? (lastResult.faceLandmarks || [])[0] : (lastResult.landmarks || [])[0];
    if (pts) for (let i = 0; i < pts.length; i += mode === "selfie" ? 6 : 1) { const p = toCrop(pts[i], c); ctx.fillRect(X(p.x) - 1.5, Y(p.y) - 1.5, 3, 3); }
  }

  function line(y) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke(); }
  function label(t, y, color) {
    ctx.font = "700 12px system-ui"; ctx.textAlign = "left";
    const tw = ctx.measureText(t).width;
    ctx.fillStyle = "rgba(0,0,0,.5)"; roundRect(8, y - 15, tw + 12, 19, 6); ctx.fill();
    ctx.fillStyle = color; ctx.fillText(t, 14, y - 1);
  }
  function roundRect(x, y, ww, hh, r) { ctx.beginPath(); ctx.roundRect ? ctx.roundRect(x, y, ww, hh, r) : ctx.rect(x, y, ww, hh); }
}

// ---------- 촬영 ----------
$("#shutter").onclick = () => capture();
async function capture() {
  const c = cropInfo(); if (!c) return;
  const score = scoreOf(checks);
  const cv = document.createElement("canvas");
  cv.width = Math.round(c.cw); cv.height = Math.round(c.ch);
  const g = cv.getContext("2d");
  if (facing === "user" && opts.mirror) { g.translate(cv.width, 0); g.scale(-1, 1); }
  g.drawImage(video, c.ox, c.oy, c.cw, c.ch, 0, 0, cv.width, cv.height);
  const blob = await new Promise((r) => cv.toBlob(r, "image/jpeg", 0.95));
  if (!blob) return;
  const url = URL.createObjectURL(blob);
  shots.push({ blob, url, score, at: Date.now() });
  $("#thumbImg").src = url;
  const fl = $("#flash"); fl.classList.add("on"); setTimeout(() => fl.classList.remove("on"), 60);
  if (navigator.vibrate) navigator.vibrate(30);
  toast(score >= 85 ? `${score}점! 잘 찍혔어요` : `${score}점 · 안내를 따라 한 장 더?`);
}
async function burst() { for (let i = 0; i < 3; i++) { await capture(); await new Promise((r) => setTimeout(r, 350)); } }

// ---------- 갤러리 ----------
$("#galleryBtn").onclick = () => { renderGallery(); $("#gallery").hidden = false; };
$("#closeGallery").onclick = () => ($("#gallery").hidden = true);
$("#clearGallery").onclick = () => { shots.forEach((s) => URL.revokeObjectURL(s.url)); shots = []; $("#thumbImg").removeAttribute("src"); renderGallery(); };
function renderGallery() {
  const g = $("#galleryGrid");
  if (!shots.length) { g.innerHTML = '<div class="g-empty">아직 찍은 사진이 없어요</div>'; return; }
  g.innerHTML = "";
  [...shots].sort((a, b) => b.score - a.score).forEach((s) => {
    const d = document.createElement("div"); d.className = "g-item";
    d.innerHTML = `<img alt="찍은 사진"><span class="g-score">${s.score}점</span><button class="g-save">저장</button>`;
    d.querySelector("img").src = s.url;
    d.querySelector(".g-save").onclick = () => saveShot(s);
    g.appendChild(d);
  });
}
async function saveShot(s) {
  const name = `insaengshot_${new Date(s.at).toISOString().replace(/[-:T]/g, "").slice(0, 14)}.jpg`;
  const file = new File([s.blob], name, { type: "image/jpeg" });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file] }); return; } catch (e) { if (e.name === "AbortError") return; }
  }
  const a = document.createElement("a"); a.href = s.url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
}

// ---------- 설정 ----------
const bind = (id, key) => { const el = $(id); if (el.type === "checkbox") el.checked = opts[key]; else el.value = opts[key];
  el.onchange = () => { opts[key] = el.type === "checkbox" ? el.checked : el.value; saveOpts(); if (key === "ratio") layout(); if (key === "voice" && !opts.voice) speechSynthesis?.cancel(); }; };
bind("#optVoice", "voice"); bind("#optAuto", "auto"); bind("#optGrid", "grid"); bind("#optDots", "dots");
bind("#optMirror", "mirror"); bind("#optRatio", "ratio"); bind("#optTurn", "turn");
$("#settingsBtn").onclick = () => ($("#settings").hidden = false);
$("#closeSettings").onclick = () => ($("#settings").hidden = true);
const openTips = () => ($("#tips").hidden = false);
$("#openTips").onclick = openTips; $("#tipsFromSettings").onclick = () => { $("#settings").hidden = true; openTips(); };
$("#closeTips").onclick = () => ($("#tips").hidden = true);
document.querySelectorAll(".sheet").forEach((s) => s.addEventListener("click", (e) => { if (e.target === s) s.hidden = true; }));

let toastT;
function toast(msg) { const t = $("#toast"); t.textContent = msg; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => (t.hidden = true), 2200); }

// 화면 꺼짐 방지
async function wake() { try { if ("wakeLock" in navigator && !$("#cam").hidden) await navigator.wakeLock.request("screen"); } catch {} }
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") wake(); });
$("#cam").addEventListener("click", wake, { once: true });

// 오프라인 설치용
if ("serviceWorker" in navigator && location.protocol === "https:") navigator.serviceWorker.register("sw.js").catch(() => {});
