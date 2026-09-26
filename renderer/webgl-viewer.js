/*
 * Viewer3DGL — real WebGL2 3D engine (Phase B). Zero external libraries, fully offline.
 *
 * Drop-in replacement for the canvas-2D Viewer3D. Same public API
 * (constructor(canvas,onSelect), onHover, selectedId, setAIHighlight, resetView,
 *  loadRoom, loadGlb, loadGltf, select) PLUS Phase B tools:
 *   setSection(on) / setSectionValue(t)  — clipping plane (Сечение)
 *   setMeasure(on)                        — two-point distance measure (Измерение)
 *   setIsolate(on)                        — hide all but the selected element
 *   setLOD(on)                            — level-of-detail decimation for heavy meshes
 *   onMeasure(distMeters,p1,p2)           — callback fired when 2 points picked
 *
 * Real features: perspective camera, orbit/pan/zoom, directional + ambient
 * lighting in GLSL, per-material color, depth buffer, CPU ray-cast picking
 * (Möller–Trumbore), real glTF 2.0 / GLB loader with node-transform baking.
 */
(function () {
  'use strict';
  const STATUS_COLOR = { err: '#e5484d', ok: '#16a34a', warn: '#d99a00', none: '#9aa4b2' };
  const TYPE_BASE = { 'вентшахта': '#7c93b8', 'оборудование': '#6b7d99', 'труба': '#a67d63', 'дверь': '#8a79b8', 'кабель-канал': '#5fa39d' };
  const hex2rgb = h => { h = h.replace('#', ''); const n = parseInt(h, 16); return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]; };
  const mixW = (c, t) => [c[0] * (1 - t) + t, c[1] * (1 - t) + t, c[2] * (1 - t) + t];

  // ---------- vec / mat helpers (column-major mat4) ----------
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const norm = a => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
  const len = a => Math.hypot(a[0], a[1], a[2]);
  const ident = () => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  function mul(a, b) { const o = new Array(16); for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) { let s = 0; for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k]; o[c * 4 + r] = s; } return o; }
  function persp(fovy, asp, n, f) { const t = 1 / Math.tan(fovy / 2); return [t / asp, 0, 0, 0, 0, t, 0, 0, 0, 0, (f + n) / (n - f), -1, 0, 0, (2 * f * n) / (n - f), 0]; }
  function ortho(l, r, b, t, n, f) { return [2 / (r - l), 0, 0, 0, 0, 2 / (t - b), 0, 0, 0, 0, -2 / (f - n), 0, -(r + l) / (r - l), -(t + b) / (t - b), -(f + n) / (f - n), 1]; }
  function look(eye, ctr, up) { const z = norm(sub(eye, ctr)); const x = norm(cross(up, z)); const y = cross(z, x); return [x[0], y[0], z[0], 0, x[1], y[1], z[1], 0, x[2], y[2], z[2], 0, -dot(x, eye), -dot(y, eye), -dot(z, eye), 1]; }
  function tvec(m, v) { return [m[0] * v[0] + m[4] * v[1] + m[8] * v[2] + m[12] * v[3], m[1] * v[0] + m[5] * v[1] + m[9] * v[2] + m[13] * v[3], m[2] * v[0] + m[6] * v[1] + m[10] * v[2] + m[14] * v[3], m[3] * v[0] + m[7] * v[1] + m[11] * v[2] + m[15] * v[3]]; }
  function tpt(m, p) { const r = tvec(m, [p[0], p[1], p[2], 1]); return [r[0], r[1], r[2]]; }
  function invert(m) {
    const a00 = m[0], a01 = m[1], a02 = m[2], a03 = m[3], a10 = m[4], a11 = m[5], a12 = m[6], a13 = m[7], a20 = m[8], a21 = m[9], a22 = m[10], a23 = m[11], a30 = m[12], a31 = m[13], a32 = m[14], a33 = m[15];
    const b00 = a00 * a11 - a01 * a10, b01 = a00 * a12 - a02 * a10, b02 = a00 * a13 - a03 * a10, b03 = a01 * a12 - a02 * a11, b04 = a01 * a13 - a03 * a11, b05 = a02 * a13 - a03 * a12, b06 = a20 * a31 - a21 * a30, b07 = a20 * a32 - a22 * a30, b08 = a20 * a33 - a23 * a30, b09 = a21 * a32 - a22 * a31, b10 = a21 * a33 - a23 * a31, b11 = a22 * a33 - a23 * a32;
    let det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06; if (!det) return ident(); det = 1 / det;
    return [(a11 * b11 - a12 * b10 + a13 * b09) * det, (a02 * b10 - a01 * b11 - a03 * b09) * det, (a31 * b05 - a32 * b04 + a33 * b03) * det, (a22 * b04 - a21 * b05 - a23 * b03) * det, (a12 * b08 - a10 * b11 - a13 * b07) * det, (a00 * b11 - a02 * b08 + a03 * b07) * det, (a32 * b02 - a30 * b05 - a33 * b01) * det, (a20 * b05 - a22 * b02 + a23 * b01) * det, (a10 * b10 - a11 * b08 + a13 * b06) * det, (a01 * b08 - a00 * b10 - a03 * b06) * det, (a30 * b04 - a31 * b02 + a33 * b00) * det, (a21 * b02 - a20 * b04 - a23 * b00) * det, (a11 * b07 - a10 * b09 - a12 * b06) * det, (a00 * b09 - a01 * b07 + a02 * b06) * det, (a31 * b01 - a30 * b03 - a32 * b00) * det, (a20 * b03 - a21 * b01 + a22 * b00) * det];
  }
  function quatMat(q) { const x = q[0], y = q[1], z = q[2], w = q[3]; const x2 = x + x, y2 = y + y, z2 = z + z; const xx = x * x2, xy = x * y2, xz = x * z2, yy = y * y2, yz = y * z2, zz = z * z2, wx = w * x2, wy = w * y2, wz = w * z2; return [1 - (yy + zz), xy + wz, xz - wy, 0, xy - wz, 1 - (xx + zz), yz + wx, 0, xz + wy, yz - wx, 1 - (xx + yy), 0, 0, 0, 0, 1]; }
  function nodeLocal(n) { if (n.matrix) return n.matrix.slice(); const t = n.translation || [0, 0, 0], r = n.rotation || [0, 0, 0, 1], s = n.scale || [1, 1, 1]; const rm = quatMat(r); const sm = [s[0], 0, 0, 0, 0, s[1], 0, 0, 0, 0, s[2], 0, 0, 0, 0, 1]; const m = mul(rm, sm); m[12] = t[0]; m[13] = t[1]; m[14] = t[2]; return m; }

  // ---------- ray/AABB + равномерная grid-сетка (пространственный индекс для ускорения пикинга) ----------
  function rayAABB(o, d, mn, mx) {
    let tmin = -Infinity, tmax = Infinity;
    for (let k = 0; k < 3; k++) {
      const inv = 1 / (d[k] || 1e-20);
      let t1 = (mn[k] - o[k]) * inv, t2 = (mx[k] - o[k]) * inv;
      if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
      if (t1 > tmin) tmin = t1; if (t2 < tmax) tmax = t2;
      if (tmax < tmin) return null;
    }
    return tmax < 0 ? null : (tmin > 0 ? tmin : 0);
  }
  function buildGrid(pos) {
    const ntri = pos.length / 9;
    let mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < pos.length; i += 3) for (let k = 0; k < 3; k++) { const v = pos[i + k]; if (v < mn[k]) mn[k] = v; if (v > mx[k]) mx[k] = v; }
    const ext = [(mx[0] - mn[0]) || 1, (mx[1] - mn[1]) || 1, (mx[2] - mn[2]) || 1];
    const res = Math.max(1, Math.min(64, Math.round(Math.cbrt(ntri))));
    const dim = [res, res, res];
    const cell = [ext[0] / dim[0], ext[1] / dim[1], ext[2] / dim[2]];
    const cells = new Map();
    const keyOf = (cx, cy, cz) => (cx * dim[1] + cy) * dim[2] + cz;
    const clamp = (v, m) => v < 0 ? 0 : (v >= m ? m - 1 : v);
    for (let t = 0; t < ntri; t++) {
      const b = t * 9;
      let tmn = [Infinity, Infinity, Infinity], tmx = [-Infinity, -Infinity, -Infinity];
      for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) { const v = pos[b + j * 3 + k]; if (v < tmn[k]) tmn[k] = v; if (v > tmx[k]) tmx[k] = v; }
      const c0 = [clamp(Math.floor((tmn[0] - mn[0]) / cell[0]), dim[0]), clamp(Math.floor((tmn[1] - mn[1]) / cell[1]), dim[1]), clamp(Math.floor((tmn[2] - mn[2]) / cell[2]), dim[2])];
      const c1 = [clamp(Math.floor((tmx[0] - mn[0]) / cell[0]), dim[0]), clamp(Math.floor((tmx[1] - mn[1]) / cell[1]), dim[1]), clamp(Math.floor((tmx[2] - mn[2]) / cell[2]), dim[2])];
      for (let x = c0[0]; x <= c1[0]; x++) for (let y = c0[1]; y <= c1[1]; y++) for (let z = c0[2]; z <= c1[2]; z++) { const key = keyOf(x, y, z); let a = cells.get(key); if (!a) { a = []; cells.set(key, a); } a.push(b); }
    }
    return { mn, mx, dim, cell, cells, keyOf };
  }
  function traverseGrid(grid, o, d, cb) {
    const hit = rayAABB(o, d, grid.mn, grid.mx);
    if (hit == null) return;
    const start = [o[0] + d[0] * hit, o[1] + d[1] * hit, o[2] + d[2] * hit];
    const cur = [0, 0, 0], step = [0, 0, 0], tMax = [0, 0, 0], tDelta = [0, 0, 0];
    for (let k = 0; k < 3; k++) {
      let c = Math.floor((start[k] - grid.mn[k]) / grid.cell[k]);
      if (c < 0) c = 0; if (c >= grid.dim[k]) c = grid.dim[k] - 1;
      cur[k] = c;
      if (d[k] > 0) { step[k] = 1; const next = grid.mn[k] + (c + 1) * grid.cell[k]; tMax[k] = hit + (next - start[k]) / d[k]; tDelta[k] = grid.cell[k] / d[k]; }
      else if (d[k] < 0) { step[k] = -1; const next = grid.mn[k] + c * grid.cell[k]; tMax[k] = hit + (next - start[k]) / d[k]; tDelta[k] = -grid.cell[k] / d[k]; }
      else { step[k] = 0; tMax[k] = Infinity; tDelta[k] = Infinity; }
    }
    for (;;) {
      const arr = grid.cells.get(grid.keyOf(cur[0], cur[1], cur[2]));
      if (arr && cb(arr)) return;
      const axis = tMax[0] < tMax[1] ? (tMax[0] < tMax[2] ? 0 : 2) : (tMax[1] < tMax[2] ? 1 : 2);
      cur[axis] += step[axis];
      if (cur[axis] < 0 || cur[axis] >= grid.dim[axis]) return;
      tMax[axis] += tDelta[axis];
    }
  }

  // Unit box faces (explicit outward normals; culling disabled so winding is irrelevant).
  const FACES = [
    { n: [1, 0, 0], c: [[.5, -.5, -.5], [.5, .5, -.5], [.5, .5, .5], [.5, -.5, .5]] },
    { n: [-1, 0, 0], c: [[-.5, -.5, .5], [-.5, .5, .5], [-.5, .5, -.5], [-.5, -.5, -.5]] },
    { n: [0, 1, 0], c: [[-.5, .5, -.5], [.5, .5, -.5], [.5, .5, .5], [-.5, .5, .5]] },
    { n: [0, -1, 0], c: [[-.5, -.5, .5], [.5, -.5, .5], [.5, -.5, -.5], [-.5, -.5, -.5]] },
    { n: [0, 0, 1], c: [[-.5, -.5, .5], [.5, -.5, .5], [.5, .5, .5], [-.5, .5, .5]] },
    { n: [0, 0, -1], c: [[.5, -.5, -.5], [-.5, -.5, -.5], [-.5, .5, -.5], [.5, .5, -.5]] }
  ];
  function boxGeom(cx, cy, cz, w, h, d) {
    const pos = [], nor = [];
    for (const f of FACES) {
      const p = f.c.map(c => [cx + c[0] * w, cy + c[1] * h, cz + c[2] * d]);
      const tri = [p[0], p[1], p[2], p[0], p[2], p[3]];
      for (const v of tri) { pos.push(v[0], v[1], v[2]); nor.push(f.n[0], f.n[1], f.n[2]); }
    }
    return { pos: new Float32Array(pos), nor: new Float32Array(nor) };
  }
  function boxEdges(cx, cy, cz, w, h, d) {
    const x0 = cx - w / 2, x1 = cx + w / 2, y0 = cy - h / 2, y1 = cy + h / 2, z0 = cz - d / 2, z1 = cz + d / 2;
    const v = [[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]];
    const E = [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7]];
    const pos = []; for (const [a, b] of E) { pos.push(...v[a], ...v[b]); }
    return new Float32Array(pos);
  }

  const VS = `#version 300 es
  in vec3 aPos; in vec3 aNormal; in vec3 aColor;
  in float aIntensity; in float aClassification; uniform mat4 uMVP;
  uniform float uPointSize; uniform float uAttenuate; uniform float uPtScale; uniform float uPtMin; uniform float uPtMax;
  out vec3 vN; out vec3 vW; out vec3 vC; out float vIntensity; out float vClassification;
  void main(){ vW=aPos; vN=aNormal; vC=aColor; vIntensity=aIntensity; vClassification=aClassification; gl_Position=uMVP*vec4(aPos,1.0);
    float ps = uPointSize;
    if(uAttenuate>0.5){ ps = clamp(uPtScale / max(gl_Position.w, 0.0001), uPtMin, uPtMax); }
    gl_PointSize = ps; }`;
  const FS = `#version 300 es
  precision highp float; in vec3 vN; in vec3 vW; in vec3 vC;
  in float vIntensity; in float vClassification; out vec4 frag;
  uniform vec3 uColor; uniform float uUnlit; uniform vec3 uLightDir; uniform float uAmbient;
  uniform float uClipOn; uniform float uClipDist; uniform vec3 uClipMin; uniform vec3 uClipMax; uniform float uUseVColor; uniform float uRound; uniform float uFrame;
  uniform float uElevMode; uniform float uAttrMode; uniform float uElevMin; uniform float uElevMax; uniform float uBright;
  uniform float uCloudPass; uniform float uCloudOpacity; uniform float uPalette;
  uniform float uGrade; uniform float uExposure; uniform float uContrast; uniform float uSaturation; uniform float uGamma; uniform float uTone;
  vec3 aces(vec3 x){ return clamp((x*(2.51*x+0.03))/(x*(2.43*x+0.59)+0.14),0.0,1.0); }
  vec3 ramp(float t){ t=clamp(t,0.0,1.0); return clamp(vec3(1.5-abs(4.0*t-3.0),1.5-abs(4.0*t-2.0),1.5-abs(4.0*t-1.0)),0.0,1.0); }
  vec3 classColor(float value){
    float code=floor(value+0.5);
    if(code<0.5) return vec3(0.58);
    float hue=fract((code+1.0)*0.61803398875);
    vec3 p=abs(fract(vec3(hue)+vec3(0.0,2.0/3.0,1.0/3.0))*6.0-3.0);
    return mix(vec3(1.0),clamp(p-1.0,0.0,1.0),0.78)*0.95;
  }
  void main(){
    if(uClipOn>0.5 && (vW.x<uClipMin.x||vW.x>uClipMax.x||vW.y<uClipMin.y||vW.y>uClipMax.y||vW.z<uClipMin.z||vW.z>uClipMax.z)) discard;
    // Screen-door opacity: order-independent, no sorting/copying of huge point buffers.
    if(uCloudPass>0.5){ uint h=uint(gl_FragCoord.x)*1973u+uint(gl_FragCoord.y)*9277u; h=(h^(h>>13u))*1274126177u; if(float(h&65535u)/65536.0>=uCloudOpacity) discard; }
    float splat=1.0;
    if(uRound>0.5){ vec2 pc=gl_PointCoord*2.0-1.0; float r2=dot(pc,pc); if(r2>1.0) discard; splat=0.82+0.18*sqrt(max(0.0,1.0-r2)); }
    vec3 c;
    if(uCloudPass>0.5 && uAttrMode>2.5){
      c = classColor(vClassification);
    } else if(uCloudPass>0.5 && uAttrMode>1.5){
      c = vec3(clamp(vIntensity,0.0,1.0));
    } else if(uCloudPass>0.5 && uElevMode>0.5){
      float t = (uElevMax==uElevMin) ? 0.5 : clamp((vW.y-uElevMin)/(uElevMax-uElevMin),0.0,1.0);
      c = uPalette>1.5 ? vec3(1.0,1.0-t,0.0) : uPalette>0.5 ? vec3(t) : ramp(t);
    } else if(uUseVColor>0.5) c=vC; else c=uColor;
    if(uUnlit<0.5){ vec3 n=normalize(vN); float d=max(dot(n,normalize(uLightDir)),0.0); c=c*(uAmbient+(1.0-uAmbient)*d); }
    c *= uBright;
    if(uGrade>0.5 && uUseVColor>0.5 && uElevMode<0.5 && uAttrMode<1.5){
      c *= uExposure;
      c = mix(c, aces(c), uTone);
      c = clamp((c-0.5)*uContrast+0.5, 0.0, 1.0);
      float l = dot(c, vec3(0.2126,0.7152,0.0722));
      c = clamp(mix(vec3(l), c, uSaturation), 0.0, 1.0);
      c = pow(max(c,1e-5), vec3(1.0/uGamma));
    }
    c *= splat;
    if(uFrame>0.5){ vec2 fe=abs(gl_PointCoord*2.0-1.0); if(max(fe.x,fe.y)>0.70) c=vec3(0.0); }
    frag=vec4(c,1.0);
  }`;

  // EDL (Eye-Dome Lighting) — экранный постпроцесс: подчёркивает края/глубину облака,
  // как в ReCap/Potree. Полноэкранный проход по цвету + текстуре глубины FBO.
  const EDL_VS = `#version 300 es
  in vec2 aP; out vec2 vUv;
  void main(){ vUv = aP * 0.5 + 0.5; gl_Position = vec4(aP, 0.0, 1.0); }`;
  const EDL_FS = `#version 300 es
  precision highp float; in vec2 vUv; out vec4 frag;
  uniform sampler2D uCol; uniform sampler2D uDep;
  uniform vec2 uTexel; uniform float uNear; uniform float uFar; uniform float uStrength; uniform float uRadius;
  float lin(float d){ float z = d * 2.0 - 1.0; return (2.0 * uNear * uFar) / (uFar + uNear - z * (uFar - uNear)); }
  void main(){
    vec3 c = texture(uCol, vUv).rgb;
    float d0 = texture(uDep, vUv).r;
    if(d0 >= 1.0){ frag = vec4(c, 1.0); return; }
    float lz0 = log2(lin(d0) + 1e-3);
    float sum = 0.0;
    for(int i = 0; i < 8; i++){
      float a = float(i) * 0.7853981634;
      vec2 off = vec2(cos(a), sin(a)) * uTexel * uRadius;
      float dn = texture(uDep, vUv + off).r;
      float lzn = (dn >= 1.0) ? lz0 : log2(lin(dn) + 1e-3);
      sum += max(0.0, lz0 - lzn);
    }
    float shade = exp(-sum * uStrength * 40.0);
    frag = vec4(c * shade, 1.0);
  }`;

  // Pick-проход «видимые точки»: рендер ID точек (gl_VertexID) в целочисленный буфер R32UI
  // с тестом глубины и реальным размером сплэта — как «Select visible» в CloudCompare/Metashape/VTK.
  // Кто впереди в пикселе, тот и попадает в выборку; перекрытые (за стеной/трубой) отбрасываются.
  const PICK_VS = `#version 300 es
  in vec3 aPos; uniform mat4 uMVP;
  uniform float uPointSize; uniform float uAttenuate; uniform float uPtScale; uniform float uPtMin; uniform float uPtMax; uniform float uGrow;
  flat out uint vId; out vec3 vW;
  void main(){ vW=aPos; gl_Position = uMVP*vec4(aPos,1.0);
    float ps = uPointSize;
    if(uAttenuate>0.5){ ps = clamp(uPtScale/max(gl_Position.w,0.0001), uPtMin, uPtMax); }
    gl_PointSize = ps + uGrow; vId = uint(gl_VertexID) + 1u; }`;
  const PICK_FS = `#version 300 es
  precision highp float; precision highp int;
  uniform float uRound; uniform float uClipOn; uniform vec3 uClipMin; uniform vec3 uClipMax; flat in uint vId; in vec3 vW; out uvec4 frag;
  void main(){
    if(uClipOn>0.5 && (vW.x<uClipMin.x||vW.x>uClipMax.x||vW.y<uClipMin.y||vW.y>uClipMax.y||vW.z<uClipMin.z||vW.z>uClipMax.z)) discard;
    if(uRound>0.5){ vec2 pc=gl_PointCoord*2.0-1.0; if(dot(pc,pc)>1.0) discard; }
    frag = uvec4(vId, 0u, 0u, 1u);
  }`;

  const EDIT_POINT_ATTRIBUTES = ['intensity', 'classification'];
  function _editAttrsFor(viewer, bo) {
    const count = bo && bo.pos ? Math.floor(bo.pos.length / 3) : 0, attrs = {};
    EDIT_POINT_ATTRIBUTES.forEach(function (key) {
      const data = (bo && bo[key]) || (viewer && (key === 'intensity' ? viewer._intensityValues : viewer._classificationLabels));
      attrs[key] = data && data.length === count ? data : null;
    });
    return attrs;
  }
  function _subsetPointAttribute(values, indices) {
    if (!values) return null;
    const out = new values.constructor(indices.length);
    for (let i = 0; i < indices.length; i++) out[i] = values[indices[i]];
    return out;
  }
  function _concatPointAttribute(a, b) {
    if (!a && !b) return null;
    if (!a || !b) return null; // mismatched attribute coverage must not be fabricated
    const out = new a.constructor(a.length + b.length);
    out.set(a, 0); out.set(b, a.length);
    return out;
  }
  function _removeTail(values, count) {
    return values && count > 0 ? values.subarray(0, Math.max(0, values.length - count)) : values;
  }

  class Viewer3DGL {
    static isSupported() { try { const c = document.createElement('canvas'); return !!(c.getContext('webgl2')); } catch (e) { return false; } }
    constructor(canvas, onSelect) {
      this.canvas = canvas; this.onSelect = onSelect || function () { }; this.onHover = null; this.onMeasure = null;
      const gl = canvas.getContext('webgl2', { antialias: true, preserveDrawingBuffer: true }); if (!gl) throw new Error('WebGL2 unavailable');
      this.gl = gl; this.supportsTools = true;
      this.yaw = -0.7; this.pitch = -0.5; this.dist = 14; this.target = [0, 1.5, 0];
      this._fov = 50 * Math.PI / 180; this._run = false;
      this.showAI = true; this.selectedId = null;
      this.base = []; this.overlay = []; this.bbox = { mn: [-1, 0, -1], mx: [1, 3, 1] };
      this._octActive = false; this._octIndex = null; this._octFetch = null; this._octCache = null; this._octBudget = Infinity;
      this._octGeneration = 0; this._octFailures = null; this._octNow = null; // cancel stale node reads; bounded retry state
      this._interBudget = 128000000; this._perfProfile = 'balanced'; this._densityBoost = 1.8; // бюджет точек при движении камеры (порог плотности): 6 млн — без подвисаний на больших LAS
      this._selDepthMode = 0; this._selThrough = false; // режим глубины выделения: 0 тонко / 1 шире / 2 насквозь
      this._selGrowPx = null; // расширение точек-окклюдеров в pick-проходе (px); null = авто по режиму глубины
      this._selSubtract = false;   // режим снятия выделения (Alt / кнопка): рамка/лассо УБИРАЕТ точки
      this._selAccumulate = true;  // мультивыбор: каждая рамка/лассо ДОБАВЛЯЕТ к выбору
      this.section = { on: false, t: 1, min: [0, 0, 0], max: [1, 1, 1] }; this.measuring = false; this.measurePts = []; this.lod = false; this.isolate = false; this.walk = false;
      this.measureMode = 'distance'; this._measResult = null; this._measLabels = []; // режим измерения: point|distance|polyline|angle|area|plane|deviation
      this.measureSnap = false; this._measRefPlane = null; this._measHistory = []; // snap к рёбрам/углам; опорная плоскость; история измерений
      this.smartMeasure = true; this._smartAxisTolDeg = 10; // «умное» измерение расстояния: живые направляющие + привязка к осям
      this.theme = 'dark'; this._tween = null;
      // Качество облака (Патч 30): цветовой режим, яркость, множитель размера точки, EDL
      this._cloudDisplay = { pointSize: 1, opacity: 1, min: 0, max: 1, palette: 0, hideOutside: false };
      this._ptElev = false; this._cloudColorMode = 'rgb';
      this._ptBright = 1; this._ptSizeMul = 1; this._roundPoints = false; this._attenuate = false;
      this._denseFill = false; this._frameBox = false; // плотная заливка при приближении; чёрные рамки точек
      // Фотореалистичная цветокоррекция (тонмаппинг) — включена по умолчанию: убирает выбитый белый, даёт контраст/цвет «как фото».
      this._grade = { on: false, exposure: 1.06, contrast: 1.14, saturation: 1.22, gamma: 1.02, tone: 0.85 };
      this._edl = false; this._edlReady = false; this._edlStrength = 1.0; this._edlRadius = 1.4;
      this._pickReady = false; // GPU-проход выбора видимых точек (ленивая инициализация)
      this._photo = false; this._photoSaved = null;   // фото-качество экскурсии
      this._edlAutoTried = false; // авто-EDL при первой загрузке облака (плотный «фото»-вид как в CloudCompare)
      this._lodBudget = 80000000; // видимый бюджет LOD (точек на экран) — максимум для мощных GPU (RTX 5070+)
      // Ниже этого порога облако рисуется ОДНИМ полным буфером (ВСЕ точки, без
      // страйд-прореживания LOD) — плотная картинка как в CloudCompare. LOD — только для гигантских облаков.
      this._lodThreshold = Number.POSITIVE_INFINITY; // порог «до бесконечности»: обычная загрузка всегда рисует ВСЕ точки одним буфером
      // v1059: предел одного VBO поднят до 96 млн — облака до ~90 млн (вкл. текущие 78 млн) рисуются ЦЕЛИКОМ,
      // как в CloudCompare (на RTX 5070 / 32 ГБ памяти). Более крупные проекты аккуратно прорежаются до этого уровня (выглядит сплошным).
      this._maxSingleBuffer = 96000000;
      this._initGL(); this._bind(); this._resize();
      // throttle resize по кадрам — иначе сильные зависания при тяге окна
      this._roRAF = 0;
      this._ro = () => { if (this._roRAF) return; this._roRAF = requestAnimationFrame(() => { this._roRAF = 0; this._resize(); this.render(); }); };
      window.addEventListener('resize', this._ro);
      // The workspace grid changes size after the viewer is constructed. A window-only
      // listener left the WebGL backing buffer at the small boot size and CSS stretched
      // it to the final viewport, changing its aspect ratio and blurring every point.
      this._canvasRO = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(this._ro) : null;
      if (this._canvasRO) this._canvasRO.observe(this.canvas);
    }

    _initGL() {
      const gl = this.gl;
      const sh = (t, src) => { const s = gl.createShader(t); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error('shader: ' + gl.getShaderInfoLog(s)); return s; };
      const p = gl.createProgram(); gl.attachShader(p, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(p, sh(gl.FRAGMENT_SHADER, FS)); gl.linkProgram(p);
      if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('link: ' + gl.getProgramInfoLog(p));
      this.prog = p; gl.useProgram(p);
      this.aPos = gl.getAttribLocation(p, 'aPos'); this.aNormal = gl.getAttribLocation(p, 'aNormal'); this.aColor = gl.getAttribLocation(p, 'aColor');
      this.aIntensity = gl.getAttribLocation(p, 'aIntensity');
      this.aClassification = gl.getAttribLocation(p, 'aClassification');
      this.u = {};
      for (const k of ['uMVP', 'uColor', 'uUnlit', 'uLightDir', 'uAmbient', 'uClipOn', 'uClipDist', 'uClipMin', 'uClipMax', 'uUseVColor', 'uPointSize', 'uRound', 'uFrame', 'uAttenuate', 'uPtScale', 'uPtMin', 'uPtMax', 'uElevMode', 'uAttrMode', 'uElevMin', 'uElevMax', 'uBright', 'uGrade', 'uExposure', 'uContrast', 'uSaturation', 'uGamma', 'uTone', 'uCloudPass', 'uCloudOpacity', 'uPalette']) this.u[k] = gl.getUniformLocation(p, k);
      gl.enable(gl.DEPTH_TEST); gl.disable(gl.CULL_FACE);
      const _tc = this._themeColors(); gl.clearColor(_tc.bg[0], _tc.bg[1], _tc.bg[2], 1);
    }

    _resize() {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = this.canvas.clientWidth || 800, h = this.canvas.clientHeight || 600;
      const dw = Math.max(1, Math.round(w * dpr)), dh = Math.max(1, Math.round(h * dpr));
      if (this.canvas.width !== dw) this.canvas.width = dw;
      if (this.canvas.height !== dh) this.canvas.height = dh;
      this.gl.viewport(0, 0, dw, dh);
    }

    // ---------- object upload ----------
    _makeObj(o) {
      if (o._lodBuild) return this._makeLodObj(o);
      const gl = this.gl; const vao = gl.createVertexArray(); gl.bindVertexArray(vao);
      const pb = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, pb); gl.bufferData(gl.ARRAY_BUFFER, o.pos, gl.STATIC_DRAW);
      gl.enableVertexAttribArray(this.aPos); gl.vertexAttribPointer(this.aPos, 3, gl.FLOAT, false, 0, 0);
      if (o.nor) { const nb = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, nb); gl.bufferData(gl.ARRAY_BUFFER, o.nor, gl.STATIC_DRAW); gl.enableVertexAttribArray(this.aNormal); gl.vertexAttribPointer(this.aNormal, 3, gl.FLOAT, false, 0, 0); o._nb = nb; }
      if (o.col && this.aColor >= 0) { const cb = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, cb); gl.bufferData(gl.ARRAY_BUFFER, o.col, gl.STATIC_DRAW); gl.enableVertexAttribArray(this.aColor); gl.vertexAttribPointer(this.aColor, 3, gl.FLOAT, false, 0, 0); o._cb = cb; }
      if (o.intensity && this.aIntensity >= 0) {
        const ib = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, ib);
        gl.bufferData(gl.ARRAY_BUFFER, o.intensity, gl.STATIC_DRAW);
        gl.enableVertexAttribArray(this.aIntensity);
        gl.vertexAttribPointer(this.aIntensity, 1, gl.FLOAT, false, 0, 0);
        o._ib = ib;
      }
      if (o.classification && this.aClassification >= 0) {
        const kb = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, kb);
        gl.bufferData(gl.ARRAY_BUFFER, o.classification, gl.STATIC_DRAW);
        gl.enableVertexAttribArray(this.aClassification);
        gl.vertexAttribPointer(this.aClassification, 1, gl.UNSIGNED_BYTE, false, 0, 0);
        o._kb = kb;
      }
      gl.bindVertexArray(null); o._vao = vao; o._pb = pb; o.count = o.pos.length / 3;
      if (!o.line) {
        let mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
        const P = o.pos; for (let i = 0; i < P.length; i += 3) for (let k = 0; k < 3; k++) { const v = P[i + k]; if (v < mn[k]) mn[k] = v; if (v > mx[k]) mx[k] = v; }
        o.aabb = { mn, mx };
        if (!o.points && P.length / 9 > 1500) o._grid = buildGrid(P);   // BVH-подобный ускоритель для тяжёлых мешей
      }
      return o;
    }
    _delObjs(list) { const gl = this.gl; for (const o of list) { if (o._lodCells) { for (const c of o._lodCells) { gl.deleteVertexArray(c.buf.vao); gl.deleteBuffer(c.buf.pb); if (c.buf.cb) gl.deleteBuffer(c.buf.cb); } o._lodCells = null; } if (o._lodCoarse) { gl.deleteVertexArray(o._lodCoarse.vao); gl.deleteBuffer(o._lodCoarse.pb); if (o._lodCoarse.cb) gl.deleteBuffer(o._lodCoarse.cb); o._lodCoarse = null; } if (o._vao) gl.deleteVertexArray(o._vao); if (o._pb) gl.deleteBuffer(o._pb); if (o._nb) gl.deleteBuffer(o._nb); if (o._cb) gl.deleteBuffer(o._cb); if (o._ib) gl.deleteBuffer(o._ib); if (o._kb) gl.deleteBuffer(o._kb); } }
    _makeLodObj(o) {
      const gl = this.gl; const lb = o._lodBuild;
      const mkBuf = (pos, col) => {
        const vao = gl.createVertexArray(); gl.bindVertexArray(vao);
        const pb = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, pb); gl.bufferData(gl.ARRAY_BUFFER, pos, gl.STATIC_DRAW);
        gl.enableVertexAttribArray(this.aPos); gl.vertexAttribPointer(this.aPos, 3, gl.FLOAT, false, 0, 0);
        let cb = null;
        if (col && this.aColor >= 0) { cb = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, cb); gl.bufferData(gl.ARRAY_BUFFER, col, gl.STATIC_DRAW); gl.enableVertexAttribArray(this.aColor); gl.vertexAttribPointer(this.aColor, 3, gl.FLOAT, false, 0, 0); }
        gl.bindVertexArray(null); return { vao, pb, cb, count: pos.length / 3 };
      };
      o._lodCells = lb.cells.map(c => ({ mn: c.mn, mx: c.mx, buf: mkBuf(c.pos, c.col) }));
      o._lodCoarse = mkBuf(lb.coarse.pos, lb.coarse.col);
      o._lod = true; o.aabb = { mn: lb.bbox.mn.slice(), mx: lb.bbox.mx.slice() }; o.count = o.pos.length / 3;
      o._vao = null; o._pb = null; o._lodBuild = null;
      return o;
    }
    _cellOutside(M, mn, mx) {
      let l = 0, r = 0, b = 0, t = 0, nn = 0, ff = 0;
      for (let i = 0; i < 8; i++) {
        const x = (i & 1) ? mx[0] : mn[0], y = (i & 2) ? mx[1] : mn[1], z = (i & 4) ? mx[2] : mn[2];
        const cx = M[0] * x + M[4] * y + M[8] * z + M[12];
        const cy = M[1] * x + M[5] * y + M[9] * z + M[13];
        const cz = M[2] * x + M[6] * y + M[10] * z + M[14];
        const cwp = M[3] * x + M[7] * y + M[11] * z + M[15];
        if (cx < -cwp) l++; if (cx > cwp) r++; if (cy < -cwp) b++; if (cy > cwp) t++; if (cz < -cwp) nn++; if (cz > cwp) ff++;
      }
      return l === 8 || r === 8 || b === 8 || t === 8 || nn === 8 || ff === 8;
    }
    _drawLod(o) {
      const gl = this.gl;
      const savedMax = o._ptMax || 8.0;
      gl.uniform1f(this.u.uPtMax, Math.max(savedMax, 4.0));
      gl.bindVertexArray(o._lodCoarse.vao); gl.drawArrays(gl.POINTS, 0, o._lodCoarse.count);
      gl.uniform1f(this.u.uPtMax, savedMax);
      const M = this._lastVP || this._vp(); const eye = this._eye(); const vis = [];
      for (const c of o._lodCells) {
        if (this._cellOutside(M, c.mn, c.mx)) continue;
        const cx = (c.mn[0] + c.mx[0]) / 2, cy = (c.mn[1] + c.mx[1]) / 2, cz = (c.mn[2] + c.mx[2]) / 2;
        const dd = (cx - eye[0]) * (cx - eye[0]) + (cy - eye[1]) * (cy - eye[1]) + (cz - eye[2]) * (cz - eye[2]);
        vis.push({ c: c, dd: dd });
      }
      vis.sort((a, b2) => a.dd - b2.dd);
      let budget = o._lodBudget || 4000000;
      for (const v of vis) { if (budget <= 0) break; gl.bindVertexArray(v.c.buf.vao); gl.drawArrays(gl.POINTS, 0, v.c.buf.count); budget -= v.c.buf.count; }
    }
    _setBase(objs) { this._delObjs(this.base); this.base = objs.map(o => this._makeObj(o)); this._recomputeBBox(); if (!this.base.some(o => o.points)) this._cloudRecord = null; this._notifyCloudChanged(); }
    _setOverlay(objs) { this._delObjs(this.overlay); this.overlay = objs.map(o => this._makeObj(o)); }

    _recomputeBBox() {
      let mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
      for (const o of this.base) { if (o.line) continue; for (let i = 0; i < o.pos.length; i += 3) for (let k = 0; k < 3; k++) { const v = o.pos[i + k]; if (v < mn[k]) mn[k] = v; if (v > mx[k]) mx[k] = v; } }
      if (mn[0] === Infinity) { mn = [-1, 0, -1]; mx = [1, 3, 1]; }
      this.bbox = { mn, mx };
    }

    // ---------- theme (CAD dark / light) ----------
    _themeColors() {
      return this.theme === 'light'
        ? { bg: [0.94, 0.955, 0.97], grid: [0.76, 0.80, 0.87], wire: [0.58, 0.64, 0.74] }
        : { bg: [0.118, 0.122, 0.125], grid: [0.28, 0.31, 0.36], wire: [0.42, 0.47, 0.55] };
    }
    setTheme(theme) {
      this.theme = theme === 'light' ? 'light' : 'dark';
      const t = this._themeColors();
      if (this.gl) this.gl.clearColor(t.bg[0], t.bg[1], t.bg[2], 1);
      for (const o of this.base) { if (o.gkind === 'grid') o.color = t.grid; else if (o.gkind === 'wire') o.color = t.wire; }
      this.render();
    }

    // ---------- smooth camera ----------
    _tweenTo(to, dur) {
      dur = dur || 480;
      if (this._tween) cancelAnimationFrame(this._tween);
      const from = { yaw: this.yaw, pitch: this.pitch, dist: this.dist, target: this.target.slice() };
      const t0 = performance.now();
      const ease = k => 1 - Math.pow(1 - k, 3); // easeOutCubic
      const step = (now) => {
        const k = Math.min(1, (now - t0) / dur); const e = ease(k);
        this.yaw = from.yaw + (to.yaw - from.yaw) * e;
        this.pitch = from.pitch + (to.pitch - from.pitch) * e;
        this.dist = from.dist + (to.dist - from.dist) * e;
        this.target = [0, 1, 2].map(i => from.target[i] + (to.target[i] - from.target[i]) * e);
        this._interacting = (k < 1);
        this.render();
        if (k < 1) this._tween = requestAnimationFrame(step); else { this._tween = null; this._endInteractSoon(0); }
      };
      this._tween = requestAnimationFrame(step);
    }
    _stopTween() { if (this._tween) { cancelAnimationFrame(this._tween); this._tween = null; } }
    // Кадры: склеиваем несколько render() в один реальный кадр через rAF (не чаще частоты монитора).
    render() { if (this._rafPending) { this._dirty = true; return; } this._rafPending = true; this._dirty = false; const self = this; requestAnimationFrame(() => { self._rafPending = false; try { self._renderNow(); } catch (e) { console.warn('render', e); } if (self._dirty) { self._dirty = false; self.render(); } }); }
    // «Идёт взаимодействие»: во время вращения/панорамы/зума рисуем прореженное облако для плавности.
    _beginInteract() { this._interacting = true; if (this._idleT) { clearTimeout(this._idleT); this._idleT = 0; } }
    _endInteractSoon(ms) { if (this._idleT) clearTimeout(this._idleT); const self = this; this._idleT = setTimeout(() => { self._idleT = 0; self._interacting = false; self.render(); }, ms == null ? 160 : ms); }
    // Однократное перемешивание точек (Fisher–Yates), чтобы префикс буфера был равномерной выборкой по всему облаку.
    _shuffleCloud(pos, col, intensity, classification) {
      const n = pos.length / 3; if (n < 2) return;
      const cs = col ? (col.length / n) | 0 : 0;
      for (let i = n - 1; i > 0; i--) {
        const j = (Math.random() * (i + 1)) | 0; if (j === i) continue;
        for (let k = 0; k < 3; k++) { const a = pos[i * 3 + k]; pos[i * 3 + k] = pos[j * 3 + k]; pos[j * 3 + k] = a; }
        if (cs) for (let k = 0; k < cs; k++) { const a = col[i * cs + k]; col[i * cs + k] = col[j * cs + k]; col[j * cs + k] = a; }
        if (intensity && intensity.length === n) { const a = intensity[i]; intensity[i] = intensity[j]; intensity[j] = a; }
        if (classification && classification.length === n) { const a = classification[i]; classification[i] = classification[j]; classification[j] = a; }
      }
    }

    // ---------- geometry builders ----------
    _gridObj(w, d) {
      const pos = []; const step = 1, x0 = -w / 2, x1 = w / 2, z0 = -d / 2, z1 = d / 2;
      for (let x = -Math.ceil(w / 2); x <= Math.ceil(w / 2); x += step) pos.push(x, 0, z0, x, 0, z1);
      for (let z = -Math.ceil(d / 2); z <= Math.ceil(d / 2); z += step) pos.push(x0, 0, z, x1, 0, z);
      return { line: true, gkind: 'grid', pos: new Float32Array(pos), color: this._themeColors().grid };
    }
    _wireObj(cx, cy, cz, w, h, d, col) { return { line: true, gkind: 'wire', pos: boxEdges(cx, cy, cz, w, h, d), color: col }; }
    _boxObj(id, g, hex, status, el) { const b = boxGeom(g[0], g[1], g[2], g[3], g[4], g[5]); return { id, el, pos: b.pos, nor: b.nor, color: hex2rgb(hex), status }; }

    loadRoom(room) {
      this.room = room; this.selectedId = null; this.isolate = false; this._modelFull = null; this.lod = false; this._clearMeasure();
      const d = room.dims || { w: Math.sqrt(room.area_m2 || 16), d: Math.sqrt(room.area_m2 || 16), h: room.height_m || 3 };
      const w = d.w, dp = d.d, h = d.h; this.target = [0, h / 2, 0];
      const objs = [this._gridObj(w, dp), this._wireObj(0, h / 2, 0, w, h, dp, this._themeColors().wire)];
      const elems = (room.elements || []).filter(e => e.type !== 'стена'); const n = elems.length || 1;
      elems.forEach((el, i) => {
        const px = -w / 2 + w * (i + 1) / (n + 1); let g;
        switch (el.type) {
          case 'вентшахта': g = [px, h - 0.6, 0, 0.9, 0.9, dp * 0.8]; break;
          case 'труба': g = [px, 0.5, -dp / 2 + 0.4, 0.35, 0.35, dp * 0.85]; break;
          case 'кабель-канал': g = [px, h - 0.4, dp / 2 - 0.3, 0.5, 0.3, dp * 0.7]; break;
          case 'дверь': g = [px, 1.05, dp / 2 - 0.05, 1.0, 2.1, 0.12]; break;
          default: g = [px, 1.0, 0, 1.3, 2.0, 1.0];
        }
        objs.push(this._boxObj(el.id, g, TYPE_BASE[el.type] || '#6b7d99', el.ai_status || 'none', el));
      });
      this._setBase(objs); this._frame(); this.render();
    }

    loadGlb(arrayBuffer) {
      const dv = new DataView(arrayBuffer); if (dv.getUint32(0, true) !== 0x46546C67) throw new Error('Файл не является .glb');
      const total = dv.getUint32(8, true); let off = 12, json = null, bin = null;
      while (off < total) { const clen = dv.getUint32(off, true), ctype = dv.getUint32(off + 4, true); off += 8; const chunk = arrayBuffer.slice(off, off + clen); off += clen; if (ctype === 0x4E4F534A) json = JSON.parse(new TextDecoder('utf-8').decode(chunk)); else if (ctype === 0x004E4942) bin = new Uint8Array(chunk); }
      if (!json) throw new Error('В .glb нет JSON-чанка'); this.loadGltf(json, bin ? [bin] : []);
    }

    loadGltf(gltf, buffers) {
      const getAcc = i => { const acc = gltf.accessors[i], bv = gltf.bufferViews[acc.bufferView], src = buffers[bv.buffer]; const u8 = src instanceof Uint8Array ? src : new Uint8Array(src); const off = u8.byteOffset + (bv.byteOffset || 0) + (acc.byteOffset || 0); const comp = { 5126: Float32Array, 5123: Uint16Array, 5125: Uint32Array, 5121: Uint8Array }[acc.componentType]; const num = acc.count * ({ SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }[acc.type]); return new comp(u8.buffer, off, num); };
      const pos = []; const nrmArr = [];
      const addMesh = (mi, world) => {
        const nmat = invert(world);   // нормали трансформируем обратной транспонированной матрицей
        for (const prim of (gltf.meshes[mi].primitives || [])) {
          if (prim.attributes.POSITION == null) continue;
          const Pa = getAcc(prim.attributes.POSITION);
          const Na = prim.attributes.NORMAL != null ? getAcc(prim.attributes.NORMAL) : null;   // уважаем accessor NORMAL
          const idx = prim.indices != null ? getAcc(prim.indices) : null;
          const vcount = idx ? idx.length : (Pa.length / 3);
          const gi = k => idx ? idx[k] : k;
          for (let k = 0; k + 2 < vcount; k += 3) {
            const wp = [], vis = [];
            for (let j = 0; j < 3; j++) { const vi = gi(k + j); vis.push(vi); wp.push(tpt(world, [Pa[vi * 3], Pa[vi * 3 + 1], Pa[vi * 3 + 2]])); }
            let wn;
            if (Na) { wn = vis.map(vi => { const t = tvec(nmat, [Na[vi * 3], Na[vi * 3 + 1], Na[vi * 3 + 2], 0]); return norm([t[0], t[1], t[2]]); }); }
            else { const fn = norm(cross(sub(wp[1], wp[0]), sub(wp[2], wp[0]))); wn = [fn, fn, fn]; }
            for (let j = 0; j < 3; j++) { pos.push(wp[j][0], wp[j][1], wp[j][2]); nrmArr.push(wn[j][0], wn[j][1], wn[j][2]); }
          }
        }
      };
      const visit = (idx, parent) => { const n = gltf.nodes[idx]; const wm = mul(parent, nodeLocal(n)); if (n.mesh != null) addMesh(n.mesh, wm); (n.children || []).forEach(c => visit(c, wm)); };
      const scene = gltf.scenes ? gltf.scenes[gltf.scene || 0] : null;
      if (gltf.nodes && scene && scene.nodes) scene.nodes.forEach(r => visit(r, ident()));
      else if (gltf.meshes) gltf.meshes.forEach((_, i) => addMesh(i, ident()));
      const P = new Float32Array(pos); const nor = new Float32Array(nrmArr);
      this.room = null; this.selectedId = null; this.isolate = false; this._clearMeasure();
      this._modelFull = { pos: P, nor }; this.lod = false;
      this._setBase([{ id: null, pos: P, nor, color: hex2rgb('#8f9bb0'), status: 'none' }]);
      this.modelDims = this._computeModelDims(P);
      this._frame(); this.render();
      if (typeof this.onModelDims === 'function' && this.modelDims) this.onModelDims(this.modelDims);
    }

    // Облако точек (LAS/LAZ/E57/PLY): pos + поточечный цвет (col)
    _estimateSpacing(pos, n) {
      try {
        n = n | 0;
        if (!pos || n < 16 || pos.length < 48) return 0;
        const offs = [Math.floor(n * 0.5), Math.floor(n * 0.15), Math.floor(n * 0.82)];
        const W = Math.min(9000, n);
        let best = Infinity;
        const hash = (ix, iy, iz) => (((ix * 73856093) ^ (iy * 19349663) ^ (iz * 83492791)) | 0);
        for (const off0 of offs) {
          let start = off0; if (start + W > n) start = Math.max(0, n - W);
          const s = start * 3, e = (start + W) * 3;
          let mnx = Infinity, mny = Infinity, mnz = Infinity, mxx = -Infinity, mxy = -Infinity, mxz = -Infinity;
          for (let i = s; i < e; i += 3) { const x = pos[i], y = pos[i + 1], z = pos[i + 2]; if (x < mnx) mnx = x; if (y < mny) mny = y; if (z < mnz) mnz = z; if (x > mxx) mxx = x; if (y > mxy) mxy = y; if (z > mxz) mxz = z; }
          const dx = mxx - mnx, dy = mxy - mny, dz = mxz - mnz;
          const diag = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
          const cell = diag / Math.max(4, Math.cbrt(W));
          if (!(cell > 0) || !isFinite(cell)) continue;
          const inv = 1 / cell;
          const grid = new Map();
          for (let i = s; i < e; i += 3) {
            const ix = Math.floor((pos[i] - mnx) * inv), iy = Math.floor((pos[i + 1] - mny) * inv), iz = Math.floor((pos[i + 2] - mnz) * inv);
            const k = hash(ix, iy, iz); let a = grid.get(k); if (!a) { a = []; grid.set(k, a); } a.push(i);
          }
          const dists = [];
          const qStride = Math.max(1, Math.floor(W / 2500)) * 3;
          for (let i = s; i < e; i += qStride) {
            const px = pos[i], py = pos[i + 1], pz = pos[i + 2];
            const ix = Math.floor((px - mnx) * inv), iy = Math.floor((py - mny) * inv), iz = Math.floor((pz - mnz) * inv);
            let bestd = Infinity;
            for (let r = 1; r <= 2 && bestd === Infinity; r++) {
              for (let ddx = -r; ddx <= r; ddx++) for (let ddy = -r; ddy <= r; ddy++) for (let ddz = -r; ddz <= r; ddz++) {
                const a = grid.get(hash(ix + ddx, iy + ddy, iz + ddz)); if (!a) continue;
                for (let t = 0; t < a.length; t++) { const j = a[t]; if (j === i) continue; const ex = pos[j] - px, ey = pos[j + 1] - py, ez = pos[j + 2] - pz; const d2 = ex * ex + ey * ey + ez * ez; if (d2 < bestd) bestd = d2; }
              }
            }
            if (bestd < Infinity && bestd > 0) dists.push(Math.sqrt(bestd));
          }
          if (dists.length > 20) { dists.sort((a, b) => a - b); const med = dists[Math.floor(dists.length * 0.5)]; if (med > 0 && med < best) best = med; }
        }
        return (best < Infinity && best > 0) ? best : 0;
      } catch (e) { return 0; }
    }
    loadCloud(cloud, opts) {
      this.room = null; this.selectedId = null; this.isolate = false; this._clearMeasure();
      this._modelFull = null; this.lod = false;
      // Per-point attributes are tied to a specific point order. Keep a copy of
      // the previous state only long enough to flag edits that drop those fields.
      const priorIntensity = this._intensityValues || null;
      const priorClassification = this._classificationLabels || null;
      const priorWarnings = this._attributeWarnings || [];
      const priorMeta = this._srcMeta || {};
      this._classificationLabels = null; this._intensityValues = null;
      const meta = cloud.meta || {};
      // Preserve the source coordinate transform through edits/reloads of the same cloud.
      const priorSrc = this._srcXform || null, priorCrs = this._srcCrs || null;
      // Resolve view/display preservation before applying the quality profile.  In the
      // previous build `preserve` was read before its declaration and the fresh-cloud
      // display state was reset after the quality profile, leaving a 1 px cloud.
      const previous = this._cloudRecord;
      const named = opts && opts.sourceName;
      const preserve = !!(opts && opts.preserveView && previous && (!named || named === previous.sourceName));
      // Undo records reference point indices/arrays from one concrete cloud.
      // Never let Ctrl+Z from an unrelated import or project switch mutate a
      // newly loaded cloud; edits that explicitly preserve the same cloud keep
      // their history (delete/downsample/undo reloads).
      if (!preserve) this._undo = [];
      this._srcXform = meta.srcXform || (preserve ? priorSrc : null);
      this._srcCrs = meta.crsWkt || (preserve ? priorCrs : null);
      this._srcUnits = meta.units || (preserve ? this._srcUnits || priorMeta.units || null : null);
      this._srcMeta = Object.assign({}, preserve ? priorMeta : {}, meta);
      this._srcMeta.srcXform = this._srcXform;
      if (this._srcCrs) this._srcMeta.crsWkt = this._srcCrs;
      if (this._srcUnits) this._srcMeta.units = this._srcUnits;
      this._attributeWarnings = preserve ? priorWarnings.slice() : [];
      (meta.attributeWarnings || []).forEach(w => { if (w && !this._attributeWarnings.includes(w)) this._attributeWarnings.push(String(w)); });
      if (!preserve) {
        this._cloudDisplay = { pointSize:null, opacity:1, min:0, max:1, palette:0, hideOutside:false };
        this.cloudVisible = true; this._ptElev = false; this._cloudColorMode = 'rgb'; this._ptSizeMul = 1.45;
        this._denseFill = false; this._attenuate = true; this._roundPoints = false;
      }
      let n = Math.min(Math.floor(cloud.count || cloud.pos.length / 3), Math.floor(cloud.pos.length / 3));
      let intensity = cloud.intensity && cloud.intensity.length >= n ? cloud.intensity.subarray ? cloud.intensity.subarray(0, n) : new Float32Array(cloud.intensity.slice(0, n)) : null;
      let classification = cloud.classification && cloud.classification.length >= n ? cloud.classification.subarray ? cloud.classification.subarray(0, n) : new Uint8Array(cloud.classification.slice(0, n)) : null;
      if (preserve && priorIntensity && !intensity) this._attributeWarnings.push('Intensity потерян при операции, которая изменила состав/порядок точек');
      if (preserve && priorClassification && !classification) this._attributeWarnings.push('Classification потерян при операции, которая изменила состав/порядок точек');
      // LOD: для больших облаков строим октантную структуру (безопасный фолбэк на обычный рендер)
      let lodBuild = null;
      if (n > (this._lodThreshold || 40000000) && typeof window !== 'undefined' && window.PCLod && this.lodEnabled !== false) {
        try { lodBuild = window.PCLod.build(cloud.pos, cloud.col || null, { pointBudget: this._lodBudget || 4000000 }); } catch (e) { console.warn('LOD build failed, fallback to single buffer', e); lodBuild = null; }
      }
      // v1042: ЖЁСТКИЙ предел на один VBO. Без LOD (PCLod может отсутствовать) облако на 78–313 млн
      // точек = буфер в сотни МБ, который WebGL не может выделить → раньше это давало «Ошибка
      // открытия облака». Прореживаем равномерно до безопасного предела — облако всегда открывается.
      // Полная точность остаётся в файле на диске (авто-очистка и CloudCompare работают с ним).
      this._decimatedFrom = 0; this._decimatedTo = 0;
      if (!lodBuild && n > (this._maxSingleBuffer || 96000000)) {
        try {
          const cap = this._maxSingleBuffer || 96000000;
          const stride = Math.ceil(n / cap);
          if (stride > 1) {
            const outN = Math.floor(n / stride);
            const sp = cloud.pos; const dpos = new Float32Array(outN * 3);
            const sc = cloud.col || null; const dcol = sc ? new sc.constructor(outN * 3) : null;
            for (let i = 0, j = 0; j < outN; i += stride, j++) {
              const s3 = i * 3, d3 = j * 3;
              dpos[d3] = sp[s3]; dpos[d3 + 1] = sp[s3 + 1]; dpos[d3 + 2] = sp[s3 + 2];
              if (dcol) { dcol[d3] = sc[s3]; dcol[d3 + 1] = sc[s3 + 1]; dcol[d3 + 2] = sc[s3 + 2]; }
            }
            const di = intensity ? new intensity.constructor(outN) : null, dc = classification ? new classification.constructor(outN) : null;
            for (let i = 0, j = 0; j < outN; i += stride, j++) { if (di) di[j] = intensity[i]; if (dc) dc[j] = classification[i]; }
            intensity = di; classification = dc;
            cloud = { pos: dpos, col: dcol, intensity:di, classification:dc, count: outN, meta: cloud.meta, spacing: cloud.spacing, pointSize: cloud.pointSize };
            this._decimatedFrom = n; this._decimatedTo = outN; n = outN;
            try { if (typeof this.onDecimated === 'function') this.onDecimated(this._decimatedFrom, outN); } catch (e) {}
          }
        } catch (e) { console.warn('decimate fallback failed', e); }
      }
      const q = cloudQuality(n); const ps = q.pointSize;
      // При большом одном буфере — перемешаем один раз, чтобы адаптивный LOD при движении брал равномерную выборку.
      // v1010: реальный шаг между точками ДО перемешивания (в файле точки идут по порядку
      // сканирования, соседи рядом). После shuffle порядок теряется.
      // Если вызывающий передал уже известный шаг (перезагрузка после правки/чистки:
      // массив точек уже перемешан, и оценка по соседям дала бы мусор и «кубики»), берём его.
      let realSpacing = 0;
      if (cloud.spacing > 0 && isFinite(cloud.spacing)) { realSpacing = cloud.spacing; }
      else { try { realSpacing = this._estimateSpacing(cloud.pos, n); } catch (e) {} }
      // E57 scan ranges and poses are positional metadata; randomizing the
      // point buffer would silently associate records with the wrong scan on
      // export. Keep the acquisition order whenever that metadata is present.
      const hasScanOrderMetadata = Array.isArray(this._srcMeta && this._srcMeta.scans) && this._srcMeta.scans.length > 0;
      const canShuffle = !lodBuild && n > 2000000 && !hasScanOrderMetadata;
      if (canShuffle) { try { this._shuffleCloud(cloud.pos, cloud.col || null, intensity, classification); } catch (e) { console.warn('shuffle skip', e); } }
      this._intensityValues = intensity ? new intensity.constructor(intensity) : null;
      this._classificationLabels = classification ? new Uint8Array(classification) : null;
      const baseObj = { id: null, points: true, pos: cloud.pos, col: cloud.col || null, intensity:this._intensityValues, classification:this._classificationLabels, pointSize: cloud.pointSize || ps, color: hex2rgb('#cfd6e2'), status: 'none' };
      if (lodBuild) { baseObj._lodBuild = lodBuild; baseObj._lodBudget = this._lodBudget || 4000000; }
      else if (canShuffle) { baseObj._shuffled = true; }
      this._setBase([baseObj]);
      // оценка среднего шага между точками → адаптивный размер точки вблизи
      const bc = this.bbox; const bw = bc.mx[0] - bc.mn[0], bh = bc.mx[1] - bc.mn[1], bd = bc.mx[2] - bc.mn[2];
      const area = 2 * (bw * bd + bw * bh + bd * bh) || 1; const diag = Math.sqrt(bw * bw + bh * bh + bd * bd) || 8;
      let spacing = Math.sqrt(area / Math.max(1, n)); spacing = Math.min(spacing, diag * 0.02);
      // v1010 «парсер плотности»: точный межточечный интервал модели -> сплэты закрывают ровно
      // зазоры (сплошная резкая поверхность), а не грубая оценка по габаритам bbox.
      let usedModel = false;
      if (realSpacing > 0 && isFinite(realSpacing) && realSpacing < spacing) { spacing = realSpacing; usedModel = true; }
      // Fresh clouds use perspective-aware square splats. The old unconditional reset
      // to a fixed 1 px point made distant scans sparse and visually low-resolution.
      // Preserve an explicitly selected mode only when reloading the same cloud.
      this._attenuate = preserve ? !!this._attenuate : true;
      try { console.info('[cloud] точек: ' + (n).toLocaleString('ru-RU') + ' · габариты ' + bw.toFixed(2) + '×' + bh.toFixed(2) + '×' + bd.toFixed(2) + ' м · шаг ~' + (spacing * 1000).toFixed(1) + ' мм' + (usedModel ? ' (по модели)' : ' (оценка bbox)')); } catch (e) {}
      const bo = this.base[0]; if (bo) { bo._spacing = spacing; bo._ptMax = q.ptMax; }
      // Авто-EDL для облаков: объём и резкость как в CloudCompare (плотная «фото»-картинка).
      // Best-effort с фолбеком на обычный рендер, если GPU не поддержит.
      if (!this._edlAutoTried) {
        this._edlAutoTried = true;
        this._edl = false; // v1061: EDL выключен по умолчанию — убирает чёрную обводку точек и чёрные зазоры. v1091: авто dense fill для PLY.
        if (typeof this.onQualityChange === 'function') { try { this.onQualityChange(); } catch (e) {} }
      }
      if (!preserve) { this._cloudDisplay.min = this.bbox.mn[1]; this._cloudDisplay.max = this.bbox.mx[1]; }
      this._cloudRecord={ sourceName:named || (preserve && previous.sourceName) || cloud.name || meta.name || 'Облако без имени', sourceCount:preserve?previous.sourceCount:(Number.isSafeInteger(meta.total)&&meta.total>=0?meta.total:null), loadedCount:n, format:meta.format || (preserve && previous.format) || '', hasRGB:(preserve && meta.colored==null)?previous.hasRGB:(meta.colored !== false && !!cloud.col), hasIntensity:!!this._intensityValues, hasClassification:!!this._classificationLabels, revision:((previous&&previous.revision)||0)+1 };
      if (!this.getAvailableColorModes().includes(this.getColorMode())) {
        this._cloudColorMode = 'rgb';
        this._ptElev = false;
      }
      this.modelDims = this._computeCloudDims(meta, n);
      this._notifyCloudChanged();
      if (opts && opts.preserveView && this.bbox && this.target) { this.render(); } else { this._frame(); this.render(); }
      if (typeof this.onModelDims === 'function' && this.modelDims) this.onModelDims(this.modelDims);
      // Keep the project manifest in sync with every loaded/reloaded point cloud.
      // This is the single common path for file imports and geometry replacements.
      try {
        if (typeof window !== 'undefined' && typeof window.CustomEvent === 'function') {
          const sourcePath = named || (preserve && previous && previous.sourceName) || '';
          const displayName = cloud.name || meta.name || (sourcePath ? String(sourcePath).split(/[\\\\/]/).pop() : '') || 'Облако';
          window.dispatchEvent(new CustomEvent('lx-cloud-loaded', { detail: {
            name: displayName, path: sourcePath, count: n,
            sourceTransform: this._srcXform || null, crsWkt: this._srcCrs || null, units:this._srcUnits||null,
            attributeWarnings:this._attributeWarnings.slice()
          } }));
        }
      } catch (error) { try { console.warn('[cloud] project sync event failed', error); } catch (_) {} }
    }
    clearCloud() {
      this._clearMeasure();
      this.clearSelection();
      this.clearOctreeStream();
      this.room = null;
      this.selectedId = null;
      this.isolate = false;
      this.lod = false;
      this._modelFull = null;
      this._undo = [];
      this._classificationLabels = null;
      this._intensityValues = null; this._attributeWarnings = [];
      this._srcXform = null;
      this._srcCrs = null;
      this._srcUnits = null; this._srcMeta = {};
      this._cloudRecord = null;
      this._cloudDisplay = { pointSize: null, opacity: 1, min: 0, max: 1, palette: 0, hideOutside: false };
      this._cloudColorMode = 'rgb';
      this._ptElev = false;
      this._sel = new Set();
      if (this._selObj) { this._delObjs([this._selObj]); this._selObj = null; }
      this._setOverlay([]);
      this._setBase([]);
      this.modelDims = null;
      this.target = [0, 1.5, 0];
      this.dist = 8; this.yaw = -0.72; this.pitch = -0.52;
      this.cloudVisible = true;
      this.render();
      return true;
    }
    applyClassificationLabels(labels, selectClass) {
      const bo = this.base && this.base[0];
      if (!bo || !bo.pos || !labels || labels.length !== Math.floor(bo.pos.length / 3)) return false;
      const data = labels instanceof Uint8Array ? labels : new Uint8Array(labels);
      this._classificationLabels = new Uint8Array(data);
      bo.classification = this._classificationLabels;
      // A classification can be produced after the cloud VAO has been
      // created. Upload the new label buffer and attach it to that VAO so the
      // classification color mode does not silently render every point as
      // the default generic-attribute value (class 0).
      const gl = this.gl;
      if (gl && bo._vao && this.aClassification >= 0) {
        const kb = gl.createBuffer();
        if (kb) {
          gl.bindVertexArray(bo._vao);
          gl.bindBuffer(gl.ARRAY_BUFFER, kb);
          gl.bufferData(gl.ARRAY_BUFFER, this._classificationLabels, gl.STATIC_DRAW);
          gl.enableVertexAttribArray(this.aClassification);
          gl.vertexAttribPointer(this.aClassification, 1, gl.UNSIGNED_BYTE, false, 0, 0);
          gl.bindVertexArray(null);
          const previousBuffer = bo._kb;
          bo._kb = kb;
          if (previousBuffer) gl.deleteBuffer(previousBuffer);
        }
      }
      if (selectClass != null) {
        const selected = new Set();
        for (let i = 0; i < data.length; i++) if (data[i] === selectClass) selected.add(i);
        this._sel = selected;
        if (this._buildSelHighlight) this._buildSelHighlight();
        if (typeof this.onEditSelect === 'function') this.onEditSelect(selected.size);
      }
      if (this._cloudRecord) this._cloudRecord.hasClassification = true;
      this.render();
      this._notifyCloudChanged();
      return true;
    }
    getClassificationLabels() {
      return this._classificationLabels ? new Uint8Array(this._classificationLabels) : null;
    }
    clearClassificationLabels() {
      const bo = this.base && this.base[0];
      if (!bo || !bo.pos || (!this._classificationLabels && !bo.classification)) return false;
      this._classificationLabels = null;
      bo.classification = null;
      const gl = this.gl;
      if (gl && bo._vao && this.aClassification >= 0) {
        gl.bindVertexArray(bo._vao);
        if (typeof gl.disableVertexAttribArray === 'function') gl.disableVertexAttribArray(this.aClassification);
        if (typeof gl.vertexAttrib1f === 'function') gl.vertexAttrib1f(this.aClassification, 0);
        gl.bindVertexArray(null);
      }
      if (gl && bo._kb && typeof gl.deleteBuffer === 'function') gl.deleteBuffer(bo._kb);
      bo._kb = null;
      if (this._cloudRecord) this._cloudRecord.hasClassification = false;
      if (this._cloudColorMode === 'classification') {
        this._cloudColorMode = 'rgb';
        this._ptElev = false;
      }
      this.render();
      this._notifyCloudChanged();
      return true;
    }
    // Меш с поточечным цветом (напр. PLY с vertex colours)
    loadColoredMesh(mesh) {
      this.room = null; this.selectedId = null; this.isolate = false; this._clearMeasure();
      this._undo = [];
      this._classificationLabels = null;
      this._intensityValues = null; this._attributeWarnings = [];
      const meta = mesh && mesh.meta || {};
      this._srcXform = meta.srcXform || null;
      this._srcCrs = meta.crsWkt || null;
      this._srcUnits = meta.units || null; this._srcMeta = Object.assign({}, meta);
      const P = mesh.pos, nor = mesh.nor, col = mesh.col || null;
      this._modelFull = { pos: P, nor, col }; this.lod = false;
      this._setBase([{ id: null, pos: P, nor, col, color: hex2rgb('#9aa6bb'), status: 'none' }]);
      this.modelDims = this._computeModelDims(P);
      this._frame(); this.render();
      if (typeof this.onModelDims === 'function' && this.modelDims) this.onModelDims(this.modelDims);
    }
    _computeCloudDims(meta, n) {
      const c = this.bbox; if (!c || c.mn[0] === Infinity) return null;
      const w = c.mx[0] - c.mn[0], h = c.mx[1] - c.mn[1], d = c.mx[2] - c.mn[2];
      return { w, d, h, footprint: w * d, bboxVolume: w * d * h, volume: 0, tris: 0, points: n, isCloud: true, mn: c.mn.slice(), mx: c.mx.slice() };
    }

    // Реальные габариты/площадь/объём модели из мировой геометрии (значения «1 в 1» с 3D)
    _computeModelDims(P) {
      const c = this.bbox; if (!c || c.mn[0] === Infinity) return null;
      const w = c.mx[0] - c.mn[0], h = c.mx[1] - c.mn[1], d = c.mx[2] - c.mn[2];
      let vol6 = 0;   // объём меша через сумму знаковых тетраэдров (теорема о дивергенции)
      for (let i = 0; i + 8 < P.length; i += 9) {
        const ax = P[i], ay = P[i + 1], az = P[i + 2], bx = P[i + 3], by = P[i + 4], bz = P[i + 5], cx = P[i + 6], cy = P[i + 7], cz = P[i + 8];
        vol6 += ax * (by * cz - cy * bz) - bx * (ay * cz - cy * az) + cx * (ay * bz - by * az);
      }
      return { w, d, h, footprint: w * d, bboxVolume: w * d * h, volume: Math.abs(vol6) / 6, tris: Math.floor(P.length / 9), mn: c.mn.slice(), mx: c.mx.slice() };
    }

    _frame() { const c = this.bbox;
      this.target = [(c.mn[0] + c.mx[0]) / 2, (c.mn[1] + c.mx[1]) / 2, (c.mn[2] + c.mx[2]) / 2];
      const ex=Math.max(1e-3,c.mx[0]-c.mn[0]), ey=Math.max(1e-3,c.mx[1]-c.mn[1]), ez=Math.max(1e-3,c.mx[2]-c.mn[2]);
      const long=Math.max(ex,ez), cross=Math.max(ey,Math.min(ex,ez));
      if(long/Math.max(1e-3,Math.min(ex,ez))>3){
        this.yaw=ez>=ex?0.28:(Math.PI/2-0.28); this.pitch=-0.18;
        this.dist=Math.max(long*0.78+cross*1.7,cross*2.8);
      }else{
        const size=Math.max(ex,ey,ez)||8; this.yaw=-0.72; this.pitch=-0.52; this.dist=size*1.28;
      }
      this._ortho=false;
    }
    resetView() {
      const c = this.bbox;
      const t = [(c.mn[0] + c.mx[0]) / 2, (c.mn[1] + c.mx[1]) / 2, (c.mn[2] + c.mx[2]) / 2];
      const ex = Math.max(1e-3, c.mx[0] - c.mn[0]), ey = Math.max(1e-3, c.mx[1] - c.mn[1]), ez = Math.max(1e-3, c.mx[2] - c.mn[2]);
      const horizontalLong = Math.max(ex, ez), cross = Math.max(ey, Math.min(ex, ez));
      const elongated = horizontalLong / Math.max(1e-3, Math.min(ex, ez)) > 3;
      let yaw, pitch, dist;
      if (elongated) {
        // Long corridors/buildings must be viewed mostly along their long axis.
        // A fixed diagonal view projected the full 27 m length sideways and made a
        // correctly-scaled 4 m-high scan look like a flat strip.
        yaw = ez >= ex ? 0.28 : (Math.PI / 2 - 0.28);
        pitch = -0.18;
        dist = horizontalLong * 0.78 + cross * 1.7;
      } else {
        const size = Math.max(ex, ey, ez) || 8;
        yaw = -0.72; pitch = -0.52; dist = size * 1.28;
      }
      this._tweenTo({ yaw, pitch, dist:Math.max(dist, cross * 2.2), target:t });
      this._ortho = false;
    }
    // Ортографическая проекция (точный план, без перспективных искажений)
    setOrtho(on) { this._ortho = !!on; this.render(); return this._ortho; }
    isOrtho() { return !!this._ortho; }
    // Вид сверху + орто (план). pitch чуть меньше 90° чтобы look() не вырождался
    topView() {
      const c = this.bbox;
      const t = [(c.mn[0] + c.mx[0]) / 2, (c.mn[1] + c.mx[1]) / 2, (c.mn[2] + c.mx[2]) / 2];
      const size = Math.max(c.mx[0] - c.mn[0], c.mx[2] - c.mn[2]) || 8;
      this._ortho = true;
      this._tweenTo({ yaw: 0, pitch: -Math.PI / 2 * 0.985, dist: size * 1.4, target: t });
      return true;
    }
    setCloudVisible(on) { if(!on)this.clearSelection();this.cloudVisible = !!on; this.render(); this._notifyCloudChanged(); return this.cloudVisible; }
    setAIHighlight(on) { this.showAI = on; this.render(); }

    select(id) {
      // Keep an active isolate stable when the user clicks empty space; otherwise
      // the selected ID becomes null and every non-line object disappears.
      if (this.isolate && !id) { this.render(); return this.selectedId; }
      this.selectedId = id; if (this.isolate) this._applyIsolate(); this.render(); return this.selectedId;
    }
    _elem(id) { const o = this.base.find(o => o.id === id); return o ? o.el : null; }

    // ---------- Phase B tools ----------
    setSection(on) { this.section.on = on; this.render(); }
    setSectionValue(t) { t = Math.max(0, Math.min(1, t)); this.section.t = t; this.section.min[1] = 0; this.section.max[1] = t; this.render(); }
    // Секущий бокс: срез по каждой оси в обе стороны (доли 0..1 габарита).
    // axis: 'x'|'y'|'z'; lo/hi — доли. Точки вне бокса скрыты И защищены от правок.
    setSectionAxis(axis, lo, hi) {
      const a = { x: 0, y: 1, z: 2 }[axis];
      if (a == null) return null;
      lo = Number(lo); hi = Number(hi);
      if (!Number.isFinite(lo) || !Number.isFinite(hi)) throw new RangeError('Границы сечения должны быть конечными числами');
      lo = Math.max(0, Math.min(1, lo)); hi = Math.max(0, Math.min(1, hi));
      if (lo > hi) { const t = lo; lo = hi; hi = t; }
      this.section.min[a] = lo; this.section.max[a] = hi;
      if (a === 1) this.section.t = hi;
      this.render(); return { axis: axis, lo: lo, hi: hi };
    }
    setSectionBox(b) { b = b || {}; const s = this.section; if (b.xmin != null) s.min[0] = b.xmin; if (b.xmax != null) s.max[0] = b.xmax; if (b.ymin != null) s.min[1] = b.ymin; if (b.ymax != null) s.max[1] = b.ymax; if (b.zmin != null) s.min[2] = b.zmin; if (b.zmax != null) s.max[2] = b.zmax; this.render(); return { min: s.min.slice(), max: s.max.slice() }; }
    resetSection() { this.section.min = [0, 0, 0]; this.section.max = [1, 1, 1]; this.section.t = 1; this.render(); return true; }
    // Ортографический вид, перпендикулярный плоскости сечения. axis — нормаль
    // плоскости: Y=план, Z=фасад, X=боковой вид.
    setSectionView(axis) {
      if (!['x', 'y', 'z'].includes(axis) || !this.bbox || !this.canvas) return false;
      const b = this.bbox, asp = (this.canvas.clientWidth || this.canvas.width || 800) / Math.max(1, this.canvas.clientHeight || this.canvas.height || 600);
      const center = b.mn.map((v, i) => (v + b.mx[i]) * 0.5);
      const axes = axis === 'y' ? [0, 2] : (axis === 'z' ? [0, 1] : [2, 1]);
      const width = Math.max(1e-3, b.mx[axes[0]] - b.mn[axes[0]]);
      const height = Math.max(1e-3, b.mx[axes[1]] - b.mn[axes[1]]);
      const halfHeight = Math.max(height * 0.5, width / (2 * Math.max(asp, 1e-3))) * 1.15;
      const dist = halfHeight / Math.max(1e-3, Math.tan((this._fov || Math.PI / 4) * 0.5));
      const view = axis === 'y'
        ? { yaw: 0, pitch: -Math.PI / 2 * 0.985 }
        : (axis === 'z' ? { yaw: 0, pitch: -0.02 } : { yaw: Math.PI / 2, pitch: -0.02 });
      this._ortho = true;
      this._tweenTo({ yaw: view.yaw, pitch: view.pitch, dist: dist, target: center });
      return true;
    }
    // ===== FARO-подобное «Выделить объект срезом»: срез → умный захват → сохранение как модели =====
    // Задаёт один тонкий срез по выбранной оси; остальные оси снова открыты полностью.
    // Это важно при переключении «горизонталь / вертикаль»: старый срез не должен
    // случайно превратить новый в пересечение двух полос.
    sliceSetup(axis, lo, hi) {
      const a = { x: 0, y: 1, z: 2 }[axis];
      if (a == null) return null;
      lo = Number(lo); hi = Number(hi);
      if (!Number.isFinite(lo) || !Number.isFinite(hi)) throw new RangeError('Границы среза должны быть конечными числами');
      lo = Math.max(0, Math.min(1, lo)); hi = Math.max(0, Math.min(1, hi));
      if (lo > hi) { const t = lo; lo = hi; hi = t; }
      this.section.on = true;
      this.section.min = [0, 0, 0]; this.section.max = [1, 1, 1];
      this.section.min[a] = lo; this.section.max[a] = hi;
      if (a === 1) this.section.t = hi;
      this.render();
      return { axis: axis, lo: lo, hi: hi, bounds: this._clipBounds() };
    }
    // Выделяет ВСЕ точки внутри текущего среза (секущего бокса).
    selectInSlice() {
      const bo = this.base && this.base[0]; if (!bo || !bo.pos) return 0;
      const n = bo.pos.length / 3, sel = new Set(), active = this._clipActive();
      for (let i = 0; i < n; i++) { if (!active || this._pointInClip(i)) sel.add(i); }
      this._sel = sel; this._buildSelHighlight();
      if (typeof this.onEditSelect === 'function') this.onEditSelect(this._sel.size);
      this.render(); return this._sel.size;
    }
    // Умный захват объекта под курсором внутри среза: region-grow (magicWand) без защиты плоскостей,
    // результат ограничивается секущим боксом — берём именно нужный объект, как в FARO.
    smartObjectAt(cx, cy, opts) {
      const bo = this.base && this.base[0]; if (!bo || !bo.pos || !window.PCEdit || !window.PCEdit.magicWand) return 0;
      const seed = this._pickIndex(cx, cy); if (seed < 0) return 0;
      const sp = bo._spacing || 0, voxel = sp > 0 ? sp * 2 : undefined;
      const idx = window.PCEdit.magicWand(seed, bo.pos, bo.pos.length / 3, { voxel: voxel, maxPts: (opts && opts.maxPts) || 800000 });
      this._sel = new Set(this._clipFilter(idx)); this._buildSelHighlight();
      if (typeof this.onEditSelect === 'function') this.onEditSelect(this._sel.size);
      this.render(); return this._sel.size;
    }
    // Region-select (рамкой) для инспектора: выделить прямоугольную область экрана и извлечь попавшие точки как отдельный объект.
    selectRegion(x0c, y0c, x1c, y1c) { this._selStart = [x0c, y0c]; this._selCur = [x1c, y1c]; try { this._finishMarquee(false, false); } catch (e) { return 0; } return this.selectionCount(); }
    extractRegionAsObject(x0c, y0c, x1c, y1c, name) { var n = this.selectRegion(x0c, y0c, x1c, y1c); if (!n) return null; return this.extractSelectionAsObject(name); }
    // Извлекает текущее выделение как ОТДЕЛЬНЫЙ объект-модель, НЕ изменяя исходное облако (недеструктивно).
    extractSelectionAsObject(name) {
      const bo = this.base && this.base[0];
      if (!bo || !bo.pos || !this._sel || !this._sel.size || !window.PCEdit || !window.PCEdit.keepByIndices) return null;
      const r = window.PCEdit.keepByIndices({ pos: bo.pos, col: bo.col || null }, this._sel);
      if (!r || !r.pos || !r.pos.length) return null;
      const count = r.pos.length / 3;
      const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
      for (let i = 0; i < count; i++) { for (let a = 0; a < 3; a++) { const v = r.pos[i * 3 + a]; if (v < mn[a]) mn[a] = v; if (v > mx[a]) mx[a] = v; } }
      this._objects = this._objects || []; this._objSeq = (this._objSeq || 0) + 1;
      const meta = {};
      if (this._srcXform && (this._srcXform.axis === 'zup' || this._srcXform.axis === 'yup') && this._srcXform.t && this._srcXform.t.length >= 3) {
        meta.srcXform = { axis: this._srcXform.axis, t: Array.prototype.slice.call(this._srcXform.t, 0, 3).map(Number) };
      }
      if (this._srcCrs) meta.crsWkt = this._srcCrs;
      const obj = { id: 'obj-' + this._objSeq, name: name || ('Объект ' + this._objSeq), pos: r.pos, col: r.col || null, count: count, bbox: { mn: mn, mx: mx }, meta: meta };
      this._objects.push(obj);
      return { id: obj.id, name: obj.name, count: obj.count, bbox: obj.bbox };
    }
    getExtractedObjects() { return (this._objects || []).map(o => ({ id: o.id, name: o.name, count: o.count, bbox: o.bbox })); }
    getExtractedObjectCloud(id) { const x = (this._objects || []).find(o => o.id === id); return x ? { pos: x.pos, col: x.col, count: x.count, meta: x.meta ? Object.assign({}, x.meta, { srcXform: x.meta.srcXform ? { axis: x.meta.srcXform.axis, t: x.meta.srcXform.t.slice() } : undefined }) : {} } : null; }
    removeExtractedObject(id) { const A = this._objects || []; const i = A.findIndex(o => o.id === id); if (i >= 0) { A.splice(i, 1); return true; } return false; }
    clearExtractedObjects() { this._objects = []; return true; }
    // Открыть извлечённый объект как активную модель (можно измерять/чистить/экспортировать как обычное облако).
    loadExtractedObjectAsCloud(id) {
      const o = this.getExtractedObjectCloud(id); if (!o) return false;
      if (this.resetSection) this.resetSection(); if (this.setSection) this.setSection(false);
      this.loadCloud({ pos: o.pos, col: o.col, count: o.count, meta: o.meta || {} }, { preserveView: true });
      return true;
    }
    _clipBounds() {
      const b=this.bbox,s=this.section;if(!b||!s)return null;
      const L=(a,z,f)=>a+(z-a)*f;
      const mn=s.on?b.mn.map((a,i)=>L(a,b.mx[i],s.min[i])):b.mn.slice();
      const mx=s.on?b.mx.map((a,i)=>L(b.mn[i],a,s.max[i])):b.mx.slice();
      if(this._heightFilter()){mn[1]=Math.max(mn[1],this._cloudDisplay.min);mx[1]=Math.min(mx[1],this._cloudDisplay.max);}
      return {mn,mx};
    }
    _pointInClip(i) { if (this.cloudVisible===false || (this._cloudDisplay&&this._cloudDisplay.opacity===0)) return false; if (!this._clipActive()) return true; const b = this._clipBounds(); if (!b) return true; const bo = this.base && this.base[0]; if (!bo || !bo.pos) return true; const p = bo.pos, x = p[i * 3], y = p[i * 3 + 1], z = p[i * 3 + 2]; return x >= b.mn[0] && x <= b.mx[0] && y >= b.mn[1] && y <= b.mx[1] && z >= b.mn[2] && z <= b.mx[2]; }
    _clipFilter(idx) { if (!this._clipActive() && this.cloudVisible!==false && !(this._cloudDisplay&&this._cloudDisplay.opacity===0)) return idx; const out = []; for (const i of idx) if (this._pointInClip(i)) out.push(i); return out; }
    // Выполняет операцию правки (очистку) ТОЛЬКО над точками внутри секущего бокса;
    // всё, что срезано (вне бокса), сохраняется нетронутым и возвращается при сбросе среза.
    _applyEditOp(runFn) {
      const bo = this.base && this.base[0]; if (!bo || !bo.pos) return null;
      const P = bo.pos, C = bo.col || null; const n = P.length / 3;
      const attrs = _editAttrsFor(this, bo);
      const active = this._clipActive(); const b = active ? this._clipBounds() : null;
      if (!b) return runFn(Object.assign({ pos: P, col: C }, attrs));
      const mn = b.mn, mx = b.mx; const inside = new Uint8Array(n); const inIdx = []; let outCount = 0;
      for (let i = 0; i < n; i++) { const x = P[i * 3], y = P[i * 3 + 1], z = P[i * 3 + 2]; if (x >= mn[0] && x <= mx[0] && y >= mn[1] && y <= mx[1] && z >= mn[2] && z <= mx[2]) { inside[i] = 1; inIdx.push(i); } else outCount++; }
      const inN = inIdx.length;
      if (!inN) return Object.assign({ pos: P, col: C, removed: 0 }, attrs);
      const inPos = new Float32Array(inN * 3);
      const inCol = C ? new C.constructor(inN * 3) : null;
      for (let j = 0; j < inN; j++) {
        const i = inIdx[j]; inPos[j * 3] = P[i * 3]; inPos[j * 3 + 1] = P[i * 3 + 1]; inPos[j * 3 + 2] = P[i * 3 + 2];
        if (C) { inCol[j * 3] = C[i * 3]; inCol[j * 3 + 1] = C[i * 3 + 1]; inCol[j * 3 + 2] = C[i * 3 + 2]; }
      }
      const inAttrs = {};
      EDIT_POINT_ATTRIBUTES.forEach(function (key) { inAttrs[key] = _subsetPointAttribute(attrs[key], inIdx); });
      const r = runFn(Object.assign({ pos: inPos, col: inCol }, inAttrs)); if (!r || !r.pos) return r;
      const keptIn = r.pos.length / 3; const total = outCount + keptIn;
      const mPos = new Float32Array(total * 3);
      const mCol = (C && r.col) ? new C.constructor(total * 3) : null;
      const mergedAttrs = {};
      EDIT_POINT_ATTRIBUTES.forEach(function (key) {
        const original = attrs[key], kept = r[key];
        if (!original && !kept) { mergedAttrs[key] = null; return; }
        if (!original || !kept || kept.length !== keptIn) { mergedAttrs[key] = null; return; }
        const merged = new original.constructor(total);
        let dst = 0;
        for (let i = 0; i < n; i++) if (!inside[i]) merged[dst++] = original[i];
        merged.set(kept, dst);
        mergedAttrs[key] = merged;
      });
      let w = 0;
      for (let i = 0; i < n; i++) {
        if (inside[i]) continue;
        mPos[w * 3] = P[i * 3]; mPos[w * 3 + 1] = P[i * 3 + 1]; mPos[w * 3 + 2] = P[i * 3 + 2];
        if (mCol) { mCol[w * 3] = C[i * 3]; mCol[w * 3 + 1] = C[i * 3 + 1]; mCol[w * 3 + 2] = C[i * 3 + 2]; }
        w++;
      }
      for (let j = 0; j < keptIn; j++) {
        mPos[w * 3] = r.pos[j * 3]; mPos[w * 3 + 1] = r.pos[j * 3 + 1]; mPos[w * 3 + 2] = r.pos[j * 3 + 2];
        if (mCol) { mCol[w * 3] = r.col[j * 3]; mCol[w * 3 + 1] = r.col[j * 3 + 1]; mCol[w * 3 + 2] = r.col[j * 3 + 2]; }
        w++;
      }
      return Object.assign({ pos: mPos, col: mCol, removed: r.removed, removedPos: r.removedPos, removedCol: r.removedCol,
        removedAttributes: r.removedAttributes || {} }, mergedAttrs);
    }
    setIsolate(on) {
      on = !!on;
      if (on && !this.selectedId) { this.isolate = false; this._applyIsolate(); this.render(); return false; }
      this.isolate = on; this._applyIsolate(); this.render(); return true;
    }
    _applyIsolate() { for (const o of this.base) { if (o.line) { o.hidden = false; continue; } if (!this.isolate) o.hidden = false; else o.hidden = !(o.id && o.id === this.selectedId); } }
    supportsLOD() {
      const f = this._modelFull, p = f && f.pos, n = f && f.nor;
      return !!(p && n && p.length >= 18 && p.length % 9 === 0 && n.length === p.length);
    }
    setLOD(on) {
      on = !!on;
      if (on && !this.supportsLOD()) { this.lod = false; return false; }
      this.lod = on;
      if (!this._modelFull) { this.render(); return !on; }
      const f = this._modelFull, baseCol = f.col ? hex2rgb('#9aa6bb') : hex2rgb('#8f9bb0');
      if (!on) this._setBase([{ id: null, pos: f.pos, nor: f.nor, col: f.col || null, color: baseCol, status: 'none' }]);
      else {
        const keep = [], kn = [], kc = f.col ? [] : null;
        for (let t = 0; t < f.pos.length / 9; t++) {
          if (t % 2) continue;
          for (let j = 0; j < 9; j++) { keep.push(f.pos[t * 9 + j]); kn.push(f.nor[t * 9 + j]); if (kc) kc.push(f.col[t * 9 + j]); }
        }
        this._setBase([{ id: null, pos: new Float32Array(keep), nor: new Float32Array(kn), col: kc ? new Float32Array(kc) : null, color: baseCol, status: 'none' }]);
      }
      this.render(); return true;
    }
    setMeasure(on) { this.measuring = on; try { this.canvas.style.cursor = on ? 'crosshair' : 'grab'; } catch (e) {} if (!on) { this._clearMeasure(); this._showMeasLabels(false); this._setHoverPoint(null); this._hideLoupe(); } this.render(); }
    // Живой предпросмотр точки-снапа под курсором (как выбор точки в CloudCompare)
    _hoverMeasure(cx, cy) {
      // Window mousemove also fires over menus. Never pick or magnify UI controls.
      if (document.elementFromPoint(cx, cy) !== this.canvas) { this._hideLoupe(); this._setHoverPoint(null); if (this.smartMeasure && (this.measureMode || 'distance') === 'distance' && this.measurePts.length === 1) this._smartDistancePreview(null); return; }
      this._hoverXY = [cx, cy];
      if (this._hoverRAF) return;
      const raf = (typeof requestAnimationFrame === 'function') ? requestAnimationFrame : (f) => setTimeout(f, 16);
      this._hoverRAF = raf(() => {
        this._hoverRAF = 0;
        if (!this.measuring) { this._setHoverPoint(null); this._hideLoupe(); return; }
        const xy = this._hoverXY; const hit = this._pick(xy[0], xy[1]);
        this._setHoverPoint(hit ? hit.point : null);
        this._drawLoupe(xy[0], xy[1], hit ? hit.point : null);
        if (this.smartMeasure && (this.measureMode || 'distance') === 'distance' && this.measurePts.length === 1) { const pv = hit ? this._smartAxisLock(this.measurePts[0], hit.point) : null; this._smartDistancePreview(pv); }
      });
    }
    _setHoverPoint(pt) {
      if (this._hoverObj) { this._delObjs([this._hoverObj]); this._hoverObj = null; }
      if (pt) this._hoverObj = this._makeObj({ id: null, points: true, pos: new Float32Array([pt[0], pt[1], pt[2]]), col: null, pointSize: 22, color: hex2rgb('#39d98a'), status: 'none', _isSel: true, _spacing: 0, _ptMax: 28 });
      this.render();
    }
    // ---------- Лупа-увеличитель для точного прицеливания при измерении (как AccuSnap/CloudCompare) ----------
    _ensureLoupe() {
      if (this._loupe) return this._loupe;
      const size = 190; const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
      const wrap = document.createElement('div');
      wrap.className = 'meas-loupe';
      wrap.style.cssText = 'position:fixed;width:' + size + 'px;height:' + size + 'px;border-radius:50%;overflow:hidden;pointer-events:none;z-index:40;display:none;border:2px solid rgba(120,170,255,.9);box-shadow:0 6px 20px rgba(0,0,0,.55);background:#0b0e14;';
      const cv = document.createElement('canvas');
      cv.width = Math.round(size * dpr); cv.height = Math.round(size * dpr);
      cv.style.cssText = 'width:' + size + 'px;height:' + size + 'px;display:block;';
      wrap.appendChild(cv);
      (document.body || document.documentElement).appendChild(wrap);
      this._loupe = { wrap, cv, ctx: cv.getContext('2d'), dpr, size, zoom: 5 };
      return this._loupe;
    }
    _hideLoupe() { if (this._loupe) this._loupe.wrap.style.display = 'none'; }
    setLoupeZoom(z) { const L = this._ensureLoupe(); L.zoom = Math.max(2, Math.min(12, +z || 5)); return L.zoom; }
    _drawLoupe(cx, cy, snapPt) {
      if (!this.measuring || document.elementFromPoint(cx, cy) !== this.canvas) { this._hideLoupe(); return; }
      const L = this._ensureLoupe(); const ctx = L.ctx; const out = L.cv.width;
      const rect = this.canvas.getBoundingClientRect();
      const px = (cx - rect.left) * (this.canvas.width / rect.width);
      const py = (cy - rect.top) * (this.canvas.height / rect.height);
      const srcPx = out / L.zoom;
      ctx.imageSmoothingEnabled = false;
      ctx.fillStyle = '#0b0e14'; ctx.fillRect(0, 0, out, out);
      try { ctx.drawImage(this.canvas, px - srcPx / 2, py - srcPx / 2, srcPx, srcPx, 0, 0, out, out); } catch (e) {}
      const c = out / 2, u = L.dpr;
      // перекрестие в центре (позиция курсора)
      ctx.strokeStyle = 'rgba(255,80,120,.95)'; ctx.lineWidth = Math.max(1, u);
      ctx.beginPath();
      ctx.moveTo(c - 16 * u, c); ctx.lineTo(c - 5 * u, c); ctx.moveTo(c + 5 * u, c); ctx.lineTo(c + 16 * u, c);
      ctx.moveTo(c, c - 16 * u); ctx.lineTo(c, c - 5 * u); ctx.moveTo(c, c + 5 * u); ctx.lineTo(c, c + 16 * u);
      ctx.stroke();
      ctx.beginPath(); ctx.arc(c, c, 3 * u, 0, Math.PI * 2); ctx.strokeStyle = 'rgba(255,255,255,.95)'; ctx.stroke();
      // позиционируем лупу рядом с курсором, удерживая её в пределах окна
      let lx = cx + 24, ly = cy - L.size - 14;
      if (lx + L.size + 8 > window.innerWidth) lx = cx - L.size - 24;
      if (lx < 4) lx = 4;
      if (ly < 4) ly = cy + 24;
      if (ly + L.size + 8 > window.innerHeight) ly = window.innerHeight - L.size - 8;
      L.wrap.style.left = lx + 'px'; L.wrap.style.top = ly + 'px'; L.wrap.style.display = 'block';
    }
    // Режим измерения: 'point' | 'distance' | 'polyline' | 'angle' | 'area' | 'plane'
    setMeasureMode(mode) {
      const ok = ['point', 'distance', 'polyline', 'angle', 'area', 'plane', 'deviation', 'corner'];
      this.measureMode = ok.indexOf(mode) >= 0 ? mode : 'distance';
      this._measRefPlane = null;
      this._clearMeasure();
      this.render();
      return this.measureMode;
    }
    // Привязка (snap) точки клика к ребру/углу/плоскости.
    setMeasureSnap(on) { this.measureSnap = !!on; return this.measureSnap; }
    // Применить snap к точке, если включено: уточняет положение по локальной геометрии.
    _applySnap(pt) {
      const Me = (typeof window !== 'undefined' && window.Measure);
      if (!this.measureSnap || !Me) return { point: pt.slice(), kind: 'raw' };
      const r = this._measSnapRadius || this._sceneDiag() * 0.02;
      const pts = this._gatherNeighborhood(pt, r);
      if (pts.length < 6) return { point: pt.slice(), kind: 'raw' };
      const s = Me.snapToFeature(pt, pts);
      return { point: (s.point.slice ? s.point.slice() : s.point), kind: s.kind };
    }
    _clearMeasure() { this.measurePts = []; this._measResult = null; this._measLabels = []; this._measPlane = null; this._measCornerPlanes = null; this._setOverlay([]); this._renderMeasLabels(); }
    _sceneDiag() { const c = this.bbox; return Math.hypot(c.mx[0] - c.mn[0], c.mx[1] - c.mn[1], c.mx[2] - c.mn[2]) || 8; }

    // Сбор локальной окрестности точек вокруг seed в радиусе r (для подгонки плоскости).
    _gatherNeighborhood(seed, r) {
      const bo = this.base && this.base[0];
      if (!bo || !bo.points || !bo.pos) return [];
      const P = bo.pos, n = P.length / 3, r2 = r * r;
      const stride = n > 1500000 ? Math.ceil(n / 1500000) : 1; // ограничиваем работу на огромных облаках (не виснет при расстановке точек)
      const out = [], cap = 60000;
      for (let pi = 0; pi < n; pi += stride) {
        const i = pi * 3, dx = P[i] - seed[0], dy = P[i + 1] - seed[1], dz = P[i + 2] - seed[2];
        if (dx * dx + dy * dy + dz * dz <= r2) { out.push([P[i], P[i + 1], P[i + 2]]); if (out.length >= cap) break; }
      }
      return out;
    }

    // Клик в режиме измерения: накапливаем точки и пересчитываем результат.
    _measureClick(pt) {
      const mode = this.measureMode || 'distance';
      if (mode === 'plane') { this._fitPlaneAt(pt); this._buildMeasure(); this.render(); return; }
      if (mode === 'deviation') { this._deviationClick(pt); this._buildMeasure(); this.render(); return; }
      if (mode === 'corner') { this._cornerClick(pt); this._buildMeasure(); this.render(); return; }
      // привязка к ребру/углу/плоскости (если включена)
      const snapped = this._applySnap(pt);
      // режимы с фиксированным числом точек — начинаем заново после завершения
      const limit = mode === 'point' ? 1 : mode === 'distance' ? 2 : mode === 'angle' ? 3 : Infinity;
      if (this.measurePts.length >= limit) this.measurePts = [];
      let placePt = snapped.point;
      // умное расстояние: 2-ю точку притягиваем к чистой вертикали/горизонтали, если направление близко к оси
      if (this.smartMeasure && mode === 'distance' && this.measurePts.length === 1) placePt = this._smartAxisLock(this.measurePts[0], placePt);
      this.measurePts.push(placePt);
      this._lastSnapKind = snapped.kind;
      this._computeMeasure();
      this._buildMeasure();
      this.render();
    }

    // Режим «точка → плоскость»: 1-й клик — опорная плоскость (RANSAC), дальше — зазор/отклонение.
    _deviationClick(pt) {
      const Me = (typeof window !== 'undefined' && window.Measure); if (!Me) return;
      if (!this._measRefPlane) {
        const r = this._measPlaneRadius || this._sceneDiag() * 0.05;
        const pts = this._gatherNeighborhood(pt, r);
        if (pts.length < 8) { this._measResult = { mode: 'deviation', error: 'Мало точек для опорной плоскости — кликните по ровной поверхности' }; if (this.onMeasure) this.onMeasure(this._measResult); return; }
        const pl = Me.ransacPlane(pts, { iters: 300 });
        if (!pl) { this._measResult = { mode: 'deviation', error: 'Не удалось подобрать опорную плоскость' }; return; }
        this._measRefPlane = pl;
        this._measPlane = { plane: pl, ext: Me.planeExtents(pl.inliers && pl.inliers.length >= 3 ? pl.inliers : pts, pl) };
        this.measurePts = [pt.slice()];
        this._measResult = { mode: 'deviation', ready: true, rms: pl.rms, inlierCount: pl.inlierCount, total: pl.total };
        if (this.onMeasure) this.onMeasure(this._measResult);
        return;
      }
      // опорная плоскость есть — меряем зазор до кликнутой точки
      const sp = this._applySnap(pt);
      const dv = Me.signedPointPlane(sp.point, this._measRefPlane);
      this.measurePts = [this._measRefPlane.centroid.slice(), dv.foot, sp.point];
      this._measResult = { mode: 'deviation', signed: dv.signed, distance: dv.distance, sign: dv.sign, foot: dv.foot, point: sp.point, refRms: this._measRefPlane.rms };
      if (this.onMeasure) this.onMeasure(this._measResult);
    }

    // Подгонка плоскости RANSAC вокруг точки клика → возвращает {plane, ext} или null.
    _fitPlaneRansacAt(pt) {
      const Me = (typeof window !== 'undefined' && window.Measure); if (!Me) return null;
      const r = this._measPlaneRadius || this._sceneDiag() * 0.05;
      const pts = this._gatherNeighborhood(pt, r);
      if (pts.length < 8) return null;
      const pl = Me.ransacPlane(pts, { iters: 300 });
      if (!pl) return null;
      const ext = Me.planeExtents(pl.inliers && pl.inliers.length >= 3 ? pl.inliers : pts, pl);
      return { plane: pl, ext: ext };
    }

    // Режим «Ребро/Угол»: кликни по 2 плоскостям → точное ребро (пересечение) + двугранный угол;
    // 3-й клик по третьей плоскости → точная точка угла комнаты (пересечение трёх плоскостей).
    _cornerClick(pt) {
      const Me = (typeof window !== 'undefined' && window.Measure); if (!Me) return;
      if (!this._measCornerPlanes || this._measCornerPlanes.length >= 3) this._measCornerPlanes = [];
      const fit = this._fitPlaneRansacAt(pt);
      if (!fit) { this._measResult = { mode: 'corner', error: 'Мало точек рядом — кликните по ровной стене/потолку/полу' }; if (this.onMeasure) this.onMeasure(this._measResult); return; }
      this._measCornerPlanes.push(fit);
      this.measurePts = this._measCornerPlanes.map(f => f.plane.centroid.slice());
      const planes = this._measCornerPlanes.map(f => f.plane);
      const n = planes.length;
      if (n === 1) {
        this._measResult = { mode: 'corner', planeCount: 1, ready: true, rms: fit.plane.rms };
      } else if (n === 2) {
        const line = Me.intersectPlanes(planes[0], planes[1]);
        const ang = Me.angleBetweenPlanes(planes[0], planes[1]);
        if (!line) { this._measResult = { mode: 'corner', planeCount: 2, error: 'Плоскости почти параллельны — ребро не определено' }; }
        else { this._measCornerLine = line; this._measResult = { mode: 'corner', planeCount: 2, angleDeg: ang.deg, dir: line.dir.slice(), linePoint: line.point.slice() }; }
      } else {
        const corner = Me.intersectThreePlanes(planes[0], planes[1], planes[2]);
        const ang = Me.angleBetweenPlanes(planes[0], planes[1]);
        const line = Me.intersectPlanes(planes[0], planes[1]);
        if (line) this._measCornerLine = line;
        if (!corner) { this._measResult = { mode: 'corner', planeCount: 3, error: 'Плоскости вырождены — точка угла не определена' }; }
        else { this._measCornerPt = corner.point.slice(); this._measResult = { mode: 'corner', planeCount: 3, corner: corner.point.slice(), angleDeg: ang.deg, dir: (line ? line.dir.slice() : null) }; }
      }
      if (this.onMeasure) this.onMeasure(this._measResult);
    }

    // Завершить накопительный режим (полилиния/площадь) — начать следующее измерение.
    finishMeasure() { this.measurePts = []; this.render(); }

    _fitPlaneAt(seed) {
      const Me = (typeof window !== 'undefined' && window.Measure); if (!Me) return;
      const r = this._measPlaneRadius || this._sceneDiag() * 0.05;
      const pts = this._gatherNeighborhood(seed, r);
      if (pts.length < 8) { this._measResult = { mode: 'plane', error: 'Мало точек рядом — приблизьтесь или кликните по поверхности' }; this.measurePts = [seed.slice()]; if (this.onMeasure) this.onMeasure(this._measResult); return; }
      const pl = Me.ransacPlane(pts, { iters: 300 });
      if (!pl) { this._measResult = { mode: 'plane', error: 'Не удалось подобрать плоскость' }; return; }
      const ext = Me.planeExtents(pl.inliers && pl.inliers.length >= 3 ? pl.inliers : pts, pl);
      const ori = Me.orientation(pl.normal);
      this._measPlane = { plane: pl, ext: ext };
      this.measurePts = [seed.slice()];
      this._measResult = {
        mode: 'plane', seed: seed.slice(), normal: pl.normal, centroid: pl.centroid,
        rms: pl.rms, inlierCount: pl.inlierCount, total: pl.total, coverage: pl.coverage,
        length: ext.length, width: ext.width, rectArea: ext.rectArea,
        dip: ori.dip, azimuth: ori.azimuth, kind: ori.kind, radius: r
      };
      if (this.onMeasure) this.onMeasure(this._measResult);
    }

    // ---------- «Умное» измерение расстояния: живые направляющие + привязка к осям ----------
    // Робастная высота потолка сцены (95-й перцентиль Y), зеркально _robustFloorY().
    _robustCeilingY() {
      const bo = this.base && this.base[0]; const c = this.bbox;
      if (!bo || !bo.pos || !bo.pos.length) return c ? c.mx[1] : 3;
      const P = bo.pos, n = P.length / 3, step = Math.max(1, Math.floor(n / 120000)), ys = [];
      for (let i = 0; i < n; i += step) ys.push(P[i * 3 + 1]);
      if (!ys.length) return c ? c.mx[1] : 3;
      ys.sort((a, b) => a - b);
      return ys[Math.floor(ys.length * 0.95)];
    }
    _smartFloorCeil() { return { floorY: this._robustFloorY(), ceilY: this._robustCeilingY() }; }
    // Притягивает вторую точку к чистой вертикали/горизонтали, если направление близко к оси —
    // так меряется реальная высота/пролёт (как в жизни), а не косой отрезок. Иначе оставляет как есть.
    _smartAxisLock(a, p) {
      if (!a || !p) return p;
      const dx = p[0] - a[0], dy = p[1] - a[1], dz = p[2] - a[2];
      const L = Math.hypot(dx, dy, dz); if (L < 1e-6) return (p.slice ? p.slice() : [p[0], p[1], p[2]]);
      const horiz = Math.hypot(dx, dz);
      const tol = Math.sin((this._smartAxisTolDeg || 10) * Math.PI / 180);
      if (horiz / L < tol) return [a[0], p[1], a[2]];        // близко к вертикали → чистая высота
      if (Math.abs(dy) / L < tol) return [p[0], a[1], p[2]]; // близко к горизонтали → чистый план
      return [p[0], p[1], p[2]];
    }
    _mkLine(a, b, color) { return { line: true, pos: new Float32Array([a[0], a[1], a[2], b[0], b[1], b[2]]), color: color }; }
    // Направляющие через первую точку: вертикаль до пола/потолка + горизонтали по X и Z до границ сцены.
    _addSmartGuides(objs, a) {
      const fc = this._smartFloorCeil(), c = this.bbox;
      objs.push(this._mkLine([a[0], fc.floorY, a[2]], [a[0], fc.ceilY, a[2]], [0.22, 0.85, 0.5])); // вертикаль (пол↔потолок)
      if (c) {
        objs.push(this._mkLine([c.mn[0], a[1], a[2]], [c.mx[0], a[1], a[2]], [1, 0.5, 0.2]));       // горизонталь по X до границ
        objs.push(this._mkLine([a[0], a[1], c.mn[2]], [a[0], a[1], c.mx[2]], [0.3, 0.6, 1]));       // горизонталь по Z до границ
      }
    }
    // Ступенька-разложение отрезка a→b: горизонтальный катет + вертикальный катет (ΔH и ΔV).
    _addDistanceDecomp(objs, a, b) {
      const knee = [b[0], a[1], b[2]];
      objs.push(this._mkLine(a, knee, [1, 0.6, 0.25]));   // горизонтальный катет
      objs.push(this._mkLine(knee, b, [0.35, 0.8, 1]));   // вертикальный катет
    }
    _pushSmartGuideLabels(labels, a, Me) {
      const fc = this._smartFloorCeil();
      labels.push({ p: [a[0], (a[1] + fc.floorY) / 2, a[2]], t: 'до пола ' + Me.fmtLen(a[1] - fc.floorY) });
      labels.push({ p: [a[0], (a[1] + fc.ceilY) / 2, a[2]], t: 'до потолка ' + Me.fmtLen(fc.ceilY - a[1]) });
    }
    _pushDistanceCompLabels(labels, a, b, Me) {
      const d = Me.distance(a, b), knee = [b[0], a[1], b[2]];
      labels.push({ p: [(a[0] + knee[0]) / 2, (a[1] + knee[1]) / 2, (a[2] + knee[2]) / 2], t: 'гор ' + Me.fmtLen(d.horizontal) });
      labels.push({ p: [(knee[0] + b[0]) / 2, (knee[1] + b[1]) / 2, (knee[2] + b[2]) / 2], t: 'верт ' + Me.fmtLen(d.vertical) });
    }
    // Живой предпросмотр при наведении, когда стоит одна точка: направляющие + линия к курсору + размеры.
    _smartDistancePreview(previewPt) {
      if (!this.measurePts || this.measurePts.length !== 1) return;
      const Me = (typeof window !== 'undefined' && window.Measure);
      const a = this.measurePts[0], objs = [];
      this._addSmartGuides(objs, a);
      const marks = [a[0], a[1], a[2]];
      if (previewPt) {
        objs.push(this._mkLine(a, previewPt, [0.1, 0.85, 0.9]));
        this._addDistanceDecomp(objs, a, previewPt);
        marks.push(previewPt[0], previewPt[1], previewPt[2]);
      }
      objs.push({ points: true, pos: new Float32Array(marks), col: null, color: hex2rgb('#2f6bff'), pointSize: 15, status: 'none', _isSel: true, _spacing: 0, _ptMax: 22 });
      this._setOverlay(objs);
      const labels = [];
      if (Me) {
        this._pushSmartGuideLabels(labels, a, Me);
        if (previewPt) { labels.push({ p: [(a[0] + previewPt[0]) / 2, (a[1] + previewPt[1]) / 2, (a[2] + previewPt[2]) / 2], t: Me.fmtLen(Me.dist3(a, previewPt)) }); this._pushDistanceCompLabels(labels, a, previewPt, Me); }
      }
      this._measLabels = labels; this._renderMeasLabels(); this.render();
    }

    _computeMeasure() {
      const Me = (typeof window !== 'undefined' && window.Measure);
      const P = this.measurePts, mode = this.measureMode;
      let res = null;
      if (mode === 'point' && P.length >= 1) res = { mode: 'point', point: P[0].slice() };
      else if (mode === 'distance' && P.length >= 2 && Me) { const d = Me.distance(P[0], P[1]); res = Object.assign({ mode: 'distance', a: P[0], b: P[1] }, d); }
      else if (mode === 'polyline' && P.length >= 2 && Me) { const r = Me.polylineLength(P, false); res = { mode: 'polyline', pts: P.slice(), total: r.total, segments: r.segments, count: P.length }; }
      else if (mode === 'angle' && P.length >= 3 && Me) { const a = Me.angleAt(P[0], P[1], P[2]); res = { mode: 'angle', a: P[0], b: P[1], c: P[2], deg: a.deg, lenA: a.lenA, lenC: a.lenC }; }
      else if (mode === 'area' && P.length >= 3 && Me) { const r = Me.polygonArea3D(P); res = { mode: 'area', pts: P.slice(), area: r.area, perimeter: r.perimeter, normal: r.normal, count: P.length }; }
      this._measResult = res;
      if (res && this.onMeasure) this.onMeasure(res);
    }

    _buildMeasure() {
      const objs = []; const s = this._sceneDiag() * 0.006; const P = this.measurePts;
      const col = hex2rgb('#2f6bff'), lineCol = [0.18, 0.42, 1];
      // Маркеры точек измерения — постоянный небольшой размер на экране (как пикеты в CloudCompare),
      // а НЕ 3D-кубы, растущие вместе с размером сцены (на больших сканах кубы огромные).
      const markPts = [];
      const mk = p => { markPts.push(p[0], p[1], p[2]); };
      P.forEach(mk);
      const seg = (a, b, c) => objs.push({ line: true, pos: new Float32Array([a[0], a[1], a[2], b[0], b[1], b[2]]), color: c || lineCol });
      const mode = this.measureMode;
      if (mode === 'distance') { if (P.length === 2) { seg(P[0], P[1]); if (this.smartMeasure) this._addDistanceDecomp(objs, P[0], P[1]); } else if (P.length === 1 && this.smartMeasure) this._addSmartGuides(objs, P[0]); }
      else if ((mode === 'polyline' || mode === 'angle') && P.length >= 2) { for (let i = 1; i < P.length; i++) seg(P[i - 1], P[i]); }
      else if (mode === 'area' && P.length >= 2) { for (let i = 1; i < P.length; i++) seg(P[i - 1], P[i]); if (P.length >= 3) seg(P[P.length - 1], P[0], [0.12, 0.7, 0.5]); }
      // визуализация подобранной плоскости: ориентированный прямоугольник + нормаль
      if (mode === 'deviation' && this._measPlane && P.length === 3) {
        // перпендикуляр от плоскости (foot) к точке: красный = снаружи, голубой = внутри
        const outward = this._measResult && this._measResult.sign >= 0;
        seg(P[1], P[2], outward ? [1, 0.35, 0.3] : [0.3, 0.7, 1]);
      }
      // визуализация режима «Ребро/Угол»: прямоугольники плоскостей + ребро-пересечение + точка угла
      if (mode === 'corner' && this._measCornerPlanes && this._measCornerPlanes.length) {
        const rectCols = [[0.2, 0.85, 0.45], [0.95, 0.7, 0.15], [0.6, 0.55, 1]];
        this._measCornerPlanes.forEach((f, idx) => {
          const ex = f.ext, c = ex.center3;
          const h1 = [ex.axis1[0] * ex.size1 / 2, ex.axis1[1] * ex.size1 / 2, ex.axis1[2] * ex.size1 / 2];
          const h2 = [ex.axis2[0] * ex.size2 / 2, ex.axis2[1] * ex.size2 / 2, ex.axis2[2] * ex.size2 / 2];
          const cor = [
            [c[0] - h1[0] - h2[0], c[1] - h1[1] - h2[1], c[2] - h1[2] - h2[2]],
            [c[0] + h1[0] - h2[0], c[1] + h1[1] - h2[1], c[2] + h1[2] - h2[2]],
            [c[0] + h1[0] + h2[0], c[1] + h1[1] + h2[1], c[2] + h1[2] + h2[2]],
            [c[0] - h1[0] + h2[0], c[1] - h1[1] + h2[1], c[2] - h1[2] + h2[2]]
          ];
          const pc = rectCols[idx % 3];
          for (let i = 0; i < 4; i++) seg(cor[i], cor[(i + 1) % 4], pc);
        });
        // ребро-пересечение двух плоскостей: яркая линия вдоль dir
        if (this._measCornerPlanes.length >= 2 && this._measCornerLine) {
          const L = this._measCornerLine, half = this._sceneDiag() * 0.12;
          const base = (this._measCornerPt || L.point);
          const a = [base[0] - L.dir[0] * half, base[1] - L.dir[1] * half, base[2] - L.dir[2] * half];
          const b = [base[0] + L.dir[0] * half, base[1] + L.dir[1] * half, base[2] + L.dir[2] * half];
          seg(a, b, [1, 0.25, 0.55]);
        }
        // точка угла (3 плоскости)
        if (this._measCornerPt) objs.push({ points: true, pos: new Float32Array([this._measCornerPt[0], this._measCornerPt[1], this._measCornerPt[2]]), col: null, color: [1, 0.2, 0.45], pointSize: 20, status: 'none', _isSel: true, _spacing: 0, _ptMax: 26 });
      }
      if ((mode === 'plane' || mode === 'deviation') && this._measPlane) {
        const ex = this._measPlane.ext, c = ex.center3;
        const h1 = [ex.axis1[0] * ex.size1 / 2, ex.axis1[1] * ex.size1 / 2, ex.axis1[2] * ex.size1 / 2];
        const h2 = [ex.axis2[0] * ex.size2 / 2, ex.axis2[1] * ex.size2 / 2, ex.axis2[2] * ex.size2 / 2];
        const cor = [
          [c[0] - h1[0] - h2[0], c[1] - h1[1] - h2[1], c[2] - h1[2] - h2[2]],
          [c[0] + h1[0] - h2[0], c[1] + h1[1] - h2[1], c[2] + h1[2] - h2[2]],
          [c[0] + h1[0] + h2[0], c[1] + h1[1] + h2[1], c[2] + h1[2] + h2[2]],
          [c[0] - h1[0] + h2[0], c[1] - h1[1] + h2[1], c[2] - h1[2] + h2[2]]
        ];
        const pc = [0.2, 0.85, 0.45];
        for (let i = 0; i < 4; i++) seg(cor[i], cor[(i + 1) % 4], pc);
        const nrm = this._measPlane.plane.normal, nl = Math.max(ex.length, ex.width) * 0.25;
        seg(c, [c[0] + nrm[0] * nl, c[1] + nrm[1] * nl, c[2] + nrm[2] * nl], [1, 0.55, 0.1]);
      }
      if (markPts.length) objs.push({ points: true, pos: new Float32Array(markPts), col: null, color: col, pointSize: 15, status: 'none', _isSel: true, _spacing: 0, _ptMax: 22 });
      this._setOverlay(objs);
      this._buildMeasLabels();
    }

    // ---------- экранные подписи измерений (DOM-оверлей над canvas) ----------
    _measLayerEl() {
      if (this._mlayer) return this._mlayer;
      const d = document.createElement('div');
      d.style.cssText = 'position:absolute;left:0;top:0;pointer-events:none;z-index:32;overflow:visible;';
      const host = this.canvas.parentElement || document.body;
      try { if (getComputedStyle(host).position === 'static') host.style.position = 'relative'; } catch (e) {}
      host.appendChild(d); this._mlayer = d; return d;
    }
    _showMeasLabels(on) { const d = this._mlayer; if (d) d.style.display = on ? 'block' : 'none'; }
    _buildMeasLabels() {
      const Me = (typeof window !== 'undefined' && window.Measure); if (!Me) { this._measLabels = []; return; }
      const labels = [], P = this.measurePts, mode = this.measureMode;
      const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
      if (mode === 'point' && P.length >= 1) labels.push({ p: P[0], t: 'X ' + P[0][0].toFixed(3) + '  Y ' + P[0][1].toFixed(3) + '  Z ' + P[0][2].toFixed(3) });
      else if (mode === 'distance' && P.length === 2) { labels.push({ p: mid(P[0], P[1]), t: Me.fmtLen(Me.dist3(P[0], P[1])) }); if (this.smartMeasure) this._pushDistanceCompLabels(labels, P[0], P[1], Me); }
      else if (mode === 'distance' && P.length === 1 && this.smartMeasure) this._pushSmartGuideLabels(labels, P[0], Me);
      else if (mode === 'polyline' && P.length >= 2) { let tot = 0; for (let i = 1; i < P.length; i++) { const l = Me.dist3(P[i - 1], P[i]); tot += l; labels.push({ p: mid(P[i - 1], P[i]), t: Me.fmtLen(l) }); } labels.push({ p: P[P.length - 1], t: 'Σ ' + Me.fmtLen(tot) }); }
      else if (mode === 'angle' && P.length >= 3) { const a = Me.angleAt(P[0], P[1], P[2]); labels.push({ p: P[1], t: a.deg.toFixed(1) + '°' }); }
      else if (mode === 'area' && P.length >= 3) { const r = Me.polygonArea3D(P); labels.push({ p: Me.centroid(P), t: Me.fmtArea(r.area) }); }
      else if (mode === 'plane' && this._measResult && !this._measResult.error) { const R = this._measResult; labels.push({ p: (this._measPlane ? this._measPlane.ext.center3 : R.seed), t: Me.fmtLen(R.length) + ' × ' + Me.fmtLen(R.width) + '  · ' + R.kind }); }
      else if (mode === 'deviation' && this._measResult && this._measResult.signed !== undefined && P.length === 3) { const R = this._measResult; labels.push({ p: [(P[1][0] + P[2][0]) / 2, (P[1][1] + P[2][1]) / 2, (P[1][2] + P[2][2]) / 2], t: (R.sign >= 0 ? '+' : '−') + Me.fmtLen(R.distance) + ' (' + (R.sign >= 0 ? 'снаружи' : 'внутри') + ')' }); }
      else if (mode === 'corner' && this._measResult && !this._measResult.error) {
        const R = this._measResult;
        if (R.angleDeg != null && this._measCornerLine) { const lp = this._measCornerPt || this._measCornerLine.point; labels.push({ p: lp, t: '∠ ' + R.angleDeg.toFixed(1) + '°' }); }
        if (R.corner) labels.push({ p: R.corner, t: 'Угол  X ' + R.corner[0].toFixed(3) + '  Y ' + R.corner[1].toFixed(3) + '  Z ' + R.corner[2].toFixed(3) });
      }
      this._measLabels = labels;
      this._renderMeasLabels();
    }
    _renderMeasLabels() {
      const d = this._mlayer; if (!d) { if (this._measLabels && this._measLabels.length) this._measLayerEl(); else return; }
      const layer = this._mlayer; if (!layer) return;
      const labels = this._measLabels || [];
      layer.style.display = (this.measuring && labels.length) ? 'block' : 'none';
      while (layer.childNodes.length > labels.length) layer.removeChild(layer.lastChild);
      while (layer.childNodes.length < labels.length) { const s = document.createElement('div'); s.style.cssText = 'position:absolute;transform:translate(-50%,-140%);white-space:nowrap;font:600 12px/1.2 system-ui,Segoe UI,sans-serif;color:#fff;background:rgba(20,40,90,.86);border:1px solid rgba(120,170,255,.7);border-radius:6px;padding:2px 7px;box-shadow:0 2px 6px rgba(0,0,0,.35);'; layer.appendChild(s); }
      const M = this._lastVP; if (!M) return;
      const w = this.canvas.clientWidth || this.canvas.width, h = this.canvas.clientHeight || this.canvas.height;
      const ox = this.canvas.offsetLeft || 0, oy = this.canvas.offsetTop || 0;
      for (let i = 0; i < labels.length; i++) {
        const el = layer.childNodes[i], p = labels[i].p;
        const cw = M[3] * p[0] + M[7] * p[1] + M[11] * p[2] + M[15];
        if (cw <= 0) { el.style.display = 'none'; continue; }
        const nx = (M[0] * p[0] + M[4] * p[1] + M[8] * p[2] + M[12]) / cw;
        const ny = (M[1] * p[0] + M[5] * p[1] + M[9] * p[2] + M[13]) / cw;
        el.style.display = ''; el.textContent = labels[i].t;
        el.style.left = (ox + (nx * 0.5 + 0.5) * w) + 'px';
        el.style.top = (oy + (1 - (ny * 0.5 + 0.5)) * h) + 'px';
      }
    }

    // ---------- standard views (ViewCube) + walk mode ----------
    setStandardView(name) {
      const PV = { front: { yaw: 0, pitch: -0.02 }, back: { yaw: Math.PI, pitch: -0.02 }, right: { yaw: Math.PI / 2, pitch: -0.02 }, left: { yaw: -Math.PI / 2, pitch: -0.02 }, top: { yaw: 0, pitch: 1.45 }, bottom: { yaw: 0, pitch: -1.45 }, iso: { yaw: -0.7, pitch: -0.5 } };
      const v = PV[name] || PV.iso; const c = this.bbox;
      const t = [(c.mn[0] + c.mx[0]) / 2, (c.mn[1] + c.mx[1]) / 2, (c.mn[2] + c.mx[2]) / 2];
      const size = Math.max(c.mx[0] - c.mn[0], c.mx[1] - c.mn[1], c.mx[2] - c.mn[2]) || 8;
      if (this.walk) this.setWalk(false);
      this._tweenTo({ yaw: v.yaw, pitch: v.pitch, dist: size * 1.7, target: t });
    }
    zoomBy(f) { this._stopTween(); this.dist = Math.max(1e-4, Math.min(6000, this.dist * f)); this.render(); }
    _robustFloorY() {
      const bo = this.base && this.base[0];
      const c = this.bbox;
      if (!bo || !bo.pos || !bo.pos.length) return c ? c.mn[1] : 0;
      const P = bo.pos; const n = P.length / 3;
      const step = Math.max(1, Math.floor(n / 120000));
      const ys = [];
      for (let i = 0; i < n; i += step) ys.push(P[i * 3 + 1]);
      if (!ys.length) return c ? c.mn[1] : 0;
      ys.sort((a, b) => a - b);
      return ys[Math.floor(ys.length * 0.05)];   // 5-й перцентиль высоты ~ пол сцены без выбросов-точек под моделью
    }
    setWalk(on) {
      this.walk = !!on;
      if (on) {
        if (this.tour) this.setTour(false);
        this.setPhoto(true);
        this._preWalk = { yaw: this.yaw, pitch: this.pitch, dist: this.dist, target: this.target.slice() };
        const c = this.bbox; const cx = (c.mn[0] + c.mx[0]) / 2, cz = (c.mn[2] + c.mx[2]) / 2;
        const h = (c.mx[1] - c.mn[1]) || 3;
        const eyeY = this._robustFloorY() + Math.max(1.2, Math.min(1.7, h * 0.1));   // высота глаз ОТНОСИТЕЛЬНО пола сцены (в её координатах), а не абсолютные 1.6 — иначе камера уходила под модель
        this.target = [cx, eyeY, cz]; this.dist = 0.35; this.pitch = -0.02;
        this._walkKeys = {}; this._walkRAF = false;
        if (!this._walkBound) {
          this._walkBound = true;
          const CODES = { KeyW: 'w', KeyA: 'a', KeyS: 's', KeyD: 'd', KeyQ: 'q', KeyE: 'e', ArrowUp: 'w', ArrowDown: 's', ArrowLeft: 'a', ArrowRight: 'd', Space: 'e' };   // по e.code — работает при любой раскладке (кириллица/латиница)
          this._onKeyDown = e => { if (!this.walk) return; this._run = e.shiftKey; const c2 = CODES[e.code]; if (!c2) return; this._walkKeys[c2] = true; e.preventDefault(); this._walkStart(); };
          this._onKeyUp = e => { this._run = e.shiftKey; const c2 = CODES[e.code]; if (c2 && this._walkKeys) this._walkKeys[c2] = false; };
          window.addEventListener('keydown', this._onKeyDown); window.addEventListener('keyup', this._onKeyUp);
        }
        this.render();
      } else {
        this.setPhoto(false);
        this._walkKeys = {}; this._walkRAF = false;
        if (this._preWalk) { const p = this._preWalk; this._preWalk = null; this._tweenTo({ yaw: p.yaw, pitch: p.pitch, dist: Math.max(p.dist, 4), target: p.target }); }
      }
    }
    // ---------- Режим «Экскурсия» (RealView): станции сканера ----------
    setStations(list) { this.stations = (list || []).slice(); this._buildStationMarkers(); this.render(); this._fireStations(); return this.stations; }
    getStations() { return (this.stations || []).slice(); }
    _fireStations() { if (this.onStations) try { this.onStations(this.getStations()); } catch (_) {} }
    // Item 3 (patch 26): ручная расстановка станций — режим 'add'|'del'|null
    setStationEdit(mode) { this._stationEdit = (mode === 'add' || mode === 'del') ? mode : null; if (this.canvas) this.canvas.style.cursor = this._stationEdit ? 'crosshair' : ''; return this._stationEdit; }
    addStationAt(point, name) {
      if (!point) return null;
      if (!this.stations) this.stations = [];
      let n = 1; const ids = new Set(this.stations.map(s => s.id));
      while (ids.has('m' + n)) n++;
      const id = 'm' + n;
      const st = (typeof window !== 'undefined' && window.RealView)
        ? window.RealView.makeStation([point[0], point[1], point[2]], 'Станция ' + id, id)
        : { id: id, name: name || id, pos: [point[0], point[1], point[2]], yaw: 0, panoUrl: null };
      this.stations.push(st); this._buildStationMarkers(); this.render(); this._fireStations();
      return st;
    }
    removeNearestStation(point) {
      if (!point || !this.stations || !this.stations.length) return null;
      const st = (typeof window !== 'undefined' && window.RealView) ? window.RealView.nearest(this.stations, point) : this.stations[0];
      if (!st) return null;
      this.stations = this.stations.filter(s => s.id !== st.id);
      this._buildStationMarkers(); this.render(); this._fireStations();
      return st;
    }
    _buildStationMarkers() {
      if (this._stationObjs) { this._delObjs(this._stationObjs); this._stationObjs = null; }
      if (!this.stations || !this.stations.length) return;
      const pos = new Float32Array(this.stations.length * 3);
      this.stations.forEach((s, i) => { pos[i * 3] = s.pos[0]; pos[i * 3 + 1] = s.pos[1]; pos[i * 3 + 2] = s.pos[2]; });
      const o = this._makeObj({ id: null, points: true, pos, col: null, pointSize: 18, color: hex2rgb('#ffcc33'), status: 'none' });
      o._spacing = 0; o._ptMax = 28; o._isStation = true;
      this._stationObjs = [o];
    }
    setTour(on) {
      this.tour = !!on;
      if (this.tour) {
        // v1091: авто-фото качество в туре (как в режиме ходьбы)
        this.setPhoto(true);
        if (!this.stations || !this.stations.length) { this.setStations((typeof window !== 'undefined' && window.RealView) ? window.RealView.suggestStations(this.bbox, {}) : []); }
        const from = this._eye();
        const s = (typeof window !== 'undefined' && window.RealView) ? (window.RealView.nearest(this.stations, from) || this.stations[0]) : this.stations[0];
        if (s) this._enterStation(s);
      } else {
        this.setPhoto(false);
        if (this._preTour) { const p = this._preTour; this._preTour = null; this._tweenTo({ yaw: p.yaw, pitch: p.pitch, dist: Math.max(p.dist, 4), target: p.target }); }
      }
      this.render();
    }
    _enterStation(station) {
      if (!station) return;
      if (!this._preTour) this._preTour = { yaw: this.yaw, pitch: this.pitch, dist: this.dist, target: this.target.slice() };
      this.currentStation = station.id;
      this._tweenTo({ yaw: this.yaw, pitch: 0.0, dist: 0.6, target: station.pos.slice() }, 500);
      if (this.onStation) this.onStation(station);
    }
    gotoStation(id) { const s = (this.stations || []).find(x => x.id === id); if (s) this._enterStation(s); }
    tourNext() {
      if (!this.tour || !this.stations || !this.stations.length || typeof window === 'undefined' || !window.RealView) return;
      const cy = Math.cos(this.yaw), sy = Math.sin(this.yaw);
      const dir = [-sy, 0, -cy];
      const cand = this.stations.filter(s => s.id !== this.currentStation);
      const s = window.RealView.pickTeleport(cand, this.target.slice(), dir, {});
      if (s) this.gotoStation(s.id);
    }
    _walkStart() { if (this._walkRAF) return; this._walkRAF = true; this._walkTick(); }
    _walkTick() {
      if (!this.walk || !this._walkKeys) { this._walkRAF = false; return; }
      const k = this._walkKeys; const bc = this.bbox;
      const dg = Math.sqrt(Math.pow(bc.mx[0] - bc.mn[0], 2) + Math.pow(bc.mx[1] - bc.mn[1], 2) + Math.pow(bc.mx[2] - bc.mn[2], 2)) || 8;
      let spd = Math.min(0.45, Math.max(0.02, dg * 0.0011)); if (this._run) spd *= 3.5; const vspd = spd * 1.7;   // скорость под размер сцены, Shift — бег
      const cy = Math.cos(this.yaw), sy = Math.sin(this.yaw);
      let fwd = 0, str = 0, up = 0;
      if (k.w) fwd += 1; if (k.s) fwd -= 1; if (k.d) str += 1; if (k.a) str -= 1; if (k.e) up += 1; if (k.q) up -= 1;
      this.target[0] += (-sy * fwd + cy * str) * spd;
      this.target[2] += (-cy * fwd - sy * str) * spd;
      this.target[1] += up * vspd;
      this.render();
      if (k.w || k.a || k.s || k.d || k.q || k.e) requestAnimationFrame(() => this._walkTick()); else this._walkRAF = false;
    }

    // ---------- camera + render ----------
    _eye() { const cp = Math.cos(this.pitch), sp = Math.sin(this.pitch), cy = Math.cos(this.yaw), sy = Math.sin(this.yaw); return [this.target[0] + this.dist * cp * sy, this.target[1] + this.dist * sp, this.target[2] + this.dist * cp * cy]; }
    _vp() {
      const asp = this.canvas.width / Math.max(1, this.canvas.height);
      const c = this.bbox; const dg = Math.sqrt(Math.pow(c.mx[0] - c.mn[0], 2) + Math.pow(c.mx[1] - c.mn[1], 2) + Math.pow(c.mx[2] - c.mn[2], 2)) || 8;
      const near = Math.max(1e-5, Math.min(dg * 0.0006, this.dist * 0.05)), far = Math.max(2000, dg * 4);   // динамические плоскости: точность глубины и отсутствие клиппинга
      let proj;
      if (this._ortho) { const h = Math.max(1e-3, this.dist * Math.tan(this._fov / 2)); const w = h * asp; const R = Math.max(2000, dg * 4); proj = ortho(-w, w, -h, h, -R, R); }
      else { proj = persp(this._fov, asp, near, far); }
      const view = look(this._eye(), this.target, [0, 1, 0]); return mul(proj, view);
    }

    // Мировая точка -> экранные координаты (для SVG-оверлея черчения). null если за камерой.
    worldToScreen(p) {
      const M = this._lastVP || this._vp();
      const c = tvec(M, [p[0], p[1], p[2], 1]);
      const w = c[3];
      if (!(w > 1e-8)) return null;
      const ndcx = c[0] / w, ndcy = c[1] / w, ndcz = c[2] / w;
      const rect = this.canvas.getBoundingClientRect();
      return { x: rect.left + (ndcx + 1) / 2 * rect.width, y: rect.top + (1 - ndcy) / 2 * rect.height, z: ndcz };
    }

    // ---------- Качество облака: цвет / яркость / размер точки / EDL ----------
    _notifyCloudChanged() {
      if (this._cloudEventPending || typeof window==='undefined') return;
      this._cloudEventPending=true;queueMicrotask(()=>{this._cloudEventPending=false;window.dispatchEvent(new Event('bim-cloud-change'));});
    }
    getCloudInfo() {
      const r=this._cloudRecord;if(!r || !(this.base.some(o=>o.points)||this._octActive))return null;
      const streamed = !!this._octActive && this._octIndex;
      return Object.assign({},r,{
        hasIntensity: streamed ? this._octIndex.hasIntensity === true : !!r.hasIntensity,
        hasClassification: streamed ? this._octIndex.hasClassification === true : !!r.hasClassification,
        loadedCount:this.base.filter(o=>o.points).reduce((n,o)=>n+o.count,0),
        bounds:{mn:this.bbox.mn.slice(),mx:this.bbox.mx.slice()},
        visible:this.cloudVisible!==false,streaming:!!this._octActive,
        display:Object.assign({},this._cloudDisplay,{mode:this.getColorMode()}),
        availableColorModes:this.getAvailableColorModes()
      });
    }
    setCloudPointSize(value) {value=Number(value);if(!Number.isFinite(value))throw new RangeError('Некорректный размер точки');this._cloudDisplay.pointSize=Math.max(1,Math.min(10,value));this._ptSizeMul=1;this._attenuate=false;this._denseFill=false;this.render();this._notifyCloudChanged();return this._cloudDisplay.pointSize;}
    setCloudOpacity(value) {value=Number(value);if(!Number.isFinite(value))throw new RangeError('Некорректная непрозрачность');this._cloudDisplay.opacity=Math.max(0,Math.min(1,value));if(this._cloudDisplay.opacity===0)this.clearSelection();this.render();this._notifyCloudChanged();return this._cloudDisplay.opacity;}
    setCloudHeightRange(min,max) {min=Number(min);max=Number(max);if(!Number.isFinite(min)||!Number.isFinite(max)||min>max)throw new RangeError('Начало диапазона должно быть не больше конца');this._cloudDisplay.min=min;this._cloudDisplay.max=max;if(this._heightFilter())this.clearSelection();this.render();this._notifyCloudChanged();return [min,max];}
    setCloudPalette(value) {this._cloudDisplay.palette=({rainbow:0,gray:1,warm:2})[value]??0;this.render();this._notifyCloudChanged();}
    setCloudHideOutside(on) {this._cloudDisplay.hideOutside=!!on;this.clearSelection();this.render();this._notifyCloudChanged();}
    _heightFilter() {return !!(this._cloudRecord&&this._ptElev&&this._cloudDisplay&&this._cloudDisplay.hideOutside);}
    _clipActive() {return !!(this.section&&this.section.on)||this._heightFilter();}
    getAvailableColorModes() {
      let hasIntensity = false, hasClassification = false;
      if (this._octActive && this._octIndex) {
        hasIntensity = this._octIndex.hasIntensity === true;
        hasClassification = this._octIndex.hasClassification === true;
      } else {
        const cloud = this._cloudRecord || {};
        hasIntensity = !!(this._intensityValues || cloud.hasIntensity);
        hasClassification = !!(this._classificationLabels || cloud.hasClassification);
        // The legacy in-memory coarse LOD cells only retain XYZ/RGB.
        if (this.base && this.base.some(o => o && o.points && o._lod)) {
          hasIntensity = false;
          hasClassification = false;
        }
      }
      const modes = ['rgb', 'elev'];
      if (hasIntensity) modes.push('intensity');
      if (hasClassification) modes.push('classification');
      return modes;
    }
    getColorMode() { return this._cloudColorMode || (this._ptElev ? 'elev' : 'rgb'); }
    setColorMode(mode) {
      if (mode === true) mode = 'elev';
      else if (mode === false || mode == null) mode = 'rgb';
      if (!['rgb', 'elev', 'intensity', 'classification'].includes(mode)) {
        throw new RangeError('Неизвестный режим окраски облака');
      }
      if (!this.getAvailableColorModes().includes(mode)) {
        throw new RangeError(mode === 'intensity'
          ? 'В текущем облаке нет intensity в выбранном режиме'
          : mode === 'classification'
            ? 'В текущем облаке нет classification в выбранном режиме'
            : 'Режим окраски недоступен');
      }
      this._cloudColorMode = mode;
      this._ptElev = mode === 'elev';
      this.render(); this._notifyCloudChanged();
      return mode;
    }
    setBrightness(v) { v = +v; if (!isFinite(v)) v = 1; this._ptBright = Math.max(0.2, Math.min(3, v)); this.render(); return this._ptBright; }
    // Фотореалистичная цветокоррекция облака (тонмаппинг). partial: true/false для вкл/выкл или объект с полями.
    setGrade(partial) {
      if (!this._grade) this._grade = { on: false, exposure: 1.06, contrast: 1.14, saturation: 1.22, gamma: 1.02, tone: 0.85 };
      if (partial === false) this._grade.on = false;
      else if (partial === true) this._grade.on = true;
      else if (partial && typeof partial === 'object') { for (const k in partial) { if (k === 'on') this._grade.on = !!partial[k]; else { const v = +partial[k]; if (isFinite(v)) this._grade[k] = v; } } }
      this.render(); return Object.assign({}, this._grade);
    }
    getGrade() { return Object.assign({}, this._grade || {}); }
    setPointSizeScale(m) { m = +m; if (!isFinite(m)) m = 1; this._ptSizeMul = Math.max(0.3, Math.min(4, m)); this._cloudDisplay.pointSize=Math.max(1,Math.min(10,(this.base[0]?.pointSize||2.2)*this._ptSizeMul)); this.render(); this._notifyCloudChanged(); return this._ptSizeMul; }
    setEDL(on) { this._edl = !!on; if (this._edl && !this._edlReady) this._edlInit(); this.render(); return this._edl && !!this._edlReady; }
    // Постоянный размер точки на экране (как в CloudCompare) ↔ растёт при приближении
    setAttenuate(on) { this._attenuate = !!on; this._cloudDisplay.pointSize=on?null:1;this._notifyCloudChanged(); this.render(); return this._attenuate; }
    attenuateOn() { return !!this._attenuate; }
    setDenseFill(on) { this._denseFill = !!on; if (on) this._attenuate = true;this._cloudDisplay.pointSize=on?null:1;this._notifyCloudChanged(); this.render(); return this._denseFill; }
    denseFillOn() { return !!this._denseFill; }
    setFrame(on) { this._frameBox = !!on; this.render(); return this._frameBox; }
    frameOn() { return !!this._frameBox; }
    // Фото-режим: крупные круглые сплэты + EDL → чёткая картинка при экскурсии.
    setPhoto(on) {
      on = !!on;
      if (on === this._photo) return this._photo;
      if (on) {
        this._photoSaved = { pointSize:this._cloudDisplay.pointSize, edl: this._edl, sizeMul: this._ptSizeMul, edlStrength: this._edlStrength, round: this._roundPoints };
        this._photo = true;this._cloudDisplay.pointSize=null;this._notifyCloudChanged();
        this._ptSizeMul = Math.max(this._ptSizeMul || 1, 2.4);
        this._edlStrength = 1.4;
        if (!this._edlReady) this._edlInit();
        if (this._edlReady) this._edl = true;
        this._roundPoints = true;
      } else {
        this._photo = false;
        if (this._photoSaved) { this._ptSizeMul = this._photoSaved.sizeMul; this._edl = this._photoSaved.edl; this._edlStrength = this._photoSaved.edlStrength; this._roundPoints = !!this._photoSaved.round; this._cloudDisplay.pointSize=this._photoSaved.pointSize; this._photoSaved = null; }
      }
      this.render();
      return this._photo;
    }
    photoOn() { return !!this._photo; }
    // Бюджет видимых точек LOD (без перечтения меняет только верхний потолок уже построенной структуры; полностью — при следующей загрузке/перечтении)
    setLodBudget(n) {
      n = n | 0;
      if (n >= 1000000) {
        this._lodBudget = n;
        const indexedPoints = Number(this._octIndex && this._octIndex.pointCount);
        this._octBudget = this._octActive && Number.isFinite(indexedPoints) && indexedPoints > 0
          ? Math.min(indexedPoints, n)
          : n;
        const bo = this.base && this.base[0]; if (bo) bo._lodBudget = n;
      }
      this.render();
      return this._lodBudget;
    }
    // Профиль «Максимум памяти/качество» (max) vs «Сбалансированный» (balanced): управляет детализацией при движении камеры.
    setPerfProfile(mode) { this._perfProfile = (mode === 'max') ? 'max' : 'balanced'; this._interBudget = (this._perfProfile === 'max') ? 2000000000 : 128000000; this.render(); return this._perfProfile; }
    setDensityBoost(v) { this._densityBoost = Math.max(0.5, Math.min(4, +v || 1.8)); this.render(); return this._densityBoost; }
    perfProfile() { return this._perfProfile || 'balanced'; }
    setMaxQuality(on) {
      if (on) {
        if (!this._maxQSaved) this._maxQSaved = { sizeMul: this._ptSizeMul, edl: this._edl, round: this._roundPoints, atten: this._attenuate };
        // «Максимум» = резкость как в CloudCompare: КВАДРАТНЫЕ точки (без размытых кружков),
        // перспективный размер (сплошная поверхность вблизи) и EDL для объёма/краёв.
        this._roundPoints = false;
        this._attenuate = true;
        this._ptSizeMul = Math.max(this._ptSizeMul || 1, 1.15);
        try { if (!this._edlReady) this._edlInit(); if (this._edlReady) this._edl = true; } catch (e) {}
      } else if (this._maxQSaved) {
        this._ptSizeMul = this._maxQSaved.sizeMul; this._edl = this._maxQSaved.edl; this._roundPoints = !!this._maxQSaved.round; this._attenuate = !!this._maxQSaved.atten; this._maxQSaved = null;
      }
      if (this.onQualityChange) { try { this.onQualityChange(); } catch (e) {} }
      this.render();
      return !!on;
    }
    edlReady() { return !!this._edlReady; }
    _edlInit() {
      const gl = this.gl;
      try {
        const sh = (t, src) => { const s = gl.createShader(t); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error('EDL shader: ' + gl.getShaderInfoLog(s)); return s; };
        const p = gl.createProgram(); gl.attachShader(p, sh(gl.VERTEX_SHADER, EDL_VS)); gl.attachShader(p, sh(gl.FRAGMENT_SHADER, EDL_FS)); gl.linkProgram(p);
        if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('EDL link: ' + gl.getProgramInfoLog(p));
        this._edlProg = p; this._edlU = {};
        for (const k of ['uCol', 'uDep', 'uTexel', 'uNear', 'uFar', 'uStrength', 'uRadius']) this._edlU[k] = gl.getUniformLocation(p, k);
        const aP = gl.getAttribLocation(p, 'aP');
        this._edlVao = gl.createVertexArray(); gl.bindVertexArray(this._edlVao);
        const vb = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, vb); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
        gl.enableVertexAttribArray(aP); gl.vertexAttribPointer(aP, 2, gl.FLOAT, false, 0, 0); gl.bindVertexArray(null);
        this._edlColTex = gl.createTexture(); this._edlDepTex = gl.createTexture(); this._edlFbo = gl.createFramebuffer();
        this._edlW = 0; this._edlH = 0; this._edlResize();
        gl.bindFramebuffer(gl.FRAMEBUFFER, this._edlFbo);
        const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        if (!ok) throw new Error('EDL framebuffer incomplete');
        this._edlReady = true;
      } catch (e) { console.warn('EDL init failed → обычный рендер', e); this._edlReady = false; }
    }
    _edlResize() {
      const gl = this.gl; const w = this.canvas.width || 800, h = this.canvas.height || 600;
      gl.bindTexture(gl.TEXTURE_2D, this._edlColTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.bindTexture(gl.TEXTURE_2D, this._edlDepTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.DEPTH_COMPONENT24, w, h, 0, gl.DEPTH_COMPONENT, gl.UNSIGNED_INT, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.bindTexture(gl.TEXTURE_2D, null);
      gl.bindFramebuffer(gl.FRAMEBUFFER, this._edlFbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this._edlColTex, 0);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, this._edlDepTex, 0);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      this._edlW = w; this._edlH = h;
    }
    _edlComposite() {
      const gl = this.gl; const c = this.bbox;
      const dg = Math.sqrt(Math.pow(c.mx[0] - c.mn[0], 2) + Math.pow(c.mx[1] - c.mn[1], 2) + Math.pow(c.mx[2] - c.mn[2], 2)) || 8;
      const near = Math.max(1e-5, Math.min(dg * 0.0006, this.dist * 0.05)), far = Math.max(2000, dg * 4);
      gl.useProgram(this._edlProg); gl.disable(gl.DEPTH_TEST); gl.bindVertexArray(this._edlVao);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this._edlColTex); gl.uniform1i(this._edlU.uCol, 0);
      gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, this._edlDepTex); gl.uniform1i(this._edlU.uDep, 1);
      gl.uniform2f(this._edlU.uTexel, 1 / (this._edlW || 1), 1 / (this._edlH || 1));
      gl.uniform1f(this._edlU.uNear, near); gl.uniform1f(this._edlU.uFar, far);
      gl.uniform1f(this._edlU.uStrength, this._edlStrength || 1.0); gl.uniform1f(this._edlU.uRadius, this._edlRadius || 1.4);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.bindVertexArray(null); gl.enable(gl.DEPTH_TEST); gl.useProgram(this.prog); gl.activeTexture(gl.TEXTURE0);
    }

    _renderNow() {
      const gl = this.gl; if (!gl) return;
      const _edlOn = this._edl && this._edlReady && !!(this.base[0] && this.base[0].points);
      if (_edlOn) { if (this._edlW !== this.canvas.width || this._edlH !== this.canvas.height) this._edlResize(); gl.bindFramebuffer(gl.FRAMEBUFFER, this._edlFbo); }
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      const vp = this._vp(); this._lastVP = vp;
      gl.useProgram(this.prog);
      gl.uniform1f(this.u.uBright, this._ptBright || 1); gl.uniform1f(this.u.uElevMode, 0); gl.uniform1f(this.u.uAttrMode, 0);
      { const G = this._grade || {}; gl.uniform1f(this.u.uGrade, G.on ? 1 : 0); gl.uniform1f(this.u.uExposure, G.exposure != null ? G.exposure : 1); gl.uniform1f(this.u.uContrast, G.contrast != null ? G.contrast : 1); gl.uniform1f(this.u.uSaturation, G.saturation != null ? G.saturation : 1); gl.uniform1f(this.u.uGamma, G.gamma != null ? G.gamma : 1); gl.uniform1f(this.u.uTone, G.tone != null ? G.tone : 0); }
      gl.uniform1f(this.u.uElevMin, this._cloudDisplay.min); gl.uniform1f(this.u.uElevMax, this._cloudDisplay.max); gl.uniform1f(this.u.uPalette,this._cloudDisplay.palette); gl.uniform1f(this.u.uCloudOpacity,this._cloudDisplay.opacity); gl.uniform1f(this.u.uCloudPass,0);
      this._edlOnThisFrame = _edlOn;
      gl.uniformMatrix4fv(this.u.uMVP, false, new Float32Array(vp));
      gl.uniform3fv(this.u.uLightDir, new Float32Array(norm([0.5, 0.9, 0.6])));
      const _cb = this._clipBounds();
      gl.uniform1f(this.u.uClipOn, (this._clipActive() && _cb) ? 1 : 0);
      if (_cb) { gl.uniform3f(this.u.uClipMin, _cb.mn[0], _cb.mn[1], _cb.mn[2]); gl.uniform3f(this.u.uClipMax, _cb.mx[0], _cb.mx[1], _cb.mx[2]); }
      const drawList = this.base.concat(this.overlay).concat(this.tour && this._stationObjs ? this._stationObjs : []).concat(this._selObj ? [this._selObj] : []).concat(this._hoverObj ? [this._hoverObj] : []);
      // solids first
      for (const o of drawList) { if (o.line || o.hidden || (o.points && this.cloudVisible === false)) continue; this._drawObj(o); }
      gl.uniform1f(this.u.uClipOn, 0);
      for (const o of drawList) { if (!o.line || o.hidden) continue; this._drawObj(o); }
      if (this._octActive && this.cloudVisible !== false) this._drawOctree();
      if (this._edlOnThisFrame) { gl.bindFramebuffer(gl.FRAMEBUFFER, null); this._edlComposite(); }
      if (this.measuring && this._measLabels && this._measLabels.length) this._renderMeasLabels();
    }
    _drawObj(o) {
      const gl = this.gl; gl.bindVertexArray(o._vao);
      if (o.points) {
        gl.uniform1f(this.u.uUnlit, 1); gl.uniform1f(this.u.uUseVColor, o.col ? 1 : 0);
        // Чёткие квадратные точки (как в CloudCompare) для самого облака — резче и без лишнего
        // fragment-discard; круглые сплэты только для маркеров/выбора и фото-режима.
        const roundPt = (o._isStation || o._isSel) ? 1 : ((this._roundPoints && !this._frameBox) ? 1 : 0);
        gl.uniform1f(this.u.uRound, roundPt); gl.uniform1f(this.u.uAmbient, 1);
        // Атрибутивные цветовые режимы — только для основного облака.
        const isMainCloud = o === (this.base && this.base[0]) && !o._isStation && !o._isSel;
        const colorMode = isMainCloud ? this.getColorMode() : 'rgb';
        const attrMode = colorMode === 'intensity' ? 2 :
          colorMode === 'classification' ? 3 : 0;
        gl.uniform1f(this.u.uAttrMode, attrMode);
        gl.uniform1f(this.u.uElevMode, colorMode === 'elev' ? 1 : 0);
        const psm = (o._isStation || o._isSel) ? 1 : (this._ptSizeMul || 1);
        // По умолчанию — постоянный размер точки на экране (как в CloudCompare): чёткая ровная
        // Картинка. Опционально размер растёт при приближении (для прогулки поверхность плотнее).
        const isCloud = !(o._isStation || o._isSel);
        gl.uniform1f(this.u.uCloudPass,isCloud?1:0);
        const vh = gl.canvas.height || 600;
        const fixedPx=isCloud && this._cloudDisplay ? this._cloudDisplay.pointSize : null;
        const baseSize = fixedPx || ((o.pointSize || 2.2) * psm);
        const scale = (o._spacing || 0) * (vh * 0.5 / Math.tan(this._fov / 2)) * (this._densityBoost || 1.8) * psm;
        // По умолчанию — адаптивный размер: вдали точки чёткие постоянного размера,
        // вблизи растут и закрывают зазоры (плотно и чётко на любом приближении).
        const adaptive = isCloud && !fixedPx && !this._frameBox && !this._denseFill && !this._attenuate && scale > 0;
        const atten = (!fixedPx && isCloud && (this._attenuate || this._denseFill || adaptive) && scale > 0) ? 1 : 0;
        gl.uniform1f(this.u.uAttenuate, atten); gl.uniform1f(this.u.uPtScale, scale);
        gl.uniform1f(this.u.uPtMin, adaptive ? baseSize : 1.0); gl.uniform1f(this.u.uPtMax, (o._ptMax || 8.0) * psm * (isCloud && this._denseFill ? 9.0 : (adaptive ? 6.0 : 1.0)));
        gl.uniform1f(this.u.uFrame, (isCloud && this._frameBox) ? 1 : 0);
        gl.uniform1f(this.u.uPointSize, baseSize);
        if (!o.col) gl.uniform3fv(this.u.uColor, new Float32Array(o.color || [0.82, 0.86, 0.93]));
        if (o._lod) { this._drawLod(o); }
        else {
          let dc = o.count;
          if (isCloud && this._interacting && o._shuffled) { const b = this._interBudget || 4000000; if (o.count > b) dc = b; }
          gl.drawArrays(gl.POINTS, 0, dc);
        }
        gl.uniform1f(this.u.uRound, 0); gl.uniform1f(this.u.uFrame, 0); gl.uniform1f(this.u.uAttenuate, 0); gl.uniform1f(this.u.uElevMode, 0); gl.uniform1f(this.u.uAttrMode, 0); gl.bindVertexArray(null); return;
      }
      gl.uniform1f(this.u.uCloudPass,0);
      let col = o.color; let amb = 0.4;
      if (!o.line) { if (this.showAI && o.status && o.status !== 'none') col = hex2rgb(STATUS_COLOR[o.status]); if (o.id && o.id === this.selectedId) { col = mixW(col, 0.28); amb = 0.62; } }
      gl.uniform3fv(this.u.uColor, new Float32Array(col)); gl.uniform1f(this.u.uUnlit, o.line ? 1 : 0); gl.uniform1f(this.u.uAmbient, amb);
      gl.uniform1f(this.u.uUseVColor, (!o.line && o.col) ? 1 : 0); gl.uniform1f(this.u.uPointSize, 1);
      gl.drawArrays(o.line ? gl.LINES : gl.TRIANGLES, 0, o.count); gl.uniform1f(this.u.uUseVColor, 0); gl.bindVertexArray(null);
    }

    // ---------- picking (Moller-Trumbore) ----------
    _ray(sx, sy) {
      const rect = this.canvas.getBoundingClientRect();
      const x = (sx - rect.left) / rect.width * 2 - 1;
      const y = 1 - (sy - rect.top) / rect.height * 2;
      const inv = invert(this._lastVP || this._vp());
      const near = tvec(inv, [x, y, -1, 1]); const far = tvec(inv, [x, y, 1, 1]);
      const p0 = [near[0] / near[3], near[1] / near[3], near[2] / near[3]];
      const p1 = [far[0] / far[3], far[1] / far[3], far[2] / far[3]];
      return { o: p0, d: norm(sub(p1, p0)) };
    }
    _pick(sx, sy) {
      const r = this._ray(sx, sy); const o = r.o, d = r.d;
      let best = null, bestT = Infinity;
      const triTest = (P, i, obj) => {
        const a = [P[i], P[i + 1], P[i + 2]], b = [P[i + 3], P[i + 4], P[i + 5]], c = [P[i + 6], P[i + 7], P[i + 8]];
        const e1 = sub(b, a), e2 = sub(c, a); const pv = cross(d, e2); const det = dot(e1, pv);
        if (Math.abs(det) < 1e-7) return; const invDet = 1 / det;
        const tv = sub(o, a); const u = dot(tv, pv) * invDet; if (u < 0 || u > 1) return;
        const qv = cross(tv, e1); const v = dot(d, qv) * invDet; if (v < 0 || u + v > 1) return;
        const t = dot(e2, qv) * invDet; if (t > 1e-4 && t < bestT) { bestT = t; best = obj; }
      };
      for (const obj of this.base) {
        if (obj.line || obj.hidden || obj.points) continue;
        const P = obj.pos;
        if (obj.aabb && rayAABB(o, d, obj.aabb.mn, obj.aabb.mx) == null) continue;   // отсекаем объекты вне луча
        if (obj._grid) {
          const seen = new Set();
          traverseGrid(obj._grid, o, d, (arr) => { for (const i of arr) { if (seen.has(i)) continue; seen.add(i); triTest(P, i, obj); } return false; });
        } else {
          for (let i = 0; i < P.length; i += 9) triTest(P, i, obj);
        }
      }
      if (!best) { const pg = this._pickGPU(sx, sy); if (pg) return pg; const pp = this._pickPoint(sx, sy); return pp || null; }
      const pt = [o[0] + d[0] * bestT, o[1] + d[1] * bestT, o[2] + d[2] * bestT];
      return { id: best.id, el: best.el, point: pt };
    }

    // ближайшая точка облака к курсору (для измерений по точкам)
    _pickPoint(sx, sy) {
      if (this.cloudVisible===false || this._cloudDisplay.opacity===0) return null;
      const cb=this._clipActive()?this._clipBounds():null;
      const rect = this.canvas.getBoundingClientRect();
      const cxN = (sx - rect.left) / rect.width * 2 - 1;
      const cyN = 1 - (sy - rect.top) / rect.height * 2;
      const rx = 22 / rect.width * 2, ry = 22 / rect.height * 2;   // радиус захвата ~22px
      const M = this._lastVP || this._vp();
      let best = null, bestScore = Infinity;
      for (const o of this.base) {
        if (!o.points || o.hidden || this.cloudVisible === false) continue; const P = o.pos; const n = P.length / 3;
        // подвыборка тяжёлых облаков: наведение и клик быстрые и одинаковые (WYSIWYG-снап)
        let step = 3; if (n > 300000) step = 3 * Math.ceil(n / 300000);
        for (let i = 0; i < P.length; i += step) {
          const x = P[i], y = P[i + 1], z = P[i + 2];
          if(cb){if(x<cb.mn[0]||x>cb.mx[0]||y<cb.mn[1]||y>cb.mx[1]||z<cb.mn[2]||z>cb.mx[2])continue;}
          const cw = M[3] * x + M[7] * y + M[11] * z + M[15]; if (cw <= 0) continue;
          const nx = (M[0] * x + M[4] * y + M[8] * z + M[12]) / cw;
          const ny = (M[1] * x + M[5] * y + M[9] * z + M[13]) / cw;
          const ddx = (nx - cxN) / rx, ddy = (ny - cyN) / ry;
          if (Math.abs(ddx) > 1 || Math.abs(ddy) > 1) continue;
          // приоритет — точка, чья проекция ближе всего к курсору (+лёгкое предпочтение передним)
          const score = ddx * ddx + ddy * ddy + Math.max(0, cw) * 1e-6;
          if (score < bestScore) { bestScore = score; best = [x, y, z]; }
        }
      }
      return best ? { id: null, el: null, point: best } : null;
    }

    // ---------- interaction ----------
    _bind() {
      const el = this.canvas; el.style.cursor = 'grab';
      let drag = null, moved = 0, sx = 0, sy = 0;
      el.addEventListener('contextmenu', e => e.preventDefault());
      el.addEventListener('mouseleave', () => { if (this._hoverObj) this._setHoverPoint(null); this._hideLoupe(); });
      el.addEventListener('mousedown', e => { this._stopTween(); if (e.button === 1) { drag = 'pan'; moved = 0; sx = e.clientX; sy = e.clientY; el.style.cursor = 'grabbing'; e.preventDefault(); return; } if (this.editSelect && e.button !== 2 && !e.shiftKey) { drag = 'select'; this._selStart = [e.clientX, e.clientY]; this._selCur = [e.clientX, e.clientY]; moved = 0; sx = e.clientX; sy = e.clientY; if (this.editMode === 'brush') { this._buildBrushGrid(); this._brushAt(e.clientX, e.clientY, e.altKey || this._selSubtract); } else if (this.editMode === 'lasso') { this._lasso = [[e.clientX, e.clientY]]; this._showLasso(true); this._updateLasso(); } else { this._showMarquee(true); this._updateMarquee(); } return; } drag = (this.editSelect && e.button === 2) ? 'orbit' : (e.button === 2 || e.shiftKey) ? 'pan' : 'orbit'; moved = 0; sx = e.clientX; sy = e.clientY; el.style.cursor = 'grabbing'; });
      window.addEventListener('mouseup', e => { if (drag === 'select') { if (this.editMode === 'wand' || this.editMode === 'eyedrop') { if (moved < 5) { if (this.editMode === 'wand' && this.magicWandAt) this.magicWandAt(e.clientX, e.clientY); else if (this.editMode === 'eyedrop' && this.selectColorAt) this.selectColorAt(e.clientX, e.clientY, 40); } drag = null; return; } if (this.editMode === 'brush') { this._brushGrid = null; if (typeof this.onEditSelect === 'function') this.onEditSelect(this._sel ? this._sel.size : 0); } else if (this.editMode === 'lasso') { this._showLasso(false); if (moved < 5 || !this._lasso || this._lasso.length < 3) { if (!(this._selSubtract || e.altKey || this._selAccumulate)) this.clearSelection(); } else { this._finishLasso(e.ctrlKey || e.metaKey, this._selSubtract || e.altKey); } this._lasso = null; } else { this._showMarquee(false); if (moved < 5) { if (!(this._selSubtract || e.altKey || this._selAccumulate)) this.clearSelection(); } else { this._selCur = [e.clientX, e.clientY]; this._finishMarquee(e.ctrlKey || e.metaKey, this._selSubtract || e.altKey); } } drag = null; return; } if (drag && moved < 5 && e.button === 0) this._click(e.clientX, e.clientY); drag = null; el.style.cursor = this.editSelect ? 'crosshair' : 'grab'; this._endInteractSoon(); });
      window.addEventListener('mousemove', e => {
        if (!drag) { if (this.measuring) this._hoverMeasure(e.clientX, e.clientY); else if (typeof window !== 'undefined' && window.__lxDraw && window.__lxDraw.active) window.__lxDraw.onHover(e.clientX, e.clientY); return; } const dx = e.clientX - sx, dy = e.clientY - sy; sx = e.clientX; sy = e.clientY; moved += Math.abs(dx) + Math.abs(dy);
        if (drag === 'select') { this._selCur = [e.clientX, e.clientY]; if (this.editMode === 'wand' || this.editMode === 'eyedrop') { return; } if (this.editMode === 'brush') { this._brushAt(e.clientX, e.clientY, e.altKey || this._selSubtract); } else if (this.editMode === 'lasso') { if (this._lasso) { const _L = this._lasso, _p = _L[_L.length - 1]; const _dx = e.clientX - _p[0], _dy = e.clientY - _p[1]; if (_dx * _dx + _dy * _dy >= 6.25) _L.push([e.clientX, e.clientY]); } this._updateLasso(); } else { this._updateMarquee(); } return; }
        if (drag === 'orbit') { this.yaw += dx * 0.005; this.pitch -= dy * 0.005; this.pitch = Math.max(-1.5, Math.min(1.5, this.pitch)); }
        else { const f = this.walk ? 0.03 : this.dist * 0.0016; const cy = Math.cos(this.yaw), sy2 = Math.sin(this.yaw); this.target[0] -= (dx * cy) * f; this.target[2] += (dx * sy2) * f; this.target[1] += dy * f; }
        this._beginInteract();
        this.render();
      });
      el.addEventListener('wheel', e => { e.preventDefault(); this._stopTween(); this._beginInteract(); this._endInteractSoon(220); if (this.editSelect && this.editMode === 'brush' && (e.ctrlKey || e.metaKey)) { this._brushRadius = Math.max(4, Math.min(160, (this._brushRadius || 16) * (e.deltaY > 0 ? 0.85 : 1.18))); if (typeof this.onBrushRadius === 'function') this.onBrushRadius(Math.round(this._brushRadius)); return; } if (this.walk) { const cy = Math.cos(this.yaw), sy = Math.sin(this.yaw); const s = (e.deltaY > 0 ? -1 : 1) * 0.6; this.target[0] += -sy * s; this.target[2] += -cy * s; this.render(); return; } this.dist *= (e.deltaY > 0 ? 1.1 : 0.9); this.dist = Math.max(1e-4, Math.min(6000, this.dist)); this.render(); }, { passive: false });
      try { if (typeof window !== 'undefined') window.__lxViewer = this; } catch (e) {}
    }
    _click(cx, cy) {
      const hit = this._pick(cx, cy);
      if (typeof window !== 'undefined' && window.__lxDraw && window.__lxDraw.active) { if (hit) window.__lxDraw.onPick(hit.point); return; }
      if (this.measuring) { if (hit) this._measureClick(hit.point); return; }
      if (this.tour && this._stationEdit && hit) {
        if (this._stationEdit === 'add') { this.addStationAt(hit.point); return; }
        if (this._stationEdit === 'del') { this.removeNearestStation(hit.point); return; }
      }
      if (this.tour && hit && typeof window !== 'undefined' && window.RealView && this.stations && this.stations.length) {
        const st = window.RealView.nearest(this.stations, hit.point);
        if (st) { this.gotoStation(st.id); return; }
      }
      if (this.isolate && !(hit && hit.id)) { this.render(); return; }
      this.select(hit ? hit.id : null);
      this.onSelect(hit && hit.id ? hit.el : null);
    }
    // ---------- Phase 4: редактирование облака точек (выбор рамкой → удаление/кроп/undo) ----------
    setEditSelect(on) {
      this.editSelect = !!on;
      if (this.editSelect) { if (this.measuring) this.setMeasure(false); if (this.walk) this.setWalk(false); if (this.tour) this.setTour(false); this.canvas.style.cursor = 'crosshair';
        // Надёжные дефолты ручной чистки: лассо + насквозь (детерминированно, без GPU-pick) + накопление.
        this.editMode = 'lasso'; this._selDepthMode = 0; this._selThrough = false; this._selAccumulate = true; this._selSubtract = false;
      }
      else { this._showMarquee(false); this._showLasso(false); this.clearSelection(); this.canvas.style.cursor = 'grab'; }
    }
    _marqueeEl() {
      if (this._marq) return this._marq;
      const d = document.createElement('div');
      d.style.cssText = 'position:absolute;border:1px solid #4c8dff;background:rgba(76,141,255,0.15);pointer-events:none;display:none;z-index:30;';
      const host = this.canvas.parentElement || document.body;
      try { if (getComputedStyle(host).position === 'static') host.style.position = 'relative'; } catch (e) {}
      host.appendChild(d); this._marq = d; return d;
    }
    _showMarquee(on) { const d = this._marqueeEl(); d.style.display = on ? 'block' : 'none'; }
    // Режим выделения: 'rect' (рамка) или 'lasso' (произвольный контур)
    setSelectMode(mode) { this.editMode = (mode === 'lasso') ? 'lasso' : (mode === 'brush') ? 'brush' : (mode === 'wand') ? 'wand' : (mode === 'eyedrop') ? 'eyedrop' : 'rect'; this._showMarquee(false); this._showLasso(false); if (this.editMode === 'brush' && !this._brushRadius) this._brushRadius = 16; try { this.canvas.style.cursor = this.editSelect ? (this.editMode === 'brush' ? 'cell' : 'crosshair') : 'grab'; } catch (e) {} return this.editMode; }
    setSelectSubtract(on) { this._selSubtract = !!on; return this._selSubtract; }
    setSelectAccumulate(on) { this._selAccumulate = !!on; return this._selAccumulate; }
    // ---------- Brush eraser: erases only VISIBLE points under the cursor (front-most per screen cell) ----------
    // One projection pass at stroke start (camera is fixed while dragging with LMB), then cheap per-move tests.
    _buildBrushGrid() {
      const proj = this._projectBase(); this._brushProj = proj;
      const xy = proj.xy, depth = proj.depth, n = proj.count | 0;
      const rect = this.canvas.getBoundingClientRect();
      const cw = Math.max(1, rect.width), ch = Math.max(1, rect.height);
      const cellPx = 3;
      const gw = Math.max(1, Math.ceil(cw / cellPx)), gh = Math.max(1, Math.ceil(ch / cellPx));
      const frontD = new Float32Array(gw * gh); frontD.fill(Infinity);
      const frontI = new Int32Array(gw * gh); frontI.fill(-1);
      for (let i = 0; i < n; i++) {
        const x = xy[i * 2], y = xy[i * 2 + 1], d = depth[i];
        if (d !== d) continue; if (x < -1 || x > 1 || y < -1 || y > 1) continue;
        let gx = ((x * 0.5 + 0.5) * gw) | 0, gy = ((1 - (y * 0.5 + 0.5)) * gh) | 0;
        if (gx < 0) gx = 0; else if (gx >= gw) gx = gw - 1;
        if (gy < 0) gy = 0; else if (gy >= gh) gy = gh - 1;
        const ci = gy * gw + gx; if (d < frontD[ci]) { frontD[ci] = d; frontI[ci] = i; }
      }
      this._brushGrid = { gw, gh, cellPx, frontI, frontD, rect };
    }
    _brushAt(cx, cy, subtract) {
      const g = this._brushGrid; if (!g) return;
      const rect = g.rect, cell = g.cellPx;
      const px = cx - rect.left, py = cy - rect.top;
      const R = this._brushRadius || 16;
      const gcx = px / cell, gcy = py / cell, gr = R / cell, r2 = gr * gr;
      const gw = g.gw, gh = g.gh, fI = g.frontI;
      let x0 = Math.max(0, Math.floor(gcx - gr)), x1 = Math.min(gw - 1, Math.ceil(gcx + gr));
      let y0 = Math.max(0, Math.floor(gcy - gr)), y1 = Math.min(gh - 1, Math.ceil(gcy + gr));
      if (!this._sel) this._sel = new Set();
      let changed = false;
      for (let gy = y0; gy <= y1; gy++) for (let gx = x0; gx <= x1; gx++) {
        const ddx = gx + 0.5 - gcx, ddy = gy + 0.5 - gcy; if (ddx * ddx + ddy * ddy > r2) continue;
        const i = fI[gy * gw + gx]; if (i < 0) continue;
        if (subtract) { if (this._sel.delete(i)) changed = true; }
        else if (!this._sel.has(i) && this._pointInClip(i)) { this._sel.add(i); changed = true; }
      }
      if (changed) { this._buildSelHighlight(); if (typeof this.onEditSelect === 'function') this.onEditSelect(this._sel.size); }
    }
    _lassoEl() {
      if (this._lassoSvg) return this._lassoSvg;
      const NS = 'http://www.w3.org/2000/svg';
      const svg = document.createElementNS(NS, 'svg');
      svg.style.cssText = 'position:absolute;left:0;top:0;width:100%;height:100%;pointer-events:none;display:none;z-index:30;';
      const poly = document.createElementNS(NS, 'polygon');
      poly.setAttribute('fill', 'rgba(76,141,255,0.15)');
      poly.setAttribute('stroke', '#4c8dff');
      poly.setAttribute('stroke-width', '1.5');
      poly.setAttribute('stroke-dasharray', '4 3');
      svg.appendChild(poly);
      const host = this.canvas.parentElement || document.body;
      try { if (getComputedStyle(host).position === 'static') host.style.position = 'relative'; } catch (e) {}
      host.appendChild(svg); this._lassoSvg = svg; this._lassoPoly = poly; return svg;
    }
    _showLasso(on) { const s = this._lassoEl(); s.style.display = on ? 'block' : 'none'; }
    _updateLasso() {
      if (!this._lasso || !this._lasso.length) return;
      this._lassoEl();
      const rect = this.canvas.getBoundingClientRect();
      const pts = this._lasso.map(p => (p[0] - rect.left) + ',' + (p[1] - rect.top)).join(' ');
      this._lassoPoly.setAttribute('points', pts);
    }
    _finishLasso(additive, subtract) {
      if (typeof window === 'undefined' || !window.PCEdit || !this._lasso || this._lasso.length < 3) return;
      const rect = this.canvas.getBoundingClientRect();
      const poly = this._lasso.map(p => [(p[0] - rect.left) / rect.width * 2 - 1, 1 - (p[1] - rect.top) / rect.height * 2]);
      const proj = this._projectBase();
      const raw = window.PCEdit.selectByPolygon(proj.xy, proj.count, poly);
      const idx = this._clipFilter(this._resolveVisibleSelection(raw, proj, 'lasso'));
      const add = additive || (this._selAccumulate && !subtract);
      let set;
      if (subtract) { set = new Set(this._sel || []); for (const i of idx) set.delete(i); }
      else { set = (add && this._sel) ? this._sel : new Set(); for (const i of idx) set.add(i); }
      this._sel = set; this._buildSelHighlight();
      if (typeof this.onEditSelect === 'function') this.onEditSelect(this._sel.size);
    }
    _updateMarquee() {
      if (!this._selStart || !this._selCur) return;
      const rect = this.canvas.getBoundingClientRect(); const d = this._marqueeEl();
      d.style.left = (Math.min(this._selStart[0], this._selCur[0]) - rect.left) + 'px';
      d.style.top = (Math.min(this._selStart[1], this._selCur[1]) - rect.top) + 'px';
      d.style.width = Math.abs(this._selCur[0] - this._selStart[0]) + 'px';
      d.style.height = Math.abs(this._selCur[1] - this._selStart[1]) + 'px';
    }
    // Проекция точек базового облака в NDC (та же математика, что в _pickPoint). NaN = за камерой.
    _projectBase() {
      const bo = this.base && this.base[0]; if (!bo || !bo.points) return { xy: new Float32Array(0), count: 0 };
      const P = bo.pos; const n = P.length / 3; const M = this._lastVP || this._vp();
      // Кэш проекции: пока камера и облако неизменны — переиспользуем (мгновенное повторное лассо/вычитание/инверсия).
      const cc = this._projCache;
      if (cc && cc.bo === bo && cc.count === n && cc.m) {
        let same = true; const cm = cc.m; for (let k = 0; k < 16; k++) { if (cm[k] !== M[k]) { same = false; break; } }
        if (same) return cc;
      }
      const xy = new Float32Array(n * 2);
      const depth = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const x = P[i * 3], y = P[i * 3 + 1], z = P[i * 3 + 2];
        const cw = M[3] * x + M[7] * y + M[11] * z + M[15];
        if (cw <= 0) { xy[i * 2] = NaN; xy[i * 2 + 1] = NaN; depth[i] = NaN; continue; }
        xy[i * 2] = (M[0] * x + M[4] * y + M[8] * z + M[12]) / cw;
        xy[i * 2 + 1] = (M[1] * x + M[5] * y + M[9] * z + M[13]) / cw;
        depth[i] = cw; // ≈ расстояние от камеры вдоль взгляда
      }
      const mc = new Float32Array(16); mc.set(M);
      this._projCache = { xy, depth, count: n, bo, m: mc };
      return this._projCache;
    }
    // ---------- Профессиональный выбор ВИДИМЫХ точек через GPU (ID-буфер + тест глубины) ----------
    _pickInit() {
      const gl = this.gl;
      try {
        const sh = (t, src) => { const s = gl.createShader(t); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error('pick shader: ' + gl.getShaderInfoLog(s)); return s; };
        const p = gl.createProgram(); gl.attachShader(p, sh(gl.VERTEX_SHADER, PICK_VS)); gl.attachShader(p, sh(gl.FRAGMENT_SHADER, PICK_FS)); gl.linkProgram(p);
        if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('pick link: ' + gl.getProgramInfoLog(p));
        this._pickProg = p; this._pickAPos = gl.getAttribLocation(p, 'aPos'); this._pickU = {};
        for (const k of ['uMVP', 'uPointSize', 'uAttenuate', 'uPtScale', 'uPtMin', 'uPtMax', 'uRound', 'uGrow', 'uClipOn', 'uClipMin', 'uClipMax']) this._pickU[k] = gl.getUniformLocation(p, k);
        this._pickVao = gl.createVertexArray();
        this._pickColTex = gl.createTexture(); this._pickDepRb = gl.createRenderbuffer(); this._pickFbo = gl.createFramebuffer();
        this._pickW = 0; this._pickH = 0; this._pickResize();
        gl.bindFramebuffer(gl.FRAMEBUFFER, this._pickFbo);
        const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        if (!ok) throw new Error('pick FBO incomplete');
        this._pickReady = true;
      } catch (e) { console.warn('pick init → CPU-фильтр видимости', e); this._pickReady = false; }
    }
    _pickResize() {
      const gl = this.gl; const w = this.canvas.width || 800, h = this.canvas.height || 600;
      gl.bindTexture(gl.TEXTURE_2D, this._pickColTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32UI, w, h, 0, gl.RED_INTEGER, gl.UNSIGNED_INT, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.bindTexture(gl.TEXTURE_2D, null);
      gl.bindRenderbuffer(gl.RENDERBUFFER, this._pickDepRb);
      gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, w, h);
      gl.bindRenderbuffer(gl.RENDERBUFFER, null);
      gl.bindFramebuffer(gl.FRAMEBUFFER, this._pickFbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this._pickColTex, 0);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, this._pickDepRb);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      this._pickW = w; this._pickH = h;
    }
    // Рендерит pick-проход (ID видимых точек) во весь буфер: тест глубины (окклюзия) + клип-бокс (срез).
    _drawPickPass(bo, grow) {
      const gl = this.gl;
      const cw = this.canvas.width, ch = this.canvas.height;
      const M = this._lastVP || this._vp();
      const psm = this._ptSizeMul || 1;
      const base = this._cloudDisplay.pointSize || (bo.pointSize || 2.2)*psm;
      const scale = (bo._spacing || 0) * (ch * 0.5 / Math.tan(this._fov / 2)) * (this._densityBoost || 1.8) * psm;
      const atten = this._cloudDisplay.pointSize ? 0 : (scale > 0 ? 1 : 0);
      gl.bindFramebuffer(gl.FRAMEBUFFER, this._pickFbo);
      gl.viewport(0, 0, cw, ch);
      gl.disable(gl.BLEND); gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LESS); gl.depthMask(true);
      gl.clearBufferuiv(gl.COLOR, 0, new Uint32Array([0, 0, 0, 0]));
      gl.clearDepth(1.0); gl.clear(gl.DEPTH_BUFFER_BIT);
      gl.useProgram(this._pickProg);
      gl.uniformMatrix4fv(this._pickU.uMVP, false, new Float32Array(M));
      gl.uniform1f(this._pickU.uPointSize, base);
      gl.uniform1f(this._pickU.uAttenuate, atten);
      gl.uniform1f(this._pickU.uPtScale, scale);
      gl.uniform1f(this._pickU.uPtMin, base);
      gl.uniform1f(this._pickU.uPtMax, (bo._ptMax || 8.0) * psm * 6.0);
      gl.uniform1f(this._pickU.uRound, this._roundPoints ? 1 : 0);
      gl.uniform1f(this._pickU.uGrow, grow || 0);
      const _cb = this._clipBounds();
      gl.uniform1f(this._pickU.uClipOn, (this._clipActive() && _cb) ? 1 : 0);
      if (_cb) { gl.uniform3f(this._pickU.uClipMin, _cb.mn[0], _cb.mn[1], _cb.mn[2]); gl.uniform3f(this._pickU.uClipMax, _cb.mx[0], _cb.mx[1], _cb.mx[2]); }
      gl.bindVertexArray(this._pickVao);
      gl.bindBuffer(gl.ARRAY_BUFFER, bo._pb);
      gl.enableVertexAttribArray(this._pickAPos);
      gl.vertexAttribPointer(this._pickAPos, 3, gl.FLOAT, false, 0, 0);
      gl.drawArrays(gl.POINTS, 0, bo.count);
      gl.bindVertexArray(null);
    }
    // Точный GPU-пикинг одной точки под курсором (WYSIWYG depth-buffer picking, как в
    // Cesium/Potree/CloudCompare): берёт РЕАЛЬНУЮ видимую точку под курсором по её vertex ID.
    // Не требует точного попадания — берётся ближайшая к курсору видимая точка в радиусе radiusPx.
    // Учитывает окклюзию (тест глубины) и клип-бокс (срез), поэтому за стеной/срезом точки не берутся.
    _pickGPU(sx, sy, radiusPx) {
      if (this.cloudVisible===false || this._cloudDisplay.opacity===0) return null;
      const gl = this.gl; const bo = this.base && this.base[0];
      if (!gl || !bo || !bo.points || !bo._pb || bo._lod || !bo.pos) return null;
      if (!this._pickReady) { this._pickInit(); if (!this._pickReady) return null; }
      if (this._pickW !== this.canvas.width || this._pickH !== this.canvas.height) this._pickResize();
      const rect = this.canvas.getBoundingClientRect();
      if (!rect.width || !rect.height) return null;
      const cw = this.canvas.width, ch = this.canvas.height;
      const scaleX = cw / rect.width, scaleY = ch / rect.height;
      const cxDev = Math.round((sx - rect.left) * scaleX);
      const cyDev = Math.round(ch - (sy - rect.top) * scaleY); // Y снизу вверх
      const R = Math.max(3, Math.round((radiusPx != null ? radiusPx : 20) * scaleX));
      const x0 = Math.max(0, cxDev - R), y0 = Math.max(0, cyDev - R);
      const x1 = Math.min(cw - 1, cxDev + R), y1 = Math.min(ch - 1, cyDev + R);
      const w = x1 - x0 + 1, h = y1 - y0 + 1;
      if (w <= 0 || h <= 0) return null;
      let px = null, id0 = 0;
      // Проход 1: реальный размер точек. Если рядом пусто — проход 2 с «раздутием» (grow),
      // чтобы закрыть зазоры между разреженными сплэтами и всё равно дать снап.
      for (let attempt = 0; attempt < 2 && !id0; attempt++) {
        this._drawPickPass(bo, attempt === 0 ? 0 : 5);
        px = new Uint32Array(w * h);
        gl.bindFramebuffer(gl.FRAMEBUFFER, this._pickFbo);
        gl.readPixels(x0, y0, w, h, gl.RED_INTEGER, gl.UNSIGNED_INT, px);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        for (let k = 0; k < px.length; k++) { if (px[k]) { id0 = 1; break; } }
      }
      gl.viewport(0, 0, cw, ch); gl.useProgram(this.prog);
      if (!px) return null;
      let bestId = 0, bestD = Infinity;
      for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
        const id = px[j * w + i]; if (!id) continue;
        const ddx = (x0 + i) - cxDev, ddy = (y0 + j) - cyDev; const d = ddx * ddx + ddy * ddy;
        if (d < bestD) { bestD = d; bestId = id; }
      }
      if (!bestId) return null;
      const idx = bestId - 1; const P = bo.pos;
      if (idx < 0 || idx * 3 + 2 >= P.length) return null;
      return { id: null, el: null, point: [P[idx * 3], P[idx * 3 + 1], P[idx * 3 + 2]], index: idx };
    }
    // Рендерит ID видимых точек в области и возвращает Set индексов (ближайших к камере в каждом пикселе).
    _gpuVisibleSet(bbox, poly) {
      const gl = this.gl; const bo = this.base && this.base[0];
      if (!gl || !bo || !bo.points || !bo._pb || bo._lod) return null;
      if (!this._pickReady) { this._pickInit(); if (!this._pickReady) return null; }
      if (this._pickW !== this.canvas.width || this._pickH !== this.canvas.height) this._pickResize();
      const cw = this.canvas.width, ch = this.canvas.height;
      const x = Math.max(0, Math.floor(bbox.x)), y = Math.max(0, Math.floor(bbox.y));
      const w = Math.min(cw - x, Math.ceil(bbox.w + (bbox.x - x))), h = Math.min(ch - y, Math.ceil(bbox.h + (bbox.y - y)));
      if (w <= 0 || h <= 0) return new Set();
      const M = this._lastVP || this._vp();
      const psm = this._ptSizeMul || 1;
      const scale = (bo._spacing || 0) * (ch * 0.5 / Math.tan(this._fov / 2)) * 1.25 * psm;
      const atten = (!this._cloudDisplay.pointSize && this._attenuate && scale > 0) ? 1 : 0;
      gl.bindFramebuffer(gl.FRAMEBUFFER, this._pickFbo);
      gl.viewport(0, 0, cw, ch);
      gl.disable(gl.BLEND); gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LESS); gl.depthMask(true);
      gl.clearBufferuiv(gl.COLOR, 0, new Uint32Array([0, 0, 0, 0]));
      gl.clearDepth(1.0); gl.clear(gl.DEPTH_BUFFER_BIT);
      gl.useProgram(this._pickProg);
      gl.uniformMatrix4fv(this._pickU.uMVP, false, new Float32Array(M));
      gl.uniform1f(this._pickU.uPointSize, this._cloudDisplay.pointSize || (bo.pointSize || 2.2) * psm);
      gl.uniform1f(this._pickU.uAttenuate, atten);
      gl.uniform1f(this._pickU.uPtScale, scale);
      gl.uniform1f(this._pickU.uPtMin, 1.0);
      gl.uniform1f(this._pickU.uPtMax, (bo._ptMax || 8.0) * psm);
      gl.uniform1f(this._pickU.uRound, this._roundPoints ? 1 : 0);
      // Расширяем точки в pick-проходе, чтобы «захватить» разрывы между разреженными сплэтами:
      // сплошная передняя поверхность-окклюдер перекрывает фон, и фоновые точки в промежутках больше не просвечивают.
      const grow = this._selGrowPx != null ? this._selGrowPx : (this._selDepthMode === 0 ? 2.5 : 4.0);
      gl.uniform1f(this._pickU.uGrow, grow);
      const cb=this._clipBounds();gl.uniform1f(this._pickU.uClipOn,this._clipActive()?1:0);if(cb){gl.uniform3fv(this._pickU.uClipMin,cb.mn);gl.uniform3fv(this._pickU.uClipMax,cb.mx);}
      gl.bindVertexArray(this._pickVao);
      gl.bindBuffer(gl.ARRAY_BUFFER, bo._pb);
      gl.enableVertexAttribArray(this._pickAPos);
      gl.vertexAttribPointer(this._pickAPos, 3, gl.FLOAT, false, 0, 0);
      gl.drawArrays(gl.POINTS, 0, bo.count);
      gl.bindVertexArray(null);
      const px = new Uint32Array(w * h);
      gl.readPixels(x, y, w, h, gl.RED_INTEGER, gl.UNSIGNED_INT, px);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, cw, ch); gl.useProgram(this.prog);
      const out = new Set();
      const testPoly = poly && typeof window !== 'undefined' && window.PCEdit;
      for (let j = 0; j < h; j++) {
        for (let i = 0; i < w; i++) {
          const id = px[j * w + i]; if (!id) continue;
          if (testPoly && !window.PCEdit.pointInPolygon([x + i + 0.5, y + j + 0.5], poly)) continue;
          out.add(id - 1);
        }
      }
      return out;
    }
    // Область выделения в пикселях фреймбуфера (Y снизу вверх), + полигон для лассо.
    _selRegionDev(kind) {
      const rect = this.canvas.getBoundingClientRect();
      if (!rect.width || !rect.height) return null;
      const sx = this.canvas.width / rect.width, sy = this.canvas.height / rect.height;
      const toDev = (cx, cy) => [(cx - rect.left) * sx, this.canvas.height - (cy - rect.top) * sy];
      if (kind === 'lasso') {
        if (!this._lasso || this._lasso.length < 3) return null;
        const poly = this._lasso.map(p => toDev(p[0], p[1]));
        let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
        for (const p of poly) { if (p[0] < minx) minx = p[0]; if (p[0] > maxx) maxx = p[0]; if (p[1] < miny) miny = p[1]; if (p[1] > maxy) maxy = p[1]; }
        return { bbox: { x: minx, y: miny, w: maxx - minx, h: maxy - miny }, poly };
      }
      if (!this._selStart || !this._selCur) return null;
      const a = toDev(this._selStart[0], this._selStart[1]); const b = toDev(this._selCur[0], this._selCur[1]);
      return { bbox: { x: Math.min(a[0], b[0]), y: Math.min(a[1], b[1]), w: Math.abs(a[0] - b[0]), h: Math.abs(a[1] - b[1]) }, poly: null };
    }
    // Шаг 3 пайплайна: 3D-кластеризация (Euclidean/DBSCAN) — отбрасывает оторванный фон.
    // Работает на ВСЕХ путях (GPU-pick и CPU-фолбэк), поэтому латает утечку фона даже на LOD/octree.
    _clusterFront(idxArr, proj, bandOverride) {
      const mode = this._selDepthMode == null ? 0 : this._selDepthMode;
      if (mode >= 2 || this._selThrough) return idxArr; // насквозь — не чистим
      if (typeof window === 'undefined' || !window.PCEdit || !window.PCEdit.clusterFront) return idxArr;
      const bo = this.base && this.base[0]; if (!bo || !bo.pos) return idxArr;
      const arr = Array.isArray(idxArr) ? idxArr : Array.from(idxArr);
      if (arr.length < 24) return arr;
      const bb = this.bbox; let diag = 8;
      if (bb) { const w = bb.mx[0] - bb.mn[0], h = bb.mx[1] - bb.mn[1], dp = bb.mx[2] - bb.mn[2]; diag = Math.sqrt(w * w + h * h + dp * dp) || 8; }
      // Радиус связности r ≈ шаг скана (по умолчанию ~5 см), но масштабируется от размера облака.
      let voxel = bo._spacing ? bo._spacing * 3 : diag * 0.006;
      voxel = Math.min(Math.max(voxel, diag * 0.002), diag * 0.05);
      // Допуск по глубине за передним кластером: тонко (режим 0) или шире (режим 1).
      const band = (bandOverride != null && bandOverride > 0) ? bandOverride : (mode === 0 ? Math.min(Math.max(diag * 0.01, 0.05), 0.25) : Math.min(Math.max(diag * 0.05, 0.4), 3));
      try {
        return window.PCEdit.clusterFront(bo.pos, arr, { depth: proj && proj.depth, voxel, band });
      } catch (e) { console.warn('clusterFront → без кластеризации', e); return arr; }
    }
    // Сводит «сырой» выбор (по 2D-контуру, насквозь) к видимым точкам согласно режиму глубины.
    _resolveVisibleSelection(raw, proj, kind) {
      const mode = this._selDepthMode == null ? 0 : this._selDepthMode;
      if (mode >= 2 || this._selThrough) return raw; // насквозь — весь луч
      try {
        const region = this._selRegionDev(kind);
        if (region) {
          const vis = this._gpuVisibleSet(region.bbox, region.poly);
          if (vis && vis.size) {
            // Ограничиваем видимый набор точками, чьи ЦЕНТРЫ реально попали в рамку/лассо (raw):
            // раздутые окклюдеры латают глубину, но их сплэты «заезжают» за границу выделения,
            // из-за чего цеплялись точки чуть за контуром. Пересечение с raw убирает краевой
            // перезахват и НЕ возвращает эффект «насквозь» (фон в зазорах перекрыт по глубине).
            const rawSet = (raw instanceof Set) ? raw : new Set(raw);
            const visIn = [];
            vis.forEach(i => { if (rawSet.has(i)) visIn.push(i); });
            const baseVis = visIn.length ? visIn : Array.from(vis); // фолбэк, если пересечение пусто
            if (mode === 0) {
              // Whole near object, not only the visible skin: from the front surface
              // back to the first depth gap (before the wall). Thresholds ABSOLUTE (from spacing), not scene size.
              const dep = proj.depth;
              const bo0 = this.base && this.base[0];
              const sp0 = (bo0 && bo0._spacing > 0) ? bo0._spacing : 0.02;
              const gapTh0 = Math.max(sp0 * 8, 0.2);
              const maxBand0 = Math.max(sp0 * 30, 0.6);
              let front0 = Infinity;
              for (let k = 0; k < baseVis.length; k++) { const d = dep[baseVis[k]]; if (d === d && d < front0) front0 = d; }
              if (!(front0 < Infinity)) return this._clusterFront(baseVis, proj);
              const ds0 = [];
              for (let k = 0; k < raw.length; k++) { const d = dep[raw[k]]; if (d === d && d >= front0 - sp0) ds0.push(d); }
              ds0.sort(function (a, b) { return a - b; });
              let cut0 = front0 + maxBand0, prev0 = front0;
              for (let k = 0; k < ds0.length; k++) { const d = ds0[k]; if (d - prev0 > gapTh0) { cut0 = prev0; break; } prev0 = d; if (d - front0 >= maxBand0) { cut0 = front0 + maxBand0; break; } }
              const set0 = new Set(baseVis);
              for (let k = 0; k < raw.length; k++) { const i = raw[k]; const d = dep[i]; if (d === d && d >= front0 - sp0 && d <= cut0) set0.add(i); }
              return this._clusterFront(Array.from(set0), proj, (cut0 - front0) + sp0);
            } // строго видимая поверхность + очистка оторванного фона
            // режим «с запасом»: видимое + тонкий слой сразу за ЛОКАЛЬНОЙ видимой поверхностью.
            // Раньше брали один глобальный ближний край (nearFront) на всё выделение — на наклонных/
            // протяжённых поверхностях это захватывало лишнее. Теперь строим локальную карту ближней
            // глубины по видимым точкам (baseVis) в экранных ячейках и добавляем точку, если её глубина
            // не дальше локального фронта + band (per-pixel допуск глубины). Пустая ячейка — фолбэк на глобальный фронт.
            const depth = proj.depth, xy = proj.xy;
            const bb = this.bbox; let diag = 8;
            if (bb) { const w = bb.mx[0] - bb.mn[0], h = bb.mx[1] - bb.mn[1], dp = bb.mx[2] - bb.mn[2]; diag = Math.sqrt(w * w + h * h + dp * dp) || 8; }
            const band = Math.min(Math.max(diag * 0.03, 0.6), 3);
            const gw = 64, gh = 64; // экранная сетка ближней глубины (NDC → ячейки)
            const cellIdx = (x, y) => {
              let gx = ((x + 1) * 0.5 * gw) | 0; let gy = ((1 - (y + 1) * 0.5) * gh) | 0;
              if (gx < 0) gx = 0; else if (gx >= gw) gx = gw - 1;
              if (gy < 0) gy = 0; else if (gy >= gh) gy = gh - 1;
              return gy * gw + gx;
            };
            const near = new Float32Array(gw * gh); near.fill(Infinity);
            let globalNear = Infinity;
            for (let k = 0; k < baseVis.length; k++) {
              const i = baseVis[k]; const d = depth[i]; if (d !== d) continue;
              if (d < globalNear) globalNear = d;
              const x = xy[i * 2], y = xy[i * 2 + 1]; if (x < -1 || x > 1 || y < -1 || y > 1) continue;
              const ci = cellIdx(x, y); if (d < near[ci]) near[ci] = d;
            }
            const set = new Set(baseVis);
            for (let k = 0; k < raw.length; k++) {
              const i = raw[k]; const d = depth[i]; if (d !== d) continue;
              let ln = near[cellIdx(xy[i * 2], xy[i * 2 + 1])];
              if (!(ln < Infinity)) ln = globalNear; // в пустой ячейке — глобальный фронт (безопасный фолбэк)
              if (d <= ln + band) set.add(i);
            }
            return this._clusterFront(Array.from(set), proj);
          }
        }
      } catch (e) { console.warn('GPU visible-select → CPU fallback', e); }
      return this._clusterFront(this._visibleFilter(raw, proj), proj); // запасной путь (CPU z-буфер) + кластеризация
    }
    // Ограничивает выбор ближним слоем по глубине (чтобы рамка/лассо не захватывали точки «насквозь»).
    // Оставляет только реально видимые точки (не перекрытые ближней поверхностью) — как «Segment visible»
    // в CloudCompare/Potree. Строим экранный z-буфер по спроецированным точкам и берём то, что впереди, а не «насквозь».
    _visibleFilter(idx, proj) {
      const mode = this._selDepthMode == null ? 0 : this._selDepthMode; // 0 видимые точно / 1 видимые с запасом / 2 насквозь
      if (mode >= 2 || this._selThrough || !idx || !idx.length || !proj || !proj.xy || !proj.depth) return idx;
      const xy = proj.xy, depth = proj.depth, n = proj.count | 0;
      const rect = this.canvas.getBoundingClientRect();
      const cw = Math.max(1, rect.width), ch = Math.max(1, rect.height);
      const cellPx = 4; // размер ячейки z-буфера в пикселях
      const gw = Math.max(1, Math.ceil(cw / cellPx)), gh = Math.max(1, Math.ceil(ch / cellPx));
      const grid = new Float32Array(gw * gh); grid.fill(Infinity);
      const cellOf = (x, y) => {
        let gx = ((x * 0.5 + 0.5) * gw) | 0; let gy = ((1 - (y * 0.5 + 0.5)) * gh) | 0;
        if (gx < 0) gx = 0; else if (gx >= gw) gx = gw - 1;
        if (gy < 0) gy = 0; else if (gy >= gh) gy = gh - 1;
        return gy * gw + gx;
      };
      // Карта ближайшей глубины по ВСЕМ точкам (меньше = ближе к камере) — это передняя видимая поверхность.
      for (let i = 0; i < n; i++) {
        const x = xy[i * 2], y = xy[i * 2 + 1], d = depth[i];
        if (d !== d) continue; if (x < -1 || x > 1 || y < -1 || y > 1) continue;
        const ci = cellOf(x, y); if (d < grid[ci]) grid[ci] = d;
      }
      const bb = this.bbox; let diag = 8;
      if (bb) { const w = bb.mx[0] - bb.mn[0], h = bb.mx[1] - bb.mn[1], dp = bb.mx[2] - bb.mn[2]; diag = Math.sqrt(w * w + h * h + dp * dp) || 8; }
      // Допуск по глубине (толщина видимого слоя, метры): растёт с дистанцией (перспектива), но ограничен.
      const tolBase = mode === 0 ? 0.12 : 0.6;
      const tolMax = mode === 0 ? Math.min(Math.max(diag * 0.006, 0.12), 0.5) : Math.min(Math.max(diag * 0.04, 0.6), 3);
      const tolRel = mode === 0 ? 0.01 : 0.03;
      const out = [];
      for (let k = 0; k < idx.length; k++) {
        const i = idx[k]; const x = xy[i * 2], y = xy[i * 2 + 1], d = depth[i];
        if (d !== d) continue;
        const near = grid[cellOf(x, y)];
        const tol = Math.min(tolMax, tolBase + d * tolRel);
        if (d <= near + tol) out.push(i); // точка — передняя в своём пикселе (не перекрыта)
      }
      return out.length ? out : idx;
    }
    _depthFilter(idx, depth) {
      const mode = this._selDepthMode == null ? 0 : this._selDepthMode; // 0 тонко / 1 шире / 2 насквозь
      if (mode >= 2 || this._selThrough || !idx || !idx.length || !depth) return idx;
      // Собираем валидные глубины выбранных точек и сортируем.
      const ds = [];
      for (let k = 0; k < idx.length; k++) { const d = depth[idx[k]]; if (d === d) ds.push(d); }
      if (!ds.length) return idx;
      ds.sort((a, b) => a - b);
      const bb = this.bbox; let diag = 8;
      if (bb) { const w = bb.mx[0] - bb.mn[0], h = bb.mx[1] - bb.mn[1], dp = bb.mx[2] - bb.mn[2]; diag = Math.sqrt(w * w + h * h + dp * dp) || 8; }
      // Робастный ближний край (2-й процентиль — отсекаем единичные выбросы у камеры).
      const dmin = ds[Math.floor(ds.length * 0.02)];
      // Ширина ближнего слоя (метры): тонко или шире, с ограничением по масштабу облака.
      const bandAbs = mode === 0 ? 0.4 : 1.4;
      const band = Math.min(Math.max(diag * (mode === 0 ? 0.015 : 0.05), bandAbs), diag * 0.5);
      // Обнаружение разрыва по глубине: если за ближним объектом есть пустота (напр. до стены), отсекаем дальний кластер.
      const gapTh = Math.max(band * 0.6, 0.15);
      let cutoff = dmin + band;
      let prev = dmin;
      for (let k = 0; k < ds.length; k++) {
        const d = ds[k]; if (d < dmin) continue;
        if (d - prev > gapTh) { cutoff = Math.min(cutoff, prev); break; }
        prev = d;
        if (d - dmin >= band) break;
      }
      const out = [];
      for (let k = 0; k < idx.length; k++) { const i = idx[k]; const d = depth[i]; if (d === d && d <= cutoff) out.push(i); }
      return out.length ? out : idx;
    }
    // Режим глубины выделения: 0 = тонкий ближний слой, 1 = слой шире, 2 = насквозь (весь луч).
    setSelectDepthMode(mode) { mode = mode | 0; if (mode < 0) mode = 0; if (mode > 2) mode = 2; this._selDepthMode = mode; this._selThrough = (mode >= 2); this.render(); return mode; }
    setSelectThrough(on) { this.setSelectDepthMode(on ? 2 : 0); return this._selThrough; }
    setSelectDepth(frac) { this._selDepthFrac = Math.max(0.005, Math.min(1, Number(frac) || 0.04)); return this._selDepthFrac; }
    // Расширение точек-окклюдеров в pick-проходе (px). Больше = агрессивнее «латает» разрывы разреженного облака.
    setSelectGrowPx(px) { const v = Number(px); this._selGrowPx = (v >= 0 && v <= 20) ? v : null; return this._selGrowPx; }
    _rectToNDC() {
      const rect = this.canvas.getBoundingClientRect();
      const toNDC = (cx, cy) => [(cx - rect.left) / rect.width * 2 - 1, 1 - (cy - rect.top) / rect.height * 2];
      const a = toNDC(this._selStart[0], this._selStart[1]); const b = toNDC(this._selCur[0], this._selCur[1]);
      return { x0: a[0], y0: a[1], x1: b[0], y1: b[1] };
    }
    _finishMarquee(additive, subtract) {
      if (typeof window === 'undefined' || !window.PCEdit) return;
      const proj = this._projectBase(); const rect = this._rectToNDC();
      const raw = window.PCEdit.selectByRect(proj.xy, proj.count, rect);
      const idx = this._clipFilter(this._resolveVisibleSelection(raw, proj, 'rect'));
      const add = additive || (this._selAccumulate && !subtract);
      let set;
      if (subtract) { set = new Set(this._sel || []); for (const i of idx) set.delete(i); }
      else { set = (add && this._sel) ? this._sel : new Set(); for (const i of idx) set.add(i); }
      this._sel = set; this._buildSelHighlight();
      if (typeof this.onEditSelect === 'function') this.onEditSelect(this._sel.size);
    }
    _buildSelHighlight() {
      const bo = this.base && this.base[0];
      if (this._selObj) { this._delObjs([this._selObj]); this._selObj = null; }
      if (!bo || !this._sel || !this._sel.size) { this.render(); return; }
      const P = bo.pos; const total = this._sel.size;
      // НЕ строим миллионы маркеров — иначе экран заливается квадратами и всё виснет.
      const MAXH = 250000;
      const stride = total > MAXH ? Math.ceil(total / MAXH) : 1;
      const cap = Math.min(total, MAXH);
      const pos = new Float32Array(cap * 3);
      let j = 0, c = 0;
      this._sel.forEach(function (i) { if ((c++ % stride) !== 0) return; if (j >= cap) return; pos[j * 3] = P[i * 3]; pos[j * 3 + 1] = P[i * 3 + 1]; pos[j * 3 + 2] = P[i * 3 + 2]; j++; });
      const posOut = (j === cap) ? pos : pos.subarray(0, j * 3);
      const selSize = Math.min((bo._ptMax || 6) + 1, 7); // компактные маркеры
      const o = this._makeObj({ id: null, points: true, pos: posOut, col: null, pointSize: selSize, color: hex2rgb('#e5484d'), status: 'none' });
      o._spacing = 0; o._ptMax = selSize; o._isSel = true;
      this._selObj = o; this.render();
    }
    clearSelection() { this._sel = new Set(); if (this._selObj) { this._delObjs([this._selObj]); this._selObj = null; } if (typeof this.onEditSelect === 'function') this.onEditSelect(0); this.render(); }
    selectionCount() { return this._sel ? this._sel.size : 0; }
    invertSelection() {
      const bo = this.base && this.base[0]; if (!bo || typeof window === 'undefined' || !window.PCEdit) return;
      const n = bo.pos.length / 3; this._sel = new Set(window.PCEdit.invertSelection(this._sel || new Set(), n)); this._buildSelHighlight();
      if (typeof this.onEditSelect === 'function') this.onEditSelect(this._sel.size);
    }
    deleteSelection() { return this._applyEdit(false); }
    cropToSelection() { return this._applyEdit(true); }
    // Принудительное удаление ВСЕХ выделенных точек без защиты конструктива и без
    // латания дыр — отдельный режим обрезки для удаления ненужного мусора.
    deleteSelectionForce() {
      const wasProtect = this._planeProtect, wasHoleFill = this._holeFill;
      this._planeProtect = false; this._holeFill = false;
      try { return this._applyEdit(false); }
      finally { this._planeProtect = wasProtect; this._holeFill = wasHoleFill; this._lastProtectRemoved = 0; }
    }
    _pushRemovedEditUndo(result, addedFill) {
      if (!result || !result.removedPos || !result.removedPos.length) return false;
      const removedAttributes = Object.assign({}, result.removedAttributes || {});
      EDIT_POINT_ATTRIBUTES.forEach(function (key) {
        const cap = key.charAt(0).toUpperCase() + key.slice(1);
        if (!removedAttributes[key] && result['removed' + cap]) removedAttributes[key] = result['removed' + cap];
      });
      (this._undo = this._undo || []).push({
        removedPos: result.removedPos, removedCol: result.removedCol || null,
        removedAttributes: removedAttributes, addedFill: addedFill | 0
      });
      if (this._undo.length > 6) this._undo.shift();
      return true;
    }
    _pushSnapshotEditUndo(bo) {
      if (!bo || !bo.pos) return false;
      const attrs = _editAttrsFor(this, bo);
      (this._undo = this._undo || []).push({
        pos: bo.pos, col: bo.col || null, intensity: attrs.intensity, classification: attrs.classification,
        snapshot: true
      });
      if (this._undo.length > 6) this._undo.shift();
      return true;
    }
    _editCloudInput(bo) {
      return Object.assign({ pos: bo.pos, col: bo.col || null }, _editAttrsFor(this, bo));
    }
    _loadEditedResult(result, bo) {
      const attrs = {};
      EDIT_POINT_ATTRIBUTES.forEach(function (key) { attrs[key] = result && result[key] || null; });
      this.loadCloud(Object.assign({
        pos: result.pos, col: result.col || null, count: result.pos.length / 3,
        spacing: (bo && bo._spacing) || 0
      }, attrs), { preserveView: true });
    }
    _applyEdit(keep) {
      const bo = this.base && this.base[0]; if (!bo || !this._sel || !this._sel.size || typeof window === 'undefined' || !window.PCEdit) return 0;
      if (!keep && this._planeProtect && window.PCEdit.protectFloorLocal) {
        // v1051: защита конструктива только через ТОЧНУЮ ЛОКАЛЬНУЮ подгонку плоскостей
        // вокруг выделения (пол/стены/потолок рядом с объектом). Глобальные RANSAC-
        // плоскости убраны из ручного удаления: на большой сцене (>100 м) малая ошибка
        // нормали давала сдвиг в десятки см — защита то «не спасала» дальние стены, то «намертво»
        // блокировала удаление мусора в воздухе, лежавшего вблизи плоскости.
        const beforeN = this._sel.size; let sel = Array.from(this._sel); const sp = bo._spacing || 0;
        try { const k = window.PCEdit.protectFloorLocal({ pos: bo.pos }, sel, { spacing: sp, maxPlanes: 8, protTol: (this._protectWidthM > 0 ? this._protectWidthM : undefined), minFrac: (this._protectMinFrac > 0 ? this._protectMinFrac : undefined), smart: (this._smartProtect === false ? false : true) }); if (Array.isArray(k)) sel = k; } catch (e) {}
        this._lastProtectRemoved = Math.max(0, beforeN - sel.length);
        this._sel = new Set(sel); if (!this._sel.size) { this._buildSelHighlight(); if (typeof this.onEditSelect === "function") this.onEditSelect(0); return 0; }
      } else { this._lastProtectRemoved = 0; }
      const cur = Object.assign({ pos: bo.pos, col: bo.col || null }, _editAttrsFor(this, bo));
      const r = keep ? window.PCEdit.keepByIndices(cur, this._sel) : window.PCEdit.deleteByIndices(cur, this._sel);
      // Латание дыр на защищённых плоскостях (пол/стены) после удаления объекта (человек/мебель).
      let addedFill = 0;
      if (!keep && this._holeFill && this._planeProtect && this._planes && this._planes.length && r.removedPos && r.removedPos.length && window.PCEdit.fillPlaneHoles) {
        try {
          const sp2 = bo._spacing || 0;
          const fr = window.PCEdit.fillPlaneHoles({ pos: r.pos, col: r.col }, this._planes, r.removedPos, { step: sp2 > 0 ? sp2 : undefined });
          if (fr && fr.added) {
            const np = new Float32Array(r.pos.length + fr.addedPos.length); np.set(r.pos, 0); np.set(fr.addedPos, r.pos.length);
            let nc = r.col;
            if (r.col && fr.addedCol) { nc = new r.col.constructor(r.col.length + fr.addedCol.length); nc.set(r.col, 0); nc.set(fr.addedCol, r.col.length); }
            r.pos = np; r.col = nc; addedFill = fr.added;
            EDIT_POINT_ATTRIBUTES.forEach(function (key) {
              if (!r[key]) return;
              const expanded = new r[key].constructor(r[key].length + fr.added);
              expanded.set(r[key], 0);
              r[key] = expanded; // synthetic fill points are intentionally unclassified/zero-intensity
            });
          }
        } catch (e) { console.warn('fillPlaneHoles', e); }
      }
      // Компактный undo: храним ТОЛЬКО удалённые точки + число синтетических точек-заплаток (для отката).
      this._pushRemovedEditUndo(r, addedFill);
      this._sel = new Set(); if (this._selObj) { this._delObjs([this._selObj]); this._selObj = null; }
      this.loadCloud(Object.assign({ pos: r.pos, col: r.col, count: r.pos.length / 3, spacing: (bo && bo._spacing) || 0 },
        r.intensity ? { intensity: r.intensity } : {}, r.classification ? { classification: r.classification } : {}), { preserveView: true });
      if (typeof this.onEditSelect === 'function') this.onEditSelect(0);
      if (typeof this.onEditChange === 'function') this.onEditChange(r.pos.length / 3);
      return r.removed;
    }
    undoEdit() {
      if (!this._undo || !this._undo.length) return false;
      const prev = this._undo.pop();
      if (prev && prev.classificationEdit) {
        const bo = this.base && this.base[0];
        const current = this._classificationLabels;
        const n = bo && bo.pos ? Math.floor(bo.pos.length / 3) : 0;
        const indices = prev.indices;
        const hasSnapshot = prev.previousLabels instanceof Uint8Array && prev.previousLabels.length === n;
        const hasDelta = indices && prev.previousValues && prev.previousValues.length === indices.length;
        if (!bo || !current || current.length !== n ||
            (prev.hadClassification && !hasSnapshot && !hasDelta)) {
          this._undo.push(prev);
          return false;
        }
        if (prev.hadClassification) {
          let restored;
          if (hasSnapshot) {
            restored = prev.previousLabels;
          } else {
            restored = new Uint8Array(current);
            for (let i = 0; i < indices.length; i++) {
              if (indices[i] >= n) { this._undo.push(prev); return false; }
              restored[indices[i]] = prev.previousValues[i];
            }
          }
          if (!this.applyClassificationLabels(restored)) { this._undo.push(prev); return false; }
          this._lastClassificationPromise = this._persistClassificationAsset(
            this._classificationLabels,
            'manual LAS/ASPRS class assignment (undo)',
            { undo: true, restoredPointCount: prev.changedPointCount || indices.length },
            { restoredPointCount: prev.changedPointCount || indices.length },
            prev.target
          );
        } else {
          if (!this.clearClassificationLabels()) { this._undo.push(prev); return false; }
          this._lastClassificationPromise = this._persistClassificationClear(prev.target);
        }
        return true;
      }
      const bo = this.base && this.base[0];
      let pos, col, restoredAttrs = {};
      if (prev.removedPos) {
        // Возвращаем удалённые точки обратно (порядок для облака не важен).
        let curPos = bo ? bo.pos : new Float32Array(0);
        let curCol = bo ? (bo.col || null) : null;
        const currentAttrs = _editAttrsFor(this, bo);
        const af = (prev.addedFill | 0);
        if (af > 0) {
          curPos = curPos.subarray(0, Math.max(0, curPos.length - af * 3));
          if (curCol) curCol = curCol.subarray(0, Math.max(0, curCol.length - af * 3));
          EDIT_POINT_ATTRIBUTES.forEach(function (key) { currentAttrs[key] = _removeTail(currentAttrs[key], af); });
        }
        const rp = prev.removedPos, rc = prev.removedCol || null;
        pos = new Float32Array(curPos.length + rp.length);
        pos.set(curPos, 0); pos.set(rp, curPos.length);
        if (curCol && rc) { col = new curCol.constructor(curCol.length + rc.length); col.set(curCol, 0); col.set(rc, curCol.length); } else { col = null; }
        EDIT_POINT_ATTRIBUTES.forEach(function (key) {
          const removed = (prev.removedAttributes && prev.removedAttributes[key]) || null;
          const joined = _concatPointAttribute(currentAttrs[key], removed);
          if (joined) restoredAttrs[key] = joined;
        });
      } else if (prev.pos) {
        pos = prev.pos; col = prev.col || null;
        EDIT_POINT_ATTRIBUTES.forEach(function (key) { if (prev[key]) restoredAttrs[key] = prev[key]; });
        if (prev.srcXform !== undefined) this._srcXform = prev.srcXform;
        if (prev.crsWkt !== undefined) this._srcCrs = prev.crsWkt;
      } else { return false; }
      this._sel = new Set(); if (this._selObj) { this._delObjs([this._selObj]); this._selObj = null; }
      this.loadCloud(Object.assign({ pos: pos, col: col, count: pos.length / 3, spacing: (bo && bo._spacing) || 0 }, restoredAttrs), { preserveView: true });
      if (typeof this.onEditSelect === 'function') this.onEditSelect(0);
      if (typeof this.onEditChange === 'function') this.onEditChange(pos.length / 3);
      return true;
    }
    canUndo() { return !!(this._undo && this._undo.length); }
    getEditedCloud() {
      const bo = this.base && this.base[0]; if (!bo) return null;
      return { pos: bo.pos, col: bo.col || null, intensity:this._intensityValues||null, classification:this._classificationLabels||null };
    }
    getSourceCloud() {
      const c = this.getEditedCloud(); if (!c || !c.pos) return null;
      const tr = this._srcXform, meta = Object.assign({}, this._srcMeta || {});
      if (tr && tr.t && tr.t.length >= 3) meta.srcXform = { axis:tr.axis, t:Array.prototype.slice.call(tr.t,0,3).map(Number) };
      else delete meta.srcXform;
      if (this._srcCrs) meta.crsWkt = this._srcCrs; else delete meta.crsWkt;
      if (this._srcUnits) meta.units = this._srcUnits; else delete meta.units;
      if (this._attributeWarnings && this._attributeWarnings.length) meta.attributeWarnings = this._attributeWarnings.slice();
      else delete meta.attributeWarnings;
      const n = c.pos.length / 3;
      if (!tr || !tr.t || tr.t.length < 3) return { pos:c.pos, col:c.col||null, intensity:c.intensity||null,
        classification:c.classification||null, count:n, meta:meta };
      const p = new Float64Array(n * 3), t = tr.t;
      if (tr.axis === 'zup') for (let i = 0; i < n; i++) { p[i*3] = c.pos[i*3] + t[0]; p[i*3+1] = -c.pos[i*3+2] + t[1]; p[i*3+2] = c.pos[i*3+1] + t[2]; }
      else for (let i = 0; i < n; i++) { p[i*3] = c.pos[i*3] + t[0]; p[i*3+1] = c.pos[i*3+1] + t[1]; p[i*3+2] = c.pos[i*3+2] + t[2]; }
      return { pos:p, col:c.col||null, intensity:c.intensity||null, classification:c.classification||null, count:n, meta:meta };
    }
    // Чистка шума/выбросов прямо в приложении (без Python) через воксельный фильтр плотности.
    cleanInApp(opts) {
      const bo = this.base && this.base[0];
      if (!bo || !bo.pos || typeof window === 'undefined' || !window.PCEdit || !window.PCEdit.cleanVoxelDensity) return 0;
      const o = Object.assign({}, opts || {});
      if (o.voxel == null && bo._spacing > 0) o.voxel = bo._spacing * (o.voxelFactor || 3);
      const r = this._applyEditOp(function (sub) { return window.PCEdit.cleanVoxelDensity(sub, o); });
      if (!r || !r.removed) return 0;
      this._pushRemovedEditUndo(r, 0);
      this._sel = new Set(); if (this._selObj) { this._delObjs([this._selObj]); this._selObj = null; }
      this._loadEditedResult(r, bo);
      if (typeof this.onEditSelect === 'function') this.onEditSelect(0);
      if (typeof this.onEditChange === 'function') this.onEditChange(r.pos.length / 3);
      return r.removed;
    }

    // Удаление ОТСОЕДИНЁННЫХ кластеров (летающий мусор / отдельные объекты), не только шум.
    cleanClustersInApp(opts) {
      const bo = this.base && this.base[0];
      if (!bo || !bo.pos || typeof window === 'undefined' || !window.PCEdit || !window.PCEdit.cleanClusters) return 0;
      const o = Object.assign({}, opts || {});
      if (o.voxel == null && bo._spacing > 0) o.voxel = bo._spacing * (o.connect || 4);
      const r = this._applyEditOp(function (sub) { return window.PCEdit.cleanClusters(sub, o); });
      if (!r || !r.removed) return 0;
      this._pushRemovedEditUndo(r, 0);
      this._sel = new Set(); if (this._selObj) { this._delObjs([this._selObj]); this._selObj = null; }
      this._loadEditedResult(r, bo);
      if (typeof this.onEditSelect === 'function') this.onEditSelect(0);
      if (typeof this.onEditChange === 'function') this.onEditChange(r.pos.length / 3);
      return r.removed;
    }

    cleanIslandsInApp(opts) {
      const bo = this.base && this.base[0];
      if (!bo || !bo.pos || typeof window === 'undefined' || !window.PCEdit || !window.PCEdit.cleanClusters) return 0;
      const n = bo.pos.length / 3;
      const o = Object.assign({}, opts || {});
      const factor = o.voxelFactor || 2;
      if (o.voxel == null && bo._spacing > 0) o.voxel = bo._spacing * factor;
      if (o.minClusterPts == null) o.minClusterPts = Math.max(120, Math.round(n * 0.0003));
      let r = this._applyEditOp(function (sub) { return window.PCEdit.cleanClusters(sub, o); });
      if (!r) return 0;
      // v1048: второй микропроход убирает одиночные «мушки», которые остаются
      // после удаления островков (они примыкают к большому кластеру, поэтому
      // выживают при связном анализе). Тесный радиус (≈2·шаг) + минимум соседей:
      // изолированные точки удаляются, а поверхности (пол/стены/фасад) — нет.
      let curPos = r.pos, curCol = r.col, remPos = r.removedPos || null, remCol = r.removedCol || null, remN = r.removed | 0;
      let curIntensity = r.intensity || null, curClassification = r.classification || null;
      let removedAttributes = Object.assign({}, r.removedAttributes || {});
      if (!this._clipActive() && o.despeckle !== false && window.PCEdit.cleanRadiusOutliers && curPos && curPos.length && bo._spacing > 0) {
        const rr = window.PCEdit.cleanRadiusOutliers({
          pos: curPos, col: curCol || null, intensity: curIntensity, classification: curClassification
        }, { radius: bo._spacing * (o.despeckleRadius || 3), minNeighbors: (o.despeckleMinN || 1) });
        if (rr && rr.removed && rr.removed <= n * (o.despeckleMaxFrac || 0.03)) {
          curPos = rr.pos; curCol = rr.col; curIntensity = rr.intensity || null; curClassification = rr.classification || null; remN += rr.removed | 0;
          if (rr.removedPos && rr.removedPos.length) {
            if (remPos && remPos.length) { const m = new Float32Array(remPos.length + rr.removedPos.length); m.set(remPos, 0); m.set(rr.removedPos, remPos.length); remPos = m; } else { remPos = rr.removedPos; }
            if (remCol && remCol.length && rr.removedCol && rr.removedCol.length) { const mc = new remCol.constructor(remCol.length + rr.removedCol.length); mc.set(remCol, 0); mc.set(rr.removedCol, remCol.length); remCol = mc; } else if (rr.removedCol && rr.removedCol.length && !(remCol && remCol.length)) { remCol = rr.removedCol; }
            const nextRemoved = rr.removedAttributes || {};
            EDIT_POINT_ATTRIBUTES.forEach(function (key) {
              const left = removedAttributes[key] || null, right = nextRemoved[key] || null;
              if (left && right) removedAttributes[key] = _concatPointAttribute(left, right);
              else if (right) removedAttributes[key] = right;
            });
          }
        }
      }
      if (remN <= 0) return 0;
      r = Object.assign({}, r, { pos: curPos, col: curCol, intensity: curIntensity, classification: curClassification,
        removed: remN, removedPos: remPos, removedCol: remCol, removedAttributes: removedAttributes });
      EDIT_POINT_ATTRIBUTES.forEach(function (key) {
        const cap = key.charAt(0).toUpperCase() + key.slice(1);
        if (removedAttributes[key]) r['removed' + cap] = removedAttributes[key];
      });
      this._pushRemovedEditUndo(r, 0);
      this._sel = new Set(); if (this._selObj) { this._delObjs([this._selObj]); this._selObj = null; }
      this._loadEditedResult(r, bo);
      if (typeof this.onEditSelect === 'function') this.onEditSelect(0);
      if (typeof this.onEditChange === 'function') this.onEditChange(curPos.length / 3);
      return remN;
    }

    cleanAutoInApp(opts) {
      const bo = this.base && this.base[0];
      if (!bo || !bo.pos || typeof window === 'undefined' || !window.PCEdit || !window.PCEdit.cleanAuto) return null;
      const o = Object.assign({}, opts || {});
      if (o.voxel == null && bo._spacing > 0) o.voxel = bo._spacing * (o.voxelFactor || 3);
      const r = this._applyEditOp(function (sub) { return window.PCEdit.cleanAuto(sub, o); });
      if (!r) return null;
      if (r.removed) this._pushRemovedEditUndo(r, 0);
      if (r.removed) {
        this._sel = new Set(); if (this._selObj) { this._delObjs([this._selObj]); this._selObj = null; }
        this._loadEditedResult(r, bo);
        if (typeof this.onEditSelect === 'function') this.onEditSelect(0);
        if (typeof this.onEditChange === 'function') this.onEditChange(r.pos.length / 3);
      }
      return { removed: r.removed | 0, passes: r.passes | 0, breakdown: r.breakdown || null };
    }
    setHoleFill(on) { this._holeFill = !!on; return this._holeFill; }
    setSmartClean(on) { on = !!on; this._smartClean = on; if (on) { this.setSelectDepthMode(1); this.setPlaneProtect(true); this._holeFill = true; } else { this._holeFill = false; } return on; }
    detectFloorWalls(opts){var bo=this.base&&this.base[0];if(!bo||!bo.pos||typeof window==='undefined'||!window.PCEdit||!window.PCEdit.detectPlanes)return [];this._planes=window.PCEdit.detectPlanes(bo.pos,bo.pos.length/3,Object.assign({maxPlanes:8,minFrac:0.02,tol:(bo._spacing>0?Math.max(bo._spacing*6,0.10):undefined)},opts||{}));return this._planes;}
    setPlaneProtect(on){this._planeProtect=!!on;if(this._planeProtect&&!(this._planes&&this._planes.length))this.detectFloorWalls();return this._planeProtect;}
    getPlaneProtect(){return !!this._planeProtect;}
    setProtectWidth(mm){var v=parseFloat(mm);this._protectWidthM=(isFinite(v)&&v>0)?v/1000:0;return this._protectWidthM;}
    getProtectWidth(){return (this._protectWidthM>0?this._protectWidthM*1000:0);}
    setProtectMinFrac(f){var v=parseFloat(f);this._protectMinFrac=(isFinite(v)&&v>0)?v:0;return this._protectMinFrac;}
    getProtectMinFrac(){return (this._protectMinFrac>0?this._protectMinFrac:0);}
    setSmartProtect(on){this._smartProtect=(on!==false);return this._smartProtect;}
    getSmartProtect(){return this._smartProtect!==false;}
    _pickIndex(cx,cy){var bo=this.base&&this.base[0];if(!bo||!bo.pos)return -1;var hit=this._pick(cx,cy);if(!hit||!hit.point)return -1;if(hit.index!=null&&hit.index>=0)return hit.index|0;var P=bo.pos,n=P.length/3;var px=hit.point[0],py=hit.point[1],pz=hit.point[2];var best=-1,bd=Infinity;var step=n>1500000?Math.ceil(n/1500000):1;for(var i=0;i<n;i+=step){var dx=P[i*3]-px,dy=P[i*3+1]-py,dz=P[i*3+2]-pz;var d=dx*dx+dy*dy+dz*dz;if(d<bd){bd=d;best=i;}}return best;}
    magicWandAt(cx,cy){var bo=this.base&&this.base[0];if(!bo||!bo.pos||!window.PCEdit||!window.PCEdit.magicWand)return 0;var seed=this._pickIndex(cx,cy);if(seed<0)return 0;var sp=bo._spacing||0;var voxel=sp>0?sp*2:undefined;var planes=null;if(this._planeProtect){if(!(this._planes&&this._planes.length))this.detectFloorWalls();planes=this._planes;}var idx=window.PCEdit.magicWand(seed,bo.pos,bo.pos.length/3,{voxel:voxel,planes:planes});this._sel=new Set(this._clipFilter(idx));this._buildSelHighlight();if(typeof this.onEditSelect==='function')this.onEditSelect(this._sel.size);this.render();return this._sel.size;}
    selectColorAt(cx,cy,tol){var bo=this.base&&this.base[0];if(!bo||!bo.pos||!bo.col||!window.PCEdit||!window.PCEdit.selectByColor)return 0;var seed=this._pickIndex(cx,cy);if(seed<0)return 0;var c=bo.col;var scaled=(c[seed*3]<=1.0001&&c[seed*3+1]<=1.0001&&c[seed*3+2]<=1.0001);var sRGB=[c[seed*3],c[seed*3+1],c[seed*3+2]].map(function(v){return scaled?v*255:v;});var idx=window.PCEdit.selectByColor(c,bo.pos.length/3,sRGB,{tol:tol||40});this._sel=new Set(this._clipFilter(idx));this._buildSelHighlight();if(typeof this.onEditSelect==='function')this.onEditSelect(this._sel.size);this.render();return this._sel.size;}
    selectSphereAt(cx,cy,radius){var bo=this.base&&this.base[0];if(!bo||!bo.pos||!window.PCEdit||!window.PCEdit.selectBySphere)return 0;var hit=this._pick(cx,cy);if(!hit||!hit.point)return 0;var idx=window.PCEdit.selectBySphere(bo.pos,bo.pos.length/3,hit.point,radius||0.5);this._sel=new Set(this._clipFilter(idx));this._buildSelHighlight();if(typeof this.onEditSelect==='function')this.onEditSelect(this._sel.size);this.render();return this._sel.size;}
    selectSphere(center,radius){var bo=this.base&&this.base[0];if(!bo||!bo.pos||!window.PCEdit||!window.PCEdit.selectBySphere)return 0;this._sel=new Set(this._clipFilter(window.PCEdit.selectBySphere(bo.pos,bo.pos.length/3,center,radius)));this._buildSelHighlight();if(typeof this.onEditSelect==='function')this.onEditSelect(this._sel.size);this.render();return this._sel.size;}
    selectBox(mn,mx){var bo=this.base&&this.base[0];if(!bo||!bo.pos||!window.PCEdit||!window.PCEdit.selectByBox)return 0;this._sel=new Set(this._clipFilter(window.PCEdit.selectByBox(bo.pos,bo.pos.length/3,mn,mx)));this._buildSelHighlight();if(typeof this.onEditSelect==='function')this.onEditSelect(this._sel.size);this.render();return this._sel.size;}
    cleanSORInApp(opts) {
      var bo=this.base&&this.base[0];
      if(!bo||!bo.pos||typeof window==='undefined'||!window.PCEdit||!window.PCEdit.cleanStatisticalOutliers)return 0;
      var o=Object.assign({},opts||{});if(o.voxel==null&&bo._spacing>0)o.voxel=bo._spacing*3;
      var r=this._applyEditOp(function(sub){return window.PCEdit.cleanStatisticalOutliers(sub,o);});
      if(!r||!r.removed)return 0;
      this._pushRemovedEditUndo(r,0);this._sel=new Set();
      if(this._selObj){this._delObjs([this._selObj]);this._selObj=null;}
      this._loadEditedResult(r,bo);
      if(typeof this.onEditSelect==='function')this.onEditSelect(0);
      if(typeof this.onEditChange==='function')this.onEditChange(r.pos.length/3);
      return r.removed;
    }
    // v1046 — Phase 1: radius outlier removal (редкие «мушки», что пропускает SOR).
    cleanRadiusInApp(opts) {
      var bo=this.base&&this.base[0];
      if(!bo||!bo.pos||typeof window==='undefined'||!window.PCEdit||!window.PCEdit.cleanRadiusOutliers)return 0;
      var o=Object.assign({},opts||{});if(o.radius==null&&bo._spacing>0)o.radius=bo._spacing*(o.radiusFactor||5);
      var r=this._applyEditOp(function(sub){return window.PCEdit.cleanRadiusOutliers(sub,o);});
      if(!r||!r.removed)return 0;
      this._pushRemovedEditUndo(r,0);this._sel=new Set();
      if(this._selObj){this._delObjs([this._selObj]);this._selObj=null;}
      this._loadEditedResult(r,bo);
      if(typeof this.onEditSelect==='function')this.onEditSelect(0);
      if(typeof this.onEditChange==='function')this.onEditChange(r.pos.length/3);
      return r.removed;
    }
    // v1046 — Phase 1: noise filter по локальной плоскости (сглаживает «толщину» поверхностей).
    noiseFilterInApp(opts) {
      var bo=this.base&&this.base[0];
      if(!bo||!bo.pos||typeof window==='undefined'||!window.PCEdit||!window.PCEdit.noiseFilterLocalPlane)return 0;
      var o=Object.assign({},opts||{});if(o.voxel==null&&bo._spacing>0)o.voxel=bo._spacing*(o.voxelFactor||2);
      var r=this._applyEditOp(function(sub){return window.PCEdit.noiseFilterLocalPlane(sub,o);});
      if(!r||!r.removed)return 0;
      this._pushRemovedEditUndo(r,0);this._sel=new Set();
      if(this._selObj){this._delObjs([this._selObj]);this._selObj=null;}
      this._loadEditedResult(r,bo);
      if(typeof this.onEditSelect==='function')this.onEditSelect(0);
      if(typeof this.onEditChange==='function')this.onEditChange(r.pos.length/3);
      return r.removed;
    }
    // v1046 — Phase 2: реальное воксельное прореживание (сохраняется, не только дисплей).
    voxelDownsampleInApp(opts) {
      var bo=this.base&&this.base[0];
      if(!bo||!bo.pos||typeof window==='undefined'||!window.PCEdit||!window.PCEdit.voxelDownsample)return 0;
      var o=Object.assign({},opts||{});if(o.voxel==null&&bo._spacing>0)o.voxel=bo._spacing*(o.voxelFactor||2);
      var before=bo.pos.length/3;
      var r=this._applyEditOp(function(sub){return window.PCEdit.voxelDownsample(sub,o);});
      if(!r||!r.pos||!r.pos.length||r.removed<=0)return 0;
      this._pushSnapshotEditUndo(bo);this._sel=new Set();
      if(this._selObj){this._delObjs([this._selObj]);this._selObj=null;}
      this._loadEditedResult(r,bo);
      if(typeof this.onEditSelect==='function')this.onEditSelect(0);
      if(typeof this.onEditChange==='function')this.onEditChange(r.pos.length/3);
      return before-(r.pos.length/3);
    }
    // v1046 — Phase 2: горизонтальный/вертикальный срез (сечение).
    sliceKeepInApp(opts) {
      var bo=this.base&&this.base[0];
      if(!bo||!bo.pos||typeof window==='undefined'||!window.PCEdit||!window.PCEdit.sliceSection)return 0;
      var r=this._applyEditOp(function(sub){return window.PCEdit.sliceSection(sub,opts||{});});
      if(!r||!r.removed)return 0;
      this._pushRemovedEditUndo(r,0);this._sel=new Set();
      if(this._selObj){this._delObjs([this._selObj]);this._selObj=null;}
      this._loadEditedResult(r,bo);
      if(typeof this.onEditSelect==='function')this.onEditSelect(0);
      if(typeof this.onEditChange==='function')this.onEditChange(r.pos.length/3);
      return r.removed;
    }
    _classificationTarget() {
      let cloudInfo = null;
      try {
        const browserWindow = typeof window !== 'undefined' ? window : null;
        cloudInfo = browserWindow && browserWindow.MultiCloud && browserWindow.MultiCloud.getActive
          ? browserWindow.MultiCloud.getActive() : null;
      } catch (_) {}
      const cloudId = (cloudInfo && (cloudInfo.id || cloudInfo.path)) ||
        (this._cloudRecord && this._cloudRecord.sourceName) || 'active-cloud';
      const sourcePath = (cloudInfo && cloudInfo.path) ||
        (this._cloudRecord && this._cloudRecord.sourceName) || '';
      return { cloudId: String(cloudId), sourcePath: String(sourcePath || '') };
    }
    _persistClassificationAsset(labels, algorithm, parameters, counts, target) {
      const projectState = typeof window !== 'undefined' && window.BimProjectState;
      if (!projectState || typeof projectState.saveClassification !== 'function') {
        return Promise.resolve({ ok: false, error: 'classification_asset_storage_unavailable' });
      }
      const source = target || this._classificationTarget();
      const payload = {
        cloudId: source.cloudId,
        sourcePath: source.sourcePath,
        pointCount: labels.length,
        labels: labels,
        operation: String(algorithm).indexOf('manual LAS/ASPRS class assignment') === 0 ? 'cloud.classify.manual' : 'cloud.classify.structure',
        algorithm: algorithm,
        parameters: parameters || {},
        counts: counts || {},
        sourceTransform: this._srcXform || null,
        crsWkt: this._srcCrs || null
      };
      const self = this;
      return Promise.resolve().then(function () {
        return projectState.saveClassification(payload);
      }).catch(function (error) {
        const message = String(error && error.message || error);
        try {
          if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function' && typeof CustomEvent === 'function') {
            window.dispatchEvent(new CustomEvent('bim-project-classification-error', { detail: { error: message } }));
          }
        } catch (_) {}
        return { ok: false, error: message };
      });
    }
    _persistClassificationClear(target) {
      const projectState = typeof window !== 'undefined' && window.BimProjectState;
      if (!projectState || typeof projectState.clearClassification !== 'function') {
        return Promise.resolve({ ok: false, error: 'classification_asset_storage_unavailable' });
      }
      const source = target || this._classificationTarget();
      return Promise.resolve().then(function () {
        return projectState.clearClassification(source.cloudId);
      }).catch(function (error) {
        const message = String(error && error.message || error);
        try {
          if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function' && typeof CustomEvent === 'function') {
            window.dispatchEvent(new CustomEvent('bim-project-classification-error', { detail: { error: message } }));
          }
        } catch (_) {}
        return { ok: false, error: message };
      });
    }
    assignClassificationInApp(classCode) {
      const code = Number(classCode);
      if (!Number.isInteger(code) || code < 0 || code > 255) return { ok: false, error: 'invalid_class_code' };
      const bo = this.base && this.base[0];
      if (!bo || !bo.pos || !bo.pos.length) return { ok: false, error: 'cloud_not_loaded' };
      const n = Math.floor(bo.pos.length / 3);
      if (!Number.isSafeInteger(n) || n < 1 || n > 0xffffffff) return { ok: false, error: 'invalid_point_count' };
      const sourceCount = this._cloudRecord && Number(this._cloudRecord.sourceCount);
      if (this._octActive || this.lod || bo._lod || bo._lodBuild || this._decimatedFrom > 0) {
        return { ok: false, error: 'streaming_cloud_edit_not_supported' };
      }
      if (Number.isSafeInteger(sourceCount) && sourceCount > 0 && sourceCount !== n) {
        return { ok: false, error: 'partial_cloud_edit_not_supported' };
      }
      const prior = this._classificationLabels || null;
      if (prior && prior.length !== n) return { ok: false, error: 'classification_point_count_mismatch' };
      const selection = this._sel;
      if (!selection || typeof selection.forEach !== 'function' || !selection.size) {
        return { ok: false, error: 'no_selected_points' };
      }
      let changed = 0, validSelected = 0;
      selection.forEach(function (index) {
        if (!Number.isSafeInteger(index) || index < 0 || index >= n) return;
        validSelected++;
        if ((prior ? prior[index] : 0) !== code) changed++;
      });
      if (!validSelected) return { ok: false, error: 'no_valid_selected_points' };
      if (!changed) return { ok: true, unchanged: true, changed: 0, classCode: code };
      // Store a sparse delta for small edits (4 bytes/index + 1 byte/value).
      // For dense edits, keep the old immutable label buffer instead; this is
      // substantially smaller than an index/value pair for every point.
      const storeDelta = !!prior && changed * 5 <= n;
      const indices = storeDelta ? new Uint32Array(changed) : null;
      const previousValues = storeDelta ? new Uint8Array(changed) : null;
      const next = prior ? new Uint8Array(prior) : new Uint8Array(n);
      let write = 0;
      selection.forEach(function (index) {
        if (!Number.isSafeInteger(index) || index < 0 || index >= n || next[index] === code) return;
        if (indices) {
          indices[write] = index;
          previousValues[write] = next[index];
        }
        next[index] = code;
        write++;
      });
      if (write !== changed) return { ok: false, error: 'selection_changed_during_assignment' };
      if (!this.applyClassificationLabels(next)) return { ok: false, error: 'classification_apply_failed' };
      const target = this._classificationTarget();
      (this._undo = this._undo || []).push({
        classificationEdit: true,
        hadClassification: !!prior,
        indices: indices,
        previousValues: previousValues,
        previousLabels: prior && !storeDelta ? prior : null,
        changedPointCount: changed,
        target: target
      });
      if (this._undo.length > 6) this._undo.shift();
      const counts = { classCode: code, assignedPointCount: changed };
      this._lastClassificationPromise = this._persistClassificationAsset(
        this._classificationLabels,
        'manual LAS/ASPRS class assignment',
        { classCode: code, selectionCount: validSelected },
        counts,
        target
      );
      return { ok: true, changed: changed, classCode: code };
    }
    // v1046 — Phase 3: классификация конструктива и выделение выбранного класса для проверки.
    classifyInApp(opts){
      var bo=this.base&&this.base[0];
      if(!bo||!bo.pos||typeof window==='undefined'||!window.PCEdit||!window.PCEdit.classifyStructure)return null;
      var o=opts||{},res=window.PCEdit.classifyStructure({pos:bo.pos},o);
      if(!res||!res.labels)return null;
      if(!this.applyClassificationLabels(res.labels,o.selectClass))return null;
      this._lastClassificationPromise=this._persistClassificationAsset(
        this._classificationLabels,'RANSAC structural planes',o,res.counts);
      return res.counts;
    }
    // ---------- Пункт 4: потоковый octree с диска ----------
    // opts.index    — index.json из bim:buildOctree (узлы, bbox, hasColor, pointCount)
    // opts.fetchNode(key) -> Promise<{pos:Float32Array, col:Float32Array|null}>  (подгрузка с диска)
    setOctreeStream(opts) {
      opts = opts || {};
      if (!opts.index || typeof opts.fetchNode !== 'function' || typeof window === 'undefined' || !window.OctreeStore) return false;
      this.clearOctreeStream();
      // отключаем обычное облако/модель, чтобы не дублировать геометрию
      const cloudRecord=this._cloudRecord;this._setBase([]);this._cloudRecord=cloudRecord;
      this._octIndex = opts.index; this._octFetch = opts.fetchNode;
      this._octCache = new Map(); this._octFrame = 0; this._octActive = true;
      this._octFailures = new Map();
      this._octHasColor = !!opts.index.hasColor;
      this._octHasIntensity = opts.index.hasIntensity === true;
      this._octHasClassification = opts.index.hasClassification === true;
      this._octFallbackColorMode = null;
      const requestedColorMode = this.getColorMode();
      if (!this.getAvailableColorModes().includes(requestedColorMode)) {
        this._octFallbackColorMode = requestedColorMode;
        this._cloudColorMode = 'rgb';
        this._ptElev = false;
      }
      const b = opts.index.bbox; if (b && b.mn && b.mx) this.bbox = { mn: b.mn.slice(), mx: b.mx.slice() };
      const c = this.bbox; const bw = c.mx[0] - c.mn[0], bh = c.mx[1] - c.mn[1], bd = c.mx[2] - c.mn[2];
      const area = 2 * (bw * bd + bw * bh + bd * bh) || 1; const diag = Math.sqrt(bw * bw + bh * bh + bd * bd) || 8;
      const pc = Math.max(1, Number(opts.index.pointCount) || 1);
      let spacing = Math.sqrt(area / Math.max(1, pc)); spacing = Math.min(spacing, diag * 0.02);
      this._octSpacing = spacing;
      this._octPtMax = pc > 6000000 ? 12 : (pc > 1500000 ? 16 : 20);
      // Поток LOD должен уважать настройку плотности просмотра. Бюджет,
      // равный размеру файла, отключал бы прореживание и мог перегрузить GPU,
      // особенно на больших облаках и в SwiftShader/интегрированной графике.
      const configuredBudget = Number(this._lodBudget);
      const safeBudget = Number.isFinite(configuredBudget) && configuredBudget >= 1
        ? Math.floor(configuredBudget)
        : 4000000;
      this._octBudget = Math.min(pc, safeBudget);
      this._frame(); this.render();
      return true;
    }
    clearOctreeStream(restoreColorMode) {
      const gl = this.gl;
      if (this._octCache && gl) { this._octCache.forEach(e => { if (e.buf) { gl.deleteVertexArray(e.buf.vao); gl.deleteBuffer(e.buf.pb); if (e.buf.cb) gl.deleteBuffer(e.buf.cb); if (e.buf.ib) gl.deleteBuffer(e.buf.ib); if (e.buf.kb) gl.deleteBuffer(e.buf.kb); } }); }
      const fallback = this._octFallbackColorMode;
      this._octGeneration = (this._octGeneration || 0) + 1;
      this._octCache = null; this._octIndex = null; this._octFetch = null; this._octActive = false;
      this._octFailures = null;
      this._octHasColor = false; this._octHasIntensity = false; this._octHasClassification = false;
      this._octFallbackColorMode = null;
      if (restoreColorMode !== false && fallback && this.getAvailableColorModes().includes(fallback)) {
        this._cloudColorMode = fallback;
        this._ptElev = fallback === 'elev';
      }
    }
    octreeActive() { return !!this._octActive; }
    _mkPtBuf(pos, col, intensity, classification) {
      const count = pos && pos.length / 3;
      if (!(pos instanceof Float32Array) || !Number.isSafeInteger(count) || count < 1 ||
          (col && (!(col instanceof Float32Array) || col.length !== count * 3)) ||
          (intensity && (!(intensity instanceof Float32Array) || intensity.length !== count)) ||
          (classification && (!(classification instanceof Uint8Array) || classification.length !== count))) {
        throw new RangeError('octree node attribute arrays do not match the point count');
      }
      const gl = this.gl; const vao = gl.createVertexArray(); gl.bindVertexArray(vao);
      const pb = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, pb); gl.bufferData(gl.ARRAY_BUFFER, pos, gl.STATIC_DRAW);
      gl.enableVertexAttribArray(this.aPos); gl.vertexAttribPointer(this.aPos, 3, gl.FLOAT, false, 0, 0);
      let cb = null;
      if (col && this.aColor >= 0) { cb = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, cb); gl.bufferData(gl.ARRAY_BUFFER, col, gl.STATIC_DRAW); gl.enableVertexAttribArray(this.aColor); gl.vertexAttribPointer(this.aColor, 3, gl.FLOAT, false, 0, 0); }
      let ib = null, kb = null;
      if (intensity && this.aIntensity >= 0) {
        ib = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, ib);
        gl.bufferData(gl.ARRAY_BUFFER, intensity, gl.STATIC_DRAW);
        gl.enableVertexAttribArray(this.aIntensity);
        gl.vertexAttribPointer(this.aIntensity, 1, gl.FLOAT, false, 0, 0);
      }
      if (classification && this.aClassification >= 0) {
        kb = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, kb);
        gl.bufferData(gl.ARRAY_BUFFER, classification, gl.STATIC_DRAW);
        gl.enableVertexAttribArray(this.aClassification);
        gl.vertexAttribPointer(this.aClassification, 1, gl.UNSIGNED_BYTE, false, 0, 0);
      }
      gl.bindVertexArray(null);
      return {
        vao, pb, cb, ib, kb, count,
        bytes: pos.byteLength + (col ? col.byteLength : 0) +
          (intensity ? intensity.byteLength : 0) +
          (classification ? classification.byteLength : 0)
      };
    }
    _recordOctreeNodeFailure(key, error) {
      if (!this._octFailures) this._octFailures = new Map();
      const previous = this._octFailures.get(key);
      const attempt = (previous && previous.attempt || 0) + 1;
      const retryInMs = Math.min(30000, 250 * Math.pow(2, Math.min(attempt - 1, 7)));
      const now = typeof this._octNow === 'function' ? this._octNow() : Date.now();
      const message = String(error && error.message || error || 'node read failed').slice(0, 256);
      this._octFailures.delete(key);
      this._octFailures.set(key, { attempt, retryAt: now + retryInMs });
      while (this._octFailures.size > 512) {
        this._octFailures.delete(this._octFailures.keys().next().value);
      }
      const detail = { key, attempt, retryInMs, error: message };
      if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function' &&
          typeof CustomEvent === 'function') {
        try { window.dispatchEvent(new CustomEvent('bim-octree-node-error', { detail })); } catch (_) {}
      }
      return detail;
    }
    _drawOctree() {
      const gl = this.gl; if (!gl || !this._octActive || typeof window === 'undefined' || !window.OctreeStore || !this._octCache) return;
      const M = this._lastVP || this._vp(); const eye = this._eye(); const self = this;
      const streamGeneration = this._octGeneration;
      this._octFrame++;
      const sel = window.OctreeStore.selectNodes(this._octIndex, {
        budget: this._octBudget || Infinity,
        isVisible: (b6) => !self._cellOutside(M, [b6[0], b6[1], b6[2]], [b6[3], b6[4], b6[5]]),
        distance: (b6) => { const cx = (b6[0] + b6[3]) / 2, cy = (b6[1] + b6[4]) / 2, cz = (b6[2] + b6[5]) / 2; return (cx - eye[0]) * (cx - eye[0]) + (cy - eye[1]) * (cy - eye[1]) + (cz - eye[2]) * (cz - eye[2]); }
      });
      gl.uniform1f(this.u.uUnlit, 1); gl.uniform1f(this.u.uUseVColor, this._octHasColor ? 1 : 0);
      gl.uniform1f(this.u.uRound, this._roundPoints ? 1 : 0); gl.uniform1f(this.u.uAmbient, 1);
      const vh = gl.canvas.height || 600;
      const scale = (this._octSpacing || 0) * (vh * 0.5 / Math.tan(this._fov / 2)) * 1.15;
      gl.uniform1f(this.u.uAttenuate, scale > 0 ? 1 : 0); gl.uniform1f(this.u.uPtScale, scale);
      gl.uniform1f(this.u.uPtMin, 1.0); gl.uniform1f(this.u.uPtMax, this._octPtMax || 8.0);
      gl.uniform1f(this.u.uPointSize, this._cloudDisplay.pointSize || 2.2);
      if(this._cloudDisplay.pointSize)gl.uniform1f(this.u.uAttenuate,0);
      gl.uniform1f(this.u.uCloudPass,1);gl.uniform1f(this.u.uElevMode,this._ptElev?1:0);
      const streamMode = this.getColorMode();
      const streamAttrMode = streamMode === 'intensity' ? 2 :
        streamMode === 'classification' ? 3 : 0;
      gl.uniform1f(this.u.uAttrMode, streamAttrMode);
      const cb=this._clipBounds();gl.uniform1f(this.u.uClipOn,this._clipActive()?1:0);if(cb){gl.uniform3fv(this.u.uClipMin,cb.mn);gl.uniform3fv(this.u.uClipMax,cb.mx);}
      if (!this._octHasColor) gl.uniform3fv(this.u.uColor, new Float32Array([0.82, 0.86, 0.93]));
      const selSet = new Set(sel.keys);
      for (const key of sel.keys) {
        let e = this._octCache.get(key);
        if (e && e.buf) { e.lastUsed = this._octFrame; gl.bindVertexArray(e.buf.vao); gl.drawArrays(gl.POINTS, 0, e.buf.count); continue; }
        if (e && e.loading) continue;
        const failure = this._octFailures && this._octFailures.get(key);
        const now = typeof this._octNow === 'function' ? this._octNow() : Date.now();
        if (failure && failure.retryAt > now) continue;
        this._octCache.set(key, { buf: null, loading: true, lastUsed: this._octFrame });
        (function (k) {
          Promise.resolve().then(function () { return self._octFetch(k); }).then(function (res) {
            if (self._octGeneration !== streamGeneration || !self._octActive) return;
            const ent = self._octCache && self._octCache.get(k);
            if (!ent) return;
            try {
              if (!res || !res.pos || !res.pos.length) throw new Error('empty octree node response');
              ent.buf = self._mkPtBuf(res.pos, res.col || null,
                res.intensity || null, res.classification || null);
              if (self._octFailures) self._octFailures.delete(k);
            } catch (error) {
              if (self._octCache) self._octCache.delete(k);
              self._recordOctreeNodeFailure(k, error);
            } finally {
              const current = self._octCache && self._octCache.get(k);
              if (current === ent) {
                ent.loading = false;
                ent.lastUsed = self._octFrame;
              }
            }
            self.render();
          }).catch(function (error) {
            if (self._octGeneration !== streamGeneration || !self._octActive) return;
            if (self._octCache) self._octCache.delete(k);
            self._recordOctreeNodeFailure(k, error);
            self.render();
          });
        })(key);
      }
      gl.uniform1f(this.u.uRound, 0); gl.uniform1f(this.u.uAttenuate, 0); gl.bindVertexArray(null);
      this._trimOctreeGpuCache(selSet, sel.points);
    }
    _trimOctreeGpuCache(selSet, visiblePoints) {
      const gl = this.gl, cache = this._octCache;
      if (!gl || !cache) return;
      const bytesPerPoint = 12 + (this._octHasColor ? 12 : 0) +
        (this._octHasIntensity ? 4 : 0) + (this._octHasClassification ? 1 : 0);
      const visibleBytes = Math.max(0, Number(visiblePoints) || 0) * bytesPerPoint;
      // Keep the current view plus a bounded 128 MiB working set for nearby
      // camera positions, while never retaining an unbounded GPU copy of the
      // entire disk-backed cloud after a long orbit/pan session.
      const cacheLimitBytes = Math.max(visibleBytes, Math.min(visibleBytes + 128 * 1024 * 1024, 512 * 1024 * 1024));
      let cachedBytes = 0;
      const evict = [];
      cache.forEach((entry, key) => {
        if (!entry || !entry.buf) return;
        const bytes = Number(entry.buf.bytes) ||
          (Number(entry.buf.count) || 0) *
            (12 + (entry.buf.cb ? 12 : 0) + (entry.buf.ib ? 4 : 0) + (entry.buf.kb ? 1 : 0));
        cachedBytes += bytes;
        if (!selSet.has(key)) evict.push({ key, bytes, lastUsed: Number(entry.lastUsed) || 0 });
      });
      if (cachedBytes <= cacheLimitBytes) return;
      evict.sort((a, b) => a.lastUsed - b.lastUsed);
      for (const item of evict) {
        if (cachedBytes <= cacheLimitBytes) break;
        const entry = cache.get(item.key);
        if (entry && entry.buf) {
          gl.deleteVertexArray(entry.buf.vao);
          gl.deleteBuffer(entry.buf.pb);
          if (entry.buf.cb) gl.deleteBuffer(entry.buf.cb);
          if (entry.buf.ib) gl.deleteBuffer(entry.buf.ib);
          if (entry.buf.kb) gl.deleteBuffer(entry.buf.kb);
          cache.delete(item.key);
          cachedBytes -= item.bytes;
        }
      }
    }
  }

  function cloudQuality(n) {
    n = n | 0;
    // Мелкие, чёткие точки как в CloudCompare (по умолчанию CC рисует точки ~1-2 px).
    // Раньше базовый размер был 3.2-5.8 px + потолок 22-42 px -> вблизи точки раздувались
    // в крупные квадраты и терялась детализация. Теперь размер мелкий и почти фиксированный.
    var pointSize = n > 6000000 ? 1.3 : (n > 1500000 ? 1.3 : (n > 400000 ? 1.4 : 1.5));
    var ptMax = n > 6000000 ? 2.5 : (n > 1500000 ? 3 : 3.5);
    return { pointSize: pointSize, ptMax: ptMax };
  }
  if (typeof window !== 'undefined') window.Viewer3DGL = Viewer3DGL;
  if (typeof module !== 'undefined' && module.exports) module.exports = { Viewer3DGL: Viewer3DGL, cloudQuality: cloudQuality };
})();
