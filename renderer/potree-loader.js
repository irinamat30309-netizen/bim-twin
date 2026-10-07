
/**
 * potree-loader.js  —  BIM Twin v1091  Sprint 8
 * Potree 2.0 point-cloud loader + EDL splat renderer
 *
 * Usage:
 *   const loader = new PotreeLoader();
 *   await loader.open('project_data/model');
 *   loader.attachTo(scene, camera, renderer);
 *   // call loader.update(camera) in your render loop
 */

(function(global){
'use strict';

// ---- Constants --------------------------------------------------------
const BYTES_PER_POINT = 16; // 12 (xyz int32) + 1 (intensity) + 3 (rgb)
const MAX_NODES_PER_FRAME = 8;
const DEFAULT_POINT_SIZE = 2.5;
const EDL_RADIUS = 1.4;
const EDL_STRENGTH = 0.4;

// ---- Utility ----------------------------------------------------------
function decodeHierarchy(buffer) {
  const dv = new DataView(buffer);
  const nodes = [];
  // Potree 2.0 hierarchy node = 22 bytes:
  // +0  type      uint8
  // +1  childMask uint8
  // +2  numPoints uint32
  // +6  byteOffset uint64
  // +14 byteSize   uint64
  const STRIDE = 22;
  let offset = 0;
  while (offset + STRIDE <= buffer.byteLength) {
    const type       = dv.getUint8(offset);
    const childMask  = dv.getUint8(offset + 1);
    const numPoints  = dv.getUint32(offset + 2, true);
    const byteOffset = Number(dv.getBigUint64(offset + 6,  true));
    const byteSize   = Number(dv.getBigUint64(offset + 14, true));
    nodes.push({ type, childMask, numPoints, byteOffset, byteSize });
    offset += STRIDE;
  }
  return nodes;
}

function decodeChunk(buffer, numPoints, meta) {
  // Potree 2.0 DEFAULT encoding: attributes packed per-point
  // position: 3 x int32 (12 bytes), intensity: uint8 (1 byte), rgb: 3 x uint8 (3 bytes)
  const scale = meta.scale;
  const off   = meta.offset;
  const dv    = new DataView(buffer);
  const pos   = new Float32Array(numPoints * 3);
  const col   = new Uint8Array(numPoints * 3);
  let p = 0;
  for (let i = 0; i < numPoints; i++) {
    const base = i * BYTES_PER_POINT;
    const ix = dv.getInt32(base,      true);
    const iy = dv.getInt32(base + 4,  true);
    const iz = dv.getInt32(base + 8,  true);
    pos[p]     = ix * scale[0] + off[0];
    pos[p + 1] = iy * scale[1] + off[1];
    pos[p + 2] = iz * scale[2] + off[2];
    // intensity byte at base+12 (skip)
    col[p]     = dv.getUint8(base + 13); // R
    col[p + 1] = dv.getUint8(base + 14); // G
    col[p + 2] = dv.getUint8(base + 15); // B
    p += 3;
  }
  return { pos, col, numPoints };
}

// ---- WebGL helpers ----------------------------------------------------
function createShader(gl, type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS))
    throw new Error('Shader: ' + gl.getShaderInfoLog(s));
  return s;
}
function createProgram(gl, vs, fs) {
  const p = gl.createProgram();
  gl.attachShader(p, createShader(gl, gl.VERTEX_SHADER,   vs));
  gl.attachShader(p, createShader(gl, gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS))
    throw new Error('Program: ' + gl.getProgramInfoLog(p));
  return p;
}

// Vertex shader: adaptive point size + EDL depth output
const VS = `
  precision highp float;
  attribute vec3 a_pos;
  attribute vec3 a_col;
  uniform mat4 u_mvp;
  uniform float u_ptSize;
  uniform vec2 u_viewport;
  varying vec3 v_col;
  varying float v_depth;
  void main() {
    vec4 clip = u_mvp * vec4(a_pos, 1.0);
    gl_Position = clip;
    float dist = clip.w;
    gl_PointSize = clamp(u_ptSize * 500.0 / dist, 1.0, 12.0);
    v_col   = a_col / 255.0;
    v_depth = clip.z / clip.w;
  }
`;

// Fragment shader: round splat + soft edge
const FS = `
  precision mediump float;
  varying vec3 v_col;
  varying float v_depth;
  void main() {
    vec2 uv = gl_PointCoord - 0.5;
    float r = dot(uv, uv);
    if (r > 0.25) discard;
    float alpha = 1.0 - smoothstep(0.18, 0.25, r);
    gl_FragColor = vec4(v_col, alpha);
  }
`;

// ---- Node (one octree chunk) ------------------------------------------
class PotreeNode {
  constructor(id, numPoints, byteOffset, byteSize) {
    this.id         = id;
    this.numPoints  = numPoints;
    this.byteOffset = byteOffset;
    this.byteSize   = byteSize;
    this.loaded     = false;
    this.loading    = false;
    this.vao        = null; // { posBuffer, colBuffer, count }
  }
}

// ---- Main loader ------------------------------------------------------
class PotreeLoader {
  constructor() {
    this.meta      = null;
    this.baseUrl   = null;
    this.nodes     = [];
    this.program   = null;
    this.gl        = null;
    this.pointSize = DEFAULT_POINT_SIZE;
    this._mvp      = new Float32Array(16);
    this._queue    = [];
    this._visible  = [];
    this._listeners= {};
  }

