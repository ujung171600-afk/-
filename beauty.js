// 뽀샵 엔진 — WebGL 한 번 그리기로 피부 보정·밝기·혈색·얼굴 갸름·눈 크게를 처리
// 미리보기와 저장 사진이 같은 처리를 거친다.

const VS = `attribute vec2 a; varying vec2 v; void main(){ v = a * 0.5 + 0.5; gl_Position = vec4(a, 0.0, 1.0); }`;

const FS = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
varying vec2 v;
uniform sampler2D tex;
uniform vec4 crop;          // 영상에서 사진 영역 (x, y, w, h) 0~1
uniform float mirror, aspect, rad;
uniform vec2 texel;
uniform float smoothAmt, bright, warm, slim, eyeAmt, hasFace;
uniform vec2 eyes[2];
uniform float eyeR;
uniform vec2 jaw[6];
uniform vec2 ctr;
uniform float jawR;

vec2 warp(vec2 p) {
  if (hasFace < 0.5) return p;
  vec2 asp = vec2(aspect, 1.0);
  for (int i = 0; i < 2; i++) {
    vec2 d = (p - eyes[i]) * asp;
    float r = length(d) / eyeR;
    if (r < 1.0) p = eyes[i] + (p - eyes[i]) * (1.0 - eyeAmt * 0.3 * (1.0 - r * r));
  }
  for (int i = 0; i < 6; i++) {
    vec2 d = (p - jaw[i]) * asp;
    float r2 = dot(d, d) / (jawR * jawR);
    if (r2 < 1.0) {
      float w = (1.0 - r2); w *= w;
      vec2 dir = normalize((ctr - jaw[i]) * asp) / asp;
      p -= dir * w * slim * jawR * 0.3;
    }
  }
  return p;
}

float skin(vec3 c) {
  float y = dot(c, vec3(0.299, 0.587, 0.114));
  float cb = (c.b - y) * 0.564 + 0.5;
  float cr = (c.r - y) * 0.713 + 0.5;
  return smoothstep(0.27, 0.33, cb) * (1.0 - smoothstep(0.48, 0.53, cb))
       * smoothstep(0.50, 0.545, cr) * (1.0 - smoothstep(0.66, 0.71, cr));
}

