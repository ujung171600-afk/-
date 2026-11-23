// 뽀샵 엔진 — 피부결 정돈 + 피부에만 옅은 혈색. 얼굴 모양과 밝기는 원본 그대로.
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
uniform float mirror, rad, smoothAmt, warm;
uniform vec2 texel;

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
  vec2 tc = crop.xy + uv * crop.zw;
  vec3 c = texture2D(tex, tc).rgb;
  float m = skin(c);
  if (smoothAmt > 0.001 && m > 0.01) {
    vec3 sum = c; float ws = 1.0;
    for (int i = 1; i < 20; i++) {
      float fi = float(i);
      float a = fi * 2.39996;
      vec2 o = vec2(cos(a), sin(a)) * sqrt(fi) * rad * texel;
      vec3 s = texture2D(tex, tc + o).rgb;
      vec3 df = s - c;
      float w = exp(-dot(df, df) * mix(90.0, 40.0, smoothAmt));
      sum += s * w; ws += w;
    }
    c = mix(c, sum / ws, smoothAmt * m * 0.55);
  }
  c += warm * m * vec3(0.04, 0.012, -0.008); // 피부에만 살짝 혈색
  gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
}`;

export function createBeauty(canvas) {
  const gl = canvas.getContext("webgl", { preserveDrawingBuffer: false, alpha: false, antialias: false });
  if (!gl) return createPlain(canvas);
  let U = null, ready = false;

  function init() {
    const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; };
    const prog = gl.createProgram();
    gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(prog); gl.useProgram(prog);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const aLoc = gl.getAttribLocation(prog, "a"); gl.enableVertexAttribArray(aLoc); gl.vertexAttribPointer(aLoc, 2, gl.FLOAT, false, 0, 0);
    gl.bindTexture(gl.TEXTURE_2D, gl.createTexture());
    for (const [k, val] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, k, val);
    U = {}; for (const n of ["crop", "mirror", "rad", "texel", "smoothAmt", "warm"]) U[n] = gl.getUniformLocation(prog, n);
    ready = true;
  }
  try { init(); } catch (e) { console.warn(e); return createPlain(canvas); }

  // 아이폰이 메모리 때문에 그래픽을 버리면 다시 만든다
  canvas.addEventListener("webglcontextlost", (e) => { e.preventDefault(); ready = false; });
  canvas.addEventListener("webglcontextrestored", () => { try { init(); } catch (e) { console.warn(e); } });

  function render(video, c, prm, mirror) {
    if (!ready || gl.isContextLost()) return;
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, video);
    gl.uniform4f(U.crop, c.ox / c.vw, c.oy / c.vh, c.cw / c.vw, c.ch / c.vh);
    gl.uniform1f(U.mirror, mirror ? 1 : 0);
    gl.uniform2f(U.texel, 1 / c.vw, 1 / c.vh);
    gl.uniform1f(U.rad, Math.max(1.2, c.vh / 520));
    gl.uniform1f(U.smoothAmt, prm.smooth); gl.uniform1f(U.warm, prm.warm);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }
  return { render, gl: true };
}

// WebGL이 안 되는 폰: 효과 없이 그대로 보여줌
function createPlain(canvas) {
  const g = canvas.getContext("2d");
  return {
    gl: false,
    render(video, c, _p, mirror) {
      g.save(); g.setTransform(1, 0, 0, 1, 0, 0);
      if (mirror) { g.translate(canvas.width, 0); g.scale(-1, 1); }
      g.drawImage(video, c.ox, c.oy, c.cw, c.ch, 0, 0, canvas.width, canvas.height);
      g.restore();
    },
  };
}

export const PRESETS = {
  none:    { name: "없음",        smooth: 0,    warm: 0 },
  natural: { name: "피부결 정돈", smooth: 0.35, warm: 0.5 },
  more:    { name: "조금 더",     smooth: 0.6,  warm: 0.7 },
};