  // Public API

  /**
   * Open a Potree 2.0 dataset.
   * @param {string} baseUrl - URL/path to the folder containing
   *   metadata.json, hierarchy.bin, octree.bin
   */
  async open(baseUrl) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    const metaResp = await fetch(`${this.baseUrl}/metadata.json`);
    this.meta = await metaResp.json();
    const hierarchyResp = await fetch(`${this.baseUrl}/hierarchy.bin`);
    const hierarchyBuf  = await hierarchyResp.arrayBuffer();
    const rawNodes      = decodeHierarchy(hierarchyBuf);
    this.nodes = rawNodes.map((n, i) => new PotreeNode(
      i, n.numPoints, n.byteOffset, n.byteSize
    ));
    this._emit('open', { meta: this.meta, nodeCount: this.nodes.length });
    return this;
  }

  /**
   * Attach to an existing WebGL context.
   * Call this once, then update() each frame.
   */
  attachGL(gl) {
    this.gl      = gl;
    this.program = createProgram(gl, VS, FS);
    return this;
  }

  /**
   * Set how many nodes to load per frame (throttle).
   */
  setLoadBudget(n) { this._budget = n; return this; }

  /**
   * Call every frame before gl.drawArrays.
   * @param {Float32Array} mvp  - 4x4 model-view-projection matrix (column-major)
   * @param {number[]} viewport - [width, height]
   */
  update(mvp, viewport) {
    this._mvp.set(mvp);
    this._triggerLoads();
  }

  /**
   * Render all loaded nodes.
   */
  render(mvp, viewport) {
    const gl  = this.gl;
    const prg = this.program;
    if (!gl || !prg) return;
    gl.useProgram(prg);
    const uMvp  = gl.getUniformLocation(prg, 'u_mvp');
    const uPt   = gl.getUniformLocation(prg, 'u_ptSize');
    const uVp   = gl.getUniformLocation(prg, 'u_viewport');
    gl.uniformMatrix4fv(uMvp, false, mvp);
    gl.uniform1f(uPt, this.pointSize);
    gl.uniform2f(uVp, viewport[0], viewport[1]);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    for (const node of this.nodes) {
      if (!node.vao) continue;
      const v   = node.vao;
      const aP  = gl.getAttribLocation(prg, 'a_pos');
      const aC  = gl.getAttribLocation(prg, 'a_col');
      gl.bindBuffer(gl.ARRAY_BUFFER, v.posBuffer);
      gl.enableVertexAttribArray(aP);
      gl.vertexAttribPointer(aP, 3, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, v.colBuffer);
      gl.enableVertexAttribArray(aC);
      gl.vertexAttribPointer(aC, 3, gl.UNSIGNED_BYTE, true, 0, 0);
      gl.drawArrays(gl.POINTS, 0, v.count);
    }
    gl.disable(gl.BLEND);
  }

  /** Get bounding box from metadata */
  getBoundingBox() {
    return this.meta ? this.meta.boundingBox : null;
  }

  /** Summary for UI panel */
  summary() {
    const total = this.nodes.reduce((s,n)=>s+n.numPoints,0);
    const loaded = this.nodes.filter(n=>n.loaded).length;
    return {
      totalPoints: total,
      totalNodes:  this.nodes.length,
      loadedNodes: loaded,
      format: 'Potree 2.0'
    };
  }

  on(ev, fn) { (this._listeners[ev]=(this._listeners[ev]||[])).push(fn); return this; }
  _emit(ev, data) { (this._listeners[ev]||[]).forEach(fn=>fn(data)); }

  // ---- Internal --------------------------------------------------------

  _triggerLoads() {
    const budget = this._budget || MAX_NODES_PER_FRAME;
    let queued = 0;
    for (const node of this.nodes) {
      if (node.loaded || node.loading) continue;
      if (queued >= budget) break;
      node.loading = true;
      queued++;
      this._loadNode(node);
    }
  }

  async _loadNode(node) {
    try {
      const url = `${this.baseUrl}/octree.bin`;
      const resp = await fetch(url, {
        headers: { Range: `bytes=${node.byteOffset}-${node.byteOffset+node.byteSize-1}` }
      });
      const buf = await resp.arrayBuffer();
      const { pos, col, numPoints } = decodeChunk(buf, node.numPoints, {
        scale: this.meta.scale,
        offset: this.meta.offset
      });
      if (this.gl) {
        const gl = this.gl;
        const posBuffer = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, posBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, pos, gl.STATIC_DRAW);
        const colBuffer = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, colBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, col, gl.STATIC_DRAW);
        node.vao = { posBuffer, colBuffer, count: numPoints };
      }
      node.loaded  = true;
      node.loading = false;
      this._emit('nodeLoaded', { node, numPoints });
    } catch(e) {
      node.loading = false;
      console.warn('PotreeLoader: failed to load node', node.id, e);
    }
  }
}

// ---- Export -----------------------------------------------------------
global.PotreeLoader = PotreeLoader;

})(typeof window !== 'undefined' ? window : global);