void main() {
  vec2 uv = vec2(v.x, 1.0 - v.y);
  if (mirror > 0.5) uv.x = 1.0 - uv.x;
  vec2 p = clamp(warp(uv), 0.0, 1.0);
  vec2 tc = crop.xy + p * crop.zw;
  vec3 c = texture2D(tex, tc).rgb;

  if (smoothAmt > 0.001) {
    float m = skin(c);
    if (m > 0.01) {
      vec3 sum = c; float ws = 1.0;
      for (int i = 1; i < 20; i++) {
        float fi = float(i);
        float a = fi * 2.39996;
        vec2 o = vec2(cos(a), sin(a)) * sqrt(fi) * rad * texel;
        vec3 s = texture2D(tex, tc + o).rgb;
        vec3 df = s - c;
        float w = exp(-dot(df, df) * mix(60.0, 14.0, smoothAmt));
        sum += s * w; ws += w;
      }
      c = mix(c, sum / ws, smoothAmt * m * 0.9);
    }
  }
  c = 1.0 - pow(max(1.0 - c, 0.0), vec3(1.0 + bright * 0.55));
  c += warm * vec3(0.03, 0.006, -0.012);
  gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
}`;

export function createBeauty(canvas) {
  const gl = canvas.getContext("webgl", { preserveDrawingBuffer: true, alpha: false, antialias: false });
  if (!gl) return createPlain(canvas);
  const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; };
  const prog = gl.createProgram();
  try { gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS)); }
  catch (e) { console.warn(e); return createPlain(canvas); }
  gl.linkProgram(prog); gl.useProgram(prog);
  const buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const aLoc = gl.getAttribLocation(prog, "a"); gl.enableVertexAttribArray(aLoc); gl.vertexAttribPointer(aLoc, 2, gl.FLOAT, false, 0, 0);
  const tex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, tex);
  for (const [k, val] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, k, val);
  const U = {}; for (const n of ["crop", "mirror", "aspect", "rad", "texel", "smoothAmt", "bright", "warm", "slim", "eyeAmt", "hasFace", "eyes", "eyeR", "jaw", "ctr", "jawR"]) U[n] = gl.getUniformLocation(prog, n);

  function render(video, c, prm, face, mirror) {
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, video);
    gl.uniform4f(U.crop, c.ox / c.vw, c.oy / c.vh, c.cw / c.vw, c.ch / c.vh);
    gl.uniform1f(U.mirror, mirror ? 1 : 0);
    gl.uniform1f(U.aspect, c.cw / c.ch);
    gl.uniform2f(U.texel, 1 / c.vw, 1 / c.vh);
    gl.uniform1f(U.rad, Math.max(1.2, c.vh / 520));
    gl.uniform1f(U.smoothAmt, prm.smooth); gl.uniform1f(U.bright, prm.bright); gl.uniform1f(U.warm, prm.warm);
    gl.uniform1f(U.slim, face ? prm.slim : 0); gl.uniform1f(U.eyeAmt, face ? prm.eye : 0);
    gl.uniform1f(U.hasFace, face ? 1 : 0);
    if (face) {
      gl.uniform2fv(U.eyes, face.eyes.flat()); gl.uniform1f(U.eyeR, face.eyeR);
      gl.uniform2fv(U.jaw, face.jaw.flat()); gl.uniform2f(U.ctr, face.ctr[0], face.ctr[1]); gl.uniform1f(U.jawR, face.jawR);
    }
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }
  return { render, gl: true };
}

// WebGL이 안 되는 폰: 효과 없이 그대로 보여줌
function createPlain(canvas) {
  const g = canvas.getContext("2d");
  return {
    gl: false,
    render(video, c, _p, _f, mirror) {
      g.save(); g.setTransform(1, 0, 0, 1, 0, 0);
      if (mirror) { g.translate(canvas.width, 0); g.scale(-1, 1); }
      g.drawImage(video, c.ox, c.oy, c.cw, c.ch, 0, 0, canvas.width, canvas.height);
      g.restore();
    },
  };
}

// 얼굴 점(사진 영역 좌표, 0~1, 좌우반전 전) → 셰이더에 넘길 값
export function faceShape(P, aspect) {
  const avg = (ids) => { let x = 0, y = 0; for (const i of ids) { const p = P(i); x += p.x; y += p.y; } return [x / ids.length, y / ids.length]; };
  const L = P(234), R = P(454);
  const fw = Math.hypot((R.x - L.x) * aspect, R.y - L.y); // 세로 단위로 본 얼굴 너비
  const eyeL = avg([33, 133, 159, 145]), eyeR = avg([263, 362, 386, 374]);
  const eyeW = Math.hypot((P(133).x - P(33).x) * aspect, P(133).y - P(33).y);
  const jaw = [172, 136, 150, 397, 365, 379].map((i) => { const p = P(i); return [p.x, p.y]; });
  const n = P(4);
  return { eyes: [eyeL, eyeR], eyeR: eyeW * 0.95, jaw, ctr: [n.x, n.y], jawR: fw * 0.28 };
}

export const PRESETS = {
  none:    { name: "없음",       smooth: 0,    bright: 0,    warm: 0,   slim: 0,    eye: 0 },
  natural: { name: "자연스럽게", smooth: 0.45, bright: 0.25, warm: 0.3, slim: 0.3,  eye: 0.2 },
  bright:  { name: "화사하게",   smooth: 0.6,  bright: 0.5,  warm: 0.5, slim: 0.45, eye: 0.3 },
  strong:  { name: "진하게",     smooth: 0.85, bright: 0.6,  warm: 0.5, slim: 0.7,  eye: 0.5 },
};
